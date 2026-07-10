// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
// celer_mem.ts — Deno FFI binding for celer-mem embedded storage.
//
// This wraps the C ABI shim in `native/celer_ffi.cpp` (compiled to
// `native/libceler_ffi.so` via `native/build.sh`) and presents a clean,
// fully-async key/value store. Every native call is marked `nonblocking`, so
// reads, writes, scans and batches run on Deno's FFI thread pool and never
// stall the event loop — matching celer-mem's own async-first design.
//
// celer-mem organizes data as scope -> table -> key/value. One SQLite file is
// created per scope; each logical table is a real SQL table inside it.
//
// The native library is optional: callers should use `CelerStore.tryOpen()` and
// fall back gracefully when FFI is unavailable (library not built, or the
// process lacks `--allow-ffi`).
//
// Buffer lifetime note: nonblocking FFI calls execute on a worker thread, so
// any input buffer must outlive the dispatch. We therefore pass explicit
// pointers via `Deno.UnsafePointer.of()` and hold the backing buffers in a
// keep-alive list referenced after the await — V8 never relocates an
// ArrayBuffer's backing store, so a live reference keeps the pointer valid.

const LIB_URL = new URL("../../../native/libceler_ffi.so", import.meta.url);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const SYMBOLS = {
  celer_open: { parameters: ["pointer", "pointer", "pointer", "i32"], result: "pointer", nonblocking: true },
  celer_close_store: { parameters: [], result: "pointer", nonblocking: true },
  celer_put: { parameters: ["pointer", "pointer", "pointer", "i32", "pointer", "i32"], result: "pointer", nonblocking: true },
  celer_get: { parameters: ["pointer", "pointer", "pointer", "i32"], result: "pointer", nonblocking: true },
  celer_del: { parameters: ["pointer", "pointer", "pointer", "i32"], result: "pointer", nonblocking: true },
  celer_prefix_scan: { parameters: ["pointer", "pointer", "pointer", "i32"], result: "pointer", nonblocking: true },
  celer_batch: { parameters: ["pointer", "pointer", "pointer", "i32"], result: "pointer", nonblocking: true },
  celer_compact: { parameters: ["pointer", "pointer"], result: "pointer", nonblocking: true },
  celer_free: { parameters: ["pointer"], result: "void" },
} as const;

type CelerLib = Deno.DynamicLibrary<typeof SYMBOLS>;

export interface CelerScanEntry {
  key: string;
  value: Uint8Array;
}

export type CelerBatchOp =
  | { kind: "put"; key: string; value: string | Uint8Array }
  | { kind: "del"; key: string };

export interface CelerTableDescriptor {
  scope: string;
  table: string;
}

export interface CelerStoreOptions {
  /** Backend kind. Only "sqlite" is wired through the shim today. */
  backend?: "sqlite" | "rocksdb";
  /** Directory where per-scope SQLite files are created. */
  path: string;
  /** Scope/table pairs to provision on open. */
  schema: CelerTableDescriptor[];
  /** Override the shared-library location (mainly for tests). */
  libPath?: string | URL;
}

const RESPONSE_FOUND = 1;
const RESPONSE_MISS = 2;
const RESPONSE_ERROR = -1;

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? encoder.encode(value) : value;
}

/** NUL-terminated buffer for `const char*` parameters; never zero length. */
function cstr(value: string): Uint8Array {
  const body = encoder.encode(value);
  const out = new Uint8Array(body.length + 1);
  out.set(body, 0);
  out[body.length] = 0;
  return out;
}

/** Binary-safe buffer for length-delimited parameters; never zero length. */
function buf(value: string | Uint8Array): Uint8Array {
  const bytes = toBytes(value);
  // Deno passes a null pointer for zero-length TypedArrays; pad to one byte so
  // the native side always receives a valid (length-bounded) pointer.
  return bytes.length === 0 ? new Uint8Array(1) : bytes;
}

function writeInt32LE(target: number[], value: number): void {
  target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

interface DecodedResponse {
  status: number;
  payload: Uint8Array;
}

function readResponse(lib: CelerLib, ptr: Deno.PointerValue): DecodedResponse {
  if (ptr === null) {
    throw new Error("celer-mem: native call returned null (allocation failed)");
  }
  const view = new Deno.UnsafePointerView(ptr);
  const status = view.getInt32(0);
  const length = view.getInt32(4);
  // getArrayBuffer returns a view over native memory, so copy the bytes out
  // before celer_free() runs — otherwise the allocator's free-list bookkeeping
  // clobbers the head of the payload (use-after-free).
  let payload = new Uint8Array(0);
  if (length > 0) {
    payload = new Uint8Array(length);
    payload.set(new Uint8Array(view.getArrayBuffer(length, 8)));
  }
  lib.symbols.celer_free(ptr);
  return { status, payload };
}

function expectOk(response: DecodedResponse, op: string): void {
  if (response.status === RESPONSE_ERROR) {
    throw new Error(`celer-mem ${op}: ${decoder.decode(response.payload)}`);
  }
}

function decodePairs(payload: Uint8Array): CelerScanEntry[] {
  if (payload.byteLength < 4) {
    return [];
  }
  const dataView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let offset = 0;
  const count = dataView.getInt32(offset, true);
  offset += 4;

  const entries: CelerScanEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const keyLen = dataView.getInt32(offset, true);
    offset += 4;
    const key = decoder.decode(payload.subarray(offset, offset + keyLen));
    offset += keyLen;

    const valueLen = dataView.getInt32(offset, true);
    offset += 4;
    const value = payload.slice(offset, offset + valueLen);
    offset += valueLen;

    entries.push({ key, value });
  }
  return entries;
}

/**
 * Async, FFI-backed handle to a celer-mem store. Construct via
 * {@link CelerStore.open} (throws on failure) or {@link CelerStore.tryOpen}
 * (resolves null on failure, for graceful fallback).
 */
type CallArg = Uint8Array | number;

export class CelerStore {
  #lib: CelerLib;
  #closed = false;

  private constructor(lib: CelerLib) {
    this.#lib = lib;
  }

  /** True when the native library can be located and loaded. */
  static canLoad(libPath?: string | URL): boolean {
    try {
      const lib = Deno.dlopen(libPath ?? LIB_URL, SYMBOLS);
      lib.close();
      return true;
    } catch {
      return false;
    }
  }

  static async open(options: CelerStoreOptions): Promise<CelerStore> {
    const lib = Deno.dlopen(options.libPath ?? LIB_URL, SYMBOLS);
    const store = new CelerStore(lib);
    const schema = options.schema.map((d) => `${d.scope}\t${d.table}`).join("\n");
    try {
      const response = await store.#invoke(
        lib.symbols.celer_open,
        cstr(options.backend ?? "sqlite"),
        cstr(options.path),
        buf(schema),
        schema.length,
      );
      expectOk(response, "open");
    } catch (error) {
      lib.close();
      throw error;
    }
    return store;
  }

  /** Open, returning null instead of throwing when FFI/native is unavailable. */
  static async tryOpen(options: CelerStoreOptions): Promise<CelerStore | null> {
    try {
      return await CelerStore.open(options);
    } catch {
      return null;
    }
  }

  #ensureOpen(): void {
    if (this.#closed) {
      throw new Error("celer-mem: store is closed");
    }
  }

  /**
   * Invoke a nonblocking native symbol. Buffer args are passed as explicit
   * pointers and held in `keepAlive` (referenced after the await) so the worker
   * thread always sees valid memory.
   */
  async #invoke(
    // deno-lint-ignore no-explicit-any
    fn: (...args: any[]) => Promise<Deno.PointerValue>,
    ...args: CallArg[]
  ): Promise<DecodedResponse> {
    const keepAlive: Uint8Array[] = [];
    const params = args.map((arg) => {
      if (typeof arg === "number") {
        return arg;
      }
      keepAlive.push(arg);
      return Deno.UnsafePointer.of(arg);
    });
    const ptr = await fn(...params);
    // Touch keepAlive after the await so V8 cannot collect the buffers while
    // the worker thread is still reading them.
    if (keepAlive.length === Number.NEGATIVE_INFINITY) {
      throw new Error("unreachable");
    }
    return readResponse(this.#lib, ptr);
  }

  async put(scope: string, table: string, key: string, value: string | Uint8Array): Promise<void> {
    this.#ensureOpen();
    const keyBytes = encoder.encode(key);
    const valueBytes = toBytes(value);
    const response = await this.#invoke(
      this.#lib.symbols.celer_put,
      cstr(scope),
      cstr(table),
      buf(keyBytes),
      keyBytes.length,
      buf(valueBytes),
      valueBytes.length,
    );
    expectOk(response, "put");
  }

  /** Get raw bytes for a key, or null when absent. */
  async get(scope: string, table: string, key: string): Promise<Uint8Array | null> {
    this.#ensureOpen();
    const keyBytes = encoder.encode(key);
    const response = await this.#invoke(
      this.#lib.symbols.celer_get,
      cstr(scope),
      cstr(table),
      buf(keyBytes),
      keyBytes.length,
    );
    expectOk(response, "get");
    if (response.status === RESPONSE_MISS) {
      return null;
    }
    if (response.status === RESPONSE_FOUND) {
      return response.payload;
    }
    return null;
  }

  /** Get a UTF-8 string value for a key, or null when absent. */
  async getText(scope: string, table: string, key: string): Promise<string | null> {
    const bytes = await this.get(scope, table, key);
    return bytes === null ? null : decoder.decode(bytes);
  }

  async delete(scope: string, table: string, key: string): Promise<void> {
    this.#ensureOpen();
    const keyBytes = encoder.encode(key);
    const response = await this.#invoke(
      this.#lib.symbols.celer_del,
      cstr(scope),
      cstr(table),
      buf(keyBytes),
      keyBytes.length,
    );
    expectOk(response, "delete");
  }

  /** Materialize all key/value pairs under an optional prefix. */
  async list(scope: string, table: string, prefix = ""): Promise<CelerScanEntry[]> {
    this.#ensureOpen();
    const prefixBytes = encoder.encode(prefix);
    const response = await this.#invoke(
      this.#lib.symbols.celer_prefix_scan,
      cstr(scope),
      cstr(table),
      buf(prefixBytes),
      prefixBytes.length,
    );
    expectOk(response, "scan");
    return decodePairs(response.payload);
  }

  /**
   * Stream key/value pairs under a prefix. The native scan resolves on the FFI
   * thread pool; entries are yielded one at a time for ergonomic, low-pressure
   * consumption.
   */
  async *scan(scope: string, table: string, prefix = ""): AsyncGenerator<CelerScanEntry> {
    for (const entry of await this.list(scope, table, prefix)) {
      yield entry;
    }
  }

  /** Apply an atomic batch of puts/deletes to a single table. */
  async batch(scope: string, table: string, ops: CelerBatchOp[]): Promise<void> {
    this.#ensureOpen();
    const bytes: number[] = [];
    writeInt32LE(bytes, ops.length);
    for (const op of ops) {
      const keyBytes = encoder.encode(op.key);
      writeInt32LE(bytes, keyBytes.length);
      for (const b of keyBytes) bytes.push(b);
      if (op.kind === "del") {
        writeInt32LE(bytes, -1);
      } else {
        const valueBytes = toBytes(op.value);
        writeInt32LE(bytes, valueBytes.length);
        for (const b of valueBytes) bytes.push(b);
      }
    }
    const encoded = Uint8Array.from(bytes);
    const response = await this.#invoke(
      this.#lib.symbols.celer_batch,
      cstr(scope),
      cstr(table),
      buf(encoded),
      encoded.length,
    );
    expectOk(response, "batch");
  }

  async compact(scope: string, table: string): Promise<void> {
    this.#ensureOpen();
    const response = await this.#invoke(this.#lib.symbols.celer_compact, cstr(scope), cstr(table));
    expectOk(response, "compact");
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      const response = readResponse(this.#lib, await this.#lib.symbols.celer_close_store());
      expectOk(response, "close");
    } finally {
      this.#lib.close();
    }
  }
}

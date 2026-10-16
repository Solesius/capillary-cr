// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
// celer_mem.ts — koffi FFI binding for celer-mem embedded storage.
//
// This wraps the C ABI shim in `native/celer_ffi.cpp` (compiled to
// `native/libceler_ffi.so` via `native/build.sh`) and presents a clean,
// fully-async key/value store. Every native call goes through koffi's `.async`
// form, so reads, writes, scans and batches run on koffi's worker threads and
// never stall the event loop — matching celer-mem's own async-first design.
//
// celer-mem organizes data as scope -> table -> key/value. The concrete storage
// engine (RocksDB by default, SQLite as a fallback) is chosen by the native
// build and resolved at open time; this binding is backend-agnostic.
//
// The native library is optional: callers should use `CelerStore.tryOpen()` and
// fall back gracefully when it is unavailable (library not built, or koffi has
// no prebuild for the platform).
//
// Buffer lifetime note (memory-safety critical): koffi hands a TypedArray's
// backing store to native code by pointer, without copying. An async call runs
// on a worker thread while JS keeps executing, so every argument buffer must
// stay alive until the call resolves. We push each buffer into `keepAlive` and
// reference it *after* the await — that post-await use makes the async state
// machine capture `keepAlive` (and therefore the buffers) for the full duration
// of the call, so V8 cannot collect them mid-flight. V8 never relocates an
// ArrayBuffer's backing store, so the pointer stays valid as long as the buffer
// is reachable. The returned response is copied out of native memory before
// `celer_free` runs.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { LibraryHandle } from "koffi";

type KoffiFunction = ReturnType<LibraryHandle["func"]>;

const require = createRequire(import.meta.url);
const LIB_URL = new URL("../../../native/libceler_ffi.so", import.meta.url);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Sink for the FFI keep-alive anchor in #invoke. Exported so it is provably
// observable module state — the optimizer cannot treat the writes that pin
// argument buffers past an async call as dead code. Never read for logic.
export let ffiKeepAliveSink = 0;

// koffi is loaded lazily so a missing or unloadable addon degrades to the
// same "native unavailable" path as a missing shared library.
type Koffi = typeof import("koffi");
let koffiModule: Koffi | null = null;
function koffi(): Koffi {
  koffiModule ??= require("koffi") as Koffi;
  return koffiModule;
}

const SIGNATURES = {
  celer_open: "void *celer_open(void *backend, void *path, void *schema, int32_t schema_len)",
  celer_close_store: "void *celer_close_store()",
  celer_put:
    "void *celer_put(void *scope, void *table, void *key, int32_t key_len, void *value, int32_t value_len)",
  celer_get: "void *celer_get(void *scope, void *table, void *key, int32_t key_len)",
  celer_del: "void *celer_del(void *scope, void *table, void *key, int32_t key_len)",
  celer_prefix_scan:
    "void *celer_prefix_scan(void *scope, void *table, void *prefix, int32_t prefix_len)",
  celer_batch: "void *celer_batch(void *scope, void *table, void *ops, int32_t ops_len)",
  celer_compact: "void *celer_compact(void *scope, void *table)",
  celer_free: "void celer_free(void *ptr)",
} as const;

type SymbolName = keyof typeof SIGNATURES;

/** Opaque native pointer as koffi represents it (null for NULL). */
type NativePointer = unknown;

interface CelerLib {
  symbols: Record<SymbolName, KoffiFunction>;
  close(): void;
}

function libPathOf(libPath: string | URL): string {
  return libPath instanceof URL ? fileURLToPath(libPath) : libPath;
}

function loadLib(libPath: string | URL): CelerLib {
  const handle: LibraryHandle = koffi().load(libPathOf(libPath));
  const symbols = Object.fromEntries(
    (Object.keys(SIGNATURES) as SymbolName[]).map((name) => [name, handle.func(SIGNATURES[name])]),
  ) as Record<SymbolName, KoffiFunction>;
  return { symbols, close: () => handle.unload() };
}

/** Promise view over koffi's callback-style async call. */
function callAsync(fn: KoffiFunction, args: unknown[]): Promise<NativePointer> {
  return new Promise((resolve, reject) => {
    fn.async(...args, (err: unknown, result: NativePointer) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

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
  /**
   * Storage engine. Omit (or pass "auto") to use whatever the native library
   * was built with — RocksDB when compiled in, else SQLite. Only override when
   * you specifically need one engine and know the build supports it.
   */
  backend?: "sqlite" | "rocksdb" | "auto";
  /** Directory where the backend's data files are created. */
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
  // A zero-length TypedArray may surface as a null pointer on the native side;
  // pad to one byte so it always receives a valid (length-bounded) pointer.
  return bytes.length === 0 ? new Uint8Array(1) : bytes;
}

function writeInt32LE(target: number[], value: number): void {
  target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

interface DecodedResponse {
  status: number;
  payload: Uint8Array;
}

function readResponse(lib: CelerLib, ptr: NativePointer): DecodedResponse {
  if (ptr === null || ptr === undefined) {
    throw new Error("celer-mem: native call returned null (allocation failed)");
  }
  const k = koffi();
  const status = k.decode(ptr, 0, "int32_t") as number;
  const length = k.decode(ptr, 4, "int32_t") as number;
  // koffi.view returns a view over native memory, so copy the bytes out
  // before celer_free() runs — otherwise the allocator's free-list bookkeeping
  // clobbers the head of the payload (use-after-free).
  let payload = new Uint8Array(0);
  if (length > 0) {
    payload = new Uint8Array(length);
    payload.set(new Uint8Array(k.view(ptr, 8 + length), 8, length));
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
      const lib = loadLib(libPath ?? LIB_URL);
      lib.close();
      return true;
    } catch {
      return false;
    }
  }

  static async open(options: CelerStoreOptions): Promise<CelerStore> {
    const lib = loadLib(options.libPath ?? LIB_URL);
    const store = new CelerStore(lib);
    const schema = options.schema.map((d) => `${d.scope}\t${d.table}`).join("\n");
    try {
      const response = await store.#invoke(
        lib.symbols.celer_open,
        // "auto" lets the native layer pick the best backend it was built
        // with (RocksDB when compiled in, else SQLite), so the runtime default
        // always matches the compiled engine.
        cstr(options.backend ?? "auto"),
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
   * Invoke a native symbol asynchronously. Buffer args are handed to koffi by
   * pointer and held in `keepAlive`, which is referenced after the await so the
   * async state machine keeps the buffers (and their native memory) valid for
   * the whole call on the worker thread. See the buffer-lifetime note above.
   */
  async #invoke(fn: KoffiFunction, ...args: CallArg[]): Promise<DecodedResponse> {
    const keepAlive = args.filter((arg): arg is Uint8Array => typeof arg !== "number");
    const ptr = await callAsync(fn, args);
    const response = readResponse(this.#lib, ptr);
    // Anchor: a real use of every kept buffer *after* the await and the native
    // read. Folding their byte lengths into a module sink is an observable side
    // effect the optimizer cannot elide, guaranteeing the buffers outlive the
    // worker thread's access — unlike a self-evidently-false branch, which DCE
    // could drop.
    for (const buffer of keepAlive) {
      ffiKeepAliveSink = (ffiKeepAliveSink + buffer.byteLength) >>> 0;
    }
    return response;
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
      const response = readResponse(this.#lib, await callAsync(this.#lib.symbols.celer_close_store, []));
      expectOk(response, "close");
    } finally {
      this.#lib.close();
    }
  }
}

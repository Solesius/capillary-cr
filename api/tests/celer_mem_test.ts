// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assert, assertEquals } from "jsr:@std/assert";
import { CelerStore } from "../src/services/storage/celer_mem.ts";

// These tests exercise the real native library. They self-skip when the shared
// object has not been built or FFI is not permitted, so the default
// `deno test --allow-env` suite stays green. Run the full storage suite with:
//   deno test --allow-env --allow-ffi --allow-read --allow-write
const NATIVE_AVAILABLE = CelerStore.canLoad();

async function withStore(fn: (store: CelerStore, dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "celer_mem_test_" });
  const store = await CelerStore.open({
    path: dir,
    schema: [{ scope: "review", table: "runs" }, { scope: "review", table: "findings" }],
  });
  try {
    await fn(store, dir);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test({
  name: "should_round_trip_put_and_get_through_celer_ffi",
  ignore: !NATIVE_AVAILABLE,
  async fn() {
    await withStore(async (store) => {
      await store.put("review", "runs", "run-1", "Ship celer-mem backing store");
      const value = await store.getText("review", "runs", "run-1");
      assertEquals(value, "Ship celer-mem backing store");

      const missing = await store.getText("review", "runs", "absent");
      assertEquals(missing, null);
    });
  },
});

Deno.test({
  name: "should_prefix_scan_keys_through_celer_ffi",
  ignore: !NATIVE_AVAILABLE,
  async fn() {
    await withStore(async (store) => {
      await store.put("review", "findings", "finding-001", "auth instability");
      await store.put("review", "findings", "finding-002", "runtime instability");
      await store.put("review", "findings", "other-001", "not a finding");

      const found = await store.list("review", "findings", "finding-");
      assertEquals(found.length, 2);
      assertEquals(found.map((entry) => entry.key).sort(), ["finding-001", "finding-002"]);

      const streamed: string[] = [];
      for await (const entry of store.scan("review", "findings", "finding-")) {
        streamed.push(entry.key);
      }
      assertEquals(streamed.sort(), ["finding-001", "finding-002"]);
    });
  },
});

Deno.test({
  name: "should_apply_atomic_batch_and_delete_through_celer_ffi",
  ignore: !NATIVE_AVAILABLE,
  async fn() {
    await withStore(async (store) => {
      await store.batch("review", "runs", [
        { kind: "put", key: "a", value: "alpha" },
        { kind: "put", key: "b", value: "beta" },
        { kind: "put", key: "c", value: "gamma" },
      ]);
      assertEquals((await store.list("review", "runs")).length, 3);

      await store.batch("review", "runs", [
        { kind: "del", key: "b" },
        { kind: "put", key: "a", value: "alpha-2" },
      ]);

      assertEquals(await store.getText("review", "runs", "a"), "alpha-2");
      assertEquals(await store.getText("review", "runs", "b"), null);
      assert((await store.list("review", "runs")).length === 2);
    });
  },
});

Deno.test({
  name: "should_preserve_binary_values_through_celer_ffi",
  ignore: !NATIVE_AVAILABLE,
  async fn() {
    await withStore(async (store) => {
      const payload = new Uint8Array([0, 1, 2, 255, 254, 0, 42]);
      await store.put("review", "runs", "blob", payload);
      const roundTripped = await store.get("review", "runs", "blob");
      assert(roundTripped !== null);
      assertEquals(Array.from(roundTripped), Array.from(payload));
    });
  },
});

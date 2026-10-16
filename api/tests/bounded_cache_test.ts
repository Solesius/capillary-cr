// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { test, assert, assertEquals, assertThrows } from "./support/harness.ts";
import { BoundedCache } from "../src/repositories/bounded_cache.ts";

test("BoundedCache rejects a non-positive or non-integer cap", () => {
  assertThrows(() => new BoundedCache<number>(0));
  assertThrows(() => new BoundedCache<number>(-3));
  assertThrows(() => new BoundedCache<number>(2.5));
});

test("BoundedCache without eviction retains everything past the cap", () => {
  const cache = new BoundedCache<number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  // Eviction is off (no durable store) — the cache is authoritative.
  assertEquals(cache.size, 3);
  assertEquals(cache.get("a"), 1);
});

test("BoundedCache with eviction never exceeds the cap and drops the LRU", () => {
  const cache = new BoundedCache<number>(2);
  cache.enableEviction();
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3); // evicts "a" (least recently used)
  assertEquals(cache.size, 2);
  assertEquals(cache.get("a"), undefined);
  assertEquals(cache.get("b"), 2);
  assertEquals(cache.get("c"), 3);
});

test("BoundedCache get() is an LRU touch — a read rescues an entry from eviction", () => {
  const cache = new BoundedCache<number>(2);
  cache.enableEviction();
  cache.set("a", 1);
  cache.set("b", 2);
  // Touch "a" so it becomes most-recently-used; "b" is now the LRU.
  assertEquals(cache.get("a"), 1);
  cache.set("c", 3); // evicts "b", not "a"
  assertEquals(cache.get("a"), 1);
  assertEquals(cache.get("b"), undefined);
  assertEquals(cache.get("c"), 3);
});

test("BoundedCache enableEviction() trims an already-oversized cache", () => {
  const cache = new BoundedCache<number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assertEquals(cache.size, 3);
  cache.enableEviction(); // must immediately trim down to cap
  assertEquals(cache.size, 2);
  assertEquals(cache.get("a"), undefined);
});

test("BoundedCache set() on an existing key updates in place without growing", () => {
  const cache = new BoundedCache<number>(2);
  cache.enableEviction();
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 11); // update, also refreshes recency
  assertEquals(cache.size, 2);
  assertEquals(cache.get("a"), 11);
  cache.set("c", 3); // "b" is LRU now (a was refreshed), so "b" evicts
  assertEquals(cache.get("b"), undefined);
  assertEquals(cache.get("a"), 11);
});

test("BoundedCache delete, has, and values behave", () => {
  const cache = new BoundedCache<number>(4);
  cache.set("a", 1);
  cache.set("b", 2);
  assert(cache.has("a"));
  cache.delete("a");
  assert(!cache.has("a"));
  assertEquals([...cache.values()].sort(), [2]);
});

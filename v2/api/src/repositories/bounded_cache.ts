// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// BoundedCache — a small insertion-ordered LRU used in front of the durable
// review store. Eviction is opt-in: until `enableEviction()` is called the
// cache retains everything (it is the source of truth when no durable store is
// attached); once enabled it never holds more than `cap` entries, evicting the
// least-recently-used, because the durable store can fault an evicted record
// back in. Reads move a key to the most-recently-used end.

export class BoundedCache<V> {
  readonly #map = new Map<string, V>();
  readonly #cap: number;
  #evict = false;

  constructor(cap: number) {
    if (!Number.isInteger(cap) || cap < 1) {
      throw new Error(`BoundedCache cap must be a positive integer, got ${cap}`);
    }
    this.#cap = cap;
  }

  /** Turn on LRU eviction. Safe only once a durable backing store exists. */
  enableEviction(): void {
    this.#evict = true;
    this.#trim();
  }

  get(key: string): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      // LRU touch: move to the most-recently-used end.
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }

  has(key: string): boolean {
    return this.#map.has(key);
  }

  set(key: string, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    this.#trim();
  }

  delete(key: string): void {
    this.#map.delete(key);
  }

  /** Current entry count — exposed for tests and diagnostics. */
  get size(): number {
    return this.#map.size;
  }

  values(): IterableIterator<V> {
    return this.#map.values();
  }

  #trim(): void {
    if (!this.#evict) return;
    while (this.#map.size > this.#cap) {
      const oldest = this.#map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
  }
}

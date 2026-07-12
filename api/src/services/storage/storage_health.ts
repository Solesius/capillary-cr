// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// StorageHealth — a small, observable record of durable-store persistence
// health. celer writes degrade gracefully: a failed write is swallowed so the
// in-memory request path keeps serving, but a *silent* durability loss is
// dangerous. This surfaces those failures (count + last error) so /healthz can
// expose them and operators can alert on them, instead of them living only in a
// log line.

export interface StoragePersistenceError {
  op: string;
  message: string;
  at: string;
}

export interface StorageHealthSnapshot {
  /** Whether a durable backing store is attached (vs. pure in-memory). */
  durable: boolean;
  /** Count of persistence operations that failed since boot. */
  writeFailures: number;
  /** False once any persistence has failed — a signal to alert on. */
  healthy: boolean;
  /** The most recent persistence failure, if any. */
  lastError: StoragePersistenceError | null;
}

export class StorageHealth {
  #durable = false;
  #writeFailures = 0;
  #lastError: StoragePersistenceError | null = null;

  /** Mark that a durable store is backing the repository. */
  markDurable(): void {
    this.#durable = true;
  }

  /** Record (and log) a swallowed persistence failure. Wire as the store onError. */
  recordError(op: string, error: unknown): void {
    this.#writeFailures += 1;
    this.#lastError = {
      op,
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    };
    console.warn(`durable-review-store ${op} failed (${this.#writeFailures} total):`, error);
  }

  snapshot(): StorageHealthSnapshot {
    return {
      durable: this.#durable,
      writeFailures: this.#writeFailures,
      healthy: this.#writeFailures === 0,
      lastError: this.#lastError,
    };
  }
}

/** Process-wide storage health, shared by deps wiring and the health endpoint. */
export const storageHealth = new StorageHealth();

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assert, assertEquals } from "jsr:@std/assert";
import { StorageHealth } from "../src/services/storage/storage_health.ts";

Deno.test("StorageHealth starts healthy and non-durable", () => {
  const health = new StorageHealth();
  const snap = health.snapshot();
  assertEquals(snap.durable, false);
  assertEquals(snap.writeFailures, 0);
  assertEquals(snap.healthy, true);
  assertEquals(snap.lastError, null);
});

Deno.test("StorageHealth.markDurable flips the durable flag", () => {
  const health = new StorageHealth();
  health.markDurable();
  assertEquals(health.snapshot().durable, true);
});

Deno.test("StorageHealth.recordError counts failures and captures the last one", () => {
  const health = new StorageHealth();
  // Silence the intentional console.warn for the failure log.
  const original = console.warn;
  console.warn = () => {};
  try {
    health.recordError("saveRun", new Error("disk full"));
    health.recordError("saveFindings", new Error("io error"));
  } finally {
    console.warn = original;
  }
  const snap = health.snapshot();
  assertEquals(snap.writeFailures, 2);
  assertEquals(snap.healthy, false); // any failure is a signal to alert on
  assert(snap.lastError !== null);
  assertEquals(snap.lastError?.op, "saveFindings");
  assertEquals(snap.lastError?.message, "io error");
  assert(typeof snap.lastError?.at === "string" && snap.lastError.at.length > 0);
});

Deno.test("StorageHealth.recordError stringifies non-Error throwables", () => {
  const health = new StorageHealth();
  const original = console.warn;
  console.warn = () => {};
  try {
    health.recordError("saveDiff", "raw string failure");
  } finally {
    console.warn = original;
  }
  assertEquals(health.snapshot().lastError?.message, "raw string failure");
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assert, assertEquals } from "jsr:@std/assert";
import { createZipArchive } from "../src/services/storage/zip_writer.ts";
import { CelerReviewRepository } from "../src/repositories/review_repository.ts";
import { RetvCdpRunRecord } from "../src/domain/entities.ts";

function makeRecord(runId: string, traceEnabled: boolean, finishedAt: string): RetvCdpRunRecord {
  return {
    runId,
    sessionId: "sess",
    goal: `goal ${runId}`,
    allowedOrigin: "http://localhost:4200",
    stopReason: "goal_achieved",
    functionalTestSucceeded: true,
    goalAchieved: true,
    startedAt: "2024-01-01T00:00:00.000Z",
    finishedAt,
    durationMs: 1000,
    cycleCount: 1,
    milestonesCompleted: 1,
    milestonesTotal: 1,
    percent: 100,
    findings: [],
    summary: "ok",
    report: "# report",
    traceEnabled,
    trace: traceEnabled ? { cycles: [], screenshots: [] } : undefined,
  };
}

Deno.test("should_build_a_valid_zip_archive_with_store_entries", () => {
  const encoder = new TextEncoder();
  const bytes = createZipArchive([
    { name: "report.md", data: encoder.encode("# hello") },
    { name: "run.json", data: encoder.encode("{}") },
  ]);

  // Local file header signature 'PK\x03\x04' at the start.
  assertEquals([bytes[0], bytes[1], bytes[2], bytes[3]], [0x50, 0x4b, 0x03, 0x04]);

  // End-of-central-directory signature 'PK\x05\x06' at the tail.
  const eocd = bytes.subarray(bytes.length - 22);
  assertEquals([eocd[0], eocd[1], eocd[2], eocd[3]], [0x50, 0x4b, 0x05, 0x06]);

  // Total entry count is encoded at EOCD offset 10 (little-endian).
  const view = new DataView(eocd.buffer, eocd.byteOffset);
  assertEquals(view.getUint16(10, true), 2);

  // The stored payload is uncompressed, so file names appear verbatim.
  const text = new TextDecoder().decode(bytes);
  assert(text.includes("report.md"));
  assert(text.includes("run.json"));
  assert(text.includes("# hello"));
});

Deno.test("should_list_retv_runs_most_recent_first_and_omit_trace", async () => {
  const repo = new CelerReviewRepository();
  await repo.saveRetvRun(makeRecord("older", true, "2024-01-01T00:00:00.000Z"));
  await repo.saveRetvRun(makeRecord("newer", false, "2024-02-01T00:00:00.000Z"));

  const list = await repo.listRetvRuns();
  assertEquals(list.map((item) => item.runId), ["newer", "older"]);
  // List items expose metadata + traceEnabled but never the heavy trace payload.
  assertEquals(list[0].traceEnabled, false);
  assertEquals(list[1].traceEnabled, true);
  assert(!("trace" in list[0]));

  const full = await repo.getRetvRun("older");
  assert(full !== null);
  assertEquals(full.trace?.cycles.length, 0);
  assertEquals(await repo.getRetvRun("missing"), null);
});

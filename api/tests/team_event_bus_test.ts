// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assert, assertEquals } from "jsr:@std/assert";
import { RetvCdpRunRecord, ReviewAgentRunRecord, ReviewFinding } from "../src/domain/entities.ts";
import {
  retvRecordToEvent,
  reviewRecordToEvent,
  TeamEvent,
  TeamEventBus,
} from "../src/services/team/event_bus.ts";

function finding(partial: Partial<ReviewFinding>): ReviewFinding {
  return {
    id: partial.id ?? crypto.randomUUID(),
    runId: "run-1",
    severity: partial.severity ?? "medium",
    passName: "Trace",
    filePath: partial.filePath ?? "src/a.ts",
    line: partial.line,
    title: partial.title ?? "finding",
    finding: "detail",
    evidence: [],
    confidence: partial.confidence ?? 0.8,
    ...partial,
  };
}

function reviewRecord(partial: Partial<ReviewAgentRunRecord>): ReviewAgentRunRecord {
  return {
    runId: "run-1",
    pullRequestId: "12",
    repositoryId: "owner/repo",
    title: "PR title",
    verdict: "comment",
    goalAchieved: true,
    stopReason: "verdict_reached",
    startedAt: "2026-07-13T00:00:00Z",
    finishedAt: "2026-07-13T00:05:00Z",
    durationMs: 300_000,
    cycleCount: 6,
    findingCount: 2,
    blockerCount: 0,
    highCount: 1,
    changedFileCount: 3,
    nodeCount: 10,
    edgeCount: 12,
    torusVariance: 0.1,
    findings: [],
    summary: "summary",
    report: "# report",
    traceEnabled: false,
    ...partial,
  };
}

Deno.test("TeamEventBus delivers to every subscriber and isolates a throwing one", () => {
  const bus = new TeamEventBus();
  const seen: string[] = [];
  bus.subscribe(() => {
    throw new Error("broken subscriber");
  });
  bus.subscribe((event) => void seen.push(event.type));
  bus.subscribe(() => Promise.reject(new Error("async broken")));

  bus.emit(retvRecordToEvent(retvRecord()));
  assertEquals(seen, ["retv.completed"]);
});

Deno.test("TeamEventBus unsubscribe detaches the listener", () => {
  const bus = new TeamEventBus();
  const seen: TeamEvent[] = [];
  const detach = bus.subscribe((event) => void seen.push(event));
  detach();
  bus.emit(retvRecordToEvent(retvRecord()));
  assertEquals(seen.length, 0);
  assertEquals(bus.listenerCount, 0);
});

Deno.test("reviewRecordToEvent ranks top findings by severity and caps at five", () => {
  const record = reviewRecord({
    findings: [
      finding({ severity: "low", title: "low-1" }),
      finding({ severity: "blocker", title: "blocker-1" }),
      finding({ severity: "note", title: "note-1" }),
      finding({ severity: "high", title: "high-1" }),
      finding({ severity: "medium", title: "med-1" }),
      finding({ severity: "medium", title: "med-2" }),
      finding({ severity: "high", title: "high-2", confidence: 0.99 }),
    ],
  });
  const event = reviewRecordToEvent(record);
  assertEquals(event.type, "review.completed");
  assertEquals(event.topFindings.length, 5);
  assertEquals(event.topFindings[0].title, "blocker-1");
  // Equal severity orders by confidence descending.
  assertEquals(event.topFindings[1].title, "high-2");
  assert(!event.topFindings.some((f) => f.title === "note-1"));
});

Deno.test("reviewRecordToEvent maps a cancelled stop reason to review.cancelled", () => {
  const event = reviewRecordToEvent(reviewRecord({ stopReason: "cancelled_by_user" }));
  assertEquals(event.type, "review.cancelled");
});

function retvRecord(): RetvCdpRunRecord {
  return {
    runId: "retv-1",
    sessionId: "s-1",
    goal: "verify the version badge",
    allowedOrigin: "http://localhost:7858",
    stopReason: "goal_achieved",
    functionalTestSucceeded: true,
    goalAchieved: true,
    startedAt: "2026-07-13T00:00:00Z",
    finishedAt: "2026-07-13T00:03:00Z",
    durationMs: 180_000,
    cycleCount: 3,
    milestonesCompleted: 2,
    milestonesTotal: 2,
    percent: 100,
    findings: ["one observation"],
    summary: "done",
    report: "# report",
    traceEnabled: true,
    inputTokens: 1000,
    outputTokens: 200,
    totalTokens: 1200,
  };
}

Deno.test("retvRecordToEvent carries the token meter and milestones", () => {
  const event = retvRecordToEvent(retvRecord());
  assertEquals(event.type, "retv.completed");
  assertEquals(event.inputTokens, 1000);
  assertEquals(event.milestonesCompleted, 2);
  assertEquals(event.findings, ["one observation"]);
});

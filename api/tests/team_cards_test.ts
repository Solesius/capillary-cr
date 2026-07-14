// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assert, assertEquals } from "jsr:@std/assert";
import {
  buildSlackPayload,
  buildTeamsPayload,
  buildTestPayload,
  runDeepLink,
} from "../src/services/team/cards.ts";
import { RetvFinishedEvent, ReviewFinishedEvent } from "../src/services/team/event_bus.ts";

const REVIEW_EVENT: ReviewFinishedEvent = {
  type: "review.completed",
  at: "2026-07-13T00:05:00Z",
  runId: "run-abc",
  pullRequestId: "12",
  repositoryId: "owner/repo",
  title: "Fix the flux capacitor",
  verdict: "request_changes",
  goalAchieved: true,
  stopReason: "verdict_reached",
  findingCount: 4,
  blockerCount: 1,
  highCount: 2,
  cycleCount: 7,
  durationMs: 154_000,
  model: "anthropic/claude-sonnet-5",
  inputTokens: 120_000,
  outputTokens: 9_000,
  topFindings: [
    { severity: "blocker", title: "SQL injection in search", filePath: "src/db.ts", line: 42 },
    { severity: "high", title: "unchecked deref", filePath: "src/x.ts" },
  ],
};

Deno.test("slack review card carries verdict, counts, tokens and the deep link", () => {
  const payload = buildSlackPayload(REVIEW_EVENT, {
    publicUrl: "https://cap.example.com",
    detail: "summary",
  });
  const text = JSON.stringify(payload);
  assert(text.includes("request changes"));
  assert(text.includes("4 total · 1 blocker · 2 high"));
  assert(text.includes("120,000"));
  assert(text.includes("https://cap.example.com/?run=run-abc"));
  // summary detail: finding titles never leave the instance.
  assert(!text.includes("SQL injection"));
});

Deno.test("detail=findings includes top finding titles; no publicUrl omits the button", () => {
  const payload = buildSlackPayload(REVIEW_EVENT, { detail: "findings" });
  const text = JSON.stringify(payload);
  assert(text.includes("[BLOCKER] SQL injection in search — src/db.ts:42"));
  assert(!text.includes('"url"'));
});

Deno.test("teams payload is an adaptive card in the message envelope", () => {
  const payload = buildTeamsPayload(REVIEW_EVENT, {
    publicUrl: "https://cap.example.com/",
    detail: "summary",
  }) as {
    type: string;
    attachments: { contentType: string; content: { type: string; actions?: unknown[] } }[];
  };
  assertEquals(payload.type, "message");
  assertEquals(payload.attachments[0].contentType, "application/vnd.microsoft.card.adaptive");
  assertEquals(payload.attachments[0].content.type, "AdaptiveCard");
  assertEquals(payload.attachments[0].content.actions?.length, 1);
  // Trailing slash on the configured public URL never doubles up.
  assert(JSON.stringify(payload).includes("https://cap.example.com/?run=run-abc"));
});

const RETV_EVENT: RetvFinishedEvent = {
  type: "retv.completed",
  at: "2026-07-13T00:03:00Z",
  runId: "retv-9",
  goal: "verify v0.9.2 badge renders in the right rail",
  allowedOrigin: "http://localhost:7858",
  stopReason: "goal_achieved",
  goalAchieved: true,
  functionalTestSucceeded: true,
  cycleCount: 3,
  durationMs: 61_000,
  milestonesCompleted: 2,
  milestonesTotal: 2,
  percent: 100,
  inputTokens: 40_000,
  outputTokens: 2_000,
  findings: ["assertText needed a ref"],
};

Deno.test("retv card reports outcome and milestones with the retvRun deep link", () => {
  const payload = buildSlackPayload(RETV_EVENT, {
    publicUrl: "https://cap.example.com",
    detail: "summary",
  });
  const text = JSON.stringify(payload);
  assert(text.includes("✅ passed"));
  assert(text.includes("2/2 · 100%"));
  assert(text.includes("?retvRun=retv-9"));
  assert(!text.includes("assertText needed a ref"));
});

Deno.test("runDeepLink returns null without a public URL and encodes run ids", () => {
  assertEquals(runDeepLink(undefined, "review", "r1"), null);
  assertEquals(runDeepLink("  ", "review", "r1"), null);
  assertEquals(
    runDeepLink("https://cap.example.com", "review", "run with space"),
    "https://cap.example.com/?run=run%20with%20space",
  );
});

Deno.test("test payloads render per app", () => {
  const slack = buildTestPayload("slack", "#code-reviews") as { text: string };
  assert(slack.text.includes("#code-reviews"));
  const teams = JSON.stringify(buildTestPayload("teams", "#code-reviews"));
  assert(teams.includes("AdaptiveCard"));
  assert(teams.includes("#code-reviews"));
});

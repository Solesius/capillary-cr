// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assert, assertEquals } from "jsr:@std/assert";
import {
  buildCheckChangesPrompt,
  buildCheckChangesReport,
  carryStillPresentFindings,
  guardFollowUpVerdict,
  parseCheckChangesReply,
} from "../src/services/check_changes.ts";
import { ReviewFinding } from "../src/domain/entities.ts";

function finding(id: string, title: string): ReviewFinding {
  return {
    id,
    runId: "run-prior",
    severity: "high",
    passName: "Review",
    filePath: "src/x.ts",
    line: 5,
    title,
    finding: `${title} detail`,
    evidence: ["e"],
    confidence: 0.8,
  };
}

Deno.test("prompt carries prior findings and clamps the delta", () => {
  const prompt = buildCheckChangesPrompt(
    [finding("f1", "bad deref")],
    [
      { path: "src/x.ts", status: "modified", patch: "@@ -1 +1 @@\n+guarded" },
      { path: "big.ts", status: "modified", patch: "x".repeat(100_000) },
    ],
  );
  assert(prompt.includes('"findingId": "f1"'));
  assert(prompt.includes("--- src/x.ts (modified) ---"));
  // Oversized patches clamp; the truncation is announced, never silent.
  assert(prompt.length < 80_000);
});

Deno.test("parse: unknown ids drop, skipped priors come back unverifiable", () => {
  const priors = [finding("f1", "one"), finding("f2", "two")];
  const parsed = parseCheckChangesReply({
    resolutions: [
      { findingId: "f1", status: "fixed", evidence: "hunk adds the guard" },
      { findingId: "ghost", status: "fixed", evidence: "n/a" },
      { findingId: "f1", status: "still_present", evidence: "dup ignored" },
    ],
    newFindings: [
      { severity: "medium", filePath: "src/y.ts", title: "new leak", finding: "detail" },
      { title: "malformed, no file/finding" },
    ],
    verdict: "approve",
    summary: "s",
  }, priors);

  assertEquals(parsed.resolutions.length, 2);
  assertEquals(parsed.resolutions[0], {
    findingId: "f1",
    title: "one",
    status: "fixed",
    evidence: "hunk adds the guard",
  });
  // f2 was never classified: silence is not resolution.
  assertEquals(parsed.resolutions[1].status, "unverifiable");
  assertEquals(parsed.newFindings.length, 1);
});

Deno.test("verdict guard: approve cannot coexist with unresolved or new findings", () => {
  const base = {
    resolutions: [{ findingId: "f1", title: "t", status: "fixed" as const, evidence: "" }],
    newFindings: [],
    verdict: "approve",
    summary: "",
  };
  assertEquals(guardFollowUpVerdict(base), "approve");
  assertEquals(
    guardFollowUpVerdict({
      ...base,
      resolutions: [{ ...base.resolutions[0], status: "still_present" }],
    }),
    "request_changes",
  );
  assertEquals(
    guardFollowUpVerdict({
      ...base,
      newFindings: [{ severity: "low", filePath: "a", title: "t", finding: "f", evidence: [] }],
    }),
    "request_changes",
  );
  // unverifiable is unresolved too — approve stays blocked.
  assertEquals(
    guardFollowUpVerdict({
      ...base,
      resolutions: [{ ...base.resolutions[0], status: "unverifiable" }],
    }),
    "request_changes",
  );
});

Deno.test("report renders the resolution table and new findings", () => {
  const report = buildCheckChangesReport({
    priorRunId: "run-prior",
    baseSha: "aaaaaaaaaaaa",
    headSha: "bbbbbbbbbbbb",
    reply: {
      resolutions: [
        { findingId: "f1", title: "one", status: "fixed", evidence: "guard added" },
        { findingId: "f2", title: "two", status: "still_present", evidence: "untouched" },
      ],
      newFindings: [
        {
          severity: "medium",
          filePath: "src/y.ts",
          line: 9,
          title: "new leak",
          finding: "d",
          evidence: [],
        },
      ],
      verdict: "approve",
      summary: "half done",
    },
    verdict: "request_changes",
    deltaFileCount: 3,
  });
  assert(report.includes("1/2 prior findings fixed · 1 new"));
  assert(report.includes("✅ fixed"));
  assert(report.includes("🛑 still present"));
  assert(report.includes("**[MEDIUM] new leak** — src/y.ts:9"));
  assert(report.includes("aaaaaaa…bbbbbbb"));
});

Deno.test("still-present priors carry into the follow-up with the new runId", () => {
  const priors = [finding("f1", "fixed one"), finding("f2", "lingering")];
  const { findings } = carryStillPresentFindings(priors, [
    { findingId: "f1", title: "fixed one", status: "fixed", evidence: "" },
    { findingId: "f2", title: "lingering", status: "still_present", evidence: "" },
  ], "run-next");
  assertEquals(findings.length, 1);
  assertEquals(findings[0].title, "lingering");
  assertEquals(findings[0].runId, "run-next");
});

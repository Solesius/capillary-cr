// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assertEquals } from "jsr:@std/assert";
import {
  accumulatePassRisk,
  computeReviewProgress,
  explainPassSelection,
  isReviewGoalAchieved,
  type ReviewLoopState,
  selectNextReviewPass,
} from "../src/services/agentic_review_logic.ts";
import { REVIEW_PASSES, toReviewPhase } from "../src/domain/review_phase.ts";

function stateOf(partial: Partial<ReviewLoopState>): ReviewLoopState {
  return {
    coveredPasses: partial.coveredPasses ?? [],
    passRisk: partial.passRisk ?? {},
    findingCount: partial.findingCount ?? 0,
  };
}

Deno.test("should_select_highest_risk_uncovered_pass_first", () => {
  const next = selectNextReviewPass(stateOf({
    passRisk: { Trace: 0.2, Runtime: 0.9, Tests: 0.5 },
  }));
  assertEquals(next, "Runtime");
});

Deno.test("should_break_risk_ties_on_canonical_tcsrct_order", () => {
  const next = selectNextReviewPass(stateOf({
    passRisk: { State: 0.5, Runtime: 0.5 },
  }));
  assertEquals(next, "State");
});

Deno.test("should_skip_already_covered_passes_when_selecting_next", () => {
  const next = selectNextReviewPass(stateOf({
    coveredPasses: ["Runtime"],
    passRisk: { Runtime: 0.9, Trace: 0.4 },
  }));
  assertEquals(next, "Trace");
});

Deno.test("should_return_null_when_every_pass_is_covered", () => {
  const next = selectNextReviewPass(stateOf({
    coveredPasses: [...REVIEW_PASSES],
  }));
  assertEquals(next, null);
});

Deno.test("should_report_goal_achieved_only_when_all_passes_covered", () => {
  assertEquals(isReviewGoalAchieved(["Trace", "Contracts"]), false);
  assertEquals(isReviewGoalAchieved([...REVIEW_PASSES]), true);
});

Deno.test("should_compute_monotonic_percent_from_covered_passes", () => {
  const progress = computeReviewProgress(stateOf({
    coveredPasses: ["Trace", "Contracts", "State"],
    findingCount: 7,
  }));
  assertEquals(progress.coveredPasses, 3);
  assertEquals(progress.totalPasses, 6);
  assertEquals(progress.percent, 50);
  assertEquals(progress.findingCount, 7);
  assertEquals(progress.goalAchieved, false);
});

Deno.test("should_mark_progress_goal_achieved_at_full_coverage", () => {
  const progress = computeReviewProgress(stateOf({
    coveredPasses: [...REVIEW_PASSES],
  }));
  assertEquals(progress.percent, 100);
  assertEquals(progress.goalAchieved, true);
  assertEquals(progress.nextPass, null);
});

Deno.test("should_accumulate_pass_risk_weighted_by_severity_and_confidence", () => {
  const risk = accumulatePassRisk([
    { passName: "Runtime", severity: "blocker", confidence: 1 },
    { passName: "Runtime", severity: "low", confidence: 0.5 },
    { passName: "Trace", severity: "note", confidence: 1 },
    { passName: "Unknown", severity: "blocker", confidence: 1 },
  ]);
  assertEquals(risk.Runtime, 1 + 0.25 * 0.5);
  assertEquals(risk.Trace, 0.1);
  assertEquals(Object.prototype.hasOwnProperty.call(risk, "Unknown"), false);
});

Deno.test("should_explain_pass_selection_with_risk_signal", () => {
  const reason = explainPassSelection("Runtime", stateOf({ passRisk: { Runtime: 0.9 } }));
  assertEquals(reason.includes("Runtime"), true);
  assertEquals(reason.includes("residual risk"), true);
});

Deno.test("should_normalize_suffixed_and_unknown_phases", () => {
  assertEquals(toReviewPhase("tcsrct:pass=Runtime"), "tcsrct");
  assertEquals(toReviewPhase("totally_made_up"), "idle");
  assertEquals(toReviewPhase(undefined), "idle");
});

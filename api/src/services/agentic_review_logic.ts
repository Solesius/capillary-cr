// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import {
  REVIEW_PASSES,
  ReviewPass,
  ReviewProgress,
} from "../domain/review_phase.ts";

/**
 * Immutable snapshot of agentic review state fed to the pure planner.
 * No methods, no mutation: pure data in, pure decision out (Okasaki style).
 */
export interface ReviewLoopState {
  readonly coveredPasses: readonly ReviewPass[];
  /** Accumulated risk weight per pass, used to order surfacing. */
  readonly passRisk: Readonly<Partial<Record<ReviewPass, number>>>;
  readonly findingCount: number;
}

const PASS_INDEX: Readonly<Record<ReviewPass, number>> = REVIEW_PASSES.reduce(
  (acc, pass, index) => ({ ...acc, [pass]: index }),
  {} as Record<ReviewPass, number>,
);

/**
 * Select the next review pass to surface. Picks the highest-risk uncovered
 * pass; ties break on canonical TCSRCT order. Returns null when every pass
 * has been covered (the agentic goal is reached).
 */
export function selectNextReviewPass(state: ReviewLoopState): ReviewPass | null {
  const covered = new Set(state.coveredPasses);
  const candidates = REVIEW_PASSES.filter((pass) => !covered.has(pass));
  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((best, pass) => {
    const bestRisk = state.passRisk[best] ?? 0;
    const passRisk = state.passRisk[pass] ?? 0;
    if (passRisk > bestRisk) {
      return pass;
    }
    if (passRisk === bestRisk && PASS_INDEX[pass] < PASS_INDEX[best]) {
      return pass;
    }
    return best;
  }, candidates[0]);
}

/** Human-readable rationale for surfacing a pass, derived purely from state. */
export function explainPassSelection(pass: ReviewPass, state: ReviewLoopState): string {
  const risk = state.passRisk[pass] ?? 0;
  if (risk > 0) {
    return `${pass} carries the highest residual risk weight (${risk.toFixed(2)}) among uncovered passes.`;
  }
  return `${pass} selected by canonical TCSRCT order; no residual risk signal remaining.`;
}

/** Whether every review pass has been covered. */
export function isReviewGoalAchieved(coveredPasses: readonly ReviewPass[]): boolean {
  const covered = new Set(coveredPasses);
  return REVIEW_PASSES.every((pass) => covered.has(pass));
}

/** Compute monotonic progress from covered passes and accumulated findings. */
export function computeReviewProgress(state: ReviewLoopState): ReviewProgress {
  const total = REVIEW_PASSES.length;
  const coveredCount = new Set(state.coveredPasses).size;
  const goalAchieved = coveredCount >= total;
  return {
    percent: Math.round((coveredCount / total) * 100),
    coveredPasses: coveredCount,
    totalPasses: total,
    findingCount: state.findingCount,
    nextPass: selectNextReviewPass(state),
    goalAchieved,
  };
}

/** Aggregate per-pass risk weights from finding-like records. */
export function accumulatePassRisk(
  findings: readonly { passName: string; confidence: number; severity: string }[],
): Partial<Record<ReviewPass, number>> {
  const severityWeight: Readonly<Record<string, number>> = {
    blocker: 1,
    high: 0.7,
    medium: 0.45,
    low: 0.25,
    note: 0.1,
  };
  const risk: Partial<Record<ReviewPass, number>> = {};
  for (const finding of findings) {
    if (!(REVIEW_PASSES as readonly string[]).includes(finding.passName)) {
      continue;
    }
    const pass = finding.passName as ReviewPass;
    const weight = (severityWeight[finding.severity] ?? 0.1) * clampUnit(finding.confidence);
    risk[pass] = (risk[pass] ?? 0) + weight;
  }
  return risk;
}

function clampUnit(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

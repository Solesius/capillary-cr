// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { ReviewFinding } from "./entities.ts";

/**
 * Canonical, strongly-typed phases of the agentic RETV review loop.
 * Ordered from idle through terminal states; the ordinal is used for
 * monotonic progress comparisons in the frontend stage rail.
 */
export const REVIEW_PHASES = [
  "idle",
  "queued",
  "diff_dag",
  "program_shape",
  "tcsrct",
  "llm_provider",
  "llm_merged",
  "completed",
  "failed",
  "cancelled",
] as const;

export type ReviewPhase = typeof REVIEW_PHASES[number];

export const REVIEW_PHASE_ORDER: Readonly<Record<ReviewPhase, number>> = {
  idle: 0,
  queued: 1,
  diff_dag: 2,
  program_shape: 3,
  tcsrct: 4,
  llm_provider: 5,
  llm_merged: 6,
  completed: 7,
  failed: 7,
  cancelled: 7,
};

/**
 * INTERNAL analysis rotation for the deterministic baseline machinery only.
 * These names never surface to users, prompts, findings, or reports — the
 * public formalism is the TCSRTC gates. Convert at the boundary with
 * lensToGate().
 */
export const REVIEW_PASSES = [
  "Trace",
  "Contracts",
  "State",
  "Runtime",
  "CodeShape",
  "Tests",
] as const;

export type ReviewPass = typeof REVIEW_PASSES[number];

/**
 * Map an internal analysis lens to the TCSRTC gate its findings belong to.
 * Trace answers "what is actually affected" (Target); Contracts polices
 * boundaries and invariants (Constrain); Tests is Test; the remaining
 * lenses are Review-gate work.
 */
export function lensToGate(lens: string): TcsrtcGate {
  switch (lens.trim().toLowerCase()) {
    case "trace":
      return "Target";
    case "contracts":
      return "Constrain";
    case "tests":
      return "Test";
    default:
      return "Review";
  }
}

/**
 * The six TCSRTC Feature Process gates, in canonical order:
 * Target -> Constrain -> Sanitize -> Review -> Test -> Confirm.
 * The tool-driven review agent walks these gates; live pipeline progress is
 * reported as gates covered. Distinct from REVIEW_PASSES, which are the
 * TCSRCT analysis lenses individual findings are categorized under.
 */
export const TCSRTC_GATES = [
  "Target",
  "Constrain",
  "Sanitize",
  "Review",
  "Test",
  "Confirm",
] as const;

export type TcsrtcGate = typeof TCSRTC_GATES[number];

/** Normalize a raw planner phase string to a canonical TCSRTC gate. */
export function toTcsrtcGate(raw: unknown): TcsrtcGate {
  const value = String(raw ?? "").trim().toLowerCase();
  const match = TCSRTC_GATES.find((gate) => gate.toLowerCase() === value);
  return match ?? "Review";
}

export interface ReviewProgress {
  readonly percent: number;
  readonly coveredPasses: number;
  readonly totalPasses: number;
  readonly findingCount: number;
  readonly nextPass: ReviewPass | null;
  readonly goalAchieved: boolean;
}

export interface ReviewCycleSummary {
  readonly cycle: number;
  readonly pass: ReviewPass;
  readonly reason: string;
  readonly findingCount: number;
  readonly progress: ReviewProgress;
}

export interface ReviewRunResult {
  readonly runId: string;
  readonly pullRequestId: string;
  readonly phase: ReviewPhase;
  readonly stopReason: string;
  readonly goalAchieved: boolean;
  readonly findingCount: number;
  readonly blockerCount: number;
  readonly highCount: number;
  readonly progress: ReviewProgress;
  readonly cycles: readonly ReviewCycleSummary[];
}

/**
 * Typed event union streamed over SSE for a live agentic review run.
 * Mirrors the RETV CDP agent's event contract so the frontend can
 * consume both streams with the same discriminated-union pattern.
 */
export type ReviewRunEvent =
  | { type: "run_start"; runId: string; pullRequestId: string; phase: ReviewPhase }
  | { type: "phase"; phase: ReviewPhase; detail?: string }
  | { type: "graph"; nodeCount: number; edgeCount: number }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  // Tool-driven TCSRTC review-agent events (mirror the CDP agent contract).
  // `thinking` carries the planner's per-cycle reasoning verbatim — this is
  // the narrative the live output renders, not a synthetic status string.
  | { type: "thinking"; cycle: number; gate: TcsrtcGate; text: string }
  | { type: "tool"; cycle: number; tool: string; ok: boolean; summary: string; reason?: string }
  | { type: "finding"; finding: ReviewFinding }
  | {
    type: "cycle";
    cycle: number;
    gate: TcsrtcGate;
    toolCount: number;
    findingCount: number;
    gatesCovered: number;
    gatesTotal: number;
    /** Cumulative model tokens consumed by the run so far (0 if unreported). */
    tokensUsed: number;
    /** Cumulative input (prompt) tokens. */
    inputTokens: number;
    /** Cumulative output (completion) tokens. */
    outputTokens: number;
  }
  | { type: "report"; markdown: string }
  | { type: "done"; result: ReviewRunResult };

/** Normalize a raw phase string (possibly suffixed with `:detail`) to a typed phase. */
export function toReviewPhase(raw: string | undefined | null): ReviewPhase {
  if (!raw) {
    return "idle";
  }
  const head = raw.split(":")[0]?.trim().toLowerCase() ?? "";
  return (REVIEW_PHASES as readonly string[]).includes(head) ? (head as ReviewPhase) : "idle";
}

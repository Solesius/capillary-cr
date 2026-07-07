// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { REVIEW_PHASE_ORDER, ReviewPhase, ReviewStageKey } from "../models";

export function isBeginEnabled(pullRequestSelected: boolean): boolean {
  return pullRequestSelected;
}

export function areCardsDisabled(repositorySelected: boolean): boolean {
  return !repositorySelected;
}

export function shouldShowGraphSummary(webglAvailable: boolean): boolean {
  return !webglAvailable;
}

export function shouldShowCleanState(findingCount: number): boolean {
  return findingCount === 0;
}

export interface ReviewStageState {
  readonly key: ReviewStageKey;
  readonly label: string;
  readonly active: boolean;
  readonly done: boolean;
}

interface ReviewStageDef {
  readonly key: ReviewStageKey;
  readonly label: string;
  readonly entersAt: ReviewPhase;
}

const REVIEW_STAGE_DEFS: readonly ReviewStageDef[] = [
  { key: "queued", label: "Queued", entersAt: "queued" },
  { key: "graph", label: "Graph", entersAt: "diff_dag" },
  { key: "wetting", label: "Wetting", entersAt: "program_shape" },
  { key: "tcsrct", label: "TCSRCT", entersAt: "tcsrct" },
  { key: "llm", label: "LLM", entersAt: "llm_provider" },
  { key: "complete", label: "Complete", entersAt: "completed" },
];

/**
 * Pure projection of a typed review phase onto the coarse UI stage rail.
 * A stage is `active` when the pipeline is exactly at the phase that enters it,
 * and `done` once the pipeline has advanced past that phase. A `failed` phase
 * leaves every stage inactive (the failure is surfaced separately).
 */
export function computeReviewStages(phase: ReviewPhase): readonly ReviewStageState[] {
  const current = REVIEW_PHASE_ORDER[phase];
  const failed = phase === "failed";
  return REVIEW_STAGE_DEFS.map((stage) => {
    const order = REVIEW_PHASE_ORDER[stage.entersAt];
    return {
      key: stage.key,
      label: stage.label,
      active: !failed && current === order,
      done: current > order,
    };
  });
}


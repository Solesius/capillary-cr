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
  { key: "graph", label: "Change Map", entersAt: "diff_dag" },
  { key: "wetting", label: "Impact", entersAt: "program_shape" },
  { key: "tcsrct", label: "Review", entersAt: "tcsrct" },
  { key: "llm", label: "Report", entersAt: "llm_provider" },
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

/**
 * Count pull requests that are genuinely open from the loaded list. Drafts
 * count as open; closed and merged do not. Defensive on the wire contract: a
 * PR whose `state` is missing (an API/cache that predates the field) counts as
 * open rather than silently zeroing the dashboard stat.
 */
export function countOpenPullRequests(prs: readonly { state?: string }[]): number {
  return prs.filter((pr) => pr.state !== "closed" && pr.state !== "merged").length;
}

/**
 * Whether the Stop button is armed. True when the locally-known run is still
 * in flight, OR — after a refresh, before local run state rehydrates — when
 * the attached server session reports a live run. A failed cancel keeps this
 * true (status stays truthful), so Stop remains armed for the retry.
 */
export function isStopArmed(
  runStatus: string | null,
  attachedSessionActive: boolean,
): boolean {
  if (
    runStatus && runStatus !== "completed" && runStatus !== "cancelled" && runStatus !== "failed"
  ) {
    return true;
  }
  return attachedSessionActive;
}

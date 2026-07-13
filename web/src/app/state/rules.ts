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
/** Unfiltered repo options rendered before "type to search" takes over. */
export const REPO_RENDER_CAP = 100;

/**
 * Window the repository options for the picker. A 1000+ repo org account must
 * not stamp thousands of DOM options into a dropdown nobody scrolls — while
 * unfiltered, render only the first `cap` (the list arrives sorted by last
 * update, so these are the relevant ones) plus the current selection so the
 * <select> value stays valid. Any query lifts the window: filtering already
 * shrinks the list to what the user asked for.
 */
export function windowRepositories<T extends { id: string }>(
  repos: readonly T[],
  hasQuery: boolean,
  selectedId: string | null,
  cap: number = REPO_RENDER_CAP,
): { visible: T[]; hiddenCount: number } {
  if (hasQuery || repos.length <= cap) {
    return { visible: [...repos], hiddenCount: 0 };
  }
  const visible = repos.slice(0, cap);
  const selected = selectedId ? repos.find((repo) => repo.id === selectedId) : undefined;
  if (selected && !visible.some((repo) => repo.id === selected.id)) {
    visible.push(selected);
  }
  return { visible, hiddenCount: repos.length - visible.length };
}

export function isStopArmed(
  runStatus: string | null,
  attachedSessionActive: boolean,
): boolean {
  // A stop is already in flight: pressing Stop again has nothing to add, and
  // an armed button during "Stopping…" reads as the first press not working.
  if (runStatus === "cancelling") {
    return false;
  }
  if (
    runStatus && runStatus !== "completed" && runStatus !== "cancelled" && runStatus !== "failed"
  ) {
    return true;
  }
  return attachedSessionActive;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// event_bus.ts — the single internal bus every team surface subscribes to.
// Agents emit typed events when work finishes or artifacts are published; UI
// notifications, Slack, Teams and future integrations (Jira, digests) are all
// just subscribers. Emission is fire-and-forget and fully isolated: a slow or
// throwing subscriber must never affect the run that emitted, or its peers.

import { RetvCdpRunRecord, ReviewAgentRunRecord } from "../../domain/entities.ts";

/** A code review finished (completed normally or stopped by a user). */
export interface ReviewFinishedEvent {
  type: "review.completed" | "review.cancelled";
  at: string;
  runId: string;
  pullRequestId: string;
  repositoryId: string;
  repositoryFullName?: string;
  title: string;
  verdict: string;
  goalAchieved: boolean;
  stopReason: string;
  findingCount: number;
  blockerCount: number;
  highCount: number;
  cycleCount: number;
  durationMs: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Highest-severity findings first, capped — enough for a channel card. */
  topFindings: { severity: string; title: string; filePath: string; line?: number }[];
}

/** A RetV browser functional-test run finished. */
export interface RetvFinishedEvent {
  type: "retv.completed";
  at: string;
  runId: string;
  goal: string;
  allowedOrigin: string;
  stopReason: string;
  goalAchieved: boolean;
  functionalTestSucceeded: boolean;
  cycleCount: number;
  durationMs: number;
  milestonesCompleted: number;
  milestonesTotal: number;
  percent: number;
  inputTokens?: number;
  outputTokens?: number;
  findings: string[];
}

/** A human published a review artifact to the PR on GitHub. */
export interface FindingPostedEvent {
  type: "finding.posted";
  at: string;
  runId: string;
  pullRequestId: string;
  repositoryId: string;
  repositoryFullName?: string;
  kind: "inline" | "suggestion" | "summary" | "dispatch" | "jira";
  findingId?: string;
  title: string;
  severity?: string;
  url: string;
  /** Member who initiated it (service identity when absent). */
  actor?: string;
}

export type TeamEvent = ReviewFinishedEvent | RetvFinishedEvent | FindingPostedEvent;

export type TeamEventListener = (event: TeamEvent) => void | Promise<void>;

export class TeamEventBus {
  #listeners = new Set<TeamEventListener>();

  /** Register a listener; returns its detach function. */
  subscribe(listener: TeamEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Deliver to every listener. Synchronous throws are swallowed and async
   * rejections observed, so emitting from an agent's hot path is always safe.
   */
  emit(event: TeamEvent): void {
    for (const listener of this.#listeners) {
      try {
        const result = listener(event);
        if (result instanceof Promise) {
          result.catch((error) => {
            console.warn(`team event listener failed for ${event.type}:`, error);
          });
        }
      } catch (error) {
        console.warn(`team event listener failed for ${event.type}:`, error);
      }
    }
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}

/** Process-wide bus (same pattern as storageHealth): services emit, deps wires subscribers. */
export const teamBus = new TeamEventBus();

const TOP_FINDINGS_LIMIT = 5;
const SEVERITY_RANK: Record<string, number> = { blocker: 0, high: 1, medium: 2, low: 3, note: 4 };

/** Map a persisted review run record onto the bus event it represents. */
export function reviewRecordToEvent(record: ReviewAgentRunRecord): ReviewFinishedEvent {
  const topFindings = [...record.findings]
    .sort((a, b) =>
      (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
      (b.confidence ?? 0) - (a.confidence ?? 0)
    )
    .slice(0, TOP_FINDINGS_LIMIT)
    .map((finding) => ({
      severity: finding.severity,
      title: finding.title,
      filePath: finding.filePath,
      line: finding.line,
    }));
  return {
    type: record.stopReason.toLowerCase().includes("cancel")
      ? "review.cancelled"
      : "review.completed",
    at: record.finishedAt,
    runId: record.runId,
    pullRequestId: record.pullRequestId,
    repositoryId: record.repositoryId,
    repositoryFullName: record.repositoryFullName,
    title: record.title,
    verdict: record.verdict,
    goalAchieved: record.goalAchieved,
    stopReason: record.stopReason,
    findingCount: record.findingCount,
    blockerCount: record.blockerCount,
    highCount: record.highCount,
    cycleCount: record.cycleCount,
    durationMs: record.durationMs,
    model: record.model,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    topFindings,
  };
}

/** Map a persisted RetV run record onto the bus event it represents. */
export function retvRecordToEvent(record: RetvCdpRunRecord): RetvFinishedEvent {
  return {
    type: "retv.completed",
    at: record.finishedAt,
    runId: record.runId,
    goal: record.goal,
    allowedOrigin: record.allowedOrigin,
    stopReason: record.stopReason,
    goalAchieved: record.goalAchieved,
    functionalTestSucceeded: record.functionalTestSucceeded,
    cycleCount: record.cycleCount,
    durationMs: record.durationMs,
    milestonesCompleted: record.milestonesCompleted,
    milestonesTotal: record.milestonesTotal,
    percent: record.percent,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    findings: record.findings,
  };
}

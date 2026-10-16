// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// team/gitlab.ts — GitLab's half of the team integrations:
//   * commit statuses — the merge-box ✓/✗ (GitHub's check runs, checks.ts)
//   * the merge-request webhook — MR opened → auto-queue a review
//
// GitLab has no app installation: statuses post with the server token, and
// the webhook is verified by the shared secret GitLab sends in X-Gitlab-Token.

import { timingSafeEqual } from "node:crypto";
import { gitlabRepositoryId, sourceOf } from "../code_host.ts";
import { type ReviewFinishedEvent, type TeamEvent, TeamEventBus } from "./event_bus.ts";

export type CommitStatusState = "success" | "failed" | "canceled";

export interface CommitStatusPayload {
  state: CommitStatusState;
  name: string;
  description: string;
  target_url?: string;
}

/**
 * Pure builder: one review event → the commit status GitLab receives. GitLab
 * has no "neutral", so a comment verdict passes (success) and only
 * request_changes fails — the same merge-box outcome as GitHub's check run.
 */
export function buildCommitStatus(event: ReviewFinishedEvent, deepLink: string | null): CommitStatusPayload {
  const cancelled = event.type === "review.cancelled";
  const state: CommitStatusState = cancelled
    ? "canceled"
    : event.verdict === "request_changes"
    ? "failed"
    : "success";
  const description = cancelled
    ? `Stopped after ${event.cycleCount} cycles`
    : `${event.verdict.replace("_", " ")} — ${event.findingCount} finding${
      event.findingCount === 1 ? "" : "s"
    } (${event.blockerCount} blocker, ${event.highCount} high)`;
  // GitLab truncates long descriptions; keep the summary line only.
  return { state, name: "Capillary review", description: description.slice(0, 255), ...(deepLink ? { target_url: deepLink } : {}) };
}

export interface CommitStatusSink {
  configured(): boolean;
  setCommitStatus(repositoryId: string, sha: string, status: CommitStatusPayload): Promise<void>;
}

export interface CommitStatusPublisherDeps {
  gitlab: CommitStatusSink;
  /** PR head sha for the event (from the catalog). */
  headSha: (repositoryId: string, pullRequestId: string) => Promise<string | null>;
  deepLink: (runId: string) => string | null;
  /** CAPILLARY_CHECKS=0 disables, as for GitHub check runs. */
  enabled?: boolean;
}

/** Publishes finished GitLab reviews as commit statuses on the MR head. */
export class CommitStatusPublisher {
  #deps: CommitStatusPublisherDeps;

  constructor(deps: CommitStatusPublisherDeps) {
    this.#deps = deps;
  }

  start(bus: TeamEventBus): () => void {
    return bus.subscribe((event) => this.#onEvent(event));
  }

  async #onEvent(event: TeamEvent): Promise<void> {
    if (event.type !== "review.completed" && event.type !== "review.cancelled") return;
    if (sourceOf(event.repositoryId) !== "gitlab") return;
    if (this.#deps.enabled === false || !this.#deps.gitlab.configured()) return;
    try {
      const sha = await this.#deps.headSha(event.repositoryId, event.pullRequestId);
      if (!sha) return;
      await this.#deps.gitlab.setCommitStatus(
        event.repositoryId,
        sha,
        buildCommitStatus(event, this.#deps.deepLink(event.runId)),
      );
    } catch (error) {
      console.warn("gitlab commit status publish failed:", error instanceof Error ? error.message : error);
    }
  }
}

/** Constant-time check of GitLab's X-Gitlab-Token against the configured secret. */
export function verifyGitlabWebhookToken(secret: string | undefined, header: string | null): boolean {
  if (!secret || !header) return false;
  const expected = Buffer.from(secret);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

interface MergeRequestHookPayload {
  object_kind?: string;
  project?: { id?: number };
  object_attributes?: { iid?: number; action?: string; draft?: boolean; work_in_progress?: boolean };
  changes?: { draft?: { previous?: boolean; current?: boolean } };
}

/**
 * The review a merge-request hook asks for, or null. Opened, reopened, and
 * draft → ready qualify; drafts and every other action do not.
 */
export function mergeRequestToReview(raw: string): { repositoryId: string; pullRequestId: string } | null {
  let payload: MergeRequestHookPayload;
  try {
    payload = JSON.parse(raw) as MergeRequestHookPayload;
  } catch {
    return null;
  }
  const attributes = payload.object_attributes;
  if (payload.object_kind !== "merge_request" || !attributes || !payload.project?.id || !attributes.iid) {
    return null;
  }
  const draft = attributes.draft ?? attributes.work_in_progress ?? false;
  const markedReady = payload.changes?.draft?.previous === true && payload.changes.draft.current === false;
  const qualifies = attributes.action === "open" || attributes.action === "reopen" ||
    (attributes.action === "update" && markedReady);
  if (!qualifies || draft) {
    return null;
  }
  return { repositoryId: gitlabRepositoryId(payload.project.id), pullRequestId: String(attributes.iid) };
}

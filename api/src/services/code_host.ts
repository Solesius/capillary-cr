// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// code_host.ts — the code-host contract the review pipeline runs on, and the
// router that serves GitHub and GitLab through it.
//
// Every repository id names its host: GitHub ids are GitHub's numeric ids;
// GitLab ids are `gitlab-<project id>`. The two can never collide, so routing
// is a pure function of the id and no caller needs to know which host it has.

import { AppError } from "../domain/errors.ts";
import type { DiffFile, GitHubRepository, PullRequest, RiskHint, SourceKind } from "../domain/entities.ts";

export const GITLAB_ID_PREFIX = "gitlab-";

export type PullRequestStateFilter = "open" | "closed";

/** One risk scale for every host: churn plus a per-file weight. */
export function deriveRiskHint(additions: number, deletions: number, changedFiles: number): RiskHint {
  const magnitude = additions + deletions + changedFiles * 8;
  if (magnitude >= 900) return "critical";
  if (magnitude >= 350) return "high";
  if (magnitude >= 160) return "medium";
  if (magnitude > 0) return "low";
  return "unknown";
}

export const sourceOf = (repositoryId: string): SourceKind =>
  repositoryId.startsWith(GITLAB_ID_PREFIX) ? "gitlab" : "github";

/** `gitlab-123` → `123` (the GitLab project id). */
export const gitlabProjectId = (repositoryId: string): string => repositoryId.slice(GITLAB_ID_PREFIX.length);

export const gitlabRepositoryId = (projectId: number | string): string => `${GITLAB_ID_PREFIX}${projectId}`;

export interface CompareFile {
  path: string;
  status: string;
  patch?: string;
}

export interface PostOptions {
  /** Team mode: post as a connected member (GitHub only; GitLab posts as the server token). */
  asToken?: string;
}

/** What the review pipeline, posting routes, CLI and MCP need from a code host. */
export interface CodeHost {
  listRepositories(refresh?: boolean): Promise<GitHubRepository[]>;
  lookupRepositories(query: string): Promise<GitHubRepository[]>;
  listPullRequests(repositoryId: string, stateFilter?: PullRequestStateFilter): Promise<PullRequest[]>;
  getPullRequest(repositoryId: string, pullRequestId: string): Promise<PullRequest>;
  getPullRequestDiff(repositoryId: string, pullRequestId: string): Promise<DiffFile[]>;
  getRepoFileContent(repositoryId: string, ref: string, path: string): Promise<string | null>;
  compareCommits(repositoryId: string, baseSha: string, headSha: string): Promise<CompareFile[]>;
  postPullRequestComment(
    repositoryId: string,
    pullRequestId: string,
    body: string,
    options?: PostOptions,
  ): Promise<{ htmlUrl: string }>;
  postPullRequestInlineComment(
    repositoryId: string,
    pullRequestId: string,
    input: { path: string; line: number; body: string },
    options?: PostOptions,
  ): Promise<{ htmlUrl: string }>;
  postPullRequestSuggestion(
    repositoryId: string,
    pullRequestId: string,
    input: { path: string; startLine: number; endLine: number; code: string; note: string },
    options?: PostOptions,
  ): Promise<{ htmlUrl: string }>;
  createRepositoryIssue(
    repositoryId: string,
    input: { title: string; body: string; labels?: string[]; assignees?: string[] },
    options?: PostOptions,
  ): Promise<{ htmlUrl: string; number: number; assigned: boolean }>;
}

/** A host that may be switched off (GitLab without a token). */
export interface OptionalCodeHost extends CodeHost {
  configured(): boolean;
}

/**
 * Serves every CodeHost call from the host the repository id names (every
 * method is async, so an unroutable id is a rejection, never a sync throw). Catalog
 * calls (list/lookup) merge both hosts; one host failing does not hide the
 * other, and only when every enabled host fails does the first error surface.
 */
export class CodeHostRouter implements CodeHost {
  readonly #github: CodeHost;
  readonly #gitlab: OptionalCodeHost | null;

  constructor(github: CodeHost, gitlab: OptionalCodeHost | null) {
    this.#github = github;
    this.#gitlab = gitlab;
  }

  host(repositoryId: string): CodeHost {
    if (sourceOf(repositoryId) === "gitlab") {
      if (!this.#gitlab?.configured()) {
        throw new AppError("gitlab_not_configured", 409, "gitlab_not_configured");
      }
      return this.#gitlab;
    }
    return this.#github;
  }

  listRepositories(refresh = false): Promise<GitHubRepository[]> {
    return this.#merge((host) => host.listRepositories(refresh));
  }

  lookupRepositories(query: string): Promise<GitHubRepository[]> {
    return this.#merge((host) => host.lookupRepositories(query));
  }

  async listPullRequests(repositoryId: string, stateFilter?: PullRequestStateFilter) {
    return await this.host(repositoryId).listPullRequests(repositoryId, stateFilter);
  }

  async getPullRequest(repositoryId: string, pullRequestId: string) {
    return await this.host(repositoryId).getPullRequest(repositoryId, pullRequestId);
  }

  async getPullRequestDiff(repositoryId: string, pullRequestId: string) {
    return await this.host(repositoryId).getPullRequestDiff(repositoryId, pullRequestId);
  }

  async getRepoFileContent(repositoryId: string, ref: string, path: string) {
    return await this.host(repositoryId).getRepoFileContent(repositoryId, ref, path);
  }

  async compareCommits(repositoryId: string, baseSha: string, headSha: string) {
    return await this.host(repositoryId).compareCommits(repositoryId, baseSha, headSha);
  }

  async postPullRequestComment(repositoryId: string, pullRequestId: string, body: string, options?: PostOptions) {
    return await this.host(repositoryId).postPullRequestComment(repositoryId, pullRequestId, body, options);
  }

  async postPullRequestInlineComment(
    repositoryId: string,
    pullRequestId: string,
    input: { path: string; line: number; body: string },
    options?: PostOptions,
  ) {
    return await this.host(repositoryId).postPullRequestInlineComment(repositoryId, pullRequestId, input, options);
  }

  async postPullRequestSuggestion(
    repositoryId: string,
    pullRequestId: string,
    input: { path: string; startLine: number; endLine: number; code: string; note: string },
    options?: PostOptions,
  ) {
    return await this.host(repositoryId).postPullRequestSuggestion(repositoryId, pullRequestId, input, options);
  }

  async createRepositoryIssue(
    repositoryId: string,
    input: { title: string; body: string; labels?: string[]; assignees?: string[] },
    options?: PostOptions,
  ) {
    return await this.host(repositoryId).createRepositoryIssue(repositoryId, input, options);
  }

  async #merge(call: (host: CodeHost) => Promise<GitHubRepository[]>): Promise<GitHubRepository[]> {
    const hosts: CodeHost[] = [this.#github, ...(this.#gitlab?.configured() ? [this.#gitlab] : [])];
    const settled = await Promise.allSettled(hosts.map(call));
    const lists = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (lists.length === 0) {
      throw (settled[0] as PromiseRejectedResult).reason;
    }
    return lists.flat();
  }
}

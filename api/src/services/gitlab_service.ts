// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// gitlab_service.ts — GitLab as a code host, on equal footing with GitHub.
//
// Implements the CodeHost contract (code_host.ts) on the GitLab REST API v4 with
// a server-side token (CAPILLARY_GITLAB_TOKEN, sent as `PRIVATE-TOKEN`). The base
// URL comes from GITLAB_BASE_URL so self-hosted instances work. Reviews, re-
// reviews, inline findings, suggestions, summary notes and issue dispatch all
// run through here exactly as they do through the GitHub service.
//
// Repository ids are `gitlab-<project id>` so they can never collide with
// GitHub's numeric ids; a merge request's iid is its pull-request id. Merge
// requests and their diffs are written to the shared catalog (the pipeline
// reads them back from there); the project list is cached in memory only,
// because the catalog's repository list belongs to the GitHub source.
//
// Field mapping notes (where GitLab has no direct equivalent):
//   project  -> GitHubRepository: owner = namespace.full_path, fullName =
//               path_with_namespace, privateRepo = visibility !== "public",
//               language is not returned (undefined), openPullRequestCount 0
//               (GitLab's open_issues_count excludes MRs).
//   merge request -> PullRequest: iid is the number/id, headSha = diff_refs.head_sha,
//               state opened/merged/closed (draft honoured). The list carries no
//               line counts, so additions/deletions are 0 and riskHint "unknown"
//               until the diff is fetched (which fills them in).
//   merge request diff -> DiffFile: new_path/old_path, new/deleted/renamed flags
//               map to status, +/- line counts come from the hunk text.
//   inline comment -> MR discussion with a text position; context lines carry
//               both old_line and new_line, added lines new_line only.
//   suggestion -> ```suggestion:-N+0 anchored on the last replaced line.

import type {
  DiffFile,
  DiffFileStatus,
  GitHubIdentity,
  GitHubRepository,
  PullRequest,
} from "../domain/entities.ts";
import { AppError } from "../domain/errors.ts";
import { enforceDefensiveInput, enforceTextBody } from "../lib/validation.ts";
import type { ReviewRepository } from "../repositories/review_repository.ts";
import {
  type CompareFile,
  deriveRiskHint,
  gitlabProjectId,
  gitlabRepositoryId,
  type OptionalCodeHost,
  type PullRequestStateFilter,
  sourceOf,
} from "./code_host.ts";

export interface GitLabConfig {
  /** Instance origin, optionally with a path prefix. Blank → https://gitlab.com. */
  baseUrl?: string | null;
  /** Personal, project or group access token. Server environment only. */
  token?: string | null;
}

/** The catalog slice GitLab writes merge requests and diffs into. */
export type GitLabCatalog = Pick<
  ReviewRepository,
  "replacePullRequests" | "upsertPullRequest" | "savePullRequestDiff" | "getPullRequestDiff"
>;

const DEFAULT_BASE_URL = "https://gitlab.com";
const PAGE_SIZE = 100;
// Loop guard only (10k items), never a product limit.
const PAGE_LOOP_GUARD = 100;
// Same delta cap the GitHub compare path applies before marking truncation.
const COMPARE_FILE_CAP = 300;
const CAPILLARY_LINK = "[Capillary](https://github.com/Solesius/capillary-cr)";

interface GitLabUserDto {
  id: number;
  username: string;
  name?: string | null;
  avatar_url?: string | null;
}

interface GitLabProjectDto {
  id: number;
  name: string;
  path_with_namespace: string;
  namespace?: { full_path?: string; path?: string };
  default_branch?: string | null;
  visibility?: string;
  web_url: string;
}

interface GitLabDiffRefs {
  base_sha?: string | null;
  head_sha?: string | null;
  start_sha?: string | null;
}

interface GitLabMergeRequestDto {
  iid: number;
  project_id: number;
  title: string;
  state: "opened" | "closed" | "locked" | "merged";
  draft?: boolean;
  work_in_progress?: boolean;
  author: { username: string };
  source_branch: string;
  target_branch: string;
  sha?: string | null;
  diff_refs?: GitLabDiffRefs | null;
  web_url: string;
  created_at: string;
  updated_at: string;
  /** A string in GitLab's API; large MRs report "1000+". */
  changes_count?: string | null;
}

interface GitLabMergeRequestDiffDto {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  generated_file?: boolean;
  /** Hunks only (no ---/+++ headers), as GitLab returns them. */
  diff: string;
}

// --- pure mapping ------------------------------------------------------------

/**
 * Validate and normalize a GitLab base URL. Blank means gitlab.com. Remote hosts
 * must use https (the token travels in a header); plain http is allowed only for
 * loopback so a local dev instance still works. Returns null when unusable.
 */
export function normalizeGitlabBaseUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return null;
  }
  return url.href.replace(/\/+$/, "");
}

/** Map a GitLab HTTP failure onto a stable AppError code (mirrors github_request_failed). */
export function gitlabHttpError(status: number): AppError {
  if (status === 401) {
    return new AppError("gitlab_auth_failed", 401, "gitlab_auth_failed");
  }
  if (status === 403) {
    return new AppError("gitlab_forbidden", 403, "gitlab_forbidden");
  }
  if (status === 404) {
    return new AppError("gitlab_not_found", 404, "gitlab_not_found");
  }
  const mapped = status >= 500 ? 502 : status;
  return new AppError("gitlab_request_failed", mapped, "gitlab_request_failed");
}

export function mergeRequestState(mr: GitLabMergeRequestDto): PullRequest["state"] {
  if (mr.state === "merged") {
    return "merged";
  }
  if (mr.state === "opened") {
    return (mr.draft ?? mr.work_in_progress) ? "draft" : "open";
  }
  return "closed";
}

/** Count +/- lines in a hunk body. Hunk headers (@@) and context lines are skipped. */
export function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

/**
 * Where a new-file line sits in a unified diff, as a GitLab text position:
 * an added line has only `new_line`; a context line needs both `old_line` and
 * `new_line` or GitLab rejects the discussion. A line outside every hunk falls
 * back to `new_line` alone (GitLab will say whether it accepts it).
 */
export function diffLinePosition(patch: string | undefined, newLine: number): { old_line?: number; new_line: number } {
  let oldCursor = 0;
  let newCursor = 0;
  // GitLab hunks end with a newline; its trailing "" is not a context line.
  for (const line of (patch ?? "").replace(/\n$/, "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldCursor = Number(hunk[1]);
      newCursor = Number(hunk[2]);
      continue;
    }
    if (line.startsWith("+")) {
      if (newCursor === newLine) return { new_line: newLine };
      newCursor += 1;
    } else if (line.startsWith("-")) {
      oldCursor += 1;
    } else if (line.startsWith(" ") || line === "") {
      if (newCursor === newLine) return { old_line: oldCursor, new_line: newLine };
      oldCursor += 1;
      newCursor += 1;
    }
  }
  return { new_line: newLine };
}

function diffStatus(file: GitLabMergeRequestDiffDto): DiffFileStatus {
  if (file.new_file) {
    return "added";
  }
  if (file.deleted_file) {
    return "deleted";
  }
  if (file.renamed_file) {
    return "renamed";
  }
  return "modified";
}

/** GitHub's compare vocabulary, which the follow-up review prompt expects. */
function compareStatus(file: GitLabMergeRequestDiffDto): string {
  if (file.new_file) return "added";
  if (file.deleted_file) return "removed";
  if (file.renamed_file) return "renamed";
  return "modified";
}

export function toRepository(project: GitLabProjectDto): GitHubRepository {
  return {
    id: gitlabRepositoryId(project.id),
    source: "gitlab",
    owner: project.namespace?.full_path ?? project.namespace?.path ?? "",
    name: project.name,
    fullName: project.path_with_namespace,
    defaultBranch: project.default_branch ?? "",
    privateRepo: project.visibility !== "public",
    htmlUrl: project.web_url,
    language: undefined,
    openPullRequestCount: 0,
  };
}

export function toPullRequest(mr: GitLabMergeRequestDto): PullRequest {
  return {
    id: String(mr.iid),
    repositoryId: gitlabRepositoryId(mr.project_id),
    number: mr.iid,
    title: mr.title,
    author: mr.author.username,
    sourceBranch: mr.source_branch,
    headSha: mr.diff_refs?.head_sha || mr.sha || undefined,
    targetBranch: mr.target_branch,
    state: mergeRequestState(mr),
    htmlUrl: mr.web_url,
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    changedFileCount: Number.parseInt(mr.changes_count ?? "", 10) || 0,
    additions: 0,
    deletions: 0,
    riskHint: "unknown",
  };
}

export function toDiffFile(file: GitLabMergeRequestDiffDto): DiffFile {
  const { additions, deletions } = countDiffLines(file.diff);
  const path = file.new_path;
  return {
    path,
    previousPath: file.renamed_file ? file.old_path : undefined,
    status: diffStatus(file),
    additions,
    deletions,
    patch: file.diff || undefined,
    language: path.split(".").at(-1),
    // Same path rules as the GitHub source, so review grouping stays consistent.
    isTest: /(^|\/)(test|tests|__tests__)\//i.test(path),
    isConfig: /(^|\/)(\.github|config|configs)\//i.test(path),
    isGenerated: file.generated_file === true || /(^|\/)dist\//i.test(path) || path.endsWith(".min.js"),
  };
}

/** A 1-based file line, or a 400 — never NaN/Infinity in a GitLab position. */
function lineNumber(value: number): number {
  if (!Number.isFinite(value)) {
    throw new AppError("invalid_line", 400, "invalid_line");
  }
  return Math.max(1, Math.floor(value));
}

/** A GitLab suggestion replacing `startLine..endLine`, anchored on `endLine`. */
export function suggestionBody(input: { startLine: number; endLine: number; code: string; note: string }): string {
  const above = Math.max(0, input.endLine - input.startLine);
  return `${input.note.trim()}\n\n\`\`\`suggestion:-${above}+0\n${input.code.replace(/\n$/, "")}\n\`\`\`` +
    `\n\n<sub>Suggested by ${CAPILLARY_LINK}</sub>`;
}

// --- service -----------------------------------------------------------------

export class GitLabService implements OptionalCodeHost {
  readonly #baseUrl: string | null;
  readonly #token: string | null;
  readonly #catalog: GitLabCatalog | null;
  readonly #fetcher: typeof fetch;
  #projects: GitHubRepository[] = [];
  #identity: GitHubIdentity | null = null;

  constructor(config: GitLabConfig, catalog: GitLabCatalog | null = null, fetcher: typeof fetch = fetch) {
    this.#baseUrl = normalizeGitlabBaseUrl(config.baseUrl);
    this.#token = config.token?.trim() || null;
    this.#catalog = catalog;
    this.#fetcher = fetcher;
  }

  /** A token is set. (A bad base URL still counts: calls then fail loudly with 503.) */
  configured(): boolean {
    return this.#token !== null;
  }

  /** Identity behind the configured token (GET /user). */
  async getIdentity(): Promise<GitHubIdentity> {
    const user = await this.#getJson<GitLabUserDto>("/user");
    this.#identity = {
      id: String(user.id),
      login: user.username,
      displayName: user.name || undefined,
      avatarUrl: user.avatar_url || undefined,
      connected: true,
    };
    return this.#identity;
  }

  /**
   * Whether the token authenticates — the login gate's GitLab half. A success
   * is remembered; a failure is retried on the next request.
   */
  async isConnected(): Promise<boolean> {
    if (this.#identity) return true;
    if (!this.configured()) return false;
    try {
      await this.getIdentity();
      return true;
    } catch {
      return false;
    }
  }

  // --- catalog ---------------------------------------------------------------

  /** Every project the token is a member of, most recently active first. */
  async listRepositories(refresh = false): Promise<GitHubRepository[]> {
    if (!refresh && this.#projects.length > 0) {
      return this.#projects;
    }
    const projects = await this.#getAllPages<GitLabProjectDto>("/projects", {
      membership: "true",
      order_by: "last_activity_at",
      sort: "desc",
    });
    this.#projects = projects.map(toRepository);
    return this.#projects;
  }

  /** `group/project` fetches that project; a bare name searches the token's projects. */
  async lookupRepositories(query: string): Promise<GitHubRepository[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    if (trimmed.includes("/")) {
      enforceDefensiveInput(trimmed, "repository_path");
      try {
        return [toRepository(await this.#getJson<GitLabProjectDto>(`/projects/${encodeURIComponent(trimmed)}`))];
      } catch (error) {
        // Only "no such project" is an empty result; auth and transport errors surface.
        if (error instanceof AppError && error.code === "gitlab_not_found") return [];
        throw error;
      }
    }
    const search = new URLSearchParams({ search: trimmed, membership: "true", per_page: "10" });
    return (await this.#getJson<GitLabProjectDto[]>(`/projects?${search}`)).map(toRepository);
  }

  async listPullRequests(repositoryId: string, stateFilter: PullRequestStateFilter = "open"): Promise<PullRequest[]> {
    const project = this.#project(repositoryId);
    const mergeRequests = await this.#getAllPages<GitLabMergeRequestDto>(
      `/projects/${project}/merge_requests`,
      { state: stateFilter === "closed" ? "closed" : "opened", order_by: "updated_at" },
    );
    const mapped = mergeRequests.map(toPullRequest);
    await this.#catalog?.replacePullRequests(repositoryId, mapped);
    return mapped;
  }

  async getPullRequest(repositoryId: string, pullRequestId: string): Promise<PullRequest> {
    const mapped = toPullRequest(await this.#mergeRequest(repositoryId, pullRequestId));
    await this.#catalog?.upsertPullRequest(mapped);
    return mapped;
  }

  /**
   * Changed files with unified hunks (paginated), saved to the catalog. The
   * merge request's line counts and risk hint are filled in from the diff,
   * since GitLab's MR objects carry neither.
   */
  async getPullRequestDiff(repositoryId: string, pullRequestId: string): Promise<DiffFile[]> {
    const project = this.#project(repositoryId);
    const iid = this.#parseIid(pullRequestId);
    const files = (await this.#getAllPages<GitLabMergeRequestDiffDto>(
      `/projects/${project}/merge_requests/${iid}/diffs`,
    )).map(toDiffFile);
    if (!this.#catalog) {
      return files;
    }
    await this.#catalog.savePullRequestDiff(repositoryId, pullRequestId, files);
    const pull = toPullRequest(await this.#mergeRequest(repositoryId, pullRequestId));
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    await this.#catalog.upsertPullRequest({
      ...pull,
      additions,
      deletions,
      changedFileCount: files.length,
      riskHint: deriveRiskHint(additions, deletions, files.length),
    });
    return files;
  }

  /**
   * Raw file content at a ref (branch, tag or sha). Graceful like the GitHub
   * source: any failure resolves to null so the agent falls back to the patch.
   */
  async getRepoFileContent(repositoryId: string, ref: string, path: string): Promise<string | null> {
    const normalizedPath = path.replace(/^\/+/, "").trim();
    const safeRef = ref.trim();
    if (!normalizedPath || normalizedPath.split("/").includes("..") || !safeRef) {
      return null;
    }
    try {
      const response = await this.#request(
        "GET",
        `/projects/${this.#project(repositoryId)}/repository/files/${encodeURIComponent(normalizedPath)}/raw` +
          `?ref=${encodeURIComponent(safeRef)}`,
      );
      return await response.text();
    } catch {
      return null;
    }
  }

  /** The delta between two commits — the feed for "check changes" follow-up reviews. */
  async compareCommits(repositoryId: string, baseSha: string, headSha: string): Promise<CompareFile[]> {
    if (!/^[0-9a-f]{7,40}$/i.test(baseSha) || !/^[0-9a-f]{7,40}$/i.test(headSha)) {
      throw new AppError("invalid_commit_sha", 400, "invalid_commit_sha");
    }
    const search = new URLSearchParams({ from: baseSha, to: headSha });
    const dto = await this.#getJson<{ diffs?: GitLabMergeRequestDiffDto[] }>(
      `/projects/${this.#project(repositoryId)}/repository/compare?${search}`,
    );
    const diffs = dto.diffs ?? [];
    const files: CompareFile[] = diffs.slice(0, COMPARE_FILE_CAP).map((file) => ({
      path: file.new_path,
      status: compareStatus(file),
      patch: file.diff || undefined,
    }));
    if (diffs.length > COMPARE_FILE_CAP) {
      files.push({
        path: `(delta truncated at ${COMPARE_FILE_CAP} files — compare cap; review the merge request directly)`,
        status: "truncated",
      });
    }
    return files;
  }

  // --- posting ---------------------------------------------------------------

  /** A note on the merge request's overview thread. */
  async postPullRequestComment(repositoryId: string, pullRequestId: string, body: string): Promise<{ htmlUrl: string }> {
    enforceTextBody(body, "comment_body");
    const mr = await this.#mergeRequest(repositoryId, pullRequestId);
    const note = await this.#send<{ id?: number }>(
      "POST",
      `/projects/${this.#project(repositoryId)}/merge_requests/${mr.iid}/notes`,
      { body },
      "gitlab_comment_failed",
    );
    return { htmlUrl: note.id ? `${mr.web_url}#note_${note.id}` : mr.web_url };
  }

  /** A diff discussion on one line of the merge request's head version. */
  async postPullRequestInlineComment(
    repositoryId: string,
    pullRequestId: string,
    input: { path: string; line: number; body: string },
  ): Promise<{ htmlUrl: string }> {
    enforceDefensiveInput(input.path, "comment_path");
    enforceTextBody(input.body, "comment_body");
    return await this.#postDiscussion(
      repositoryId,
      pullRequestId,
      input.path,
      lineNumber(input.line),
      `${input.body}\n\n<sub>Flagged by ${CAPILLARY_LINK}</sub>`,
      "gitlab_inline_comment_failed",
    );
  }

  /** A committable GitLab suggestion ("Apply suggestion") on the given lines. */
  async postPullRequestSuggestion(
    repositoryId: string,
    pullRequestId: string,
    input: { path: string; startLine: number; endLine: number; code: string; note: string },
  ): Promise<{ htmlUrl: string }> {
    enforceDefensiveInput(input.path, "suggestion_path");
    const startLine = lineNumber(input.startLine);
    const endLine = Math.max(startLine, lineNumber(input.endLine));
    return await this.#postDiscussion(
      repositoryId,
      pullRequestId,
      input.path,
      endLine,
      suggestionBody({ startLine, endLine, code: input.code, note: input.note }),
      "gitlab_suggestion_failed",
    );
  }

  /**
   * Create a project issue (dispatch-to-coding-agent). Assignment is best effort
   * after the issue exists, by username → user id; a refusal never loses the issue.
   */
  async createRepositoryIssue(
    repositoryId: string,
    input: { title: string; body: string; labels?: string[]; assignees?: string[] },
  ): Promise<{ htmlUrl: string; number: number; assigned: boolean }> {
    enforceTextBody(input.body, "issue_body");
    const project = this.#project(repositoryId);
    const issue = await this.#send<{ iid?: number; web_url?: string }>(
      "POST",
      `/projects/${project}/issues`,
      {
        title: input.title.slice(0, 250),
        description: input.body,
        ...(input.labels?.length ? { labels: input.labels.join(",") } : {}),
      },
      "gitlab_issue_failed",
    );
    const result = { htmlUrl: String(issue.web_url ?? ""), number: Number(issue.iid ?? 0), assigned: false };
    if (!input.assignees?.length || !result.number) {
      return result;
    }
    try {
      const ids: number[] = [];
      for (const username of input.assignees) {
        const users = await this.#getJson<{ id: number }[]>(`/users?${new URLSearchParams({ username })}`);
        if (users[0]) ids.push(users[0].id);
      }
      if (ids.length > 0) {
        await this.#send("PUT", `/projects/${project}/issues/${result.number}`, { assignee_ids: ids }, "gitlab_issue_failed");
        result.assigned = true;
      }
    } catch {
      // Assignment is advisory; the issue stands.
    }
    return result;
  }

  /** Set the Capillary commit status on a sha (the merge-box ✓/✗; team/gitlab.ts). */
  async setCommitStatus(
    repositoryId: string,
    sha: string,
    status: { state: string; name: string; description: string; target_url?: string },
  ): Promise<void> {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      throw new AppError("invalid_commit_sha", 400, "invalid_commit_sha");
    }
    await this.#send("POST", `/projects/${this.#project(repositoryId)}/statuses/${sha}`, status, "gitlab_status_failed");
  }

  // --- internals -------------------------------------------------------------

  async #postDiscussion(
    repositoryId: string,
    pullRequestId: string,
    path: string,
    line: number,
    body: string,
    failureCode: string,
  ): Promise<{ htmlUrl: string }> {
    const project = this.#project(repositoryId);
    const mr = await this.#mergeRequest(repositoryId, pullRequestId);
    const refs = mr.diff_refs;
    if (!refs?.head_sha || !refs.base_sha || !refs.start_sha) {
      throw new AppError("gitlab_merge_request_head_unknown", 409, "gitlab_merge_request_head_unknown");
    }
    const file = await this.#diffFile(repositoryId, pullRequestId, path);
    const discussion = await this.#send<{ notes?: { id?: number }[] }>(
      "POST",
      `/projects/${project}/merge_requests/${mr.iid}/discussions`,
      {
        body,
        position: {
          position_type: "text",
          base_sha: refs.base_sha,
          start_sha: refs.start_sha,
          head_sha: refs.head_sha,
          old_path: file?.old_path ?? path,
          new_path: path,
          ...diffLinePosition(file?.diff, line),
        },
      },
      failureCode,
    );
    const noteId = discussion.notes?.[0]?.id;
    return { htmlUrl: noteId ? `${mr.web_url}#note_${noteId}` : mr.web_url };
  }

  /**
   * One file's old path and hunks, for positioning a discussion. Read from the
   * catalog the review already filled, so posting N findings is not N full
   * diff walks; GitLab is asked only when the catalog has nothing.
   */
  async #diffFile(
    repositoryId: string,
    pullRequestId: string,
    path: string,
  ): Promise<{ old_path: string; diff: string } | undefined> {
    const stored = await this.#catalog?.getPullRequestDiff(repositoryId, pullRequestId).catch(() => []) ?? [];
    const hit = stored.find((entry) => entry.path === path);
    if (hit) {
      return { old_path: hit.previousPath ?? hit.path, diff: hit.patch ?? "" };
    }
    const fetched = await this.#getAllPages<GitLabMergeRequestDiffDto>(
      `/projects/${this.#project(repositoryId)}/merge_requests/${this.#parseIid(pullRequestId)}/diffs`,
    );
    return fetched.find((entry) => entry.new_path === path);
  }

  async #mergeRequest(repositoryId: string, pullRequestId: string): Promise<GitLabMergeRequestDto> {
    return await this.#getJson<GitLabMergeRequestDto>(
      `/projects/${this.#project(repositoryId)}/merge_requests/${this.#parseIid(pullRequestId)}`,
    );
  }

  /** `gitlab-123` → the URL-safe project id; anything else is not ours. */
  #project(repositoryId: string): string {
    if (sourceOf(repositoryId) !== "gitlab") {
      throw new AppError("not_a_gitlab_repository", 400, "not_a_gitlab_repository");
    }
    const projectId = gitlabProjectId(repositoryId);
    enforceDefensiveInput(projectId, "project_id");
    return encodeURIComponent(projectId);
  }

  #parseIid(iid: string): string {
    if (!/^\d+$/.test(iid)) {
      throw new AppError("invalid_merge_request_id", 400, "invalid_merge_request_id");
    }
    return iid;
  }

  async #getJson<T>(path: string): Promise<T> {
    return await this.#parseJson<T>(await this.#request("GET", path));
  }

  async #send<T>(method: "POST" | "PUT", path: string, body: unknown, failureCode: string): Promise<T> {
    try {
      return await this.#parseJson<T>(await this.#request(method, path, body));
    } catch (error) {
      // Write failures keep GitHub-style operation codes; auth/permission stay specific.
      if (error instanceof AppError && error.code === "gitlab_request_failed") {
        throw new AppError(failureCode, error.status, failureCode);
      }
      throw error;
    }
  }

  /**
   * Parse a 2xx body. An HTML page with a 200 (SSO or proxy login) is a bad
   * response, not a JSON failure to leak as a 500.
   */
  async #parseJson<T>(response: Response): Promise<T> {
    try {
      return await response.json() as T;
    } catch {
      throw new AppError("gitlab_bad_response", 502, "gitlab_bad_response");
    }
  }

  /**
   * Walks `x-next-page` until GitLab reports no further page. Reaching the loop
   * guard while pages remain is an error, never a silently short result: a
   * truncated MR diff must not look complete.
   */
  async #getAllPages<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page += 1) {
      if (page > PAGE_LOOP_GUARD) {
        throw new AppError("gitlab results truncated", 502, "gitlab_result_truncated");
      }
      const search = new URLSearchParams({ ...params, per_page: String(PAGE_SIZE), page: String(page) });
      const response = await this.#request("GET", `${path}?${search.toString()}`);
      items.push(...await this.#parseJson<T[]>(response));
      if (!response.headers.get("x-next-page")) {
        break;
      }
    }
    return items;
  }

  async #request(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<Response> {
    if (!this.#token) {
      throw new AppError("gitlab_token_required", 401, "gitlab_token_required");
    }
    if (!this.#baseUrl) {
      throw new AppError("gitlab_base_url_invalid", 503, "gitlab_base_url_invalid");
    }
    let response: Response;
    try {
      response = await this.#fetcher(`${this.#baseUrl}/api/v4${path}`, {
        method,
        headers: {
          "PRIVATE-TOKEN": this.#token,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new AppError("gitlab_unreachable", 502, "gitlab_unreachable");
    }
    if (!response.ok) {
      throw gitlabHttpError(response.status);
    }
    return response;
  }
}

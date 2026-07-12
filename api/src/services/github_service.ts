// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import {
  DiffFile,
  GitHubIdentity,
  GitHubRepository,
  PullRequest,
  RiskHint,
} from "../domain/entities.ts";
import { AppError, unauthorized } from "../domain/errors.ts";
import { enforceDefensiveInput, enforceTextBody } from "../lib/validation.ts";
import { ReviewRepository } from "../repositories/review_repository.ts";

interface GitHubUserDto {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

interface GitHubRepositoryDto {
  id: number;
  owner: {
    login: string;
  };
  name: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  html_url: string;
  language: string | null;
  open_issues_count: number;
}

interface GitHubPullRequestListDto {
  number: number;
  title: string;
  user: {
    login: string;
  };
  head: {
    ref: string;
    sha?: string;
  };
  base: {
    ref: string;
  };
  state: "open" | "closed";
  draft: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
}

interface GitHubPullRequestDetailDto extends GitHubPullRequestListDto {
  additions: number;
  deletions: number;
  changed_files: number;
  merged_at?: string | null;
}

interface GitHubContentItemDto {
  type: string;
  encoding?: string;
  content?: string;
}

type GitHubContentDto = GitHubContentItemDto | GitHubContentItemDto[];

interface GitHubPullRequestFileDto {
  filename: string;
  previous_filename?: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied";
  additions: number;
  deletions: number;
  patch?: string;
}

interface GitHubOAuthTokenDto {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

const DEFAULT_GITHUB_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

interface GitHubDeviceCodeDto {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

interface PendingGithubOAuthState {
  webOrigin: string;
  redirectUri: string;
  createdAtMs: number;
}

interface PendingGithubDeviceSession {
  webOrigin: string;
  deviceCode: string;
  createdAtMs: number;
  expiresAtMs: number;
  intervalSeconds: number;
}

type GithubOAuthStartResult =
  | {
    mode: "web";
    authorizeUrl: string;
    state: string;
    expiresAt: string;
    redirectUri: string;
  }
  | {
    mode: "device";
    authorizeUrl: string;
    sessionId: string;
    userCode: string;
    expiresAt: string;
    intervalSeconds: number;
  };

type GithubOAuthPollResult =
  | {
    status: "pending";
    retryAfterSeconds: number;
  }
  | {
    status: "connected";
    identity: GitHubIdentity;
  }
  | {
    status: "failed";
    message: string;
  };

type PullRequestStateFilter = "open" | "closed";

/**
 * GitHub returns a JSON error body ({message, errors[]}) explaining WHY a
 * write failed (missing scope, invalid line range, etc). Surface it so the UI
 * shows the real cause instead of an opaque code.
 */
async function describeGithubError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as {
      message?: string;
      errors?: Array<{ message?: string; field?: string }>;
    };
    const detail = payload.errors?.map((e) => e.message || e.field).filter(Boolean).join("; ");
    const base = payload.message ? `${fallback}: ${payload.message}` : fallback;
    return detail ? `${base} (${detail})` : base;
  } catch {
    return `${fallback} (HTTP ${response.status})`;
  }
}

export class GitHubOakService {
  readonly #pendingOAuthStates = new Map<string, PendingGithubOAuthState>();
  readonly #pendingDeviceSessions = new Map<string, PendingGithubDeviceSession>();
  readonly #oauthStateTtlMs = 10 * 60 * 1000;

  constructor(
    private readonly repository: ReviewRepository,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async beginGithubOAuth(apiOrigin: string, webOrigin?: string): Promise<GithubOAuthStartResult> {
    const oauthClientId = this.requireGithubOAuthClientId();
    const normalizedWebOrigin = this.normalizeWebOrigin(webOrigin);
    const now = Date.now();

    this.pruneExpiredOAuthStates(now);
    this.pruneExpiredDeviceSessions(now);

    // No client secret: use OAuth device flow (browser popup + polling), as used in some local setups.
    if (!this.hasGithubOAuthClientSecret()) {
      const deviceStart = await this.requestGithubDeviceCode(oauthClientId);
      const sessionId = crypto.randomUUID().replace(/-/g, "");
      const expiresInSeconds = Math.max(60, Number(deviceStart.expires_in || 600));
      const intervalSeconds = Math.max(2, Number(deviceStart.interval || 5));
      const expiresAtMs = now + expiresInSeconds * 1000;

      const verificationUri = String(
        deviceStart.verification_uri || "https://github.com/login/device",
      );
      const userCode = String(deviceStart.user_code || "");

      // Only a server-provided verification_uri_complete may carry the code
      // (RFC 8628). GitHub doesn't send one and ignores a hand-rolled
      // ?user_code= param, so otherwise open the bare verification page —
      // the UI surfaces the code for the user to type.
      const authorizeUrl = String(deviceStart.verification_uri_complete || verificationUri);

      if (!String(deviceStart.device_code || "").trim() || !userCode.trim()) {
        throw new AppError(
          "github_oauth_device_start_failed",
          502,
          "github_oauth_device_start_failed",
        );
      }

      this.#pendingDeviceSessions.set(sessionId, {
        webOrigin: normalizedWebOrigin,
        deviceCode: String(deviceStart.device_code),
        createdAtMs: now,
        expiresAtMs,
        intervalSeconds,
      });

      return {
        mode: "device",
        authorizeUrl,
        sessionId,
        userCode,
        expiresAt: new Date(expiresAtMs).toISOString(),
        intervalSeconds,
      };
    }

    const redirectUri = this.resolveGithubOAuthRedirectUri(apiOrigin);
    const state = crypto.randomUUID().replace(/-/g, "");
    this.#pendingOAuthStates.set(state, {
      webOrigin: normalizedWebOrigin,
      redirectUri,
      createdAtMs: now,
    });

    const scopes = Deno.env.get("GITHUB_OAUTH_SCOPES")?.trim() ||
      "repo workflow read:org read:user";
    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", oauthClientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", scopes);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("allow_signup", "false");

    return {
      mode: "web",
      authorizeUrl: authorizeUrl.toString(),
      state,
      expiresAt: new Date(now + this.#oauthStateTtlMs).toISOString(),
      redirectUri,
    };
  }

  async pollGithubOAuthSession(sessionId: string): Promise<GithubOAuthPollResult> {
    enforceDefensiveInput(sessionId, "github_oauth_session_id");
    const pending = this.#pendingDeviceSessions.get(sessionId);
    if (!pending) {
      throw new AppError("github_oauth_session_not_found", 404, "github_oauth_session_not_found");
    }

    const now = Date.now();
    if (now > pending.expiresAtMs) {
      this.#pendingDeviceSessions.delete(sessionId);
      return {
        status: "failed",
        message: "github_oauth_session_expired",
      };
    }

    const exchanged = await this.exchangeGithubDeviceCode(pending.deviceCode);
    if (exchanged.status === "pending") {
      return {
        status: "pending",
        retryAfterSeconds: Math.max(
          pending.intervalSeconds,
          exchanged.retryAfterSeconds || pending.intervalSeconds,
        ),
      };
    }
    if (exchanged.status === "failed") {
      this.#pendingDeviceSessions.delete(sessionId);
      return exchanged;
    }

    this.#pendingDeviceSessions.delete(sessionId);
    const identity = await this.connectGithub("valid", exchanged.accessToken);
    return {
      status: "connected",
      identity,
    };
  }

  peekGithubOAuthWebOrigin(state: string): string | null {
    const pending = this.#pendingOAuthStates.get(state);
    if (!pending) {
      return null;
    }

    const expired = Date.now() - pending.createdAtMs > this.#oauthStateTtlMs;
    if (expired) {
      this.#pendingOAuthStates.delete(state);
      return null;
    }

    return pending.webOrigin;
  }

  async completeGithubOAuth(
    code: string,
    state: string,
  ): Promise<{ identity: GitHubIdentity; webOrigin: string }> {
    enforceDefensiveInput(code, "github_oauth_code");
    enforceDefensiveInput(state, "github_oauth_state");

    const pending = this.#pendingOAuthStates.get(state);
    if (!pending) {
      throw new AppError("github_oauth_state_invalid", 401, "github_oauth_state_invalid");
    }

    const expired = Date.now() - pending.createdAtMs > this.#oauthStateTtlMs;
    this.#pendingOAuthStates.delete(state);
    if (expired) {
      throw new AppError("github_oauth_state_expired", 401, "github_oauth_state_expired");
    }

    const token = await this.exchangeGithubOAuthCode(code, pending.redirectUri);
    const identity = await this.connectGithub("valid", token);
    return {
      identity,
      webOrigin: pending.webOrigin,
    };
  }

  async connectGithub(oauthState = "valid", token?: string): Promise<GitHubIdentity> {
    if (oauthState !== "valid") {
      throw new AppError("invalid_oauth_state", 401, "invalid_oauth_state");
    }

    const resolvedToken = token?.trim() ||
      Deno.env.get("CAPILLARY_GITHUB_TOKEN")?.trim() ||
      Deno.env.get("GITHUB_TOKEN")?.trim() ||
      null;
    if (!resolvedToken) {
      throw new AppError("github_token_required", 401, "github_token_required");
    }

    try {
      const user = await this.githubGet<GitHubUserDto>("/user", resolvedToken);
      const identity: GitHubIdentity = {
        id: String(user.id),
        login: user.login,
        displayName: user.name || undefined,
        avatarUrl: user.avatar_url || undefined,
        connected: true,
      };

      await this.repository.setGithubToken(resolvedToken);
      await this.repository.setIdentity(identity);
      return identity;
    } catch {
      throw new AppError("github_auth_failed", 401, "github_auth_failed");
    }
  }

  async listRepositories(): Promise<GitHubRepository[]> {
    await this.requireAuthenticatedIdentity();
    const token = await this.requireGithubToken();

    const repositories = await this.fetchAllUserRepositories(token);

    const mapped = repositories.map((repo) => ({
      id: String(repo.id),
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      privateRepo: repo.private,
      htmlUrl: repo.html_url,
      language: repo.language || undefined,
      openPullRequestCount: repo.open_issues_count || 0,
    }));

    await this.repository.replaceRepositories(mapped);
    return mapped;
  }

  async listPullRequests(
    repositoryId: string,
    stateFilter: PullRequestStateFilter = "open",
  ): Promise<PullRequest[]> {
    await this.requireAuthenticatedIdentity();
    this.validateRepositoryId(repositoryId);
    this.validateStateFilter(stateFilter);

    const token = await this.requireGithubToken();

    const repo = await this.findRepositoryById(repositoryId, token);
    const pulls = await this.githubGet<GitHubPullRequestListDto[]>(
      `/repos/${repo.owner.login}/${repo.name}/pulls?state=${stateFilter}&per_page=50`,
      token,
    );

    const pullDetails = await Promise.all(
      pulls.map((pull) =>
        this.githubGet<GitHubPullRequestDetailDto>(
          `/repos/${repo.owner.login}/${repo.name}/pulls/${pull.number}`,
          token,
        )
      ),
    );

    const mapped = pullDetails.map((pull) => ({
      id: String(pull.number),
      repositoryId,
      number: pull.number,
      title: pull.title,
      author: pull.user.login,
      sourceBranch: pull.head.ref,
      headSha: pull.head.sha,
      targetBranch: pull.base.ref,
      state: pull.merged_at
        ? "merged"
        : pull.draft
        ? "draft"
        : (pull.state as PullRequest["state"]),
      htmlUrl: pull.html_url,
      createdAt: pull.created_at,
      updatedAt: pull.updated_at,
      changedFileCount: pull.changed_files,
      additions: pull.additions,
      deletions: pull.deletions,
      riskHint: this.deriveRiskHint(pull.additions, pull.deletions, pull.changed_files),
    }));

    await this.repository.replacePullRequests(repositoryId, mapped);
    return mapped;
  }

  async getPullRequest(repositoryId: string, pullRequestId: string): Promise<PullRequest> {
    await this.requireAuthenticatedIdentity();
    this.validateRepositoryId(repositoryId);
    this.validatePullRequestId(pullRequestId);

    const token = await this.requireGithubToken();

    const repo = await this.findRepositoryById(repositoryId, token);
    const pullNumber = Number(pullRequestId);
    if (!Number.isFinite(pullNumber)) {
      throw new AppError("invalid_pull_request_id", 400, "invalid_pull_request_id");
    }

    const pull = await this.githubGet<GitHubPullRequestDetailDto>(
      `/repos/${repo.owner.login}/${repo.name}/pulls/${pullNumber}`,
      token,
    );

    const mapped: PullRequest = {
      id: String(pull.number),
      repositoryId,
      number: pull.number,
      title: pull.title,
      author: pull.user.login,
      sourceBranch: pull.head.ref,
      headSha: pull.head.sha,
      targetBranch: pull.base.ref,
      state: pull.draft ? "draft" : (pull.state as PullRequest["state"]),
      htmlUrl: pull.html_url,
      createdAt: pull.created_at,
      updatedAt: pull.updated_at,
      changedFileCount: pull.changed_files,
      additions: pull.additions,
      deletions: pull.deletions,
      riskHint: this.deriveRiskHint(pull.additions, pull.deletions, pull.changed_files),
    };

    await this.repository.upsertPullRequest(mapped);
    return mapped;
  }

  async getPullRequestDiff(repositoryId: string, pullRequestId: string): Promise<DiffFile[]> {
    await this.requireAuthenticatedIdentity();
    this.validateRepositoryId(repositoryId);
    this.validatePullRequestId(pullRequestId);

    const token = await this.requireGithubToken();

    const repo = await this.findRepositoryById(repositoryId, token);
    const pullNumber = Number(pullRequestId);
    if (!Number.isFinite(pullNumber)) {
      throw new AppError("invalid_pull_request_id", 400, "invalid_pull_request_id");
    }

    const files: GitHubPullRequestFileDto[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const chunk = await this.githubGet<GitHubPullRequestFileDto[]>(
        `/repos/${repo.owner.login}/${repo.name}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
        token,
      );
      files.push(...chunk);
      if (chunk.length < 100) {
        break;
      }
    }

    const mapped = files.map((file) => {
      const status: DiffFile["status"] = file.status === "removed" ? "deleted" : file.status;

      return {
        path: file.filename,
        previousPath: file.previous_filename,
        status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch,
        language: file.filename.split(".").at(-1),
        isTest: /(^|\/)(test|tests|__tests__)\//i.test(file.filename),
        isConfig: /(^|\/)(\.github|config|configs)\//i.test(file.filename),
        isGenerated: /(^|\/)dist\//i.test(file.filename) || file.filename.endsWith(".min.js"),
      };
    });

    await this.repository.savePullRequestDiff(repositoryId, pullRequestId, mapped);
    return mapped;
  }

  /**
   * Read-only fetch of a single repository file at a given ref (branch or sha),
   * via the GitHub Contents API. This powers the review agent's on-demand
   * neighbor/impact lookups. It is intentionally GRACEFUL: any failure (no
   * token, network error, missing file, oversized blob) resolves to null so the
   * agent can fall back to patch-derived content. The path is constrained to a
   * repo-relative location to avoid traversal.
   */
  async getRepoFileContent(
    repositoryId: string,
    ref: string,
    path: string,
  ): Promise<string | null> {
    const token = await this.repository.getGithubToken();
    if (!token) {
      return null;
    }
    const normalizedPath = path.replace(/^\/+/, "").trim();
    if (normalizedPath.length === 0 || normalizedPath.includes("..")) {
      return null;
    }
    const safeRef = encodeURIComponent(ref.trim());
    if (safeRef.length === 0) {
      return null;
    }

    try {
      const repo = await this.findRepositoryById(repositoryId, token);
      const encodedPath = normalizedPath.split("/").map(encodeURIComponent).join("/");
      const dto = await this.githubGet<GitHubContentDto>(
        `/repos/${repo.owner.login}/${repo.name}/contents/${encodedPath}?ref=${safeRef}`,
        token,
      );

      if (Array.isArray(dto) || dto.type !== "file" || typeof dto.content !== "string") {
        return null;
      }
      if (dto.encoding !== "base64") {
        return dto.content;
      }
      const binary = atob(dto.content.replace(/\n/g, ""));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }

  /** Post a comment on the PR's conversation thread; returns the comment URL. */
  async postPullRequestComment(
    repositoryId: string,
    pullRequestId: string,
    body: string,
  ): Promise<{ htmlUrl: string }> {
    this.validateRepositoryId(repositoryId);
    this.validatePullRequestId(pullRequestId);
    enforceTextBody(body, "comment_body");
    const token = await this.requireGithubToken();

    const pull = await this.getPullRequest(repositoryId, pullRequestId);
    const repo = await this.findRepositoryById(repositoryId, token);

    const response = await this.fetcher(
      `https://api.github.com/repos/${repo.full_name}/issues/${pull.number}/comments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ body }),
      },
    );

    if (!response.ok) {
      throw new AppError(
        "github_comment_failed",
        response.status,
        await describeGithubError(response, "github_comment_failed"),
      );
    }

    const dto = await response.json() as { html_url?: string };
    return { htmlUrl: String(dto.html_url || pull.htmlUrl) };
  }

  /**
   * Post a plain inline review comment on a specific line of a file in the PR
   * head commit. Works for any finding (no code fix required) — the actionable
   * counterpart to the full-report summary comment.
   */
  async postPullRequestInlineComment(
    repositoryId: string,
    pullRequestId: string,
    input: { path: string; line: number; body: string },
  ): Promise<{ htmlUrl: string }> {
    this.validateRepositoryId(repositoryId);
    this.validatePullRequestId(pullRequestId);
    enforceDefensiveInput(input.path, "comment_path");
    enforceTextBody(input.body, "comment_body");
    const token = await this.requireGithubToken();

    const pull = await this.getPullRequest(repositoryId, pullRequestId);
    const repo = await this.findRepositoryById(repositoryId, token);
    if (!pull.headSha) {
      throw new AppError("github_pull_head_unknown", 409, "github_pull_head_unknown");
    }

    const response = await this.fetcher(
      `https://api.github.com/repos/${repo.full_name}/pulls/${pull.number}/comments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({
          commit_id: pull.headSha,
          path: input.path,
          side: "RIGHT",
          line: Math.max(1, Math.floor(input.line)),
          body: `${input.body}\n\n<sub>Flagged by [Capillary](https://github.com/Solesius/capillary-cr)</sub>`,
        }),
      },
    );

    if (!response.ok) {
      throw new AppError(
        "github_inline_comment_failed",
        response.status,
        await describeGithubError(response, "github_inline_comment_failed"),
      );
    }

    const dto = await response.json() as { html_url?: string };
    return { htmlUrl: String(dto.html_url || pull.htmlUrl) };
  }

  /**
   * Post a committable GitHub suggested change on specific lines of a file in
   * the PR head commit. Human-initiated (one finding at a time). The body is
   * a ```suggestion block GitHub renders with a "Commit suggestion" button.
   */
  async postPullRequestSuggestion(
    repositoryId: string,
    pullRequestId: string,
    input: {
      path: string;
      startLine: number;
      endLine: number;
      code: string;
      note: string;
    },
  ): Promise<{ htmlUrl: string }> {
    this.validateRepositoryId(repositoryId);
    this.validatePullRequestId(pullRequestId);
    enforceDefensiveInput(input.path, "suggestion_path");
    const token = await this.requireGithubToken();

    const pull = await this.getPullRequest(repositoryId, pullRequestId);
    const repo = await this.findRepositoryById(repositoryId, token);
    if (!pull.headSha) {
      throw new AppError("github_pull_head_unknown", 409, "github_pull_head_unknown");
    }

    const startLine = Math.max(1, Math.floor(input.startLine));
    const endLine = Math.max(startLine, Math.floor(input.endLine));
    const body =
      `${input.note.trim()}\n\n\`\`\`suggestion\n${input.code.replace(/\n$/, "")}\n\`\`\`` +
      `\n\n<sub>Suggested by [Capillary](https://github.com/Solesius/capillary-cr)</sub>`;

    // Multi-line suggestions carry start_line; single-line ones omit it.
    const payload: Record<string, unknown> = {
      commit_id: pull.headSha,
      path: input.path,
      side: "RIGHT",
      line: endLine,
      body,
    };
    if (endLine > startLine) {
      payload.start_line = startLine;
      payload.start_side = "RIGHT";
    }

    const response = await this.fetcher(
      `https://api.github.com/repos/${repo.full_name}/pulls/${pull.number}/comments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      throw new AppError(
        "github_suggestion_failed",
        response.status,
        await describeGithubError(response, "github_suggestion_failed"),
      );
    }

    const dto = await response.json() as { html_url?: string };
    return { htmlUrl: String(dto.html_url || pull.htmlUrl) };
  }

  private async findRepositoryById(
    repositoryId: string,
    token: string,
  ): Promise<GitHubRepositoryDto> {
    const repositories = await this.fetchAllUserRepositories(token);

    const repo = repositories.find((item) => String(item.id) === repositoryId);
    if (!repo) {
      throw new AppError("repository_not_found", 404, "repository_not_found");
    }

    return repo;
  }

  // GitHub caps per_page at 100, so accounts that can see more repos than
  // that (org members especially) silently lost everything past the first
  // page. Walk pages until a short page; the page cap bounds worst-case
  // latency for accounts with thousands of visible repos.
  private async fetchAllUserRepositories(token: string): Promise<GitHubRepositoryDto[]> {
    const all: GitHubRepositoryDto[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.githubGet<GitHubRepositoryDto[]>(
        `/user/repos?per_page=100&sort=updated&direction=desc&page=${page}`,
        token,
      );
      all.push(...batch);
      if (batch.length < 100) {
        break;
      }
    }
    return all;
  }

  private async githubGet<T>(path: string, token: string): Promise<T> {
    const response = await this.fetcher(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });

    if (!response.ok) {
      throw new AppError("github_request_failed", response.status, "github_request_failed");
    }

    return response.json();
  }

  private async exchangeGithubOAuthCode(code: string, redirectUri: string): Promise<string> {
    const clientId = this.requireGithubOAuthClientId();
    const clientSecret = this.requireGithubOAuthClientSecret();

    const response = await this.fetcher("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const payload = await response.json().catch(() => null) as GitHubOAuthTokenDto | null;
    if (!response.ok || !payload?.access_token) {
      const description = payload?.error_description || payload?.error || "oauth_exchange_failed";
      throw new AppError("github_oauth_exchange_failed", 401, description);
    }

    return payload.access_token;
  }

  private async requestGithubDeviceCode(clientId: string): Promise<GitHubDeviceCodeDto> {
    const scopes = Deno.env.get("GITHUB_OAUTH_SCOPES")?.trim() || "repo read:org read:user";
    const body = new URLSearchParams({
      client_id: clientId,
      scope: scopes,
    });

    const response = await this.fetcher("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const payload = await response.json().catch(() => null) as GitHubDeviceCodeDto | null;
    if (!response.ok || !payload) {
      const description = payload?.error_description || payload?.error ||
        "github_oauth_device_start_failed";
      throw new AppError("github_oauth_device_start_failed", 502, description);
    }

    return payload;
  }

  private async exchangeGithubDeviceCode(deviceCode: string): Promise<
    | { status: "pending"; retryAfterSeconds?: number }
    | { status: "connected"; accessToken: string }
    | { status: "failed"; message: string }
  > {
    const clientId = this.requireGithubOAuthClientId();
    const body = new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });

    const secret = this.getGithubOAuthClientSecret();
    if (secret) {
      body.set("client_secret", secret);
    }

    const response = await this.fetcher("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const payload = await response.json().catch(() => null) as GitHubOAuthTokenDto | null;
    const error = payload?.error || "";

    if (!response.ok && !payload?.access_token) {
      return {
        status: "failed",
        message: payload?.error_description || error || "github_oauth_exchange_failed",
      };
    }

    if (payload?.access_token) {
      return {
        status: "connected",
        accessToken: payload.access_token,
      };
    }

    if (error === "authorization_pending") {
      return {
        status: "pending",
      };
    }

    if (error === "slow_down") {
      return {
        status: "pending",
        retryAfterSeconds: 10,
      };
    }

    if (error === "expired_token") {
      return {
        status: "failed",
        message: "github_oauth_session_expired",
      };
    }

    if (error === "access_denied") {
      return {
        status: "failed",
        message: "github_oauth_access_denied",
      };
    }

    return {
      status: "failed",
      message: payload?.error_description || error || "github_oauth_exchange_failed",
    };
  }

  private requireGithubOAuthClientId(): string {
    const configuredClientId = Deno.env.get("GITHUB_OAUTH_CLIENT_ID")?.trim();
    if (configuredClientId) {
      return configuredClientId;
    }

    // Mirror IHHI login behavior: provide a built-in Copilot OAuth client id fallback
    // so browser/device auth can start without local OAuth app configuration.
    return DEFAULT_GITHUB_COPILOT_CLIENT_ID;
  }

  private requireGithubOAuthClientSecret(): string {
    const clientSecret = Deno.env.get("GITHUB_OAUTH_CLIENT_SECRET")?.trim();
    if (!clientSecret) {
      throw new AppError("github_oauth_not_configured", 503, "github_oauth_not_configured");
    }
    return clientSecret;
  }

  private getGithubOAuthClientSecret(): string {
    return Deno.env.get("GITHUB_OAUTH_CLIENT_SECRET")?.trim() || "";
  }

  private hasGithubOAuthClientSecret(): boolean {
    return this.getGithubOAuthClientSecret().length > 0;
  }

  private resolveGithubOAuthRedirectUri(apiOrigin: string): string {
    const fromEnv = Deno.env.get("GITHUB_OAUTH_REDIRECT_URI")?.trim();
    if (fromEnv) {
      return fromEnv;
    }

    const normalizedApiOrigin = apiOrigin.replace(/\/+$/, "");
    return `${normalizedApiOrigin}/api/github/oauth/callback`;
  }

  private normalizeWebOrigin(webOrigin?: string): string {
    const candidate = webOrigin?.trim() || Deno.env.get("CORS_ORIGIN")?.trim() ||
      "http://localhost:4200";
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new AppError("invalid_web_origin", 400, "invalid_web_origin");
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new AppError("invalid_web_origin", 400, "invalid_web_origin");
    }

    return parsed.origin;
  }

  private pruneExpiredOAuthStates(nowMs: number): void {
    for (const [state, pending] of this.#pendingOAuthStates.entries()) {
      if (nowMs - pending.createdAtMs > this.#oauthStateTtlMs) {
        this.#pendingOAuthStates.delete(state);
      }
    }
  }

  private pruneExpiredDeviceSessions(nowMs: number): void {
    for (const [sessionId, pending] of this.#pendingDeviceSessions.entries()) {
      if (nowMs > pending.expiresAtMs) {
        this.#pendingDeviceSessions.delete(sessionId);
      }
    }
  }

  private deriveRiskHint(additions: number, deletions: number, changedFiles: number): RiskHint {
    const magnitude = additions + deletions + changedFiles * 8;
    if (magnitude >= 900) {
      return "critical";
    }
    if (magnitude >= 350) {
      return "high";
    }
    if (magnitude >= 160) {
      return "medium";
    }
    if (magnitude > 0) {
      return "low";
    }
    return "unknown";
  }

  private async requireAuthenticatedIdentity(): Promise<void> {
    const identity = await this.repository.getIdentity();
    if (!identity || !identity.connected) {
      throw unauthorized("unauthorized");
    }
  }

  private async requireGithubToken(): Promise<string> {
    const token = await this.repository.getGithubToken();
    if (!token) {
      throw unauthorized("github_token_required");
    }

    return token;
  }

  private validateRepositoryId(value: string): void {
    enforceDefensiveInput(value, "repository_id");
  }

  private validatePullRequestId(value: string): void {
    enforceDefensiveInput(value, "pull_request_id");
  }

  private validateStateFilter(value: string): void {
    if (value !== "open" && value !== "closed") {
      throw new AppError("invalid_state_filter", 400, "invalid_state_filter");
    }
  }
}

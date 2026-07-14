// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { Injectable, signal } from "@angular/core";
import {
  CdpSessionSummary,
  CdpWorkUnitRequest,
  CdpWorkUnitResult,
  ChannelApp,
  ChannelConnectionView,
  ChannelEventToggles,
  NotifyDetail,
  GitHubOAuthPollResponse,
  GitHubOAuthStartResponse,
  GitHubRepository,
  MemberView,
  TeamIntegrationsStatus,
  GraphSnapshotView,
  PullRequest,
  PullRequestDiffFile,
  PullRequestFileContent,
  RetvCdpRunListItem,
  RetvCdpRunRecord,
  RetvCdpRunResult,
  RetvPlannerConfigUpdate,
  RetvPlannerConfigView,
  ReviewAgentRunListItem,
  ReviewAgentRunRecord,
  ReviewChecklistItem,
  ReviewFinding,
  ReviewRun,
  ReviewSessionSummary,
} from "../models";

@Injectable({ providedIn: "root" })
export class ApiClientService {
  private readonly baseUrl = this.resolveBaseUrl();

  /** In-flight HTTP request count — drives the global network loader. */
  readonly inFlight = signal(0);

  getApiOrigin(): string {
    return new URL(this.baseUrl).origin;
  }

  private async tracked<T>(run: () => Promise<T>): Promise<T> {
    this.inFlight.update((n) => n + 1);
    try {
      return await run();
    } finally {
      this.inFlight.update((n) => Math.max(0, n - 1));
    }
  }

  async connectGithub(token?: string): Promise<void> {
    await this.post("/api/github/connect", {
      oauthState: "valid",
      ...(token ? { token } : {}),
    });
  }

  async startGithubOAuth(webOrigin: string): Promise<GitHubOAuthStartResponse> {
    const query = new URLSearchParams({ webOrigin });
    return this.get(`/api/github/oauth/start?${query.toString()}`);
  }

  async pollGithubOAuth(sessionId: string): Promise<GitHubOAuthPollResponse> {
    return this.get(`/api/github/oauth/poll/${sessionId}`);
  }

  async listRepositories(refresh = false): Promise<GitHubRepository[]> {
    return this.get(`/api/github/repositories${refresh ? "?refresh=1" : ""}`);
  }

  /** Direct lookup: "owner/name" exact, bare name via search. */
  async lookupRepositories(name: string): Promise<GitHubRepository[]> {
    return this.get(`/api/github/repositories/lookup?name=${encodeURIComponent(name)}`);
  }

  async listPullRequests(
    repositoryId: string,
    stateFilter: "open" | "closed" = "open",
  ): Promise<PullRequest[]> {
    return this.get(`/api/github/repositories/${repositoryId}/pull-requests?state=${stateFilter}`);
  }

  /** Changed-file map for the explorer tree — served from the cached diff. */
  async getPullRequestDiffFiles(
    repositoryId: string,
    pullRequestId: string,
  ): Promise<PullRequestDiffFile[]> {
    return this.get(`/api/github/repositories/${repositoryId}/pull-requests/${pullRequestId}/diff`);
  }

  /**
   * One file body fetched on click — never in bulk (429 armor). side=head is
   * the PR head; side=base is the target branch (diff view's original pane).
   */
  async getPullRequestFileContent(
    repositoryId: string,
    pullRequestId: string,
    path: string,
    side: "head" | "base" = "head",
  ): Promise<PullRequestFileContent> {
    return this.get(
      `/api/github/repositories/${repositoryId}/pull-requests/${pullRequestId}/file?path=${
        encodeURIComponent(path)
      }&side=${side}`,
    );
  }

  async beginReview(pullRequestId: string, repositoryId: string): Promise<ReviewRun> {
    return this.post("/api/review/runs", { pullRequestId, repositoryId });
  }

  async beginReviewAsync(pullRequestId: string, repositoryId: string): Promise<ReviewRun> {
    return this.post("/api/review/runs/async", { pullRequestId, repositoryId });
  }

  buildReviewStreamUrl(request: {
    pullRequestId: string;
    repositoryId: string;
    maxCycles?: number;
    trace?: boolean;
  }): string {
    const query = new URLSearchParams({
      pullRequestId: request.pullRequestId,
      repositoryId: request.repositoryId,
    });
    if (request.maxCycles !== undefined) {
      query.set("maxCycles", String(request.maxCycles));
    }
    if (request.trace) {
      query.set("trace", "1");
    }
    return `${this.baseUrl}/api/review/runs/stream?${query.toString()}`;
  }

  async getReviewRun(runId: string): Promise<ReviewRun> {
    return this.get(`/api/review/runs/${runId}`);
  }

  async getReviewEvents(runId: string): Promise<{ events: string[] }> {
    return this.get(`/api/review/runs/${runId}/events`);
  }

  async getReviewFindings(runId: string): Promise<{ findings: ReviewFinding[] }> {
    return this.get(`/api/review/runs/${runId}/findings`);
  }

  async getReviewChecklist(runId: string): Promise<{ checklist: ReviewChecklistItem[] }> {
    return this.get(`/api/review/runs/${runId}/checklist`);
  }

  /** Delta re-review: verify prior findings + review only the new commits. */
  async checkChanges(runId: string): Promise<ReviewAgentRunRecord> {
    return this.post(`/api/review/runs/${runId}/check-changes`, {});
  }

  async cancelReview(runId: string): Promise<{ cancelled: boolean }> {
    return this.post(`/api/review/runs/${runId}/cancel`, {});
  }

  async postReviewSummaryToPr(runId: string): Promise<{ posted: boolean; url: string }> {
    return this.post(`/api/review/runs/${runId}/pr-comment`, {});
  }

  async postFindingSuggestion(
    runId: string,
    findingId: string,
  ): Promise<{ posted: boolean; url: string }> {
    return this.post(`/api/review/runs/${runId}/findings/${findingId}/suggestion`, {});
  }

  async postFindingComment(
    runId: string,
    findingId: string,
  ): Promise<{ posted: boolean; url: string }> {
    return this.post(`/api/review/runs/${runId}/findings/${findingId}/comment`, {});
  }

  async createReviewSession(request: {
    pullRequestId: string;
    repositoryId: string;
    maxCycles?: number;
    trace?: boolean;
    suggest?: boolean;
  }): Promise<ReviewSessionSummary> {
    return this.post("/api/review/sessions", request);
  }

  async listReviewSessions(): Promise<ReviewSessionSummary[]> {
    const response = await this.get<{ sessions: ReviewSessionSummary[] }>("/api/review/sessions");
    return response.sessions;
  }

  buildSessionStreamUrl(runId: string): string {
    return `${this.baseUrl}/api/review/sessions/${runId}/stream`;
  }

  async listReviewAgentRuns(): Promise<ReviewAgentRunListItem[]> {
    const response = await this.get<{ runs: ReviewAgentRunListItem[] }>("/api/review/agent/runs");
    return response.runs;
  }

  async getReviewAgentRun(runId: string): Promise<ReviewAgentRunRecord> {
    return this.get(`/api/review/agent/runs/${runId}`);
  }

  buildRetvDriverUrl(runId: string, format: "playwright" | "runsheet"): string {
    return `${this.baseUrl}/api/cdp/retv/runs/${runId}/driver?format=${format}`;
  }

  buildReviewExportUrl(runId: string): string {
    return `${this.baseUrl}/api/review/agent/runs/${runId}/export`;
  }

  async getMarkdown(runId: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/artifacts/${runId}/markdown`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.text();
  }

  async getGraph(runId: string): Promise<GraphSnapshotView> {
    const response = await fetch(`${this.baseUrl}/api/artifacts/${runId}/graph`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    return JSON.parse(text) as GraphSnapshotView;
  }

  async createCdpSession(startUrl = "about:blank", headed = false): Promise<CdpSessionSummary> {
    return this.post("/api/cdp/sessions", { startUrl, headed });
  }

  /** Idempotent visible-browser open: focus if open, relaunch if closed. */
  async openHeadedBrowser(startUrl = "about:blank"): Promise<CdpSessionSummary> {
    return this.post("/api/cdp/browser/open", { startUrl });
  }

  async listCdpSessions(): Promise<CdpSessionSummary[]> {
    return this.get("/api/cdp/sessions");
  }

  async executeCdpWorkUnit(
    sessionId: string,
    request: CdpWorkUnitRequest,
  ): Promise<CdpWorkUnitResult> {
    return this.post(`/api/cdp/sessions/${sessionId}/work-units`, request);
  }

  /** Live stop for an in-flight functional run — the loop lands it in moments. */
  async cancelRetvRun(runId: string): Promise<{ cancelled: boolean }> {
    return this.post(`/api/cdp/retv/runs/${runId}/cancel`, {});
  }

  async runRetvCdpGoalRound(request: {
    goal: string;
    sessionId?: string;
    startUrl?: string;
    maxCycles?: number;
    trace?: boolean;
  }): Promise<RetvCdpRunResult> {
    return this.post("/api/cdp/retv/run", request);
  }

  buildRetvCdpStreamUrl(request: {
    goal: string;
    sessionId?: string;
    startUrl?: string;
    maxCycles?: number;
    maxDurationMs?: number;
    trace?: boolean;
    allowedDomains?: string;
  }): string {
    const query = new URLSearchParams({ goal: request.goal });
    if (request.sessionId) {
      query.set("sessionId", request.sessionId);
    }
    if (request.startUrl) {
      query.set("startUrl", request.startUrl);
    }
    if (request.maxCycles !== undefined) {
      query.set("maxCycles", String(request.maxCycles));
    }
    if (request.maxDurationMs !== undefined) {
      query.set("maxDurationMs", String(request.maxDurationMs));
    }
    if (request.trace) {
      query.set("trace", "1");
    }
    if (request.allowedDomains && request.allowedDomains.trim().length > 0) {
      query.set("allowedDomains", request.allowedDomains.trim());
    }
    return `${this.baseUrl}/api/cdp/retv/run/stream?${query.toString()}`;
  }

  async listRetvRuns(): Promise<RetvCdpRunListItem[]> {
    const response = await this.get<{ runs: RetvCdpRunListItem[] }>("/api/cdp/retv/runs");
    return response.runs;
  }

  async getRetvRun(runId: string): Promise<RetvCdpRunRecord> {
    return this.get(`/api/cdp/retv/runs/${runId}`);
  }

  buildRetvRunExportUrl(runId: string): string {
    return `${this.baseUrl}/api/cdp/retv/runs/${runId}/export`;
  }

  async getRetvPlannerConfig(): Promise<RetvPlannerConfigView> {
    return this.get("/api/cdp/retv/config");
  }

  async setRetvPlannerConfig(request: RetvPlannerConfigUpdate): Promise<RetvPlannerConfigView> {
    return this.post("/api/cdp/retv/config", request);
  }

  async closeCdpSession(sessionId: string): Promise<{ closed: boolean }> {
    const response = await fetch(`${this.baseUrl}/api/cdp/sessions/${sessionId}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw await this.toApiError(response);
    }
    return response.json();
  }

  // --- team member identity + integrations ---------------------------------

  async getTeamMe(): Promise<MemberView> {
    return this.get("/api/team/me");
  }

  async connectMemberGithub(token: string): Promise<MemberView> {
    return this.post("/api/team/me/github", { token });
  }

  async disconnectMemberGithub(): Promise<MemberView> {
    return this.tracked(async () => {
      const response = await fetch(`${this.baseUrl}/api/team/me/github`, { method: "DELETE" });
      if (!response.ok) {
        throw await this.toApiError(response);
      }
      return response.json();
    });
  }

  async getTeamIntegrations(): Promise<TeamIntegrationsStatus> {
    return this.get("/api/team/integrations");
  }

  async getGithubAppManifest(): Promise<{ manifest: Record<string, unknown>; createUrl: string }> {
    return this.get("/api/github/app/manifest");
  }

  async dispatchFinding(runId: string, findingId: string): Promise<{ dispatched: boolean; url: string }> {
    return this.post(`/api/review/runs/${runId}/findings/${findingId}/dispatch`, {});
  }

  async createJiraFromFinding(
    runId: string,
    findingId: string,
  ): Promise<{ created: boolean; key: string; url: string }> {
    return this.post(`/api/review/runs/${runId}/findings/${findingId}/jira`, {});
  }

  // --- team channel connections (webhook URLs only travel to the server) ---

  async listTeamConnections(): Promise<{
    connections: ChannelConnectionView[];
    publicUrlConfigured: boolean;
  }> {
    return this.get("/api/team/connections");
  }

  async createTeamConnection(request: {
    app: ChannelApp;
    label: string;
    webhookUrl: string;
    detail?: NotifyDetail;
  }): Promise<ChannelConnectionView> {
    return this.post("/api/team/connections", request);
  }

  async updateTeamConnection(
    id: string,
    request: {
      label?: string;
      events?: Partial<ChannelEventToggles>;
      detail?: NotifyDetail;
      repoFilter?: string | null;
      enabled?: boolean;
    },
  ): Promise<ChannelConnectionView> {
    return this.tracked(async () => {
      const response = await fetch(`${this.baseUrl}/api/team/connections/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        throw await this.toApiError(response);
      }
      return response.json();
    });
  }

  async deleteTeamConnection(id: string): Promise<{ deleted: boolean }> {
    return this.tracked(async () => {
      const response = await fetch(`${this.baseUrl}/api/team/connections/${id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw await this.toApiError(response);
      }
      return response.json();
    });
  }

  async testTeamConnection(id: string): Promise<{ ok: boolean; error?: string }> {
    const response = await fetch(`${this.baseUrl}/api/team/connections/${id}/test`, {
      method: "POST",
    });
    // 502 carries the delivery failure detail; surface it instead of throwing.
    return response.json();
  }

  private resolveBaseUrl(): string {
    if (typeof window === "undefined") {
      return "http://localhost:8080";
    }

    const { hostname, origin, protocol } = window.location;
    const localhostHost = hostname === "localhost" || hostname === "127.0.0.1";

    if (localhostHost && window.location.port === "4200") {
      return `${protocol}//${hostname}:8080`;
    }

    return origin;
  }

  private get<T>(path: string): Promise<T> {
    return this.tracked(async () => {
      const response = await fetch(`${this.baseUrl}${path}`);
      if (!response.ok) {
        throw await this.toApiError(response);
      }
      return response.json();
    });
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.tracked(async () => {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw await this.toApiError(response);
      }
      return response.json();
    });
  }

  private async toApiError(response: Response): Promise<Error> {
    try {
      const payload = await response.json();
      if (payload?.message) {
        return new Error(payload.message);
      }
    } catch {
      // ignore parse failures and fallback to status text
    }

    return new Error(`HTTP ${response.status}`);
  }
}

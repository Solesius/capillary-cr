// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import {
  DiffFile,
  GitHubIdentity,
  GitHubRepository,
  GraphSnapshot,
  PullRequest,
  RetvCdpRunListItem,
  RetvCdpRunRecord,
  ReviewAgentRunListItem,
  ReviewAgentRunRecord,
  ReviewChecklistItem,
  ReviewFinding,
  ReviewPacket,
  ReviewRun,
} from "../domain/entities.ts";
import { notFound } from "../domain/errors.ts";
import { DurableReviewStore, ReviewStoreSnapshot } from "../services/storage/celer_review_store.ts";

export interface RuntimeLlmConfig {
  providerKind: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface ReviewRepository {
  getIdentity(): GitHubIdentity | null;
  setIdentity(identity: GitHubIdentity): void;
  getGithubToken(): string | null;
  setGithubToken(token: string | null): void;

  replaceRepositories(repositories: GitHubRepository[]): void;
  replacePullRequests(repositoryId: string, pullRequests: PullRequest[]): void;
  upsertPullRequest(pullRequest: PullRequest): void;
  savePullRequestDiff(repositoryId: string, pullRequestId: string, diff: DiffFile[]): void;
  findPullRequestRepositoryId(pullRequestId: string): string | null;

  listRepositories(): GitHubRepository[];
  listPullRequests(repositoryId: string, stateFilter?: "open" | "closed" | "all"): PullRequest[];
  getPullRequest(repositoryId: string, pullRequestId: string): PullRequest;
  getPullRequestDiff(repositoryId: string, pullRequestId: string): DiffFile[];

  createReviewRun(run: ReviewRun): void;
  updateReviewRun(runId: string, mutate: (run: ReviewRun) => ReviewRun): ReviewRun;
  getReviewRun(runId: string): ReviewRun;

  appendReviewEvent(runId: string, event: string): void;
  listReviewEvents(runId: string): string[];

  saveGraphSnapshot(diffDagId: string, snapshot: GraphSnapshot): void;
  
  
  getGraphSnapshot(diffDagId: string): GraphSnapshot;
  findGraphByPullRequest(pullRequestId: string): GraphSnapshot | null;

  saveReviewPacket(packet: ReviewPacket): void;
  getReviewPacket(packetId: string): ReviewPacket;

  saveFindings(runId: string, findings: ReviewFinding[]): void;
  getFindings(runId: string): ReviewFinding[];

  saveChecklist(runId: string, items: ReviewChecklistItem[]): void;
  getChecklist(runId: string): ReviewChecklistItem[];

  saveRetvRun(record: RetvCdpRunRecord): void;
  listRetvRuns(): RetvCdpRunListItem[];
  getRetvRun(runId: string): RetvCdpRunRecord | null;

  saveReviewAgentRun(record: ReviewAgentRunRecord): void;
  listReviewAgentRuns(): ReviewAgentRunListItem[];
  getReviewAgentRun(runId: string): ReviewAgentRunRecord | null;

  setRuntimeLlmConfig(config: RuntimeLlmConfig): void;
  getRuntimeLlmConfig(): RuntimeLlmConfig | null;
}

export class InMemoryReviewRepository implements ReviewRepository {
  #identity: GitHubIdentity | null = null;
  #githubToken: string | null = null;

  #repositories: GitHubRepository[] = [];
  #pullRequests: PullRequest[] = [];
  #diffs = new Map<string, DiffFile[]>();

  #runs = new Map<string, ReviewRun>();
  #runEvents = new Map<string, string[]>();
  #graphs = new Map<string, GraphSnapshot>();
  #packets = new Map<string, ReviewPacket>();
  #findings = new Map<string, ReviewFinding[]>();
  #checklist = new Map<string, ReviewChecklistItem[]>();
  #retvRuns = new Map<string, RetvCdpRunRecord>();
  #reviewAgentRuns = new Map<string, ReviewAgentRunRecord>();
  #runtimeLlmConfig: RuntimeLlmConfig | null = null;
  #durable: DurableReviewStore | null = null;

  /**
   * Attach a durable backing store and replay its snapshot into memory. Safe to
   * call once at boot; subsequent mutations are mirrored through to the store.
   */
  async attachDurableStore(store: DurableReviewStore): Promise<void> {
    this.#rehydrate(await store.loadSnapshot());
    this.#durable = store;
  }

  #rehydrate(snapshot: ReviewStoreSnapshot): void {
    for (const run of snapshot.runs) {
      this.#runs.set(run.id, run);
      if (!this.#runEvents.has(run.id)) {
        this.#runEvents.set(run.id, []);
      }
    }
    for (const [runId, events] of snapshot.events) {
      this.#runEvents.set(runId, events.slice());
    }
    for (const [runId, findings] of snapshot.findings) {
      this.#findings.set(runId, findings.slice());
    }
    for (const packet of snapshot.packets) {
      this.#packets.set(packet.id, packet);
    }
    for (const [diffDagId, graph] of snapshot.graphs) {
      this.#graphs.set(diffDagId, graph);
    }
    for (const [runId, items] of snapshot.checklists) {
      this.#checklist.set(runId, items.slice());
    }
    for (const record of snapshot.retvRuns) {
      this.#retvRuns.set(record.runId, record);
    }
    for (const record of snapshot.reviewAgentRuns) {
      this.#reviewAgentRuns.set(record.runId, record);
    }
  }

  getIdentity(): GitHubIdentity | null {
    return this.#identity;
  }

  setIdentity(identity: GitHubIdentity): void {
    this.#identity = identity;
  }

  getGithubToken(): string | null {
    return this.#githubToken;
  }

  setGithubToken(token: string | null): void {
    this.#githubToken = token;
  }

  replaceRepositories(repositories: GitHubRepository[]): void {
    this.#repositories = repositories.slice();
  }

  replacePullRequests(repositoryId: string, pullRequests: PullRequest[]): void {
    this.#pullRequests = this.#pullRequests.filter((pr) => pr.repositoryId !== repositoryId)
      .concat(pullRequests.map((pr) => ({ ...pr, repositoryId })));
  }

  upsertPullRequest(pullRequest: PullRequest): void {
    const index = this.#pullRequests.findIndex((item) =>
      item.repositoryId === pullRequest.repositoryId && item.id === pullRequest.id
    );

    if (index === -1) {
      this.#pullRequests.push(pullRequest);
      return;
    }

    this.#pullRequests[index] = pullRequest;
  }

  savePullRequestDiff(repositoryId: string, pullRequestId: string, diff: DiffFile[]): void {
    this.#diffs.set(`${repositoryId}:${pullRequestId}`, diff.slice());
  }

  findPullRequestRepositoryId(pullRequestId: string): string | null {
    return this.#pullRequests.find((item) => item.id === pullRequestId)?.repositoryId || null;
  }

  listRepositories(): GitHubRepository[] {
    return this.#repositories.slice();
  }

  listPullRequests(repositoryId: string, stateFilter: "open" | "closed" | "all" = "all"): PullRequest[] {
    return this.#pullRequests.filter((pr) => {
      if (pr.repositoryId !== repositoryId) {
        return false;
      }

      if (stateFilter === "all") {
        return true;
      }

      if (stateFilter === "closed") {
        return pr.state === "closed" || pr.state === "merged";
      }

      return pr.state === "open" || pr.state === "draft";
    });
  }

  getPullRequest(repositoryId: string, pullRequestId: string): PullRequest {
    const pr = this.#pullRequests.find((item) => item.repositoryId === repositoryId && item.id === pullRequestId);
    if (!pr) {
      throw notFound("pull_request_not_found");
    }
    return pr;
  }

  getPullRequestDiff(repositoryId: string, pullRequestId: string): DiffFile[] {
    const key = `${repositoryId}:${pullRequestId}`;
    const diff = this.#diffs.get(key);
    if (!diff) {
      throw notFound("diff_not_found");
    }
    return diff.slice();
  }

  createReviewRun(run: ReviewRun): void {
    this.#runs.set(run.id, run);
    this.#runEvents.set(run.id, []);
    void this.#durable?.saveRun(run);
  }

  updateReviewRun(runId: string, mutate: (run: ReviewRun) => ReviewRun): ReviewRun {
    const current = this.#runs.get(runId);
    if (!current) {
      throw notFound("review_run_not_found");
    }
    const updated = mutate(current);
    this.#runs.set(runId, updated);
    void this.#durable?.saveRun(updated);
    return updated;
  }

  getReviewRun(runId: string): ReviewRun {
    const run = this.#runs.get(runId);
    if (!run) {
      throw notFound("review_run_not_found");
    }
    return run;
  }

  appendReviewEvent(runId: string, event: string): void {
    const events = this.#runEvents.get(runId);
    if (!events) {
      throw notFound("review_run_not_found");
    }
    events.push(event);
    this.#runEvents.set(runId, events);
    void this.#durable?.saveEvents(runId, events);
  }

  listReviewEvents(runId: string): string[] {
    const events = this.#runEvents.get(runId);
    if (!events) {
      throw notFound("review_run_not_found");
    }
    return events.slice();
  }

  saveGraphSnapshot(diffDagId: string, snapshot: GraphSnapshot): void {
    this.#graphs.set(diffDagId, snapshot);
    void this.#durable?.saveGraph(diffDagId, snapshot);
  }

  getGraphSnapshot(diffDagId: string): GraphSnapshot {
    const snapshot = this.#graphs.get(diffDagId);
    if (!snapshot) {
      throw notFound("diff_dag_not_found");
    }
    return snapshot;
  }

  findGraphByPullRequest(pullRequestId: string): GraphSnapshot | null {
    for (const snapshot of this.#graphs.values()) {
      if (snapshot.dag.pullRequestId === pullRequestId) {
        return snapshot;
      }
    }
    return null;
  }

  saveReviewPacket(packet: ReviewPacket): void {
    this.#packets.set(packet.id, packet);
    void this.#durable?.savePacket(packet);
  }

  getReviewPacket(packetId: string): ReviewPacket {
    const packet = this.#packets.get(packetId);
    if (!packet) {
      throw notFound("review_packet_not_found");
    }
    return packet;
  }

  saveFindings(runId: string, findings: ReviewFinding[]): void {
    this.#findings.set(runId, findings);
    void this.#durable?.saveFindings(runId, findings);
  }

  getFindings(runId: string): ReviewFinding[] {
    return (this.#findings.get(runId) || []).slice();
  }

  saveChecklist(runId: string, items: ReviewChecklistItem[]): void {
    this.#checklist.set(runId, items);
    void this.#durable?.saveChecklist(runId, items);
  }

  getChecklist(runId: string): ReviewChecklistItem[] {
    return (this.#checklist.get(runId) || []).slice();
  }

  saveRetvRun(record: RetvCdpRunRecord): void {
    this.#retvRuns.set(record.runId, record);
    void this.#durable?.saveRetvRun(record);
  }

  listRetvRuns(): RetvCdpRunListItem[] {
    return [...this.#retvRuns.values()]
      .map((record) => ({
        runId: record.runId,
        goal: record.goal,
        stopReason: record.stopReason,
        functionalTestSucceeded: record.functionalTestSucceeded,
        goalAchieved: record.goalAchieved,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        durationMs: record.durationMs,
        cycleCount: record.cycleCount,
        milestonesCompleted: record.milestonesCompleted,
        milestonesTotal: record.milestonesTotal,
        percent: record.percent,
        traceEnabled: record.traceEnabled,
      }))
      .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  }

  getRetvRun(runId: string): RetvCdpRunRecord | null {
    return this.#retvRuns.get(runId) ?? null;
  }

  saveReviewAgentRun(record: ReviewAgentRunRecord): void {
    this.#reviewAgentRuns.set(record.runId, record);
    void this.#durable?.saveReviewAgentRun(record);
  }

  listReviewAgentRuns(): ReviewAgentRunListItem[] {
    return [...this.#reviewAgentRuns.values()]
      .map((record) => ({
        runId: record.runId,
        pullRequestId: record.pullRequestId,
        title: record.title,
        verdict: record.verdict,
        goalAchieved: record.goalAchieved,
        stopReason: record.stopReason,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        durationMs: record.durationMs,
        cycleCount: record.cycleCount,
        findingCount: record.findingCount,
        blockerCount: record.blockerCount,
        highCount: record.highCount,
        traceEnabled: record.traceEnabled,
      }))
      .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  }

  getReviewAgentRun(runId: string): ReviewAgentRunRecord | null {
    return this.#reviewAgentRuns.get(runId) ?? null;
  }

  setRuntimeLlmConfig(config: RuntimeLlmConfig): void {
    this.#runtimeLlmConfig = {
      providerKind: config.providerKind,
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    };
  }

  getRuntimeLlmConfig(): RuntimeLlmConfig | null {
    if (!this.#runtimeLlmConfig) {
      return null;
    }

    return {
      providerKind: this.#runtimeLlmConfig.providerKind,
      model: this.#runtimeLlmConfig.model,
      baseUrl: this.#runtimeLlmConfig.baseUrl,
      apiKey: this.#runtimeLlmConfig.apiKey,
    };
  }
}

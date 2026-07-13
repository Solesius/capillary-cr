// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// The review repository. celer-mem is the durable source of truth for review
// artifacts; this class keeps only a bounded LRU cache in front of it, so
// resident memory stays flat and low no matter how many reviews accumulate.
// Every read falls through to the store on a cache miss; every write persists
// before it resolves. When no durable store is attached (native library
// unavailable), the caches become the authoritative in-memory store and never
// evict — preserving a graceful, zero-dependency fallback.
//
// Secrets and catalog data (identity, tokens, the runtime LLM config, and the
// GitHub repo/PR listing) are never persisted: they live only in memory, behind
// the same async interface for a uniform contract.
//
// Concurrency contract: reads are safe under any concurrency. Writes are safe
// under the actual usage model — at most one review loop writes to a given
// runId at a time (each review is a single detached loop; concurrent reviews
// operate on distinct runIds and never share cache keys). The read-modify-write
// paths (updateReviewRun, appendReviewEvent) are NOT safe against two writers
// racing on the *same* runId: both could read the same value across the celer
// await and the later write would clobber the earlier. That is not a pattern the
// system produces today; if a future caller fans out concurrent writes to one
// runId, it must serialize them (e.g. a per-run mutex) rather than rely on this.
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
import { ReviewArtifactStore } from "../services/storage/celer_review_store.ts";
import { BoundedCache } from "./bounded_cache.ts";

export interface RuntimeLlmConfig {
  providerKind: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface ReviewRepository {
  getIdentity(): Promise<GitHubIdentity | null>;
  setIdentity(identity: GitHubIdentity): Promise<void>;
  getGithubToken(): Promise<string | null>;
  setGithubToken(token: string | null): Promise<void>;

  replaceRepositories(repositories: GitHubRepository[]): Promise<void>;
  replacePullRequests(repositoryId: string, pullRequests: PullRequest[]): Promise<void>;
  upsertPullRequest(pullRequest: PullRequest): Promise<void>;
  savePullRequestDiff(repositoryId: string, pullRequestId: string, diff: DiffFile[]): Promise<void>;
  findPullRequestRepositoryId(pullRequestId: string): Promise<string | null>;

  listRepositories(): Promise<GitHubRepository[]>;
  listPullRequests(
    repositoryId: string,
    stateFilter?: "open" | "closed" | "all",
  ): Promise<PullRequest[]>;
  getPullRequest(repositoryId: string, pullRequestId: string): Promise<PullRequest>;
  getPullRequestDiff(repositoryId: string, pullRequestId: string): Promise<DiffFile[]>;

  createReviewRun(run: ReviewRun): Promise<void>;
  updateReviewRun(runId: string, mutate: (run: ReviewRun) => ReviewRun): Promise<ReviewRun>;
  getReviewRun(runId: string): Promise<ReviewRun>;

  appendReviewEvent(runId: string, event: string): Promise<void>;
  listReviewEvents(runId: string): Promise<string[]>;

  saveGraphSnapshot(diffDagId: string, snapshot: GraphSnapshot): Promise<void>;
  getGraphSnapshot(diffDagId: string): Promise<GraphSnapshot>;
  findGraphByPullRequest(pullRequestId: string): Promise<GraphSnapshot | null>;

  saveReviewPacket(packet: ReviewPacket): Promise<void>;
  getReviewPacket(packetId: string): Promise<ReviewPacket>;

  saveFindings(runId: string, findings: ReviewFinding[]): Promise<void>;
  getFindings(runId: string): Promise<ReviewFinding[]>;

  saveChecklist(runId: string, items: ReviewChecklistItem[]): Promise<void>;
  getChecklist(runId: string): Promise<ReviewChecklistItem[]>;

  saveRetvRun(record: RetvCdpRunRecord): Promise<void>;
  listRetvRuns(): Promise<RetvCdpRunListItem[]>;
  getRetvRun(runId: string): Promise<RetvCdpRunRecord | null>;

  saveReviewAgentRun(record: ReviewAgentRunRecord): Promise<void>;
  listReviewAgentRuns(): Promise<ReviewAgentRunListItem[]>;
  getReviewAgentRun(runId: string): Promise<ReviewAgentRunRecord | null>;

  setRuntimeLlmConfig(config: RuntimeLlmConfig): Promise<void>;
  getRuntimeLlmConfig(): Promise<RuntimeLlmConfig | null>;
}

/**
 * Per-entity LRU cache caps. Large payloads (graphs, diffs, RetV traces) keep
 * small caps so resident memory stays flat; small records can afford more
 * headroom. Overridable via the repository constructor for tuning and tests.
 */
export interface CacheCaps {
  runs: number;
  events: number;
  findings: number;
  packets: number;
  graphs: number;
  checklists: number;
  diffs: number;
  retvRuns: number;
  reviewAgentRuns: number;
}

const DEFAULT_CAPS: CacheCaps = {
  runs: 256,
  events: 256,
  findings: 256,
  packets: 128,
  graphs: 32,
  checklists: 256,
  diffs: 32,
  retvRuns: 8,
  reviewAgentRuns: 64,
};

export class CelerReviewRepository implements ReviewRepository {
  // In-memory only, never persisted (secrets + GitHub catalog).
  #identity: GitHubIdentity | null = null;
  #githubToken: string | null = null;
  #runtimeLlmConfig: RuntimeLlmConfig | null = null;
  #repositories: GitHubRepository[] = [];
  #pullRequests: PullRequest[] = [];

  // Bounded caches in front of the durable store.
  readonly #diffs: BoundedCache<DiffFile[]>;
  readonly #runs: BoundedCache<ReviewRun>;
  readonly #runEvents: BoundedCache<string[]>;
  readonly #graphs: BoundedCache<GraphSnapshot>;
  readonly #packets: BoundedCache<ReviewPacket>;
  readonly #findings: BoundedCache<ReviewFinding[]>;
  readonly #checklist: BoundedCache<ReviewChecklistItem[]>;
  readonly #retvRuns: BoundedCache<RetvCdpRunRecord>;
  readonly #reviewAgentRuns: BoundedCache<ReviewAgentRunRecord>;

  #durable: ReviewArtifactStore | null = null;

  constructor(caps: Partial<CacheCaps> = {}) {
    const c: CacheCaps = { ...DEFAULT_CAPS, ...caps };
    this.#diffs = new BoundedCache<DiffFile[]>(c.diffs);
    this.#runs = new BoundedCache<ReviewRun>(c.runs);
    this.#runEvents = new BoundedCache<string[]>(c.events);
    this.#graphs = new BoundedCache<GraphSnapshot>(c.graphs);
    this.#packets = new BoundedCache<ReviewPacket>(c.packets);
    this.#findings = new BoundedCache<ReviewFinding[]>(c.findings);
    this.#checklist = new BoundedCache<ReviewChecklistItem[]>(c.checklists);
    this.#retvRuns = new BoundedCache<RetvCdpRunRecord>(c.retvRuns);
    this.#reviewAgentRuns = new BoundedCache<ReviewAgentRunRecord>(c.reviewAgentRuns);
  }

  /**
   * Attach the durable backing store. celer becomes the source of truth and the
   * caches begin bounding themselves — nothing is replayed into memory, so boot
   * is instant and resident memory starts (and stays) flat.
   */
  /**
   * Boot-time sweep (#38): a run stranded in 'cancelling' means the process
   * died between the stop request and the loop landing it. The user's intent
   * is durable — finalize it to 'cancelled' so history never shows a phantom
   * in-flight stop. Returns the number of runs finalized.
   */
  async finalizeInterruptedRuns(): Promise<number> {
    if (!this.#durable) {
      return 0;
    }
    let finalized = 0;
    for (const run of await this.#durable.listRuns()) {
      if (run.status !== "cancelling") {
        continue;
      }
      const settled: ReviewRun = {
        ...run,
        status: "cancelled",
        currentPhase: "cancelled",
        finishedAt: run.finishedAt ?? new Date().toISOString(),
      };
      await this.#durable.saveRun(settled);
      this.#runs.set(settled.id, settled);
      finalized += 1;
    }
    return finalized;
  }

  attachDurableStore(store: ReviewArtifactStore): void {
    this.#durable = store;
    for (
      const cache of [
        this.#diffs,
        this.#runs,
        this.#runEvents,
        this.#graphs,
        this.#packets,
        this.#findings,
        this.#checklist,
        this.#retvRuns,
        this.#reviewAgentRuns,
      ]
    ) {
      cache.enableEviction();
    }
  }

  // --- identity / secrets (memory only) ---
  getIdentity(): Promise<GitHubIdentity | null> {
    return Promise.resolve(this.#identity);
  }
  setIdentity(identity: GitHubIdentity): Promise<void> {
    this.#identity = identity;
    return Promise.resolve();
  }
  getGithubToken(): Promise<string | null> {
    return Promise.resolve(this.#githubToken);
  }
  setGithubToken(token: string | null): Promise<void> {
    this.#githubToken = token;
    return Promise.resolve();
  }

  // --- GitHub catalog (memory only) ---
  replaceRepositories(repositories: GitHubRepository[]): Promise<void> {
    this.#repositories = repositories.slice();
    return Promise.resolve();
  }

  replacePullRequests(repositoryId: string, pullRequests: PullRequest[]): Promise<void> {
    this.#pullRequests = this.#pullRequests.filter((pr) => pr.repositoryId !== repositoryId)
      .concat(pullRequests.map((pr) => ({ ...pr, repositoryId })));
    return Promise.resolve();
  }

  upsertPullRequest(pullRequest: PullRequest): Promise<void> {
    const index = this.#pullRequests.findIndex((item) =>
      item.repositoryId === pullRequest.repositoryId && item.id === pullRequest.id
    );
    if (index === -1) {
      this.#pullRequests.push(pullRequest);
    } else {
      this.#pullRequests[index] = pullRequest;
    }
    return Promise.resolve();
  }

  findPullRequestRepositoryId(pullRequestId: string): Promise<string | null> {
    return Promise.resolve(
      this.#pullRequests.find((item) => item.id === pullRequestId)?.repositoryId || null,
    );
  }

  listRepositories(): Promise<GitHubRepository[]> {
    return Promise.resolve(this.#repositories.slice());
  }

  listPullRequests(
    repositoryId: string,
    stateFilter: "open" | "closed" | "all" = "all",
  ): Promise<PullRequest[]> {
    return Promise.resolve(this.#pullRequests.filter((pr) => {
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
    }));
  }

  // async so a not-found rejects the promise rather than throwing
  // synchronously — the whole repository contract is uniformly async.
  // deno-lint-ignore require-await
  async getPullRequest(repositoryId: string, pullRequestId: string): Promise<PullRequest> {
    const pr = this.#pullRequests.find((item) =>
      item.repositoryId === repositoryId && item.id === pullRequestId
    );
    if (!pr) {
      throw notFound("pull_request_not_found");
    }
    return pr;
  }

  // --- diffs (durable) ---
  async savePullRequestDiff(
    repositoryId: string,
    pullRequestId: string,
    diff: DiffFile[],
  ): Promise<void> {
    const key = `${repositoryId}:${pullRequestId}`;
    this.#diffs.set(key, diff.slice());
    await this.#durable?.saveDiff(key, diff);
  }

  async getPullRequestDiff(repositoryId: string, pullRequestId: string): Promise<DiffFile[]> {
    const key = `${repositoryId}:${pullRequestId}`;
    const cached = this.#diffs.get(key);
    if (cached) {
      return cached.slice();
    }
    const loaded = (await this.#durable?.getDiff(key)) ?? null;
    if (!loaded) {
      throw notFound("diff_not_found");
    }
    this.#diffs.set(key, loaded);
    return loaded.slice();
  }

  // --- review runs (durable) ---
  async createReviewRun(run: ReviewRun): Promise<void> {
    this.#runs.set(run.id, run);
    this.#runEvents.set(run.id, []);
    await this.#durable?.saveRun(run);
  }

  async updateReviewRun(runId: string, mutate: (run: ReviewRun) => ReviewRun): Promise<ReviewRun> {
    const current = await this.getReviewRun(runId);
    const updated = mutate(current);
    this.#runs.set(runId, updated);
    await this.#durable?.saveRun(updated);
    return updated;
  }

  async getReviewRun(runId: string): Promise<ReviewRun> {
    const cached = this.#runs.get(runId);
    if (cached) {
      return cached;
    }
    const loaded = (await this.#durable?.getRun(runId)) ?? null;
    if (!loaded) {
      throw notFound("review_run_not_found");
    }
    this.#runs.set(runId, loaded);
    return loaded;
  }

  // --- events (durable) ---
  async #loadEvents(runId: string): Promise<string[]> {
    const cached = this.#runEvents.get(runId);
    if (cached) {
      return cached;
    }
    const loaded = (await this.#durable?.getEvents(runId)) ?? null;
    if (loaded) {
      this.#runEvents.set(runId, loaded);
      return loaded;
    }
    // No events row yet — confirm the run exists, else this is a genuine miss.
    await this.getReviewRun(runId);
    const empty: string[] = [];
    this.#runEvents.set(runId, empty);
    return empty;
  }

  async appendReviewEvent(runId: string, event: string): Promise<void> {
    const events = await this.#loadEvents(runId);
    events.push(event);
    this.#runEvents.set(runId, events);
    await this.#durable?.saveEvents(runId, events);
  }

  async listReviewEvents(runId: string): Promise<string[]> {
    const events = await this.#loadEvents(runId);
    return events.slice();
  }

  // --- graphs (durable) ---
  async saveGraphSnapshot(diffDagId: string, snapshot: GraphSnapshot): Promise<void> {
    this.#graphs.set(diffDagId, snapshot);
    await this.#durable?.saveGraph(diffDagId, snapshot);
  }

  async getGraphSnapshot(diffDagId: string): Promise<GraphSnapshot> {
    const cached = this.#graphs.get(diffDagId);
    if (cached) {
      return cached;
    }
    const loaded = (await this.#durable?.getGraph(diffDagId)) ?? null;
    if (!loaded) {
      throw notFound("diff_dag_not_found");
    }
    this.#graphs.set(diffDagId, loaded);
    return loaded;
  }

  async findGraphByPullRequest(pullRequestId: string): Promise<GraphSnapshot | null> {
    for (const snapshot of this.#graphs.values()) {
      if (snapshot.dag.pullRequestId === pullRequestId) {
        return snapshot;
      }
    }
    if (this.#durable) {
      for (const snapshot of await this.#durable.listGraphs()) {
        if (snapshot.dag.pullRequestId === pullRequestId) {
          this.#graphs.set(snapshot.dag.id, snapshot);
          return snapshot;
        }
      }
    }
    return null;
  }

  // --- packets (durable) ---
  async saveReviewPacket(packet: ReviewPacket): Promise<void> {
    this.#packets.set(packet.id, packet);
    await this.#durable?.savePacket(packet);
  }

  async getReviewPacket(packetId: string): Promise<ReviewPacket> {
    const cached = this.#packets.get(packetId);
    if (cached) {
      return cached;
    }
    const loaded = (await this.#durable?.getPacket(packetId)) ?? null;
    if (!loaded) {
      throw notFound("review_packet_not_found");
    }
    this.#packets.set(packetId, loaded);
    return loaded;
  }

  // --- findings (durable) ---
  async saveFindings(runId: string, findings: ReviewFinding[]): Promise<void> {
    // Copy so a later mutation of the caller's array cannot corrupt the cache.
    this.#findings.set(runId, findings.slice());
    await this.#durable?.saveFindings(runId, findings);
  }

  async getFindings(runId: string): Promise<ReviewFinding[]> {
    const cached = this.#findings.get(runId);
    if (cached) {
      return cached.slice();
    }
    const loaded = (await this.#durable?.getFindings(runId)) ?? null;
    if (!loaded) {
      return [];
    }
    this.#findings.set(runId, loaded);
    return loaded.slice();
  }

  // --- checklists (durable) ---
  async saveChecklist(runId: string, items: ReviewChecklistItem[]): Promise<void> {
    // Copy so a later mutation of the caller's array cannot corrupt the cache.
    this.#checklist.set(runId, items.slice());
    await this.#durable?.saveChecklist(runId, items);
  }

  async getChecklist(runId: string): Promise<ReviewChecklistItem[]> {
    const cached = this.#checklist.get(runId);
    if (cached) {
      return cached.slice();
    }
    const loaded = (await this.#durable?.getChecklist(runId)) ?? null;
    if (!loaded) {
      return [];
    }
    this.#checklist.set(runId, loaded);
    return loaded.slice();
  }

  // --- RetV runs (durable; lists scan celer) ---
  async saveRetvRun(record: RetvCdpRunRecord): Promise<void> {
    this.#retvRuns.set(record.runId, record);
    await this.#durable?.saveRetvRun(record);
  }

  async listRetvRuns(): Promise<RetvCdpRunListItem[]> {
    const records = this.#durable
      ? await this.#durable.listRetvRuns()
      : [...this.#retvRuns.values()];
    return records
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

  async getRetvRun(runId: string): Promise<RetvCdpRunRecord | null> {
    const cached = this.#retvRuns.get(runId);
    if (cached) {
      return cached;
    }
    const loaded = (await this.#durable?.getRetvRun(runId)) ?? null;
    if (loaded) {
      this.#retvRuns.set(runId, loaded);
    }
    return loaded;
  }

  // --- review-agent runs (durable; lists scan celer) ---
  async saveReviewAgentRun(record: ReviewAgentRunRecord): Promise<void> {
    this.#reviewAgentRuns.set(record.runId, record);
    await this.#durable?.saveReviewAgentRun(record);
  }

  async listReviewAgentRuns(): Promise<ReviewAgentRunListItem[]> {
    const records = this.#durable
      ? await this.#durable.listReviewAgentRuns()
      : [...this.#reviewAgentRuns.values()];
    return records
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

  async getReviewAgentRun(runId: string): Promise<ReviewAgentRunRecord | null> {
    const cached = this.#reviewAgentRuns.get(runId);
    if (cached) {
      return cached;
    }
    const loaded = (await this.#durable?.getReviewAgentRun(runId)) ?? null;
    if (loaded) {
      this.#reviewAgentRuns.set(runId, loaded);
    }
    return loaded;
  }

  // --- runtime LLM config (memory only) ---
  setRuntimeLlmConfig(config: RuntimeLlmConfig): Promise<void> {
    this.#runtimeLlmConfig = {
      providerKind: config.providerKind,
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    };
    return Promise.resolve();
  }

  getRuntimeLlmConfig(): Promise<RuntimeLlmConfig | null> {
    if (!this.#runtimeLlmConfig) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      providerKind: this.#runtimeLlmConfig.providerKind,
      model: this.#runtimeLlmConfig.model,
      baseUrl: this.#runtimeLlmConfig.baseUrl,
      apiKey: this.#runtimeLlmConfig.apiKey,
    });
  }
}

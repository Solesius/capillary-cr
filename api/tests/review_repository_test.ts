// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// High-fidelity unit tests for the celer-backed review repository. The durable
// store is faked with an in-memory implementation that serializes to JSON on
// write and parses on read — exactly as the real celer-backed store does — so
// these exercise the true read-through / write-through / eviction / degradation
// behavior without needing the native library. Runs everywhere.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { CelerReviewRepository } from "../src/repositories/review_repository.ts";
import { ReviewArtifactStore } from "../src/services/storage/celer_review_store.ts";
import {
  DiffFile,
  GitHubIdentity,
  GitHubRepository,
  GraphSnapshot,
  PullRequest,
  RetvCdpRunRecord,
  ReviewAgentRunRecord,
  ReviewChecklistItem,
  ReviewFinding,
  ReviewPacket,
  ReviewRun,
} from "../src/domain/entities.ts";

// --- a faithful in-memory ReviewArtifactStore (serializes like celer) --------

class FakeStore implements ReviewArtifactStore {
  runs = new Map<string, string>();
  events = new Map<string, string>();
  findings = new Map<string, string>();
  packets = new Map<string, string>();
  graphs = new Map<string, string>();
  checklists = new Map<string, string>();
  retvRuns = new Map<string, string>();
  reviewAgentRuns = new Map<string, string>();
  diffs = new Map<string, string>();

  /** Total point reads — asserts the cache actually shields the store. */
  reads = 0;
  /** Simulate silently-failed persistence (writes are no-ops). */
  dropWrites = false;

  #put(map: Map<string, string>, key: string, value: unknown): Promise<void> {
    if (!this.dropWrites) map.set(key, JSON.stringify(value));
    return Promise.resolve();
  }
  #get<T>(map: Map<string, string>, key: string): Promise<T | null> {
    this.reads += 1;
    const raw = map.get(key);
    return Promise.resolve(raw === undefined ? null : (JSON.parse(raw) as T));
  }
  #scan<T>(map: Map<string, string>): Promise<T[]> {
    return Promise.resolve([...map.values()].map((raw) => JSON.parse(raw) as T));
  }

  saveRun(run: ReviewRun) {
    return this.#put(this.runs, run.id, run);
  }
  saveEvents(runId: string, events: string[]) {
    return this.#put(this.events, runId, events);
  }
  saveFindings(runId: string, findings: ReviewFinding[]) {
    return this.#put(this.findings, runId, findings);
  }
  savePacket(packet: ReviewPacket) {
    return this.#put(this.packets, packet.id, packet);
  }
  saveGraph(diffDagId: string, snapshot: GraphSnapshot) {
    return this.#put(this.graphs, diffDagId, snapshot);
  }
  saveChecklist(runId: string, items: ReviewChecklistItem[]) {
    return this.#put(this.checklists, runId, items);
  }
  saveRetvRun(record: RetvCdpRunRecord) {
    return this.#put(this.retvRuns, record.runId, record);
  }
  saveReviewAgentRun(record: ReviewAgentRunRecord) {
    return this.#put(this.reviewAgentRuns, record.runId, record);
  }
  saveDiff(key: string, diff: DiffFile[]) {
    return this.#put(this.diffs, key, diff);
  }

  getRun(runId: string) {
    return this.#get<ReviewRun>(this.runs, runId);
  }
  getEvents(runId: string) {
    return this.#get<string[]>(this.events, runId);
  }
  getFindings(runId: string) {
    return this.#get<ReviewFinding[]>(this.findings, runId);
  }
  getPacket(packetId: string) {
    return this.#get<ReviewPacket>(this.packets, packetId);
  }
  getGraph(diffDagId: string) {
    return this.#get<GraphSnapshot>(this.graphs, diffDagId);
  }
  getChecklist(runId: string) {
    return this.#get<ReviewChecklistItem[]>(this.checklists, runId);
  }
  getRetvRun(runId: string) {
    return this.#get<RetvCdpRunRecord>(this.retvRuns, runId);
  }
  getReviewAgentRun(runId: string) {
    return this.#get<ReviewAgentRunRecord>(this.reviewAgentRuns, runId);
  }
  getDiff(key: string) {
    return this.#get<DiffFile[]>(this.diffs, key);
  }

  listRetvRuns() {
    return this.#scan<RetvCdpRunRecord>(this.retvRuns);
  }
  listReviewAgentRuns() {
    return this.#scan<ReviewAgentRunRecord>(this.reviewAgentRuns);
  }
  listGraphs() {
    return this.#scan<GraphSnapshot>(this.graphs);
  }
  listRuns() {
    return this.#scan<ReviewRun>(this.runs);
  }
  close() {
    return Promise.resolve();
  }
}

// --- fixtures ---------------------------------------------------------------

function makeRun(id: string, over: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id,
    pullRequestId: "pr-1",
    status: "reviewing",
    startedAt: "2026-01-01T00:00:00.000Z",
    currentPhase: "observe",
    findingCount: 0,
    blockerCount: 0,
    highCount: 0,
    ...over,
  };
}

function makeFinding(id: string, runId: string): ReviewFinding {
  return {
    id,
    runId,
    severity: "high",
    passName: "State",
    filePath: "src/main.ts",
    line: 12,
    title: "Unflushed write",
    finding: "State mutation not persisted before return.",
    evidence: ["tcsrtc.gate=Test"],
    confidence: 0.9,
  };
}

function makeGraph(diffDagId: string, pullRequestId: string): GraphSnapshot {
  return {
    dag: {
      id: diffDagId,
      repositoryId: "repo-1",
      pullRequestId,
      baseSha: "base",
      headSha: "head",
      nodeCount: 0,
      edgeCount: 0,
      changedNodeCount: 0,
      saturation: 0,
      torusVariance: 0,
      flowCompleteness: 1,
      completenessNotes: [],
    },
    nodes: [],
    edges: [],
    shapeSamples: [],
    surfaces: [],
  };
}

function makePacket(id: string): ReviewPacket {
  return {
    id,
    pullRequestId: "pr-1",
    diffDagId: "dag-1",
    summary: "packet",
    changedFiles: [],
    neighborFiles: [],
    riskSurfaces: [],
    shapeSamples: [],
    tcsrctPasses: [],
  };
}

function makeDiff(path: string): DiffFile {
  return {
    path,
    status: "modified",
    additions: 3,
    deletions: 1,
    patch: `@@ -1 +1 @@\n+changed`,
    language: "TypeScript",
    isTest: false,
    isConfig: false,
    isGenerated: false,
  };
}

function makeRetvRun(runId: string, finishedAt: string, traced: boolean): RetvCdpRunRecord {
  return {
    runId,
    sessionId: "s1",
    goal: "verify",
    allowedOrigin: "http://localhost",
    stopReason: "goal_achieved",
    functionalTestSucceeded: true,
    goalAchieved: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt,
    durationMs: 1000,
    cycleCount: 1,
    milestonesCompleted: 1,
    milestonesTotal: 1,
    percent: 100,
    findings: [],
    summary: "ok",
    report: "# Report",
    traceEnabled: traced,
    trace: traced ? { cycles: [], screenshots: [] } : undefined,
  };
}

function makeAgentRun(runId: string, finishedAt: string): ReviewAgentRunRecord {
  return {
    runId,
    pullRequestId: "pr-1",
    repositoryId: "repo-1",
    title: "PR title",
    verdict: "comment",
    goalAchieved: true,
    stopReason: "verdict_reached",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt,
    durationMs: 1000,
    cycleCount: 2,
    findingCount: 1,
    blockerCount: 0,
    highCount: 1,
    changedFileCount: 1,
    nodeCount: 0,
    edgeCount: 0,
    torusVariance: 0,
    findings: [makeFinding("f1", runId)],
    summary: "reviewed",
    report: "# Code Review Report",
    traceEnabled: false,
  };
}

function makeRepo(id: string): GitHubRepository {
  return {
    id,
    owner: "o",
    name: id,
    fullName: `o/${id}`,
    defaultBranch: "main",
    privateRepo: false,
    htmlUrl: "https://example",
    openPullRequestCount: 0,
  };
}

function makePr(id: string, repositoryId: string, state: PullRequest["state"]): PullRequest {
  return {
    id,
    repositoryId,
    number: 1,
    title: "t",
    author: "a",
    sourceBranch: "feature",
    targetBranch: "main",
    state,
    htmlUrl: "https://example",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    changedFileCount: 1,
    additions: 1,
    deletions: 0,
    riskHint: "low",
  };
}

const IDENTITY: GitHubIdentity = { id: "u1", login: "octocat", connected: true };

// --- in-memory mode (no durable store) --------------------------------------

Deno.test("in-memory: review run create / get / update round-trips", async () => {
  const repo = new CelerReviewRepository();
  await repo.createReviewRun(makeRun("run-1"));
  assertEquals((await repo.getReviewRun("run-1")).status, "reviewing");
  const updated = await repo.updateReviewRun(
    "run-1",
    (r) => ({ ...r, status: "completed", findingCount: 2 }),
  );
  assertEquals(updated.status, "completed");
  assertEquals((await repo.getReviewRun("run-1")).findingCount, 2);
});

Deno.test("in-memory: missing run / packet / graph / diff reject as not-found", async () => {
  const repo = new CelerReviewRepository();
  await assertRejects(() => repo.getReviewRun("nope"));
  await assertRejects(() => repo.getReviewPacket("nope"));
  await assertRejects(() => repo.getGraphSnapshot("nope"));
  await assertRejects(() => repo.getPullRequestDiff("r", "p"));
  await assertRejects(() => repo.listReviewEvents("nope"));
});

Deno.test("in-memory: events append in order; empty for a run with none", async () => {
  const repo = new CelerReviewRepository();
  await repo.createReviewRun(makeRun("run-1"));
  assertEquals(await repo.listReviewEvents("run-1"), []);
  await repo.appendReviewEvent("run-1", "phase:observe");
  await repo.appendReviewEvent("run-1", "phase:plan");
  assertEquals(await repo.listReviewEvents("run-1"), ["phase:observe", "phase:plan"]);
});

Deno.test("in-memory: findings / checklist save+get; empty defaults to []", async () => {
  const repo = new CelerReviewRepository();
  assertEquals(await repo.getFindings("run-1"), []);
  assertEquals(await repo.getChecklist("run-1"), []);
  await repo.saveFindings("run-1", [makeFinding("f1", "run-1")]);
  await repo.saveChecklist("run-1", [{
    id: "c1",
    runId: "run-1",
    description: "verify",
    required: true,
    completed: false,
  }]);
  assertEquals((await repo.getFindings("run-1")).length, 1);
  assertEquals((await repo.getChecklist("run-1")).length, 1);
});

Deno.test("returned findings are a defensive copy — mutating them cannot corrupt the cache", async () => {
  const repo = new CelerReviewRepository();
  const source = [makeFinding("f1", "run-1")];
  await repo.saveFindings("run-1", source);
  source.push(makeFinding("f2", "run-1")); // mutate the caller's array after save
  assertEquals((await repo.getFindings("run-1")).length, 1);
  const got = await repo.getFindings("run-1");
  got.push(makeFinding("f3", "run-1")); // mutate the returned array
  assertEquals((await repo.getFindings("run-1")).length, 1);
});

Deno.test("in-memory: graph save/get and findGraphByPullRequest", async () => {
  const repo = new CelerReviewRepository();
  await repo.saveGraphSnapshot("dag-1", makeGraph("dag-1", "pr-9"));
  assertEquals((await repo.getGraphSnapshot("dag-1")).dag.id, "dag-1");
  assertEquals((await repo.findGraphByPullRequest("pr-9"))?.dag.id, "dag-1");
  assertEquals(await repo.findGraphByPullRequest("pr-absent"), null);
});

Deno.test("in-memory: diff save/get keyed by repo:pr", async () => {
  const repo = new CelerReviewRepository();
  await repo.savePullRequestDiff("repo-1", "pr-1", [makeDiff("a.ts"), makeDiff("b.ts")]);
  assertEquals((await repo.getPullRequestDiff("repo-1", "pr-1")).length, 2);
  await assertRejects(() => repo.getPullRequestDiff("repo-1", "pr-other"));
});

Deno.test("in-memory: retv + review-agent runs list newest-first", async () => {
  const repo = new CelerReviewRepository();
  await repo.saveRetvRun(makeRetvRun("older", "2026-01-01T00:00:00.000Z", true));
  await repo.saveRetvRun(makeRetvRun("newer", "2026-02-01T00:00:00.000Z", false));
  assertEquals((await repo.listRetvRuns()).map((r) => r.runId), ["newer", "older"]);
  assertEquals((await repo.getRetvRun("older"))?.traceEnabled, true);
  assertEquals(await repo.getRetvRun("missing"), null);

  await repo.saveReviewAgentRun(makeAgentRun("a-older", "2026-01-01T00:00:00.000Z"));
  await repo.saveReviewAgentRun(makeAgentRun("a-newer", "2026-03-01T00:00:00.000Z"));
  assertEquals((await repo.listReviewAgentRuns()).map((r) => r.runId), ["a-newer", "a-older"]);
});

Deno.test("in-memory: identity, token, runtime LLM config are stored and returned", async () => {
  const repo = new CelerReviewRepository();
  assertEquals(await repo.getIdentity(), null);
  await repo.setIdentity(IDENTITY);
  await repo.setGithubToken("ghp_x");
  await repo.setRuntimeLlmConfig({
    providerKind: "claude_code",
    model: "m",
    baseUrl: "",
    apiKey: "k",
  });
  assertEquals((await repo.getIdentity())?.login, "octocat");
  assertEquals(await repo.getGithubToken(), "ghp_x");
  assertEquals((await repo.getRuntimeLlmConfig())?.providerKind, "claude_code");
});

Deno.test("in-memory: repo/PR catalog list, filter, upsert, and lookup", async () => {
  const repo = new CelerReviewRepository();
  await repo.replaceRepositories([makeRepo("r1"), makeRepo("r2")]);
  assertEquals((await repo.listRepositories()).length, 2);

  await repo.replacePullRequests("r1", [makePr("p1", "r1", "open"), makePr("p2", "r1", "merged")]);
  assertEquals((await repo.listPullRequests("r1", "open")).map((p) => p.id), ["p1"]);
  assertEquals((await repo.listPullRequests("r1", "closed")).map((p) => p.id), ["p2"]);
  assertEquals((await repo.listPullRequests("r1", "all")).length, 2);
  assertEquals(await repo.findPullRequestRepositoryId("p1"), "r1");
  assertEquals(await repo.findPullRequestRepositoryId("absent"), null);

  await repo.upsertPullRequest({ ...makePr("p1", "r1", "closed") });
  assertEquals((await repo.getPullRequest("r1", "p1")).state, "closed");
  await assertRejects(() => repo.getPullRequest("r1", "absent"));
});

// --- durable mode (fake celer store attached) -------------------------------

Deno.test("durable: writes persist through to the store (write-through)", async () => {
  const store = new FakeStore();
  const repo = new CelerReviewRepository();
  repo.attachDurableStore(store);
  await repo.createReviewRun(makeRun("run-1"));
  await repo.saveFindings("run-1", [makeFinding("f1", "run-1")]);
  assert(store.runs.has("run-1"));
  assert(store.findings.has("run-1"));
});

Deno.test("durable: a cold repository faults records back in from the store", async () => {
  const store = new FakeStore();
  const writer = new CelerReviewRepository();
  writer.attachDurableStore(store);
  await writer.createReviewRun(makeRun("run-1", { status: "completed", findingCount: 3 }));
  await writer.appendReviewEvent("run-1", "phase:done");
  await writer.saveFindings("run-1", [makeFinding("f1", "run-1")]);
  await writer.saveGraphSnapshot("dag-1", makeGraph("dag-1", "pr-1"));
  await writer.savePullRequestDiff("repo-1", "pr-1", [makeDiff("a.ts")]);

  // A brand-new repository sharing the same store — nothing replayed at boot.
  const reader = new CelerReviewRepository();
  reader.attachDurableStore(store);
  assertEquals((await reader.getReviewRun("run-1")).findingCount, 3);
  assertEquals(await reader.listReviewEvents("run-1"), ["phase:done"]);
  assertEquals((await reader.getFindings("run-1")).length, 1);
  assertEquals((await reader.getGraphSnapshot("dag-1")).dag.id, "dag-1");
  assertEquals((await reader.findGraphByPullRequest("pr-1"))?.dag.id, "dag-1");
  assertEquals((await reader.getPullRequestDiff("repo-1", "pr-1")).length, 1);
});

Deno.test("durable: a cache hit shields the store from repeat reads", async () => {
  const store = new FakeStore();
  await store.saveRun(makeRun("run-1"));
  const repo = new CelerReviewRepository();
  repo.attachDurableStore(store);

  await repo.getReviewRun("run-1"); // cold: one store read, then cached
  const afterFirst = store.reads;
  await repo.getReviewRun("run-1");
  await repo.getReviewRun("run-1");
  assertEquals(store.reads, afterFirst); // cache served the repeats
});

Deno.test("durable: LRU eviction is transparent — an evicted run reloads from the store", async () => {
  const store = new FakeStore();
  const repo = new CelerReviewRepository({ runs: 2 }); // tiny cap for the test
  repo.attachDurableStore(store);
  await repo.createReviewRun(makeRun("run-1", { findingCount: 1 }));
  await repo.createReviewRun(makeRun("run-2", { findingCount: 2 }));
  await repo.createReviewRun(makeRun("run-3", { findingCount: 3 })); // evicts run-1 from cache

  // run-1 is gone from the cache but still durable — a read faults it back in.
  assertEquals((await repo.getReviewRun("run-1")).findingCount, 1);
  assertEquals((await repo.getReviewRun("run-3")).findingCount, 3);
});

Deno.test("durable: lists and finds scan the store, not the partial cache", async () => {
  const store = new FakeStore();
  const repo = new CelerReviewRepository({ retvRuns: 1, graphs: 1 });
  repo.attachDurableStore(store);
  await repo.saveRetvRun(makeRetvRun("r-a", "2026-01-01T00:00:00.000Z", false));
  await repo.saveRetvRun(makeRetvRun("r-b", "2026-02-01T00:00:00.000Z", false)); // evicts r-a from cache
  // The scan must see BOTH, from the store — not just the one still cached.
  assertEquals((await repo.listRetvRuns()).map((r) => r.runId), ["r-b", "r-a"]);

  await repo.saveGraphSnapshot("dag-a", makeGraph("dag-a", "pr-a"));
  await repo.saveGraphSnapshot("dag-b", makeGraph("dag-b", "pr-b")); // evicts dag-a
  assertEquals((await repo.findGraphByPullRequest("pr-a"))?.dag.id, "dag-a");
});

Deno.test("durable: serialization is faithful — traced and untraced retv runs round-trip", async () => {
  const store = new FakeStore();
  const writer = new CelerReviewRepository();
  writer.attachDurableStore(store);
  await writer.saveRetvRun(makeRetvRun("traced", "2026-01-01T00:00:00.000Z", true));
  await writer.saveRetvRun(makeRetvRun("light", "2026-01-02T00:00:00.000Z", false));

  const reader = new CelerReviewRepository();
  reader.attachDurableStore(store);
  const traced = await reader.getRetvRun("traced");
  assert(traced?.trace !== undefined);
  const light = await reader.getRetvRun("light");
  assertEquals(light?.trace, undefined);
});

Deno.test("degradation: a silently-failed persistence keeps the session alive but is not durable", async () => {
  const store = new FakeStore();
  store.dropWrites = true; // simulate celer write failures swallowed by onError
  const repo = new CelerReviewRepository();
  repo.attachDurableStore(store);

  // Writes still resolve (never throw) and the session-local cache serves reads.
  await repo.createReviewRun(makeRun("run-1"));
  assertEquals((await repo.getReviewRun("run-1")).id, "run-1");

  // But nothing reached the store, so a cold repository cannot see it.
  const cold = new CelerReviewRepository();
  cold.attachDurableStore(store);
  await assertRejects(() => cold.getReviewRun("run-1"));
});

Deno.test("secrets are never handed to the durable store", async () => {
  const store = new FakeStore();
  const repo = new CelerReviewRepository();
  repo.attachDurableStore(store);
  await repo.setIdentity(IDENTITY);
  await repo.setGithubToken("ghp_secret");
  await repo.setRuntimeLlmConfig({
    providerKind: "anthropic",
    model: "m",
    baseUrl: "",
    apiKey: "sk-secret",
  });
  await repo.replaceRepositories([makeRepo("r1")]);
  // The durable store has no table for any of these — they live only in memory.
  const serialized = JSON.stringify([...store.runs, ...store.findings, ...store.diffs]);
  assert(!serialized.includes("ghp_secret"));
  assert(!serialized.includes("sk-secret"));
});

Deno.test("boot sweep finalizes runs stranded in 'cancelling' (#38)", async () => {
  const store = new FakeStore();
  // A run whose stop was requested, then the process died mid-landing.
  await store.saveRun(makeRun("run-stranded", { status: "cancelling", currentPhase: "cancelling" }));
  await store.saveRun(makeRun("run-live", { status: "reviewing" }));

  const repo = new CelerReviewRepository();
  repo.attachDurableStore(store);
  const finalized = await repo.finalizeInterruptedRuns();

  assertEquals(finalized, 1);
  const settled = await repo.getReviewRun("run-stranded");
  assertEquals(settled.status, "cancelled");
  assert(typeof settled.finishedAt === "string" && settled.finishedAt.length > 0);
  // In-flight work untouched: the sweep only settles declared intent.
  assertEquals((await repo.getReviewRun("run-live")).status, "reviewing");
});

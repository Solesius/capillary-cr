// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
export type RiskHint = "unknown" | "low" | "medium" | "high" | "critical";
export type PullRequestState = "open" | "closed" | "merged" | "draft";
export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";
export type NodeKind =
  | "file"
  | "symbol"
  | "test"
  | "config"
  | "route"
  | "endpoint"
  | "data_model"
  | "runtime_path"
  | "review_pass";
export type EdgeKind =
  | "imports"
  | "exports"
  | "calls"
  | "tests"
  | "configures"
  | "routes_to"
  | "persists_to"
  | "authenticates"
  | "mentions"
  | "owns"
  | "changed_with";

export type ReviewSeverity = "blocker" | "high" | "medium" | "low" | "note";
export type ReviewRunStatus =
  | "queued"
  | "wetting"
  | "graphing"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled";

export interface GitHubIdentity {
  id: string;
  login: string;
  displayName?: string;
  avatarUrl?: string;
  connected: boolean;
}

export interface GitHubRepository {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  privateRepo: boolean;
  htmlUrl: string;
  language?: string;
  openPullRequestCount: number;
}

export interface PullRequest {
  id: string;
  repositoryId: string;
  number: number;
  title: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  state: PullRequestState;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  changedFileCount: number;
  additions: number;
  deletions: number;
  riskHint: RiskHint;
}

export interface PullRequestCard {
  pullRequestId: string;
  title: string;
  subtitle: string;
  authorLine: string;
  changeSummary: string;
  riskBadge: string;
  selected: boolean;
}

export interface DiffFile {
  path: string;
  previousPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  patch?: string;
  language?: string;
  isTest: boolean;
  isConfig: boolean;
  isGenerated: boolean;
}

export interface DiffHunk {
  filePath: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  body: string;
  semanticSummary?: string;
}

export interface ModuleNode {
  id: string;
  kind: NodeKind;
  path: string;
  name: string;
  language?: string;
  changed: boolean;
  weight: number;
}

export interface ModuleEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: EdgeKind;
  directed: boolean;
  weight: number;
}

export interface DiffDag {
  id: string;
  repositoryId: string;
  pullRequestId: string;
  baseSha: string;
  headSha: string;
  nodeCount: number;
  edgeCount: number;
  changedNodeCount: number;
  saturation: number;
  torusVariance: number;
  flowCompleteness: number;
  completenessNotes: string[];
}

export interface ProgramShapeSample {
  nodeId: string;
  timeDelta: number;
  stateMagnitude: number;
  interopMagnitude: number;
  theta: number;
  phi: number;
  radiusMajor: number;
  radiusMinor: number;
  curvature: number;
  torsion: number;
  riskGradient: number;
}

export type RiskSurfaceKind =
  | "auth"
  | "persistence"
  | "payment"
  | "public_api"
  | "configuration"
  | "runtime"
  | "performance"
  | "concurrency"
  | "data_model"
  | "test_gap";

export interface RiskSurface {
  id: string;
  pullRequestId: string;
  surfaceKind: RiskSurfaceKind;
  entryNodeId: string;
  riskScore: number;
  reason: string;
}

export type TcsrctPassName = "Trace" | "Contracts" | "State" | "Runtime" | "CodeShape" | "Tests";

export interface TcsrctPass {
  id: string;
  name: TcsrctPassName;
  description: string;
  enabled: boolean;
  maxFindings: number;
}

export interface ReviewPacket {
  id: string;
  pullRequestId: string;
  diffDagId: string;
  summary: string;
  changedFiles: DiffFile[];
  neighborFiles: DiffFile[];
  riskSurfaces: RiskSurface[];
  shapeSamples: ProgramShapeSample[];
  tcsrctPasses: TcsrctPass[];
}

export interface ReviewFinding {
  id: string;
  runId: string;
  severity: ReviewSeverity;
  passName: string;
  filePath: string;
  line?: number;
  title: string;
  finding: string;
  evidence: string[];
  suggestedFix?: string;
  confidence: number;
}

export interface ReviewChecklistItem {
  id: string;
  runId: string;
  command?: string;
  description: string;
  required: boolean;
  completed: boolean;
}

export interface ReviewRun {
  id: string;
  pullRequestId: string;
  status: ReviewRunStatus;
  startedAt: string;
  finishedAt?: string;
  currentPhase: string;
  findingCount: number;
  blockerCount: number;
  highCount: number;
  packetId?: string;
}

export interface BuildTarget {
  name: string;
  command: string;
  requiresDocker: boolean;
  description: string;
}

export interface GraphSnapshot {
  dag: DiffDag;
  nodes: ModuleNode[];
  edges: ModuleEdge[];
  shapeSamples: ProgramShapeSample[];
  surfaces: RiskSurface[];
}

// ---------------------------------------------------------------------------
// RetV CDP run persistence — full functional-test traces and reports.
//
// Captured for every browser functional-test run so prior runs can be browsed,
// previewed, and (when traced) exported as a self-contained bundle. The full
// per-step trace and screenshots are only retained when the run requested
// tracing; lightweight runs persist the report + metadata only.
// ---------------------------------------------------------------------------

/** A single executed CDP action within a cycle (the atomic trace unit). */
export interface RetvCdpTraceStep {
  index: number;
  action: string;
  ok: boolean;
  durationMs: number;
  output?: string;
  error?: string;
}

/** A tool call the planner requested, as recorded in the trace. */
export interface RetvCdpTraceToolCall {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

/** Full trace for one Reason→Act→Observe cycle. */
export interface RetvCdpTraceCycle {
  cycle: number;
  startedAt: string;
  url: string;
  title: string;
  headings: string[];
  interactiveLabels: string[];
  plannerRaw?: string;
  toolCalls: RetvCdpTraceToolCall[];
  steps: RetvCdpTraceStep[];
  workUnitName: string;
  workUnitSuccess: boolean;
  failedSteps: number;
  findings: string[];
}

/** A captured cycle screenshot (base64 data URL). */
export interface RetvCdpTraceScreenshot {
  cycle: number;
  dataUrl: string;
}

/** The complete trace payload, retained only for traced runs. */
export interface RetvCdpRunTrace {
  cycles: RetvCdpTraceCycle[];
  screenshots: RetvCdpTraceScreenshot[];
}

/** A persisted RetV functional-test run (report always present, trace optional). */
export interface RetvCdpRunRecord {
  runId: string;
  sessionId: string;
  goal: string;
  allowedOrigin: string;
  stopReason: string;
  functionalTestSucceeded: boolean;
  goalAchieved: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  cycleCount: number;
  milestonesCompleted: number;
  milestonesTotal: number;
  percent: number;
  findings: string[];
  summary: string;
  /** Structured markdown report — always generated, viewable regardless of tracing. */
  report: string;
  /** Whether the run was traced; gates trace retention and bundle export. */
  traceEnabled: boolean;
  /** Full per-step trace and screenshots; present only when traceEnabled. */
  trace?: RetvCdpRunTrace;
}

/** Lightweight run-history row (no heavy trace/report payload). */
export interface RetvCdpRunListItem {
  runId: string;
  goal: string;
  stopReason: string;
  functionalTestSucceeded: boolean;
  goalAchieved: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  cycleCount: number;
  milestonesCompleted: number;
  milestonesTotal: number;
  percent: number;
  traceEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Review agent run persistence — TCSRTC tool-driven code-review traces +
// reports. Mirrors the RetV CDP run records: every review always produces a
// markdown report (previewable in the app); the full per-step tool trace and
// capture manifest are retained only when the run requested tracing, which
// also gates the downloadable bundle export.
// ---------------------------------------------------------------------------

/** A tool call the review agent requested, as recorded in the trace. */
export interface ReviewAgentTraceToolCall {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

/** A single executed review tool within a cycle (the atomic trace unit). */
export interface ReviewAgentTraceStep {
  index: number;
  tool: string;
  ok: boolean;
  durationMs: number;
  output?: string;
  error?: string;
}

/** Full trace for one Reason→Toolform→Act→Observe review cycle. */
export interface ReviewAgentTraceCycle {
  cycle: number;
  startedAt: string;
  /** The TCSRTC phase the agent declared it was operating in this cycle. */
  phase: string;
  plannerRaw?: string;
  toolCalls: ReviewAgentTraceToolCall[];
  steps: ReviewAgentTraceStep[];
  findings: string[];
}

/** The complete review trace payload, retained only for traced runs. */
export interface ReviewAgentRunTrace {
  cycles: ReviewAgentTraceCycle[];
  /** Serialized on-disk capture manifest (JSON), retained for the bundle. */
  captureManifest?: string;
}

/** A persisted TCSRTC review run (report always present, trace optional). */
export interface ReviewAgentRunRecord {
  runId: string;
  pullRequestId: string;
  repositoryId: string;
  title: string;
  /** "approve" | "request_changes" | "comment". */
  verdict: string;
  /** Provider/model that drove the review, e.g. "anthropic/claude-sonnet-4-6"; "deterministic" when no LLM ran. */
  model?: string;
  /** True when the agent reached a confident, complete verdict. */
  goalAchieved: boolean;
  stopReason: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  cycleCount: number;
  findingCount: number;
  blockerCount: number;
  highCount: number;
  changedFileCount: number;
  nodeCount: number;
  edgeCount: number;
  torusVariance: number;
  findings: ReviewFinding[];
  summary: string;
  /** Structured markdown report — always generated, viewable regardless of tracing. */
  report: string;
  /** Whether the run was traced; gates trace retention and bundle export. */
  traceEnabled: boolean;
  /** Full per-step trace and capture manifest; present only when traceEnabled. */
  trace?: ReviewAgentRunTrace;
}

/** Lightweight review-history row (no heavy trace/report/findings payload). */
export interface ReviewAgentRunListItem {
  runId: string;
  pullRequestId: string;
  title: string;
  verdict: string;
  goalAchieved: boolean;
  stopReason: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  cycleCount: number;
  findingCount: number;
  blockerCount: number;
  highCount: number;
  traceEnabled: boolean;
}

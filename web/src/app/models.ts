// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
export type RiskHint = "unknown" | "low" | "medium" | "high" | "critical";

export interface GitHubRepository {
  id: string;
  fullName: string;
}

export interface GitHubOAuthStartWebResponse {
  mode: "web";
  authorizeUrl: string;
  state: string;
  expiresAt: string;
  redirectUri: string;
}

export interface GitHubOAuthStartDeviceResponse {
  mode: "device";
  authorizeUrl: string;
  sessionId: string;
  userCode: string;
  expiresAt: string;
  intervalSeconds: number;
}

export type GitHubOAuthStartResponse = GitHubOAuthStartWebResponse | GitHubOAuthStartDeviceResponse;

export type GitHubOAuthPollResponse =
  | {
    status: "pending";
    retryAfterSeconds: number;
  }
  | {
    status: "connected";
    identity: {
      id: string;
      login: string;
      connected: boolean;
    };
  }
  | {
    status: "failed";
    message: string;
  };

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  author: string;
  targetBranch: string;
  /** Mirrors the API's PullRequestState — used to count genuinely-open PRs. */
  state: "open" | "closed" | "merged" | "draft";
  additions: number;
  deletions: number;
  changedFileCount: number;
  riskHint: RiskHint;
}

export interface ReviewRun {
  id: string;
  pullRequestId: string;
  status: "queued" | "wetting" | "graphing" | "reviewing" | "completed" | "failed" | "cancelled";
  currentPhase: string;
  findingCount: number;
}

/**
 * Strongly-typed review pipeline phase. Mirrors the ordered phase strings the
 * orchestrator emits (`queued` → `diff_dag` → `program_shape` → `tcsrct` →
 * `llm_provider` → `llm_merged`) plus the terminal lifecycle states.
 */
export const REVIEW_PHASES = [
  "idle",
  "queued",
  "diff_dag",
  "program_shape",
  "tcsrct",
  "llm_provider",
  "llm_merged",
  "completed",
  "failed",
  "cancelled",
] as const;

export type ReviewPhase = (typeof REVIEW_PHASES)[number];

/** Ordinal position of a phase along the happy-path pipeline (terminal states map to the end). */
export const REVIEW_PHASE_ORDER: Readonly<Record<ReviewPhase, number>> = {
  idle: 0,
  queued: 1,
  diff_dag: 2,
  program_shape: 3,
  tcsrct: 4,
  llm_provider: 5,
  llm_merged: 6,
  completed: 7,
  failed: 7,
  cancelled: 7,
};

/** Coarse pipeline stages surfaced in the UI, each gated by the phase that first enters it. */
export type ReviewStageKey = "queued" | "graph" | "wetting" | "tcsrct" | "llm" | "complete";

/** Normalize a raw backend phase string (which may carry a `:detail` suffix) into a typed phase. */
export function toReviewPhase(raw: string | null | undefined): ReviewPhase {
  if (!raw) {
    return "idle";
  }
  const head = raw.split(":")[0].trim().toLowerCase();
  return (REVIEW_PHASES as readonly string[]).includes(head) ? (head as ReviewPhase) : "idle";
}

export interface ReviewFinding {
  id: string;
  severity: "blocker" | "high" | "medium" | "low" | "note";
  /** TCSRTC gate the finding was raised under (field name is legacy). */
  passName: string;
  filePath: string;
  line?: number;
  title: string;
  finding: string;
  confidence: number;
  evidence?: string[];
  suggestedFix?: string;
  suggestion?: ReviewSuggestion;
}

export interface ReviewSuggestion {
  startLine: number;
  endLine: number;
  code: string;
}

export interface ReviewChecklistItem {
  id: string;
  description: string;
  command?: string;
  completed: boolean;
}

/** A durable server-side review run clients attach to and detach from. */
export interface ReviewSessionSummary {
  runId: string;
  pullRequestId: string;
  active: boolean;
  startedAt: string;
  eventCount: number;
}

/**
 * The six TCSRTC Feature Process gates the review agent walks, in order.
 * Findings are raised under these gates — the single public formalism.
 */
export const TCSRTC_GATES = [
  "Target",
  "Constrain",
  "Sanitize",
  "Review",
  "Test",
  "Confirm",
] as const;

export type TcsrtcGate = (typeof TCSRTC_GATES)[number];

/** One line of the live review narrative rendered in the Run tab. */
export interface ReviewNarrativeEntry {
  id: string;
  kind: "stage" | "thinking" | "tool" | "finding" | "gate";
  cycle?: number;
  gate?: TcsrtcGate;
  tool?: string;
  ok?: boolean;
  severity?: string;
  text: string;
}

export interface ReviewProgress {
  percent: number;
  coveredPasses: number;
  totalPasses: number;
  findingCount: number;
  nextPass: string | null;
  goalAchieved: boolean;
}

export interface ReviewCycleSummary {
  cycle: number;
  /** TCSRTC gate the cycle ran under. */
  pass: string;
  reason: string;
  findingCount: number;
  progress: ReviewProgress;
}

export interface ReviewRunResult {
  runId: string;
  pullRequestId: string;
  phase: ReviewPhase;
  stopReason: string;
  goalAchieved: boolean;
  findingCount: number;
  blockerCount: number;
  highCount: number;
  progress: ReviewProgress;
  cycles: ReviewCycleSummary[];
}

/** Typed event union streamed over SSE for a live agentic review run. */
export type ReviewRunEvent =
  | { type: "run_start"; runId: string; pullRequestId: string; phase: ReviewPhase }
  | { type: "phase"; phase: ReviewPhase; detail?: string }
  | { type: "graph"; nodeCount: number; edgeCount: number }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "thinking"; cycle: number; gate: TcsrtcGate; text: string }
  | { type: "tool"; cycle: number; tool: string; ok: boolean; summary: string; reason?: string }
  | { type: "finding"; finding: ReviewFinding }
  | {
    type: "cycle";
    cycle: number;
    gate: TcsrtcGate;
    toolCount: number;
    findingCount: number;
    gatesCovered: number;
    gatesTotal: number;
    tokensUsed: number;
    inputTokens: number;
    outputTokens: number;
  }
  | { type: "report"; markdown: string }
  | { type: "done"; result: ReviewRunResult };

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

export interface ReviewAgentRunRecord {
  runId: string;
  pullRequestId: string;
  repositoryId: string;
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
  changedFileCount: number;
  nodeCount: number;
  edgeCount: number;
  torusVariance: number;
  findings: ReviewFinding[];
  summary: string;
  report: string;
  traceEnabled: boolean;
}


export interface GraphNode {
  id: string;
  kind: "file" | "symbol" | "test" | "config";
  path: string;
  name: string;
  language?: string;
  changed: boolean;
  weight: number;
}

export interface GraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  /** Open union: the API grows edge kinds (e.g. "semantic") ahead of the UI. */
  kind: string;
  directed: boolean;
  weight: number;
}

export interface GraphShapeSample {
  nodeId: string;
  theta: number;
  phi: number;
  curvature: number;
  torsion: number;
  riskGradient: number;
}

export interface GraphSnapshotView {
  dag: {
    id: string;
    pullRequestId: string;
    nodeCount: number;
    edgeCount: number;
    changedNodeCount: number;
    saturation: number;
    torusVariance: number;
    flowCompleteness: number;
    completenessNotes: string[];
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  shapeSamples: GraphShapeSample[];
  surfaces: Array<{
    id: string;
    surfaceKind: string;
    entryNodeId: string;
    riskScore: number;
    reason: string;
  }>;
}

export interface CdpSessionSummary {
  sessionId: string;
  targetId: string;
  targetUrl: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface CdpWorkStep {
  action: string;
  [key: string]: unknown;
}

export interface CdpWorkUnitRequest {
  name?: string;
  stopOnFailure?: boolean;
  steps: CdpWorkStep[];
}

export interface CdpWorkStepResult {
  action: string;
  ok: boolean;
  durationMs: number;
  output?: unknown;
  error?: string;
}

export interface CdpWorkUnitResult {
  sessionId: string;
  name: string;
  success: boolean;
  startedAt: string;
  finishedAt: string;
  steps: CdpWorkStepResult[];
}

export interface RetvCdpToolCall {
  tool: "navigate" | "waitForSelector" | "click" | "type" | "extractText" | "assertText" | "evaluate" | "readPage";
  args: Record<string, unknown>;
  reason: string;
}

export interface RetvCdpCycleSummary {
  cycle: number;
  observation: {
    url: string;
    title: string;
    activePageTab: string;
    activeRunTab: string;
    buttonLabels: string[];
    headings: string[];
    interactiveLabels: string[];
    visibleText: string;
    timestamp: string;
  };
  toolCalls: RetvCdpToolCall[];
  workUnit: {
    name: string;
    success: boolean;
    failedSteps: number;
  };
  toolOutputs: string[];
  findings: string[];
  plannerRaw?: string;
  screenshot?: string;
}

export interface RetvCdpRunResult {
  runId: string;
  sessionId: string;
  goal: string;
  allowedOrigin: string;
  stopReason: string;
  functionalTestSucceeded: boolean;
  goalAchieved: boolean;
  structuredPlan: {
    milestones: string[];
    successCriteria: string[];
    antiDriftRules: string[];
  };
  progress: {
    percent: number;
    completedMilestones: number;
    totalMilestones: number;
    nextMilestone: string;
    roundsWithoutProgress: number;
    driftWarnings: number;
    goalAchieved: boolean;
  };
  cycles: RetvCdpCycleSummary[];
  findings: string[];
  summary: string;
  report: string;
  traceEnabled: boolean;
}

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
  report: string;
  traceEnabled: boolean;
}

export type RetvPlannerProviderKind =
  | "github_copilot"
  | "openrouter"
  | "anthropic"
  | "gemini"
  | "ihhi_bedrock"
  | "codex_app_server"
  | "claude_code"
  | "openai_compatible";

export interface RetvPlannerConfigView {
  providerKind: RetvPlannerProviderKind;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  availableProviderKinds: RetvPlannerProviderKind[];
}

export interface RetvPlannerConfigUpdate {
  providerKind?: RetvPlannerProviderKind;
  model?: string;
  baseUrl?: string;
}

export interface AgentTranscriptItem {
  id: string;
  role: "agent" | "user" | "system";
  message: string;
  kind?: "info" | "question" | "result" | "error";
  at: string;
}

export type RetvCdpRunEvent =
  | { type: "run_start"; runId: string; sessionId: string; goal: string; allowedOrigin: string }
  | {
    type: "plan";
    structuredPlan: { milestones: string[]; successCriteria: string[]; antiDriftRules: string[] };
  }
  | { type: "observation"; cycle: number; observation: RetvCdpCycleSummary["observation"] }
  | { type: "planner_delta"; cycle: number; text: string }
  | { type: "planner"; cycle: number; rawContent: string; toolCalls: RetvCdpToolCall[]; findings: string[] }
  | { type: "screenshot"; cycle: number; dataUrl: string }
  | { type: "cycle"; cycle: RetvCdpCycleSummary; progress: RetvCdpRunResult["progress"] }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "summary"; summary: string }
  | { type: "report"; report: string }
  | { type: "done"; result: RetvCdpRunResult };

export interface AgentConsoleLine {
  id: string;
  at: string;
  channel: "system" | "observe" | "plan" | "tool" | "llm" | "finding" | "result" | "user";
  text: string;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { ReviewPacket, RiskSurface, TcsrctPass } from "../../domain/entities.ts";

export const RETV_PHASE_SEQUENCE = ["reason", "toolform", "act", "observe", "update", "decide"] as const;

export type RetvDecision = "continue" | "stop" | "backtrack";
export type RetvPhase = (typeof RETV_PHASE_SEQUENCE)[number];
export type RetvTask =
  | "tests.plan_regression"
  | "graph.expand_persistence_path"
  | "graph.expand_auth_boundary"
  | "graph.expand_runtime_path";
export type RetvStopConditionKind = "iteration_budget_exhausted" | "no_surfaces" | "risk_threshold_met";

/// TCSRTC Feature Process gates (Target -> Constrain -> Sanitize -> Review -> Test -> Confirm).
export type TcsrtcGate = "Target" | "Constrain" | "Sanitize" | "Review" | "Test" | "Confirm";

export interface RetvStopCondition {
  kind: RetvStopConditionKind;
  iterationId?: string;
  decision?: RetvDecision;
}

export interface RetvLoopPolicy {
  maxIterations: number;
  minEvidencePerIteration: number;
  stopRiskThreshold: number;
  requireGraphCompleteness: number;
}

export interface RetvObservation {
  phase: RetvPhase;
  summary: string;
  evidence: string[];
  success: boolean;
}

export interface RetvTraceElement {
  iterationId: string;
  surfaceId: string;
  phase: RetvPhase;
  summary: string;
}

export type RetvToolArgValue = string | number | boolean;

export interface RetvToolCall {
  toolName:
    | "dag.inspect_neighbors"
    | "dag.inspect_entry"
    | "cdp.navigate"
    | "cdp.wait_for_selector"
    | "cdp.extract_text"
    | "cdp.assert_text"
    | "tests.plan_regression"
    | "tests.assert_failure_first";
  args: Record<string, RetvToolArgValue>;
  expectedObservation: string;
}

export interface RetvLoopIteration {
  iterationId: string;
  surfaceId: string;
  passName: TcsrctPass["name"];
  tcsrtcGate: TcsrtcGate;
  reasoningSummary: string;
  selectedTask: RetvTask;
  toolPlan: RetvToolCall[];
  observationSummary: string;
  decision: RetvDecision;
  evidence: string[];
  phases: RetvObservation[];
}

export interface RetvLoopResult {
  iterations: RetvLoopIteration[];
  traces: RetvTraceElement[];
  stopCondition: RetvStopCondition;
  stopReason: string;
}

const DEFAULT_POLICY: RetvLoopPolicy = {
  maxIterations: 6,
  minEvidencePerIteration: 3,
  stopRiskThreshold: 0.45,
  requireGraphCompleteness: 0.7,
};

const MIN_POLICY: Readonly<RetvLoopPolicy> = {
  maxIterations: 1,
  minEvidencePerIteration: 1,
  stopRiskThreshold: 0,
  requireGraphCompleteness: 0,
};

const MAX_POLICY: Readonly<RetvLoopPolicy> = {
  maxIterations: 32,
  minEvidencePerIteration: 12,
  stopRiskThreshold: 1,
  requireGraphCompleteness: 1,
};

const PASS_BY_SURFACE_KIND: Readonly<Record<RiskSurface["surfaceKind"], TcsrctPass["name"]>> = {
  auth: "Contracts",
  persistence: "State",
  payment: "Runtime",
  public_api: "Runtime",
  configuration: "Runtime",
  runtime: "Runtime",
  performance: "Runtime",
  concurrency: "Runtime",
  data_model: "Runtime",
  test_gap: "Tests",
};

/// The TCSRTC gate whose checklist most directly catches each risk class.
const GATE_BY_SURFACE_KIND: Readonly<Record<RiskSurface["surfaceKind"], TcsrtcGate>> = {
  auth: "Review",
  persistence: "Test",
  payment: "Test",
  public_api: "Constrain",
  configuration: "Constrain",
  runtime: "Test",
  performance: "Test",
  concurrency: "Test",
  data_model: "Review",
  test_gap: "Test",
};

const TASK_BY_SURFACE_KIND: Readonly<Record<RiskSurface["surfaceKind"], RetvTask>> = {
  auth: "graph.expand_auth_boundary",
  persistence: "graph.expand_persistence_path",
  payment: "graph.expand_runtime_path",
  public_api: "graph.expand_runtime_path",
  configuration: "graph.expand_runtime_path",
  runtime: "graph.expand_runtime_path",
  performance: "graph.expand_runtime_path",
  concurrency: "graph.expand_runtime_path",
  data_model: "graph.expand_runtime_path",
  test_gap: "tests.plan_regression",
};

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampRatio(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function normalizePolicy(policy: Partial<RetvLoopPolicy>): RetvLoopPolicy {
  return {
    maxIterations: clampInteger(policy.maxIterations ?? DEFAULT_POLICY.maxIterations, MIN_POLICY.maxIterations, MAX_POLICY.maxIterations),
    minEvidencePerIteration: clampInteger(
      policy.minEvidencePerIteration ?? DEFAULT_POLICY.minEvidencePerIteration,
      MIN_POLICY.minEvidencePerIteration,
      MAX_POLICY.minEvidencePerIteration,
    ),
    stopRiskThreshold: clampRatio(
      policy.stopRiskThreshold ?? DEFAULT_POLICY.stopRiskThreshold,
      MIN_POLICY.stopRiskThreshold,
      MAX_POLICY.stopRiskThreshold,
    ),
    requireGraphCompleteness: clampRatio(
      policy.requireGraphCompleteness ?? DEFAULT_POLICY.requireGraphCompleteness,
      MIN_POLICY.requireGraphCompleteness,
      MAX_POLICY.requireGraphCompleteness,
    ),
  };
}

function formatStopReason(stopCondition: RetvStopCondition): string {
  if (stopCondition.kind === "risk_threshold_met" && stopCondition.iterationId) {
    return `stop_at_${stopCondition.iterationId}`;
  }
  return stopCondition.kind;
}

function selectTask(surface: RiskSurface): RetvTask {
  return TASK_BY_SURFACE_KIND[surface.surfaceKind];
}

function selectGate(surface: RiskSurface): TcsrtcGate {
  return GATE_BY_SURFACE_KIND[surface.surfaceKind] ?? "Review";
}

function selectPass(surface: RiskSurface, passes: TcsrctPass[]): TcsrctPass["name"] {
  const desired = PASS_BY_SURFACE_KIND[surface.surfaceKind];

  const match = passes.find((pass) => pass.name === desired);
  return match?.name || passes[0]?.name || "CodeShape";
}

function buildToolPlan(surface: RiskSurface, selectedTask: RetvTask): RetvToolCall[] {
  const tools: RetvToolCall[] = [
    {
      toolName: "dag.inspect_entry",
      args: {
        entryNodeId: surface.entryNodeId,
        focus: surface.surfaceKind,
      },
      expectedObservation: "Entry node dependencies and direct fan-out are loaded.",
    },
  ];

  if (selectedTask === "graph.expand_auth_boundary") {
    tools.push({
      toolName: "dag.inspect_neighbors",
      args: {
        boundary: "auth",
        maxDepth: 2,
      },
      expectedObservation: "Auth ingress/egress paths and trust boundaries are visible.",
    });
  } else if (selectedTask === "graph.expand_persistence_path") {
    tools.push({
      toolName: "dag.inspect_neighbors",
      args: {
        boundary: "persistence",
        maxDepth: 3,
      },
      expectedObservation: "Persistence writes/reads and transaction fan-out are visible.",
    });
  } else if (selectedTask === "tests.plan_regression") {
    tools.push(
      {
        toolName: "tests.plan_regression",
        args: {
          focus: surface.surfaceKind,
          requiresFailureFirst: true,
        },
        expectedObservation: "Regression test candidates include a failing pre-fix assertion.",
      },
      {
        toolName: "tests.assert_failure_first",
        args: {
          gate: "tdd",
        },
        expectedObservation: "Proposed test fails against current behavior before any fix.",
      },
    );
  } else {
    tools.push(
      {
        toolName: "cdp.navigate",
        args: {
          target: "runtime-surface",
        },
        expectedObservation: "Runtime flow for the target surface is reachable.",
      },
      {
        toolName: "cdp.extract_text",
        args: {
          selector: "body",
        },
        expectedObservation: "UI/runtime text confirms the currently active path.",
      },
    );
  }

  return tools;
}

export function buildRetvLoop(packet: ReviewPacket): RetvLoopIteration[] {
  return runRetvLoop(packet).iterations;
}

export function runRetvLoop(packet: ReviewPacket, policy: Partial<RetvLoopPolicy> = {}): RetvLoopResult {
  const effectivePolicy = normalizePolicy(policy);

  const graphCompleteness = deriveGraphCompleteness(packet);
  const sorted = packet.riskSurfaces
    .slice()
    .sort((left, right) => right.riskScore - left.riskScore)
    .slice(0, effectivePolicy.maxIterations);

  const iterations: RetvLoopIteration[] = [];
  const traces: RetvTraceElement[] = [];
  let stopCondition: RetvStopCondition = {
    kind: "iteration_budget_exhausted",
  };

  for (let index = 0; index < sorted.length; index += 1) {
    const surface = sorted[index];
    const iteration = toIteration(packet, surface, index, sorted.length, graphCompleteness, effectivePolicy);
    iterations.push(iteration);

    for (const phase of iteration.phases) {
      traces.push({
        iterationId: iteration.iterationId,
        surfaceId: iteration.surfaceId,
        phase: phase.phase,
        summary: phase.summary,
      });
    }

    if (iteration.decision === "stop") {
      stopCondition = {
        kind: "risk_threshold_met",
        iterationId: iteration.iterationId,
        decision: iteration.decision,
      };
      break;
    }
  }

  if (iterations.length === 0) {
    stopCondition = {
      kind: "no_surfaces",
    };
  }

  return {
    iterations,
    traces,
    stopCondition,
    stopReason: formatStopReason(stopCondition),
  };
}

function toIteration(
  packet: ReviewPacket,
  surface: RiskSurface,
  index: number,
  total: number,
  graphCompleteness: number,
  policy: RetvLoopPolicy,
): RetvLoopIteration {
  const passName = selectPass(surface, packet.tcsrctPasses);
  const selectedTask = selectTask(surface);
  const tcsrtcGate = selectGate(surface);
  const toolPlan = buildToolPlan(surface, selectedTask);
  const evidence = buildEvidence(surface, graphCompleteness, packet, tcsrtcGate);
  const decision = decide(surface, index, total, graphCompleteness, evidence.length, policy);
  const iterationId = `retv_${index + 1}`;
  const reasoningSummary = `Prioritize ${surface.surfaceKind} due to risk ${surface.riskScore.toFixed(3)} on entry ${surface.entryNodeId}`;
  const observationSummary = `TCSRCT pass ${passName} validates evidence for ${surface.surfaceKind}`;

  const phases: RetvObservation[] = [
    {
      phase: RETV_PHASE_SEQUENCE[0],
      summary: reasoningSummary,
      evidence: [`surface.risk=${surface.riskScore.toFixed(3)}`],
      success: true,
    },
    {
      phase: RETV_PHASE_SEQUENCE[1],
      summary: `selected_task=${selectedTask}; tools=${toolPlan.map((tool) => tool.toolName).join(",")}`,
      evidence: [`pass=${passName}`, `tool_count=${toolPlan.length}`],
      success: true,
    },
    {
      phase: RETV_PHASE_SEQUENCE[2],
      summary: `execute_${selectedTask}`,
      evidence: toolPlan.map((tool) => `tool.call=${tool.toolName}`),
      success: true,
    },
    {
      phase: RETV_PHASE_SEQUENCE[3],
      summary: observationSummary,
      evidence,
      success: evidence.length >= policy.minEvidencePerIteration,
    },
    {
      phase: RETV_PHASE_SEQUENCE[4],
      summary: `trace.updated iteration=${iterationId}`,
      evidence: [`graph.completeness=${graphCompleteness.toFixed(3)}`],
      success: true,
    },
    {
      phase: RETV_PHASE_SEQUENCE[5],
      summary: `decision=${decision}`,
      evidence: [`remaining=${Math.max(0, total - (index + 1))}`],
      success: true,
    },
  ];

  return {
    iterationId,
    surfaceId: surface.id,
    passName,
    tcsrtcGate,
    reasoningSummary,
    selectedTask,
    toolPlan,
    observationSummary,
    decision,
    evidence,
    phases,
  };
}

function buildEvidence(
  surface: RiskSurface,
  graphCompleteness: number,
  packet: ReviewPacket,
  tcsrtcGate: TcsrtcGate,
): string[] {
  const changedFiles = packet.changedFiles.map((file) => file.path).slice(0, 3).join(",") || "none";
  return [
    `surface.kind=${surface.surfaceKind}`,
    `surface.risk=${surface.riskScore.toFixed(3)}`,
    `surface.entry=${surface.entryNodeId}`,
    `tcsrtc.gate=${tcsrtcGate}`,
    `graph.completeness=${graphCompleteness.toFixed(3)}`,
    `changed.files=${changedFiles}`,
  ];
}

function decide(
  surface: RiskSurface,
  index: number,
  total: number,
  graphCompleteness: number,
  evidenceCount: number,
  policy: RetvLoopPolicy,
): RetvDecision {
  if (evidenceCount < policy.minEvidencePerIteration) {
    return "backtrack";
  }

  if (graphCompleteness < policy.requireGraphCompleteness && index < total - 1) {
    return "continue";
  }

  if (surface.riskScore <= policy.stopRiskThreshold || index === total - 1) {
    return "stop";
  }

  return "continue";
}

function deriveGraphCompleteness(packet: ReviewPacket): number {
  const fromSummary = /flow completeness\s+([0-9.]+)/i.exec(packet.summary);
  if (fromSummary) {
    const parsed = Number(fromSummary[1]);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
      return parsed;
    }
  }

  const changed = Math.max(1, packet.changedFiles.length);
  const surfaces = Math.max(1, packet.riskSurfaces.length);
  return Math.min(1, Math.max(0.45, 1 - (surfaces / (changed * 4))));
}

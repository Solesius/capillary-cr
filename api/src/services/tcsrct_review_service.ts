// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import {
  DiffFile,
  ModuleEdge,
  ModuleNode,
  ProgramShapeSample,
  ReviewChecklistItem,
  ReviewFinding,
  ReviewPacket,
  RiskSurface,
  TcsrctPass,
} from "../domain/entities.ts";
import { AppError } from "../domain/errors.ts";
import { enforceDefensiveInput } from "../lib/validation.ts";
import { ReviewRepository } from "../repositories/review_repository.ts";

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

const PASSES: TcsrctPass[] = [
  { id: "pass_trace", name: "Trace", description: "Runtime traversal path validation", enabled: true, maxFindings: 10 },
  { id: "pass_contracts", name: "Contracts", description: "API and type contracts", enabled: true, maxFindings: 10 },
  { id: "pass_state", name: "State", description: "State transition analysis", enabled: true, maxFindings: 10 },
  { id: "pass_runtime", name: "Runtime", description: "Runtime hazards", enabled: true, maxFindings: 10 },
  { id: "pass_codeshape", name: "CodeShape", description: "Structural drift and complexity", enabled: true, maxFindings: 10 },
  { id: "pass_tests", name: "Tests", description: "Regression and coverage gaps", enabled: true, maxFindings: 10 },
];

export class TcsrctReviewService {
  constructor(private readonly repository: ReviewRepository) {}

  buildReviewPacket(runId: string): ReviewPacket {
    enforceDefensiveInput(runId, "run_id");
    const run = this.repository.getReviewRun(runId);
    const graph = this.repository.findGraphByPullRequest(run.pullRequestId);
    if (!graph) {
      throw new AppError("diff_dag_not_found", 404, "diff_dag_not_found");
    }

    const packet: ReviewPacket = {
      id: createId("packet"),
      pullRequestId: run.pullRequestId,
      diffDagId: graph.dag.id,
      summary: "Capillary review packet generated",
      changedFiles: graph.nodes.filter((n) => n.changed).map((node) => ({
        path: node.path,
        status: "modified",
        additions: 0,
        deletions: 0,
        language: node.language,
        isTest: node.kind === "test",
        isConfig: node.kind === "config",
        isGenerated: false,
      })),
      neighborFiles: graph.nodes.filter((n) => !n.changed).map((node) => ({
        path: node.path,
        status: "modified",
        additions: 0,
        deletions: 0,
        language: node.language,
        isTest: node.kind === "test",
        isConfig: node.kind === "config",
        isGenerated: false,
      })),
      riskSurfaces: graph.surfaces,
      shapeSamples: graph.shapeSamples,
      tcsrctPasses: PASSES,
    };

    this.repository.saveReviewPacket(packet);
    this.repository.updateReviewRun(runId, (current) => ({
      ...current,
      packetId: packet.id,
      currentPhase: "packet_built",
    }));

    return packet;
  }

  runModifiedTcsrct(runId: string): ReviewFinding[] {
    enforceDefensiveInput(runId, "run_id");
    const run = this.repository.getReviewRun(runId);
    if (!run.packetId) {
      throw new AppError("review_packet_not_found", 404, "review_packet_not_found");
    }

    const packet = this.repository.getReviewPacket(run.packetId);

    const graph = this.repository.getGraphSnapshot(packet.diffDagId);
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const shapeByNodeId = new Map(graph.shapeSamples.map((sample) => [sample.nodeId, sample]));
    const graphStats = buildGraphStats(graph.nodes, graph.edges);

    const repositoryId = this.repository.findPullRequestRepositoryId(packet.pullRequestId);
    const diffByPath = new Map<string, DiffFile>();
    if (repositoryId) {
      for (const diff of this.repository.getPullRequestDiff(repositoryId, packet.pullRequestId)) {
        diffByPath.set(normalizePath(diff.path), diff);
      }
    }

    const findings: ReviewFinding[] = packet.riskSurfaces
      .slice()
      .sort((left, right) => right.riskScore - left.riskScore)
      .map((surface) => {
        const entryNode = nodeById.get(surface.entryNodeId);
        const shape = shapeByNodeId.get(surface.entryNodeId);
        const normalizedFilePath = normalizePath(extractNodeFilePath(entryNode?.path));
        const sourceDiff = diffByPath.get(normalizedFilePath);
        const nodeStats = graphStats.get(surface.entryNodeId) || { inDegree: 0, outDegree: 0, neighbors: [] as string[] };
        const patchSignals = collectPatchSignals(sourceDiff?.patch);

        const titleTarget = entryNode?.name || basenamePath(normalizedFilePath) || "entry-node";
        const passName = passForSurface(surface.surfaceKind, packet.tcsrctPasses);
        const line = estimateLineFromPatch(
          sourceDiff?.patch,
          buildLineAnchor(surface.surfaceKind, entryNode?.name, sourceDiff?.path),
        );
        const churn = (sourceDiff?.additions || 0) + (sourceDiff?.deletions || 0);

        return {
          id: createId("finding"),
          runId,
          severity: severityFromSignals(
            surface.riskScore,
            nodeStats.inDegree,
            nodeStats.outDegree,
            churn,
            graph.dag.flowCompleteness,
            entryNode?.kind,
            normalizedFilePath,
          ),
          passName,
          filePath: normalizedFilePath || "unknown",
          line,
          title: `${surface.surfaceKind} instability around ${titleTarget}`,
          finding: buildFindingNarrative(surface, entryNode, shape, nodeStats, sourceDiff, graph.dag),
          evidence: buildEvidence(surface, entryNode, shape, nodeStats, sourceDiff, patchSignals, graph.dag),
          suggestedFix: suggestedFixForSurface(surface.surfaceKind, normalizedFilePath),
          confidence: confidenceFromSignals(
            surface,
            shape,
            nodeStats,
            sourceDiff,
            patchSignals,
            graph.dag.flowCompleteness,
            graph.dag.torusVariance,
          ),
        };
      });

    const deduped = dedupeFindings(findings);
    const prioritized = sortFindingsForPriority(deduped);
    this.repository.saveFindings(runId, prioritized);

    const blockerCount = prioritized.filter((f) => f.severity === "blocker").length;
    const highCount = prioritized.filter((f) => f.severity === "high").length;

    this.repository.updateReviewRun(runId, (current) => ({
      ...current,
      status: "completed",
      currentPhase: "completed",
      finishedAt: new Date().toISOString(),
      findingCount: prioritized.length,
      blockerCount,
      highCount,
    }));

    return prioritized;
  }

  produceAuthorChecklist(runId: string): ReviewChecklistItem[] {
    enforceDefensiveInput(runId, "run_id");
    const findings = this.repository.getFindings(runId);

    const baseChecklist: ReviewChecklistItem[] = findings.map((finding) => ({
      id: createId("check"),
      runId,
      command: finding.filePath.endsWith(".ts") ? "deno test --allow-env --allow-net" : undefined,
      description: `Verify and resolve: ${finding.title}`,
      required: true,
      completed: false,
    }));

    if (baseChecklist.length === 0) {
      baseChecklist.push({
        id: createId("check"),
        runId,
        command: "deno task test",
        description: "No findings. Run complete test suite to preserve baseline.",
        required: true,
        completed: false,
      });
    }

    this.repository.saveChecklist(runId, baseChecklist);
    return baseChecklist;
  }
}

function buildGraphStats(nodes: ModuleNode[], edges: ModuleEdge[]): Map<string, { inDegree: number; outDegree: number; neighbors: string[] }> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const stats = new Map<string, { inDegree: number; outDegree: number; neighbors: Set<string> }>();

  for (const node of nodes) {
    stats.set(node.id, { inDegree: 0, outDegree: 0, neighbors: new Set() });
  }

  for (const edge of edges) {
    const from = stats.get(edge.fromNodeId);
    const to = stats.get(edge.toNodeId);
    if (!from || !to) {
      continue;
    }

    from.outDegree += 1;
    to.inDegree += 1;
    from.neighbors.add(edge.toNodeId);
    to.neighbors.add(edge.fromNodeId);
  }

  const result = new Map<string, { inDegree: number; outDegree: number; neighbors: string[] }>();
  for (const [nodeId, value] of stats.entries()) {
    const neighbors = Array.from(value.neighbors)
      .map((neighborId) => nodeById.get(neighborId)?.path || neighborId)
      .map(extractNodeFilePath)
      .map(normalizePath)
      .filter(Boolean)
      .slice(0, 6);

    result.set(nodeId, {
      inDegree: value.inDegree,
      outDegree: value.outDegree,
      neighbors,
    });
  }

  return result;
}

function buildFindingNarrative(
  surface: RiskSurface,
  entryNode: ModuleNode | undefined,
  shape: ProgramShapeSample | undefined,
  nodeStats: { inDegree: number; outDegree: number; neighbors: string[] },
  diff: DiffFile | undefined,
  dag: { flowCompleteness: number; torusVariance: number; completenessNotes: string[] },
): string {
  const risk = surface.riskScore.toFixed(3);
  const curvature = shape ? shape.curvature.toFixed(3) : "n/a";
  const torsion = shape ? shape.torsion.toFixed(3) : "n/a";
  const churn = diff ? `${diff.additions}+/${diff.deletions}-` : "n/a";
  const nodeKind = entryNode?.kind || "unknown";
  const flowCompleteness = dag.flowCompleteness.toFixed(3);
  const torusVariance = dag.torusVariance.toFixed(3);

  return [
    `${surface.reason}.`,
    `Surface ${surface.surfaceKind} scored ${risk} on DAG entry ${entryNode?.id || "unknown"} (${nodeKind}).`,
    `Shape curvature=${curvature}, torsion=${torsion}; edge pressure in=${nodeStats.inDegree}, out=${nodeStats.outDegree}.`,
    `Changed-file churn at entry path is ${churn}.`,
    `Flow completeness=${flowCompleteness}, torus variance=${torusVariance}.`,
    `Flow note: ${dag.completenessNotes[0] || "none"}.`,
  ].join(" ");
}

function buildEvidence(
  surface: RiskSurface,
  entryNode: ModuleNode | undefined,
  shape: ProgramShapeSample | undefined,
  nodeStats: { inDegree: number; outDegree: number; neighbors: string[] },
  diff: DiffFile | undefined,
  patchSignals: string[],
  dag: { flowCompleteness: number; torusVariance: number; completenessNotes: string[] },
): string[] {
  const evidence = [
    `surface.kind=${surface.surfaceKind}`,
    `surface.risk=${surface.riskScore.toFixed(3)}`,
    `entry.node.id=${surface.entryNodeId}`,
    `entry.node.path=${normalizePath(extractNodeFilePath(entryNode?.path)) || "unknown"}`,
    `entry.node.kind=${entryNode?.kind || "unknown"}`,
    `entry.node.weight=${entryNode?.weight?.toFixed(3) || "n/a"}`,
    `entry.graph.in_degree=${nodeStats.inDegree}`,
    `entry.graph.out_degree=${nodeStats.outDegree}`,
    `entry.graph.neighbors=${nodeStats.neighbors.join(", ") || "none"}`,
    `dag.flow_completeness=${dag.flowCompleteness.toFixed(3)}`,
    `dag.torus_variance=${dag.torusVariance.toFixed(3)}`,
    `dag.completeness_notes=${dag.completenessNotes.join(" | ") || "none"}`,
  ];

  if (shape) {
    evidence.push(`entry.shape.curvature=${shape.curvature.toFixed(3)}`);
    evidence.push(`entry.shape.torsion=${shape.torsion.toFixed(3)}`);
    evidence.push(`entry.shape.risk_gradient=${shape.riskGradient.toFixed(3)}`);
    evidence.push(`entry.shape.interop_magnitude=${shape.interopMagnitude.toFixed(3)}`);
  }

  if (diff) {
    evidence.push(`entry.diff.status=${diff.status}`);
    evidence.push(`entry.diff.additions=${diff.additions}`);
    evidence.push(`entry.diff.deletions=${diff.deletions}`);
    evidence.push(`entry.diff.language=${diff.language || "unknown"}`);
  }

  for (const signal of patchSignals.slice(0, 5)) {
    evidence.push(`entry.patch.signal=${signal}`);
  }

  return evidence;
}

function severityFromSignals(
  riskScore: number,
  inDegree: number,
  outDegree: number,
  churn: number,
  flowCompleteness: number,
  nodeKind?: ModuleNode["kind"],
  filePath?: string,
): ReviewFinding["severity"] {
  const pressure = inDegree + outDegree;
  const flowPenalty = flowCompleteness < 0.62 ? 1 : 0;

  let severity: ReviewFinding["severity"];
  if (riskScore >= 0.93 && (pressure >= 10 || churn >= 1000 || flowPenalty > 0)) {
    severity = "blocker";
  } else if (riskScore >= 0.82 || (pressure >= 8 && churn >= 400) || (riskScore >= 0.74 && flowPenalty > 0)) {
    severity = "high";
  } else if (riskScore >= 0.58 || pressure >= 4 || churn >= 120) {
    severity = "medium";
  } else {
    severity = "low";
  }

  if ((nodeKind === "config" || isConfigPath(filePath)) && !(riskScore >= 0.94 && flowCompleteness < 0.5)) {
    severity = demoteSeverity(severity);
  }

  return severity;
}

function confidenceFromSignals(
  surface: RiskSurface,
  shape: ProgramShapeSample | undefined,
  nodeStats: { inDegree: number; outDegree: number; neighbors: string[] },
  diff: DiffFile | undefined,
  patchSignals: string[],
  flowCompleteness: number,
  torusVariance: number,
): number {
  let confidence = 0.55 + surface.riskScore * 0.2;
  if (shape) {
    confidence += 0.08;
  }
  if (diff) {
    confidence += 0.06;
  }
  if (patchSignals.length > 0) {
    confidence += 0.06;
  }
  if (nodeStats.inDegree + nodeStats.outDegree > 0) {
    confidence += 0.05;
  }
  confidence += torusVariance * 0.04;
  confidence -= (1 - flowCompleteness) * 0.06;

  const bounded = Math.min(0.99, Math.max(0.35, confidence));
  return Math.round(bounded * 1000) / 1000;
}

function passForSurface(surfaceKind: RiskSurface["surfaceKind"], passes: TcsrctPass[]): string {
  const mappedName = surfaceKind === "auth"
    ? "Contracts"
    : surfaceKind === "concurrency" || surfaceKind === "runtime"
    ? "Runtime"
    : surfaceKind === "test_gap"
    ? "Tests"
    : surfaceKind === "persistence"
    ? "State"
    : "CodeShape";

  const pass = passes.find((candidate) => candidate.name === mappedName);
  return pass?.name || passes[0]?.name || "CodeShape";
}

function suggestedFixForSurface(surfaceKind: RiskSurface["surfaceKind"], filePath: string): string {
  if (surfaceKind === "auth") {
    return `Harden authentication and authorization invariants around ${basenamePath(filePath)}; add explicit negative tests for bypass paths.`;
  }
  if (surfaceKind === "concurrency") {
    return `Add deterministic stress tests and lock/order assertions for ${basenamePath(filePath)}; verify cancellation and timeout propagation.`;
  }
  if (surfaceKind === "persistence") {
    return `Add persistence round-trip and rollback/error-path tests for ${basenamePath(filePath)}; enforce write/read consistency assertions.`;
  }
  if (surfaceKind === "test_gap") {
    return `Add focused regression tests that reproduce the entry-node change path and at least one failing negative scenario.`;
  }

  return `Add targeted invariants and regression tests around ${basenamePath(filePath)} based on the DAG entry-node evidence.`;
}

function collectPatchSignals(patch?: string): string[] {
  if (!patch) {
    return [];
  }

  const signals: string[] = [];
  const patterns = [
    /#include\s*[<"][^">]+[">]/,
    /import\s+.+/,
    /require\(.+\)/,
    /\basync\b|\bawait\b/,
    /\bmutex\b|\block\b|\bthread\b|\batomic\b/,
    /\btransaction\b|\bcommit\b|\brollback\b|\bpersist\b/,
  ];

  for (const raw of patch.split("\n")) {
    if (!raw.startsWith("+") || raw.startsWith("+++")) {
      continue;
    }

    const line = raw.slice(1).trim();
    if (line.length === 0) {
      continue;
    }

    if (patterns.some((pattern) => pattern.test(line))) {
      signals.push(line.slice(0, 160));
    }
  }

  return signals;
}

function estimateLineFromPatch(patch?: string, anchor?: string): number | undefined {
  if (!patch) {
    return undefined;
  }

  let currentLine: number | undefined;
  let firstHunkLine: number | undefined;
  let firstChangedLine: number | undefined;
  const anchorNeedles = toAnchorNeedles(anchor);

  for (const raw of patch.split("\n")) {
    const hunk = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(raw);
    if (hunk) {
      currentLine = Number(hunk[1]);
      if (!firstHunkLine) {
        firstHunkLine = currentLine;
      }
      continue;
    }

    if (typeof currentLine !== "number") {
      continue;
    }

    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const content = raw.slice(1).trim().toLowerCase();
      if (!firstChangedLine) {
        firstChangedLine = currentLine;
      }
      if (containsAnchor(content, anchorNeedles)) {
        return currentLine;
      }
      currentLine += 1;
      continue;
    }

    if (raw.startsWith(" ")) {
      const content = raw.slice(1).trim().toLowerCase();
      if (containsAnchor(content, anchorNeedles)) {
        return currentLine;
      }
      currentLine += 1;
      continue;
    }

    if (raw.startsWith("-") && !raw.startsWith("---")) {
      const content = raw.slice(1).trim().toLowerCase();
      if (!firstChangedLine) {
        firstChangedLine = currentLine;
      }
      if (containsAnchor(content, anchorNeedles)) {
        return currentLine;
      }
      continue;
    }
  }

  return firstChangedLine || firstHunkLine;
}

function buildLineAnchor(surfaceKind: RiskSurface["surfaceKind"], nodeName?: string, filePath?: string): string {
  const parts: string[] = [];
  if (nodeName) {
    parts.push(nodeName);
  }

  const basename = basenamePath(normalizePath(filePath || ""));
  if (basename) {
    parts.push(stripExtension(basename));
  }

  if (surfaceKind === "concurrency") {
    parts.push("mutex", "thread", "async", "await", "lock", "atomic");
  } else if (surfaceKind === "persistence") {
    parts.push("sqlite", "sql", "query", "transaction", "batch", "insert", "update");
  } else if (surfaceKind === "auth") {
    parts.push("auth", "token", "jwt", "permission", "policy");
  } else if (surfaceKind === "test_gap") {
    parts.push("test", "assert", "expect", "verify");
  }

  return parts.join(" ");
}

function toAnchorNeedles(anchor?: string): string[] {
  if (!anchor) {
    return [];
  }

  const tokens = anchor
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

  return Array.from(new Set(tokens)).slice(0, 8);
}

function containsAnchor(content: string, needles: string[]): boolean {
  if (needles.length === 0) {
    return false;
  }

  return needles.some((needle) => content.includes(needle));
}

function extractNodeFilePath(path?: string): string {
  if (!path) {
    return "unknown";
  }
  const index = path.indexOf("#");
  return index === -1 ? path : path.slice(0, index);
}

function normalizePath(path?: string): string {
  if (!path) {
    return "";
  }
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function basenamePath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function stripExtension(path: string): string {
  const index = path.lastIndexOf(".");
  if (index <= 0) {
    return path;
  }
  return path.slice(0, index);
}

function dedupeFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.passName}:${finding.filePath}:${finding.title}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function sortFindingsForPriority(findings: ReviewFinding[]): ReviewFinding[] {
  const severityRank: Record<ReviewFinding["severity"], number> = {
    blocker: 5,
    high: 4,
    medium: 3,
    low: 2,
    note: 1,
  };

  return findings.slice().sort((left, right) => {
    const leftRank = severityRank[left.severity];
    const rightRank = severityRank[right.severity];
    if (leftRank !== rightRank) {
      return rightRank - leftRank;
    }

    const leftConfig = isConfigPath(left.filePath);
    const rightConfig = isConfigPath(right.filePath);
    if (leftConfig !== rightConfig) {
      return leftConfig ? 1 : -1;
    }

    return right.confidence - left.confidence;
  });
}

function demoteSeverity(severity: ReviewFinding["severity"]): ReviewFinding["severity"] {
  if (severity === "blocker") {
    return "high";
  }
  if (severity === "high") {
    return "medium";
  }
  if (severity === "medium") {
    return "low";
  }
  return "note";
}

function isConfigPath(path?: string): boolean {
  if (!path) {
    return false;
  }

  const lower = path.toLowerCase();
  if (
    lower.endsWith(".json") ||
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml") ||
    lower.endsWith(".toml") ||
    lower.endsWith(".ini") ||
    lower.endsWith(".env") ||
    lower.endsWith(".gitignore") ||
    lower.endsWith("makefile")
  ) {
    return true;
  }

  return lower.includes("config/") || lower.includes("/configs/") || lower.includes("settings");
}

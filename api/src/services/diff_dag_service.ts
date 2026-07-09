// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import {
  DiffFile,
  DiffDag,
  ModuleEdge,
  ModuleNode,
  ProgramShapeSample,
  RiskSurface,
} from "../domain/entities.ts";
import { AppError } from "../domain/errors.ts";
import { enforceDefensiveInput } from "../lib/validation.ts";
import { ReviewRepository } from "../repositories/review_repository.ts";
import {
  GraphMathService,
  TORUS_RADIUS_MAJOR,
  TORUS_RADIUS_MINOR,
} from "./graph_math_service.ts";
import {
  cosineSimilarity,
  FileEmbeddingProvider,
  MiniLmEmbeddingService,
} from "./embedding_service.ts";

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

const SEMANTIC_EDGE_MIN_SIMILARITY = 0.45;
const SEMANTIC_EDGE_TOP_K = 3;

function defaultEmbeddingProvider(): FileEmbeddingProvider | null {
  return Deno.env.get("CAPILLARY_EMBEDDINGS") === "0" ? null : new MiniLmEmbeddingService();
}

const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
const COMMON_TOKENS = new Set([
  "const",
  "let",
  "var",
  "if",
  "else",
  "for",
  "while",
  "return",
  "new",
  "class",
  "struct",
  "interface",
  "type",
  "enum",
  "void",
  "auto",
  "true",
  "false",
  "null",
  "undefined",
  "public",
  "private",
  "protected",
  "static",
  "final",
  "import",
  "from",
  "export",
  "include",
  "using",
  "namespace",
  "async",
  "await",
  "fn",
  "pub",
  "mod",
]);

export class DiffDagService {
  constructor(
    private readonly repository: ReviewRepository,
    private readonly math: GraphMathService,
    private readonly embeddings: FileEmbeddingProvider | null = defaultEmbeddingProvider(),
  ) {}

  /**
   * Add `semantic` edges between changed files whose diffs are close in
   * meaning (MiniLM cosine over path + patch), independent of import edges.
   * Semantic edges feed the same degree statistics as structural edges, so
   * meaning-coupling flows into disturbance (theta) and risk with no extra
   * plumbing. Best-effort: embedding failures (offline model fetch,
   * CAPILLARY_EMBEDDINGS=0) leave the graph unchanged.
   */
  async enrichSemanticEdges(diffDagId: string): Promise<number> {
    if (!this.embeddings) {
      return 0;
    }
    const snapshot = this.repository.getGraphSnapshot(diffDagId);
    const fileNodes = snapshot.nodes.filter((node) => node.changed && node.kind !== "symbol");
    if (fileNodes.length < 2) {
      return 0;
    }

    const repositoryId = snapshot.dag.repositoryId ||
      this.repository.findPullRequestRepositoryId(snapshot.dag.pullRequestId);
    if (!repositoryId) {
      return 0;
    }
    const patchByPath = new Map(
      this.repository.getPullRequestDiff(repositoryId, snapshot.dag.pullRequestId)
        .map((file) => [normalizePath(file.path), file.patch || ""]),
    );

    let vectors: Map<string, Float32Array>;
    try {
      vectors = await this.embeddings.embed(fileNodes.map((node) => ({
        path: node.path,
        content: patchByPath.get(node.path) || "",
      })));
    } catch (error) {
      console.log(
        `[embeddings] semantic edges skipped: ${error instanceof Error ? error.message : error}`,
      );
      return 0;
    }

    const connected = buildAdjacency(snapshot.edges);
    const semanticEdges: ModuleEdge[] = [];
    for (let left = 0; left < fileNodes.length; left += 1) {
      const leftVector = vectors.get(fileNodes[left].path);
      if (!leftVector || leftVector.length === 0) {
        continue;
      }
      // Top-K per node keeps the graph sparse on 100+ file reviews.
      const scored: { index: number; similarity: number }[] = [];
      for (let right = 0; right < fileNodes.length; right += 1) {
        if (right === left) {
          continue;
        }
        const rightVector = vectors.get(fileNodes[right].path);
        if (!rightVector || rightVector.length === 0) {
          continue;
        }
        const similarity = cosineSimilarity(leftVector, rightVector);
        if (similarity >= SEMANTIC_EDGE_MIN_SIMILARITY) {
          scored.push({ index: right, similarity });
        }
      }
      scored.sort((a, b) => b.similarity - a.similarity);
      for (const { index, similarity } of scored.slice(0, SEMANTIC_EDGE_TOP_K)) {
        // Undirected: materialize left<right only (no mirrored pairs), and
        // skip pairs the structural graph already connects directly.
        if (index < left || connected.get(fileNodes[left].id)?.has(fileNodes[index].id)) {
          continue;
        }
        semanticEdges.push({
          id: createId("edge"),
          fromNodeId: fileNodes[left].id,
          toNodeId: fileNodes[index].id,
          kind: "semantic",
          directed: false,
          weight: Math.min(0.9, 0.3 + similarity * 0.5),
        });
      }
    }

    if (semanticEdges.length === 0) {
      return 0;
    }

    const edges = [...snapshot.edges, ...semanticEdges];
    this.repository.saveGraphSnapshot(diffDagId, {
      ...snapshot,
      dag: {
        ...snapshot.dag,
        edgeCount: edges.length,
        saturation: calculateSaturation(snapshot.nodes.length, edges.length),
      },
      edges,
    });
    return semanticEdges.length;
  }

  buildDiffDag(pullRequestId: string, repositoryId?: string): DiffDag {
    enforceDefensiveInput(pullRequestId, "pull_request_id");

    const resolvedRepositoryId = repositoryId || this.repository.findPullRequestRepositoryId(pullRequestId);
    if (!resolvedRepositoryId) {
      throw new AppError("pull_request_not_found", 404, "pull_request_not_found");
    }

    const pullRequest = this.repository.getPullRequest(resolvedRepositoryId, pullRequestId);
    const diffFiles = this.repository.getPullRequestDiff(resolvedRepositoryId, pullRequestId);
    if (diffFiles.length === 0) {
      throw new AppError("pull_request_diff_empty", 422, "pull_request_diff_empty");
    }

    const fileNodes: ModuleNode[] = diffFiles.map((file, index) => ({
      id: createId("node"),
      kind: file.isTest ? "test" : file.isConfig ? "config" : "file",
      path: normalizePath(file.path),
      name: normalizePath(file.path).split("/").at(-1) || `file_${index}`,
      language: file.language,
      changed: true,
      weight: estimateNodeWeight(file),
    }));

    const nodes: ModuleNode[] = [...fileNodes];
    const pathToNodeId = new Map<string, string>(
      fileNodes.map((node) => [normalizePath(node.path), node.id]),
    );

    const edges: ModuleEdge[] = [];
    const referencesByFile = collectReferencesByFile(diffFiles);

    for (const file of diffFiles) {
      const sourcePath = normalizePath(file.path);
      const sourceNodeId = pathToNodeId.get(sourcePath);
      if (!sourceNodeId) {
        continue;
      }

      for (const reference of referencesByFile.get(sourcePath) || []) {
        const resolvedPath = resolveReferenceToChangedPath(sourcePath, reference, pathToNodeId);
        if (!resolvedPath) {
          continue;
        }

        const targetNodeId = pathToNodeId.get(resolvedPath);
        if (!targetNodeId || targetNodeId === sourceNodeId) {
          continue;
        }

        edges.push({
          id: createId("edge"),
          fromNodeId: sourceNodeId,
          toNodeId: targetNodeId,
          kind: "imports",
          directed: true,
          weight: 0.55,
        });
      }

      for (const symbol of extractChangedSymbols(file.patch)) {
        const symbolNodeId = createId("node");
        nodes.push({
          id: symbolNodeId,
          kind: "symbol",
          path: `${sourcePath}#${symbol}`,
          name: symbol,
          language: file.language,
          changed: true,
          weight: 0.3,
        });

        edges.push({
          id: createId("edge"),
          fromNodeId: sourceNodeId,
          toNodeId: symbolNodeId,
          kind: "owns",
          directed: true,
          weight: 0.35,
        });
      }
    }

    const changeTokenMap = new Map<string, Set<string>>();
    for (const file of diffFiles) {
      changeTokenMap.set(normalizePath(file.path), extractChangeTokens(file.patch));
    }

    const filePaths = Array.from(pathToNodeId.keys());
    for (let left = 0; left < filePaths.length; left += 1) {
      for (let right = left + 1; right < filePaths.length; right += 1) {
        const leftTokens = changeTokenMap.get(filePaths[left]) || new Set<string>();
        const rightTokens = changeTokenMap.get(filePaths[right]) || new Set<string>();
        const overlap = countTokenOverlap(leftTokens, rightTokens);
        if (overlap < 3) {
          continue;
        }

        edges.push({
          id: createId("edge"),
          fromNodeId: pathToNodeId.get(filePaths[left]) as string,
          toNodeId: pathToNodeId.get(filePaths[right]) as string,
          kind: "changed_with",
          directed: false,
          weight: Math.min(0.95, 0.35 + overlap / 12),
        });
      }
    }

    if (!edges.some((edge) => edge.kind === "changed_with") && filePaths.length > 1) {
      for (let index = 1; index < filePaths.length; index += 1) {
        edges.push({
          id: createId("edge"),
          fromNodeId: pathToNodeId.get(filePaths[index - 1]) as string,
          toNodeId: pathToNodeId.get(filePaths[index]) as string,
          kind: "changed_with",
          directed: false,
          weight: 0.25,
        });
      }
    }

    const dedupedEdges = dedupeEdges(edges);
    const completeness = analyzeFlowCompleteness(nodes, dedupedEdges);

    const dag: DiffDag = {
      id: createId("dag"),
      repositoryId: resolvedRepositoryId,
      pullRequestId,
      baseSha: `base:${pullRequest.targetBranch}`,
      headSha: `head:${pullRequest.sourceBranch}`,
      nodeCount: nodes.length,
      edgeCount: dedupedEdges.length,
      changedNodeCount: fileNodes.length,
      saturation: calculateSaturation(nodes.length, dedupedEdges.length),
      torusVariance: 0,
      flowCompleteness: completeness.score,
      completenessNotes: completeness.notes,
    };

    this.repository.saveGraphSnapshot(dag.id, {
      dag,
      nodes,
      edges: dedupedEdges,
      shapeSamples: [],
      surfaces: [],
    });

    return dag;
  }

  expandDependencyWetting(diffDagId: string): DiffDag {
    enforceDefensiveInput(diffDagId, "diff_dag_id");
    const snapshot = this.repository.getGraphSnapshot(diffDagId);

    const repositoryId = snapshot.dag.repositoryId || this.repository.findPullRequestRepositoryId(snapshot.dag.pullRequestId);
    if (!repositoryId) {
      throw new AppError("pull_request_not_found", 404, "pull_request_not_found");
    }

    const diffFiles = this.repository.getPullRequestDiff(repositoryId, snapshot.dag.pullRequestId);
    const referencesByFile = collectReferencesByFile(diffFiles);

    const existingNodes = snapshot.nodes.slice();
    const existingEdges = snapshot.edges.slice();
    const pathToNodeId = new Map<string, string>(
      existingNodes.map((node) => [normalizePath(node.path), node.id]),
    );

    for (const file of diffFiles) {
      const sourcePath = normalizePath(file.path);
      const sourceNodeId = pathToNodeId.get(sourcePath);
      if (!sourceNodeId) {
        continue;
      }

      for (const reference of referencesByFile.get(sourcePath) || []) {
        const resolvedChangedPath = resolveReferenceToChangedPath(sourcePath, reference, pathToNodeId);
        if (resolvedChangedPath) {
          continue;
        }

        const neighborPath = toNeighborPath(sourcePath, reference);
        if (!neighborPath) {
          continue;
        }

        let neighborNodeId = pathToNodeId.get(neighborPath);
        if (!neighborNodeId) {
          neighborNodeId = createId("node");
          existingNodes.push({
            id: neighborNodeId,
            kind: "file",
            path: neighborPath,
            name: basenamePath(neighborPath),
            changed: false,
            weight: 0.18,
          });
          pathToNodeId.set(neighborPath, neighborNodeId);
        }

        if (neighborNodeId === sourceNodeId) {
          continue;
        }

        existingEdges.push({
          id: createId("edge"),
          fromNodeId: sourceNodeId,
          toNodeId: neighborNodeId,
          kind: "imports",
          directed: true,
          weight: 0.32,
        });
      }
    }

    const expandedEdges = dedupeEdges(existingEdges);
    const saturation = calculateSaturation(existingNodes.length, expandedEdges.length);
    const completeness = analyzeFlowCompleteness(existingNodes, expandedEdges);

    const dag: DiffDag = {
      ...snapshot.dag,
      nodeCount: existingNodes.length,
      edgeCount: expandedEdges.length,
      saturation,
      flowCompleteness: completeness.score,
      completenessNotes: completeness.notes,
    };

    this.repository.saveGraphSnapshot(diffDagId, {
      ...snapshot,
      dag,
      nodes: existingNodes,
      edges: expandedEdges,
    });

    return dag;
  }

  computeProgramShape(diffDagId: string): ProgramShapeSample[] {
    enforceDefensiveInput(diffDagId, "diff_dag_id");
    const snapshot = this.repository.getGraphSnapshot(diffDagId);

    const nodeFlowStats = buildNodeFlowStats(snapshot.nodes, snapshot.edges);
    let maxDegree = 1;
    for (const stats of nodeFlowStats.values()) {
      if (stats.totalDegree > maxDegree) {
        maxDegree = stats.totalDegree;
      }
    }

    const samples = snapshot.nodes.map((node) => {
      const stateMagnitude = node.changed
        ? Math.min(1, 0.35 + node.weight * 0.7)
        : Math.min(1, 0.15 + node.weight * 0.35);
      const flowStats = nodeFlowStats.get(node.id) || { inDegree: 0, outDegree: 0, totalDegree: 0 };
      const interopMagnitude = Math.min(
        1,
        flowStats.totalDegree / Math.max(1, snapshot.nodes.length * 0.65),
      );
      const coupling = Math.min(1, flowStats.totalDegree / maxDegree);
      const directionalImbalance = flowStats.totalDegree === 0
        ? 0
        : Math.abs(flowStats.inDegree - flowStats.outDegree) / flowStats.totalDegree;

      // Placement: major angle is stable node identity (hash of path), minor
      // angle is disturbance — quiet nodes sit on the outer equator, disturbed
      // nodes migrate to the inner-rim saddle. Metrics are the real curvature
      // and torsion of the node's flow direction at that surface point.
      const pathHash = fnv1aUnit(node.path || node.id);
      const disturbance = clamp01(stateMagnitude * 0.55 + interopMagnitude * 0.45);
      const hemisphere = fnv1aUnit(node.id) < 0.5 ? -1 : 1;
      const phi = this.math.calculatePhi(pathHash);
      const theta = this.math.calculateTheta(disturbance, hemisphere);
      const alpha = this.math.calculateFlowAngle(directionalImbalance, coupling);
      const curvature = this.math.calculateCurvature(theta, alpha);
      const torsion = this.math.calculateTorsion(theta, alpha);

      return {
        nodeId: node.id,
        timeDelta: pathHash,
        stateMagnitude,
        interopMagnitude,
        theta,
        phi,
        radiusMajor: TORUS_RADIUS_MAJOR,
        radiusMinor: TORUS_RADIUS_MINOR,
        curvature,
        torsion,
        riskGradient: this.math.calculateRiskGradient(curvature, torsion),
      };
    });

    const torusVariance = computeTorusVariance(samples);

    this.repository.saveGraphSnapshot(diffDagId, {
      ...snapshot,
      dag: {
        ...snapshot.dag,
        torusVariance,
      },
      shapeSamples: samples,
    });

    return samples;
  }

  deriveRiskSurfaces(diffDagId: string): RiskSurface[] {
    enforceDefensiveInput(diffDagId, "diff_dag_id");
    const snapshot = this.repository.getGraphSnapshot(diffDagId);

    if (snapshot.shapeSamples.length === 0) {
      this.repository.saveGraphSnapshot(diffDagId, {
        ...snapshot,
        surfaces: [],
      });
      return [];
    }

    const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const samplesByNodeId = new Map(snapshot.shapeSamples.map((sample) => [sample.nodeId, sample]));
    const flowStats = buildNodeFlowStats(snapshot.nodes, snapshot.edges);
    const adjacency = buildAdjacency(snapshot.edges);
    const edgeWeightByPair = buildEdgeWeightMap(snapshot.edges);

    const targetSurfaceCount = Math.min(12, Math.max(5, Math.ceil(snapshot.dag.changedNodeCount * 0.75)));
    const candidateNodeIds = selectRiskSurfaceNodeIds(
      snapshot.nodes,
      snapshot.shapeSamples,
      flowStats,
      adjacency,
      edgeWeightByPair,
      targetSurfaceCount,
    );

    const surfaces = candidateNodeIds.map((nodeId, index) => {
      const sample = samplesByNodeId.get(nodeId);
      if (!sample) {
        return null;
      }

      const entryNode = nodesById.get(sample.nodeId);

      const surfaceKind = inferSurfaceKind(entryNode?.path || "runtime", entryNode?.kind);
      const neighborRisk = averageNeighborRisk(nodeId, adjacency, samplesByNodeId);
      // Risk is dominated by monotonic fundamentals so that large,
      // well-connected changes always outrank trivial edits. The torus shape
      // signal (riskGradient from curvature/torsion) and flow/correlation act
      // as secondary modulators rather than driving the ranking on their own.
      const changeMagnitude = sample.stateMagnitude;
      const blastRadius = sample.interopMagnitude;
      const flowPenalty = 1 - snapshot.dag.flowCompleteness;
      const baseRisk = clamp01(
        changeMagnitude * 0.34 +
          blastRadius * 0.24 +
          sample.riskGradient * 0.18 +
          neighborRisk * 0.12 +
          flowPenalty * 0.08 +
          snapshot.dag.torusVariance * 0.04,
      );
      const riskScore = lowerPriorityRiskForConfig(baseRisk, surfaceKind, entryNode?.path);

      return {
        id: createId("surface"),
        pullRequestId: snapshot.dag.pullRequestId,
        surfaceKind,
        entryNodeId: nodeId,
        riskScore,
        reason: surfaceKind === "configuration"
          ? "Configuration-focused change; deprioritized below runtime/data-flow surfaces"
          : neighborRisk > 0.45
          ? "High local risk correlation across neighboring DAG nodes"
          : sample.riskGradient > 0.75
          ? "High curvature and torsion indicate fragile interop"
          : index === 0
          ? "Top-risk changed node by derived graph disturbance"
          : "Moderate graph disturbance",
      };
    }).filter((surface): surface is RiskSurface => surface !== null);

    if (snapshot.dag.flowCompleteness < 0.72 && surfaces.length > 0) {
      const entryNode = surfaces
        .map((surface) => samplesByNodeId.get(surface.entryNodeId))
        .filter((sample): sample is ProgramShapeSample => Boolean(sample))
        .find((sample) => {
        const node = nodesById.get(sample.nodeId);
        return !isConfigPath(node?.path) && node?.kind !== "config";
      }) || samplesByNodeId.get(surfaces[0].entryNodeId);

      if (entryNode) {
      surfaces.push({
        id: createId("surface"),
        pullRequestId: snapshot.dag.pullRequestId,
        surfaceKind: "runtime",
        entryNodeId: entryNode.nodeId,
        riskScore: clamp01(0.54 + (1 - snapshot.dag.flowCompleteness) * 0.42),
        reason: snapshot.dag.completenessNotes[0] || "DAG flow completeness is below target for app-flow validation",
      });
      }
    }

    this.repository.saveGraphSnapshot(diffDagId, {
      ...snapshot,
      surfaces,
    });

    return surfaces;
  }
}

function selectRiskSurfaceNodeIds(
  nodes: ModuleNode[],
  shapeSamples: ProgramShapeSample[],
  flowStats: Map<string, { inDegree: number; outDegree: number; totalDegree: number }>,
  adjacency: Map<string, Set<string>>,
  edgeWeightByPair: Map<string, number>,
  targetCount: number,
): string[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const samplesByNodeId = new Map(shapeSamples.map((sample) => [sample.nodeId, sample]));
  // Risk surfaces must anchor to files a reviewer opens — never symbol nodes
  // (interfaces, functions), which otherwise surface as "hot paths" like
  // `foo.ts#PlacedNode` and read as noise in the report.
  const rankedSeeds = shapeSamples
    .filter((sample) => nodesById.get(sample.nodeId)?.kind !== "symbol")
    .sort((left, right) => riskSeedScore(right, nodesById.get(right.nodeId), flowStats) - riskSeedScore(left, nodesById.get(left.nodeId), flowStats));

  const selected = new Set<string>();
  for (const sample of rankedSeeds) {
    selected.add(sample.nodeId);
    if (selected.size >= targetCount) {
      break;
    }
  }

  const seedIds = Array.from(selected);
  for (const seedId of seedIds) {
    if (selected.size >= targetCount) {
      break;
    }

    const neighbors = Array.from(adjacency.get(seedId) || [])
      .filter((neighborId) => samplesByNodeId.has(neighborId))
      .sort((left, right) => {
        const leftScore = correlatedNeighborScore(seedId, left, nodesById, samplesByNodeId, edgeWeightByPair);
        const rightScore = correlatedNeighborScore(seedId, right, nodesById, samplesByNodeId, edgeWeightByPair);
        return rightScore - leftScore;
      })
      .slice(0, 2);

    for (const neighborId of neighbors) {
      selected.add(neighborId);
      if (selected.size >= targetCount) {
        break;
      }
    }
  }

  return Array.from(selected);
}

function riskSeedScore(
  sample: ProgramShapeSample,
  node: ModuleNode | undefined,
  flowStats: Map<string, { inDegree: number; outDegree: number; totalDegree: number }>,
): number {
  const stats = flowStats.get(sample.nodeId) || { inDegree: 0, outDegree: 0, totalDegree: 0 };
  const degreeBoost = Math.min(0.25, stats.totalDegree / 20);
  const changedBoost = node?.changed ? 0.2 : 0;
  const configPenalty = isConfigPath(node?.path) ? 0.25 : 0;
  return sample.riskGradient + degreeBoost + changedBoost - configPenalty;
}

function correlatedNeighborScore(
  seedId: string,
  neighborId: string,
  nodesById: Map<string, ModuleNode>,
  samplesByNodeId: Map<string, ProgramShapeSample>,
  edgeWeightByPair: Map<string, number>,
): number {
  const sample = samplesByNodeId.get(neighborId);
  if (!sample) {
    return -1;
  }

  const edgeWeight = edgeWeightByPair.get(edgePairKey(seedId, neighborId)) || 0;
  const changedBoost = nodesById.get(neighborId)?.changed ? 0.12 : 0;
  const configPenalty = isConfigPath(nodesById.get(neighborId)?.path) ? 0.16 : 0;
  return sample.riskGradient * 0.58 + edgeWeight * 0.3 + changedBoost - configPenalty;
}

function averageNeighborRisk(
  nodeId: string,
  adjacency: Map<string, Set<string>>,
  samplesByNodeId: Map<string, ProgramShapeSample>,
): number {
  const neighborIds = Array.from(adjacency.get(nodeId) || []).filter((neighborId) => samplesByNodeId.has(neighborId));
  if (neighborIds.length === 0) {
    return 0;
  }

  const total = neighborIds.reduce((sum, neighborId) => sum + (samplesByNodeId.get(neighborId)?.riskGradient || 0), 0);
  return clamp01(total / neighborIds.length);
}

function buildAdjacency(edges: ModuleEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!adjacency.has(edge.fromNodeId)) {
      adjacency.set(edge.fromNodeId, new Set());
    }
    if (!adjacency.has(edge.toNodeId)) {
      adjacency.set(edge.toNodeId, new Set());
    }

    adjacency.get(edge.fromNodeId)?.add(edge.toNodeId);
    adjacency.get(edge.toNodeId)?.add(edge.fromNodeId);
  }
  return adjacency;
}

function buildEdgeWeightMap(edges: ModuleEdge[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const edge of edges) {
    const key = edgePairKey(edge.fromNodeId, edge.toNodeId);
    const previous = result.get(key) || 0;
    if (edge.weight > previous) {
      result.set(key, edge.weight);
    }
  }
  return result;
}

function edgePairKey(leftNodeId: string, rightNodeId: string): string {
  return [leftNodeId, rightNodeId].sort().join("::");
}

function estimateNodeWeight(file: DiffFile): number {
  const churn = Math.max(1, file.additions + file.deletions);
  const churnWeight = Math.min(1, Math.log1p(churn) / 7.5);
  if (file.isTest) {
    return Math.min(1, churnWeight * 0.8);
  }
  if (file.isConfig) {
    return Math.min(1, churnWeight * 0.9);
  }
  return churnWeight;
}

function calculateSaturation(nodeCount: number, edgeCount: number): number {
  if (nodeCount === 0) {
    return 0;
  }
  return Math.min(1, edgeCount / nodeCount);
}

function buildNodeFlowStats(
  nodes: ModuleNode[],
  edges: ModuleEdge[],
): Map<string, { inDegree: number; outDegree: number; totalDegree: number }> {
  const stats = new Map<string, { inDegree: number; outDegree: number; totalDegree: number }>();

  for (const node of nodes) {
    stats.set(node.id, { inDegree: 0, outDegree: 0, totalDegree: 0 });
  }

  for (const edge of edges) {
    const from = stats.get(edge.fromNodeId);
    const to = stats.get(edge.toNodeId);
    if (!from || !to) {
      continue;
    }

    from.outDegree += 1;
    to.inDegree += 1;
    from.totalDegree += 1;
    to.totalDegree += 1;

    if (!edge.directed) {
      from.inDegree += 1;
      to.outDegree += 1;
    }
  }

  return stats;
}

function analyzeFlowCompleteness(
  nodes: ModuleNode[],
  edges: ModuleEdge[],
): { score: number; notes: string[] } {
  if (nodes.length === 0) {
    return { score: 0, notes: ["graph is empty"] };
  }

  const stats = buildNodeFlowStats(nodes, edges);
  const changedNodes = nodes.filter((node) => node.changed && node.kind !== "symbol");
  const changedCount = Math.max(1, changedNodes.length);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) {
    adjacency.set(node.id, new Set());
  }
  for (const edge of edges) {
    adjacency.get(edge.fromNodeId)?.add(edge.toNodeId);
    adjacency.get(edge.toNodeId)?.add(edge.fromNodeId);
  }

  let linkedChanged = 0;
  let bridgedChanged = 0;
  let boundaryReach = 0;

  for (const node of changedNodes) {
    const nodeStats = stats.get(node.id) || { inDegree: 0, outDegree: 0, totalDegree: 0 };
    if (nodeStats.totalDegree > 0) {
      linkedChanged += 1;
    }
    if (nodeStats.inDegree > 0 && nodeStats.outDegree > 0) {
      bridgedChanged += 1;
    }

    const neighbors = adjacency.get(node.id) || new Set<string>();
    if (Array.from(neighbors).some((neighborId) => !nodeById.get(neighborId)?.changed)) {
      boundaryReach += 1;
    }
  }

  const orphanCount = nodes.filter((node) => (stats.get(node.id)?.totalDegree || 0) === 0).length;
  const largestComponent = largestConnectedComponentRatio(nodes, adjacency);

  const linkedRatio = linkedChanged / changedCount;
  const bridgedRatio = bridgedChanged / changedCount;
  const boundaryRatio = boundaryReach / changedCount;
  const orphanRatio = orphanCount / Math.max(1, nodes.length);

  const score = clamp01(
    linkedRatio * 0.34 +
      bridgedRatio * 0.22 +
      boundaryRatio * 0.2 +
      largestComponent * 0.2 +
      (1 - orphanRatio) * 0.04,
  );

  const notes: string[] = [];
  if (linkedRatio < 0.75) {
    notes.push("changed nodes have sparse linkage to the rest of the DAG");
  }
  if (bridgedRatio < 0.45) {
    notes.push("few changed nodes participate in both inbound and outbound flow");
  }
  if (boundaryRatio < 0.5) {
    notes.push("changed nodes have limited connectivity to non-changed neighbors");
  }
  if (largestComponent < 0.65) {
    notes.push("graph is fragmented across multiple components");
  }
  if (orphanRatio > 0.2) {
    notes.push("graph has isolated nodes without any flow edges");
  }
  if (notes.length === 0) {
    notes.push("flow coverage is consistent across changed and neighbor nodes");
  }

  return { score, notes };
}

function largestConnectedComponentRatio(nodes: ModuleNode[], adjacency: Map<string, Set<string>>): number {
  if (nodes.length === 0) {
    return 0;
  }

  const unvisited = new Set(nodes.map((node) => node.id));
  let largest = 0;

  while (unvisited.size > 0) {
    const start = unvisited.values().next().value as string;
    const queue = [start];
    unvisited.delete(start);
    let size = 0;

    while (queue.length > 0) {
      const nodeId = queue.shift() as string;
      size += 1;
      for (const neighbor of adjacency.get(nodeId) || []) {
        if (!unvisited.has(neighbor)) {
          continue;
        }
        unvisited.delete(neighbor);
        queue.push(neighbor);
      }
    }

    if (size > largest) {
      largest = size;
    }
  }

  return largest / nodes.length;
}

function computeTorusVariance(samples: ProgramShapeSample[]): number {
  if (samples.length < 2) {
    return 0;
  }

  const curvatureVar = variance(samples.map((sample) => sample.curvature));
  const torsionVar = variance(samples.map((sample) => sample.torsion));
  // theta is signed in (-pi, pi]; spread is measured on |theta| (disturbance
  // depth), so mirrored hemispheres don't read as artificial variance.
  const thetaVar = variance(samples.map((sample) => Math.abs(sample.theta) / Math.PI));
  const phiVar = variance(samples.map((sample) => sample.phi / (2 * Math.PI)));

  return clamp01(torsionVar * 0.38 + curvatureVar * 0.32 + thetaVar * 0.15 + phiVar * 0.15);
}

/** FNV-1a hash mapped to [0,1): stable, even node placement (as in kujua). */
function fnv1aUnit(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash / 0x100000000;
}

function variance(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const squared = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return clamp01(squared * 4);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function collectReferencesByFile(diffFiles: DiffFile[]): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const file of diffFiles) {
    const key = normalizePath(file.path);
    const references: string[] = [];

    for (const line of getPatchChangeLines(file.patch)) {
      const reference = extractReference(line);
      if (reference && !references.includes(reference)) {
        references.push(reference);
      }
    }

    result.set(key, references);
  }

  return result;
}

function getPatchChangeLines(patch?: string): string[] {
  if (!patch) {
    return [];
  }

  const lines: string[] = [];
  for (const line of patch.split("\n")) {
    if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
      lines.push(line.slice(1).trim());
    }
  }

  return lines;
}

function extractReference(line: string): string | null {
  const includeMatch = /#include\s*[<"]([^">]+)[">]/.exec(line);
  if (includeMatch) {
    return includeMatch[1];
  }

  const importFromMatch = /import\s+.+?\s+from\s+["']([^"']+)["']/.exec(line);
  if (importFromMatch) {
    return importFromMatch[1];
  }

  const importBareMatch = /import\s+["']([^"']+)["']/.exec(line);
  if (importBareMatch) {
    return importBareMatch[1];
  }

  const requireMatch = /require\(\s*["']([^"']+)["']\s*\)/.exec(line);
  if (requireMatch) {
    return requireMatch[1];
  }

  const pythonFromMatch = /from\s+([A-Za-z0-9_.]+)\s+import/.exec(line);
  if (pythonFromMatch) {
    return pythonFromMatch[1];
  }

  const pythonImportMatch = /^import\s+([A-Za-z0-9_.]+)/.exec(line);
  if (pythonImportMatch) {
    return pythonImportMatch[1];
  }

  const rustUseMatch = /^use\s+([A-Za-z0-9_:]+)/.exec(line);
  if (rustUseMatch) {
    return rustUseMatch[1].replaceAll("::", "/");
  }

  const csharpUsingMatch = /^using\s+([A-Za-z0-9_.]+)/.exec(line);
  if (csharpUsingMatch) {
    return csharpUsingMatch[1].replaceAll(".", "/");
  }

  return null;
}

function resolveReferenceToChangedPath(
  sourcePath: string,
  reference: string,
  changedPathToNodeId: Map<string, string>,
): string | null {
  const normalizedReference = normalizePath(reference);
  const candidates: string[] = [];

  if (normalizedReference.startsWith(".")) {
    candidates.push(normalizePath(joinPath(dirnamePath(sourcePath), normalizedReference)));
  } else {
    candidates.push(normalizedReference.replace(/^\//, ""));
  }

  for (const candidate of candidates) {
    const resolved = matchChangedPath(candidate, changedPathToNodeId);
    if (resolved) {
      return resolved;
    }
  }

  const referenceBase = basenamePath(stripExtension(normalizedReference));
  if (!referenceBase) {
    return null;
  }

  const baseMatches = Array.from(changedPathToNodeId.keys()).filter((path) =>
    basenamePath(stripExtension(path)) === referenceBase
  );
  return baseMatches.length === 1 ? baseMatches[0] : null;
}

function matchChangedPath(candidate: string, changedPathToNodeId: Map<string, string>): string | null {
  const normalizedCandidate = normalizePath(candidate);
  if (changedPathToNodeId.has(normalizedCandidate)) {
    return normalizedCandidate;
  }

  const candidateWithoutExtension = stripExtension(normalizedCandidate);
  for (const changedPath of changedPathToNodeId.keys()) {
    const changedWithoutExtension = stripExtension(changedPath);
    if (changedWithoutExtension === candidateWithoutExtension) {
      return changedPath;
    }

    if (changedWithoutExtension === `${candidateWithoutExtension}/index`) {
      return changedPath;
    }
  }

  return null;
}

function extractChangedSymbols(patch?: string): string[] {
  if (!patch) {
    return [];
  }

  const symbols = new Set<string>();
  const patterns = [
    /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /(?:^|\s)class\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /(?:^|\s)(?:struct|enum|interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)/,
  ];

  for (const line of patch.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) {
      continue;
    }

    const content = line.slice(1).trim();
    for (const pattern of patterns) {
      const match = pattern.exec(content);
      if (match) {
        symbols.add(match[1]);
      }
    }
  }

  return Array.from(symbols);
}

function extractChangeTokens(patch?: string): Set<string> {
  const tokens = new Set<string>();

  for (const line of getPatchChangeLines(patch)) {
    for (const token of line.match(TOKEN_RE) || []) {
      const normalized = token.toLowerCase();
      if (normalized.length < 3 || COMMON_TOKENS.has(normalized)) {
        continue;
      }
      tokens.add(normalized);
    }
  }

  return tokens;
}

function countTokenOverlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) {
      overlap += 1;
    }
  }

  return overlap;
}

function toNeighborPath(sourcePath: string, reference: string): string | null {
  const normalizedReference = normalizePath(reference);
  if (!normalizedReference) {
    return null;
  }

  if (normalizedReference.startsWith(".")) {
    return normalizePath(joinPath(dirnamePath(sourcePath), normalizedReference));
  }

  if (normalizedReference.startsWith("/")) {
    return normalizePath(normalizedReference.slice(1));
  }

  return `external/${normalizedReference}`;
}

function dedupeEdges(edges: ModuleEdge[]): ModuleEdge[] {
  const seen = new Set<string>();
  const deduped: ModuleEdge[] = [];

  for (const edge of edges) {
    const key = edge.directed
      ? `${edge.kind}:${edge.fromNodeId}->${edge.toNodeId}`
      : `${edge.kind}:${[edge.fromNodeId, edge.toNodeId].sort().join("<->")}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(edge);
  }

  return deduped;
}

function inferSurfaceKind(path: string, nodeKind?: ModuleNode["kind"]): RiskSurface["surfaceKind"] {
  if (nodeKind === "config" || isConfigPath(path)) {
    return "configuration";
  }

  const lower = path.toLowerCase();
  if (lower.includes("auth") || lower.includes("jwt") || lower.includes("token")) {
    return "auth";
  }
  if (lower.includes("db") || lower.includes("sql") || lower.includes("store") || lower.includes("persist")) {
    return "persistence";
  }
  if (lower.includes("test") || lower.includes("spec")) {
    return "test_gap";
  }
  if (lower.includes("async") || lower.includes("thread") || lower.includes("queue") || lower.includes("sched")) {
    return "concurrency";
  }
  if (lower.includes("perf") || lower.includes("cache")) {
    return "performance";
  }
  return "runtime";
}

function lowerPriorityRiskForConfig(
  riskScore: number,
  surfaceKind: RiskSurface["surfaceKind"],
  path?: string,
): number {
  if (surfaceKind !== "configuration" && !isConfigPath(path)) {
    return riskScore;
  }

  return clamp01(riskScore * 0.62);
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
    lower.endsWith("makefile") ||
    lower.endsWith("cmakelists.txt") ||
    lower.endsWith(".cmake") ||
    lower.endsWith(".mk") ||
    lower.endsWith(".gradle") ||
    lower.endsWith(".bazel") ||
    lower.endsWith(".bzl")
  ) {
    return true;
  }

  return lower.includes("config/") || lower.includes("/configs/") || lower.includes("settings");
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function dirnamePath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function basenamePath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function stripExtension(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf(".");
  return index === -1 ? normalized : normalized.slice(0, index);
}

function joinPath(baseDir: string, relativePath: string): string {
  const parts = normalizePath(baseDir).split("/").filter(Boolean);
  for (const segment of normalizePath(relativePath).split("/")) {
    if (!segment || segment === ".") {
      continue;
    }

    if (segment === "..") {
      parts.pop();
      continue;
    }

    parts.push(segment);
  }

  return parts.join("/");
}

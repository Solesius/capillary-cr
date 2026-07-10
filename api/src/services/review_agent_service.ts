// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
// review_agent_service.ts — TCSRTC tool-driven code-review agent.
//
// This brings the code-review flow up to the caliber of the CDP RetV functional
// test driver. Where the orchestrator previously surfaced findings from a fixed
// pass loop, this agent:
//   1. Captures a torus-informed snapshot of the PR (changed files + diff +
//      neighbor surface + risk surfaces + program-shape samples) and writes it
//      to disk (best-effort) in a place the model can reference.
//   2. Exposes read-only review tools so the agent can pull slices of a file, a
//      whole file, a diff, the torus metrics, or an on-demand neighbor file —
//      expanding the goal space lazily and token-efficiently.
//   3. Runs a TCSRTC-guided Reason -> Toolform -> Act -> Observe loop (bounded
//      by wall clock + a hard cycle cap), recording structured findings.
//   4. Always produces an exportable markdown report (LLM when available, a
//      deterministic fallback otherwise) and persists a ReviewAgentRunRecord.
//
// The agent degrades gracefully: when no runtime LLM config is present (e.g.
// tests, or no provider configured) it keeps the deterministic baseline
// findings and emits a deterministic report — no network required.

import {
  DiffFile,
  ReviewAgentRunRecord,
  ReviewAgentTraceCycle,
  ReviewAgentTraceStep,
  ReviewFinding,
  ReviewSuggestion,
  ReviewPacket,
  ReviewSeverity,
} from "../domain/entities.ts";
import {
  ReviewRunEvent,
  TCSRTC_GATES,
  TcsrtcGate,
  toTcsrtcGate,
} from "../domain/review_phase.ts";
import { ReviewRepository } from "../repositories/review_repository.ts";
import { GitHubOakService } from "./github_service.ts";
import { TcsrctReviewService } from "./tcsrct_review_service.ts";
import { providerUsesGithubToken } from "./providers/provider_registry.ts";
import {
  extractJsonObject,
  type PlannerChatConfig,
  plannerChat,
} from "./providers/planner_chat.ts";
import { createZipArchive } from "./storage/zip_writer.ts";

const DEFAULT_REVIEW_MAX_DURATION_MS = 300_000;
const HARD_CYCLE_CAP = 60;
const DEFAULT_MAX_CYCLES = 12;
// Tools whose successful use marks a path as examined for coverage purposes.
const READ_TOOLS = new Set(["readDiff", "readFile", "readFileSlice", "readNeighbor"]);
const MAX_TOOL_OUTPUT_CHARS = 6_000;
const MAX_FILE_CHARS = 20_000;
// Per-read content the planner sees next turn, and how many recent reads to
// carry at full length. Sized so the model reasons over real diffs/files
// instead of stubs, while bounding context growth.
const MAX_READ_FEEDBACK_CHARS = 7_000;
const MAX_RECENT_RESULTS = 4;
// After this many reads of the same path, tell the planner to stop and decide.
const REREAD_LIMIT = 2;

const SEVERITY_ORDER: Record<ReviewSeverity, number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
  note: 4,
};

function reviewMaxDurationMs(): number {
  const raw = Deno.env.get("REVIEW_AGENT_MAX_DURATION_MS");
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_REVIEW_MAX_DURATION_MS;
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

interface CapturedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  isTest: boolean;
  patch: string;
}

/** A risk surface resolved to the file that anchors it — never a raw node id. */
interface AnchoredRiskSurface {
  kind: string;
  path: string;
  riskScore: number;
  reason: string;
}

/** A program-shape hotspot resolved to its file path for human consumption. */
interface AnchoredShapeSample {
  path: string;
  riskGradient: number;
  curvature: number;
  torsion: number;
}

interface ReviewCapture {
  runId: string;
  pullRequestId: string;
  repositoryId: string;
  headRef: string;
  title: string;
  summary: string;
  changedFiles: CapturedFile[];
  neighborFiles: CapturedFile[];
  riskSurfaces: AnchoredRiskSurface[];
  shapeSamples: AnchoredShapeSample[];
  /** "a.ts ~ b.ts .61" — meaning-coupled pairs with no direct import edge. */
  semanticPairs: string[];
  dag: {
    nodeCount: number;
    edgeCount: number;
    changedNodeCount: number;
    saturation: number;
    torusVariance: number;
    flowCompleteness: number;
  };
  diskPath: string | null;
}

export interface ReviewAgentPassInput {
  runId: string;
  pullRequestId: string;
  repositoryId: string;
  packetId: string;
  baselineFindings: ReviewFinding[];
  maxCycles?: number;
  trace: boolean;
  /** Encourage the agent to emit committable suggestions on findings. */
  suggest?: boolean;
  emit: (event: ReviewRunEvent) => void;
}

export interface ReviewAgentPassOutput {
  findings: ReviewFinding[];
  report: string;
  verdict: string;
  goalAchieved: boolean;
  stopReason: string;
  cycleCount: number;
  record: ReviewAgentRunRecord;
}

/**
 * Tool-driven TCSRTC review agent. Constructed cheaply from services the
 * orchestrator already holds, so wiring it in requires no constructor or DI
 * signature changes.
 */
export class ReviewAgentService {
  constructor(
    private readonly repository: ReviewRepository,
    private readonly githubService: GitHubOakService,
    private readonly tcsrct: TcsrctReviewService,
  ) {}

  /** Run one tool-driven review pass and persist the resulting run record. */
  async runReviewPass(input: ReviewAgentPassInput): Promise<ReviewAgentPassOutput> {
    const startedAt = new Date();
    const capture = await this.buildCapture(input);

    const config = this.resolvePlannerConfig();
    const recordedFindings: ReviewFinding[] = [];
    const traceCycles: ReviewAgentTraceCycle[] = [];

    let verdict = "comment";
    let summary = "";
    let stopReason = "deterministic_review";
    let cycleCount = 0;
    let llmReport: string | null = null;
    let unexaminedHotPaths: string[] = [];

    if (config) {
      const loop = await this.runToolLoop(input, capture, config, recordedFindings, traceCycles);
      cycleCount = loop.cycleCount;
      stopReason = loop.stopReason;
      if (loop.verdict) {
        verdict = loop.verdict;
      }
      summary = loop.summary;
      unexaminedHotPaths = loop.unexaminedHotPaths;

      // Coverage teeth: an approval that skipped hot paths is not an
      // approval. Downgrade to comment and say why — "LGTM" on a large
      // review with unexamined risk is the failure mode this exists to kill.
      if (verdict === "approve" && unexaminedHotPaths.length > 0) {
        verdict = "comment";
        const note = `Downgraded from approve: ${unexaminedHotPaths.length} hot path(s) were not examined.`;
        summary = summary ? `${summary} ${note}` : note;
        input.emit({ type: "log", level: "warn", message: note });
      }

      llmReport = await this.generateLlmReport(
        capture,
        recordedFindings,
        verdict,
        summary,
        config,
        unexaminedHotPaths,
      );
    }

    // Merge agent findings with the deterministic baseline (dedupe by signature).
    const merged = this.mergeFindings(input.runId, input.baselineFindings, recordedFindings);
    const blockerCount = merged.filter((finding) => finding.severity === "blocker").length;
    const highCount = merged.filter((finding) => finding.severity === "high").length;

    if (!config || recordedFindings.length === 0) {
      verdict = deriveVerdict(blockerCount, highCount, merged.length);
      if (summary.trim().length === 0) {
        summary = deriveSummary(capture, merged);
      }
    } else {
      verdict = verdict || deriveVerdict(blockerCount, highCount, merged.length);
    }

    this.repository.saveFindings(input.runId, merged);
    this.repository.updateReviewRun(input.runId, (current) => ({
      ...current,
      findingCount: merged.length,
      blockerCount,
      highCount,
    }));

    const report = llmReport ??
      buildDeterministicReport(capture, merged, verdict, summary, unexaminedHotPaths);
    input.emit({ type: "report", markdown: report });

    const finishedAt = new Date();
    const goalAchieved = stopReason === "verdict_reached" || stopReason === "deterministic_review";

    const record: ReviewAgentRunRecord = {
      runId: input.runId,
      pullRequestId: input.pullRequestId,
      repositoryId: input.repositoryId,
      title: capture.title,
      verdict,
      model: config ? `${config.providerKind}/${config.model}` : "deterministic",
      goalAchieved,
      stopReason,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      cycleCount,
      findingCount: merged.length,
      blockerCount,
      highCount,
      changedFileCount: capture.changedFiles.length,
      nodeCount: capture.dag.nodeCount,
      edgeCount: capture.dag.edgeCount,
      torusVariance: capture.dag.torusVariance,
      findings: merged,
      summary,
      report,
      traceEnabled: input.trace,
      trace: input.trace
        ? { cycles: traceCycles, captureManifest: JSON.stringify(toCaptureManifest(capture), null, 2) }
        : undefined,
    };

    this.repository.saveReviewAgentRun(record);

    return {
      findings: merged,
      report,
      verdict,
      goalAchieved,
      stopReason,
      cycleCount,
      record,
    };
  }

  /**
   * Build a self-contained, exportable bundle for a traced review run.
   * Returns null when the run is unknown; the caller distinguishes "not traced".
   */
  buildReviewExport(runId: string): Uint8Array | null {
    const record = this.repository.getReviewAgentRun(runId);
    if (!record || !record.traceEnabled) {
      return null;
    }

    const encoder = new TextEncoder();
    const runJson = {
      runId: record.runId,
      pullRequestId: record.pullRequestId,
      repositoryId: record.repositoryId,
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
      changedFileCount: record.changedFileCount,
      torusVariance: record.torusVariance,
    };

    const entries = [
      { name: "report.md", data: encoder.encode(record.report) },
      { name: "run.json", data: encoder.encode(JSON.stringify(runJson, null, 2)) },
      { name: "findings.json", data: encoder.encode(JSON.stringify(record.findings, null, 2)) },
    ];
    const cycles = record.trace?.cycles;
    if (cycles && cycles.length > 0) {
      entries.push({ name: "trace.json", data: encoder.encode(JSON.stringify(cycles, null, 2)) });
    }
    if (record.trace?.captureManifest) {
      entries.push({
        name: "capture/manifest.json",
        data: encoder.encode(record.trace.captureManifest),
      });
    }

    return createZipArchive(entries);
  }

  // --- capture -------------------------------------------------------------

  private async buildCapture(input: ReviewAgentPassInput): Promise<ReviewCapture> {
    const packet: ReviewPacket = this.repository.getReviewPacket(input.packetId);
    const pull = this.repository.getPullRequest(input.repositoryId, input.pullRequestId);
    const graph = this.repository.findGraphByPullRequest(input.pullRequestId);

    // Source changed files from the real diff (carries the unified patch); the
    // packet's graph-derived files have no patch. Neighbor names come from the
    // packet (graph) and are read on demand.
    const diff = this.repository.getPullRequestDiff(input.repositoryId, input.pullRequestId);
    const changedPaths = new Set(diff.map((file) => file.path));
    const changedFiles = diff.map(toCapturedFile);
    const neighborFiles = packet.neighborFiles
      .filter((file) => !changedPaths.has(file.path))
      .map(toCapturedFile);

    // Resolve graph node ids to file paths once: everything downstream (tools,
    // prompts, reports) speaks in paths a reviewer can act on, never node ids.
    const nodePath = new Map((graph?.nodes ?? []).map((node) => [node.id, node.path]));
    const anchoredSurfaces: AnchoredRiskSurface[] = packet.riskSurfaces.map((surface) => ({
      kind: surface.surfaceKind,
      path: nodePath.get(surface.entryNodeId) ?? surface.entryNodeId,
      riskScore: surface.riskScore,
      reason: surface.reason,
    }));
    const anchoredSamples: AnchoredShapeSample[] = packet.shapeSamples
      .slice()
      .sort((a, b) => b.riskGradient - a.riskGradient)
      .slice(0, 8)
      .map((sample) => ({
        path: nodePath.get(sample.nodeId) ?? sample.nodeId,
        riskGradient: sample.riskGradient,
        curvature: sample.curvature,
        torsion: sample.torsion,
      }));

    // Semantic edges: meaning-coupled files the import graph does not join.
    // Surfaced to the planner so it can chase "same concept, different
    // module" drift — the class of defect human reviewers miss most.
    const semanticPairs = (graph?.edges ?? [])
      .filter((edge) => edge.kind === "semantic")
      .map((edge) =>
        `${nodePath.get(edge.fromNodeId) ?? edge.fromNodeId} ~ ` +
        `${nodePath.get(edge.toNodeId) ?? edge.toNodeId} ${edge.weight.toFixed(2)}`
      )
      .slice(0, 12);

    const capture: ReviewCapture = {
      runId: input.runId,
      pullRequestId: input.pullRequestId,
      repositoryId: input.repositoryId,
      headRef: pull.sourceBranch,
      title: pull.title,
      summary: packet.summary,
      changedFiles,
      neighborFiles,
      riskSurfaces: anchoredSurfaces,
      shapeSamples: anchoredSamples,
      semanticPairs,
      dag: {
        nodeCount: graph?.dag.nodeCount ?? 0,
        edgeCount: graph?.dag.edgeCount ?? 0,
        changedNodeCount: graph?.dag.changedNodeCount ?? changedFiles.length,
        saturation: graph?.dag.saturation ?? 0,
        torusVariance: graph?.dag.torusVariance ?? 0,
        flowCompleteness: graph?.dag.flowCompleteness ?? 0,
      },
      diskPath: null,
    };

    capture.diskPath = await this.writeCaptureToDisk(capture);
    return capture;
  }

  /** Best-effort disk write so the model can reference a real on-disk path. */
  private async writeCaptureToDisk(capture: ReviewCapture): Promise<string | null> {
    try {
      const base = Deno.env.get("CAPILLARY_STORAGE_DIR");
      const dir = base
        ? `${base.replace(/\/+$/, "")}/review_captures/${capture.runId}`
        : await Deno.makeTempDir({ prefix: "capillary_review_" });
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/manifest.json`,
        JSON.stringify(toCaptureManifest(capture), null, 2),
      );
      const filesDir = `${dir}/changed`;
      await Deno.mkdir(filesDir, { recursive: true });
      for (const file of capture.changedFiles) {
        const safe = file.path.replace(/[^A-Za-z0-9._-]+/g, "_");
        await Deno.writeTextFile(`${filesDir}/${safe}.patch`, file.patch);
      }
      return dir;
    } catch {
      // No --allow-write / --allow-read, or sandboxed: tools read the in-memory
      // capture instead, so this is non-fatal.
      return null;
    }
  }

  // --- LLM config ----------------------------------------------------------

  private resolvePlannerConfig(): PlannerChatConfig | null {
    const runtime = this.repository.getRuntimeLlmConfig();
    if (!runtime) {
      return null;
    }
    // Only Copilot / Codex-via-Copilot are authenticated by the GitHub token;
    // never fall it back into a third-party provider's Authorization header.
    const githubFallback = providerUsesGithubToken(runtime.providerKind)
      ? (this.repository.getGithubToken() || "")
      : "";
    const apiKey = runtime.apiKey?.trim() || githubFallback;
    return {
      providerKind: runtime.providerKind as PlannerChatConfig["providerKind"],
      model: runtime.model,
      baseUrl: runtime.baseUrl,
      apiKey,
    };
  }

  // --- tool loop -----------------------------------------------------------

  private async runToolLoop(
    input: ReviewAgentPassInput,
    capture: ReviewCapture,
    config: PlannerChatConfig,
    recordedFindings: ReviewFinding[],
    traceCycles: ReviewAgentTraceCycle[],
  ): Promise<{
    cycleCount: number;
    stopReason: string;
    verdict: string;
    summary: string;
    unexaminedHotPaths: string[];
  }> {
    const deadline = Date.now() + reviewMaxDurationMs();
    // Budget scales with the change surface: a 100-file review gets more
    // cycles than a 3-file one, capped hard. Explicit maxCycles still wins.
    const scaledCycles = DEFAULT_MAX_CYCLES + Math.ceil(capture.changedFiles.length / 6);
    const budget = Math.max(1, Math.min(HARD_CYCLE_CAP, input.maxCycles ?? scaledCycles));
    const fileCache = new Map<string, string>();
    const observations: string[] = [];
    // Full (generously-capped) content of the most recent read results — this
    // is the channel the planner actually reasons over, so a diff the agent
    // read is visible next turn instead of a 400-char stub.
    const recentResults: { cycle: number; tool: string; path: string; output: string }[] = [];
    // How many times each path has been read — used to stop re-read loops.
    const readCounts = new Map<string, number>();
    const coveredGates = new Set<TcsrtcGate>();
    // Hot paths the agent is obliged to examine before Confirm is legitimate.
    const hotPaths = [...new Set(capture.riskSurfaces.map((surface) => surface.path))].slice(0, 10);
    const examinedPaths = new Set<string>();
    let tokensUsed = 0;

    let verdict = "";
    let summary = "";
    let stopReason = "budget_exhausted";
    let cycle = 0;

    for (cycle = 1; cycle <= budget; cycle += 1) {
      if (Date.now() >= deadline) {
        stopReason = "time_budget_reached";
        break;
      }

      const unexamined = hotPaths.filter((path) => !examinedPaths.has(path));
      const overRead = [...readCounts.entries()]
        .filter(([, count]) => count > REREAD_LIMIT)
        .map(([path]) => path);
      const userMessage = buildPlannerUserMessage(
        capture,
        observations,
        recentResults,
        recordedFindings,
        cycle,
        budget,
        { hot: hotPaths.length, examined: hotPaths.length - unexamined.length, unexamined, overRead },
      );
      const systemPrompt = input.suggest
        ? `${REVIEW_SYSTEM_PROMPT}\n\n${SUGGESTION_DIRECTIVE}`
        : REVIEW_SYSTEM_PROMPT;
      const reply = await plannerChat(config, systemPrompt, userMessage, {
        runContextId: input.runId,
        maxOutputTokens: input.suggest ? 2400 : 1800,
      });

      if (!reply.ok || !reply.value) {
        if (cycle === 1) {
          // No usable provider — abandon the LLM loop and fall back to baseline.
          return {
            cycleCount: 0,
            stopReason: "llm_unavailable",
            verdict: "",
            summary: "",
            unexaminedHotPaths: hotPaths,
          };
        }
        stopReason = "planner_error";
        break;
      }

      tokensUsed += (reply.value.inputTokens ?? 0) + (reply.value.outputTokens ?? 0);

      const payload = extractJsonObject(reply.value.content);
      if (!payload) {
        input.emit({ type: "log", level: "warn", message: `cycle ${cycle}: planner reply unparseable` });
        observations.push(`cycle ${cycle}: planner produced no actionable JSON.`);
        continue;
      }

      const gate = toTcsrtcGate(payload.phase);
      coveredGates.add(gate);

      // Stream the planner's reasoning verbatim: this is the review narrative
      // the live output renders, and it is persisted so replays keep it.
      const reasoning = typeof payload.reasoning === "string" ? payload.reasoning.trim() : "";
      if (reasoning.length > 0) {
        input.emit({ type: "thinking", cycle, gate, text: clamp(reasoning, 700) });
        this.repository.appendReviewEvent(
          input.runId,
          `thinking:${gate}:${clamp(reasoning, 300)}`,
        );
      }

      const toolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls : [];
      const steps: ReviewAgentTraceStep[] = [];
      const cycleFindings: string[] = [];

      for (let stepIndex = 0; stepIndex < toolCalls.length; stepIndex += 1) {
        const raw = toolCalls[stepIndex] as Record<string, unknown>;
        const tool = String(raw?.tool || "").trim();
        const toolReason = String(raw?.reason || "").trim();
        const args = (raw?.args && typeof raw.args === "object")
          ? raw.args as Record<string, unknown>
          : {};
        const stepStart = Date.now();

        const argPath = typeof args.path === "string" ? args.path.trim() : "";
        const result = await this.executeTool(input, capture, fileCache, recordedFindings, tool, args);
        if (result.ok && argPath && READ_TOOLS.has(tool)) {
          examinedPaths.add(argPath);
          readCounts.set(argPath, (readCounts.get(argPath) ?? 0) + 1);
        }
        if (result.findingTitle) {
          cycleFindings.push(result.findingTitle);
          const last = recordedFindings[recordedFindings.length - 1];
          if (last) {
            input.emit({ type: "finding", finding: last });
          }
        }

        const output = clamp(result.output, MAX_TOOL_OUTPUT_CHARS);
        // Keep full read content available to the planner next turn (the real
        // reasoning channel); a short older-history line stays in observations.
        if (READ_TOOLS.has(tool) && result.ok) {
          recentResults.push({ cycle, tool, path: argPath, output: clamp(result.output, MAX_READ_FEEDBACK_CHARS) });
          while (recentResults.length > MAX_RECENT_RESULTS) {
            recentResults.shift();
          }
        }
        observations.push(`cycle ${cycle} ${tool}${argPath ? ` ${argPath}` : ""}: ${clamp(result.output, 200)}`);
        steps.push({
          index: stepIndex,
          tool,
          ok: result.ok,
          durationMs: Date.now() - stepStart,
          output: input.trace ? output : undefined,
          error: result.ok ? undefined : output,
        });
        input.emit({
          type: "tool",
          cycle,
          tool,
          ok: result.ok,
          summary: clamp(result.output, 160),
          reason: toolReason || undefined,
        });

        if (tool === "complete") {
          verdict = typeof args.verdict === "string" ? args.verdict : verdict;
          summary = typeof args.summary === "string" ? args.summary : summary;
        }
      }

      traceCycles.push({
        cycle,
        startedAt: new Date().toISOString(),
        phase: gate,
        plannerRaw: input.trace ? clamp(reply.value.content, 4000) : undefined,
        toolCalls: toolCalls.map((call) => {
          const raw = call as Record<string, unknown>;
          return {
            tool: String(raw?.tool || ""),
            args: (raw?.args && typeof raw.args === "object")
              ? raw.args as Record<string, unknown>
              : {},
            reason: String(raw?.reason || ""),
          };
        }),
        steps,
        findings: cycleFindings,
      });

      input.emit({
        type: "cycle",
        cycle,
        gate,
        toolCount: toolCalls.length,
        findingCount: cycleFindings.length,
        gatesCovered: coveredGates.size,
        gatesTotal: TCSRTC_GATES.length,
        tokensUsed,
      });
      this.repository.appendReviewEvent(
        input.runId,
        `gate:${gate}:cycle=${cycle}:tools=${toolCalls.length}:findings=${cycleFindings.length}`,
      );

      const isDone = payload.done === true ||
        toolCalls.some((call) => String((call as Record<string, unknown>)?.tool || "") === "complete");
      if (isDone) {
        verdict = typeof payload.verdict === "string" ? payload.verdict : verdict;
        summary = typeof payload.summary === "string" ? payload.summary : summary;
        stopReason = "verdict_reached";
        break;
      }
    }

    return {
      cycleCount: Math.min(cycle, budget),
      stopReason,
      verdict,
      summary,
      unexaminedHotPaths: hotPaths.filter((path) => !examinedPaths.has(path)),
    };
  }

  private async executeTool(
    input: ReviewAgentPassInput,
    capture: ReviewCapture,
    fileCache: Map<string, string>,
    recordedFindings: ReviewFinding[],
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; output: string; findingTitle?: string }> {
    try {
      switch (tool) {
        case "listChangedFiles":
          return { ok: true, output: listFiles(capture.changedFiles) };
        case "listNeighbors":
          return { ok: true, output: listFiles(capture.neighborFiles) };
        case "readDiff": {
          const file = findFile(capture, String(args.path || ""));
          if (!file) {
            return { ok: false, output: `unknown path: ${String(args.path || "")}` };
          }
          return { ok: true, output: file.patch || "(no patch available)" };
        }
        case "readFile":
        case "readNeighbor": {
          const path = String(args.path || "");
          const content = await this.resolveFileContent(input, capture, fileCache, path);
          if (content === null) {
            return { ok: false, output: `unable to read: ${path}` };
          }
          return { ok: true, output: clamp(content, MAX_FILE_CHARS) };
        }
        case "readFileSlice": {
          const path = String(args.path || "");
          const content = await this.resolveFileContent(input, capture, fileCache, path);
          if (content === null) {
            return { ok: false, output: `unable to read: ${path}` };
          }
          const start = Math.max(1, Number(args.startLine) || 1);
          const end = Math.max(start, Number(args.endLine) || start + 40);
          const lines = content.split("\n");
          const slice = lines.slice(start - 1, end)
            .map((line, idx) => `${start + idx}\t${line}`)
            .join("\n");
          return { ok: true, output: slice || "(empty slice)" };
        }
        case "readTorus":
          return { ok: true, output: describeTorus(capture) };
        case "recordFinding": {
          const finding = this.coerceFinding(input.runId, args);
          if (!finding) {
            return { ok: false, output: "recordFinding rejected: missing required fields" };
          }
          recordedFindings.push(finding);
          return {
            ok: true,
            output: `recorded ${finding.severity} finding: ${finding.title}`,
            findingTitle: finding.title,
          };
        }
        case "complete":
          return {
            ok: true,
            output: `review complete: ${String(args.verdict || "comment")}`,
          };
        default:
          return { ok: false, output: `unknown tool: ${tool}` };
      }
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : "tool_error" };
    }
  }

  private async resolveFileContent(
    input: ReviewAgentPassInput,
    capture: ReviewCapture,
    fileCache: Map<string, string>,
    path: string,
  ): Promise<string | null> {
    if (path.trim().length === 0) {
      return null;
    }
    const cached = fileCache.get(path);
    if (cached !== undefined) {
      return cached;
    }

    const fetched = await this.githubService.getRepoFileContent(
      input.repositoryId,
      capture.headRef,
      path,
    );
    if (fetched !== null) {
      fileCache.set(path, fetched);
      return fetched;
    }

    // Graceful fallback: reconstruct approximate post-change content from the
    // diff patch when the Contents API is unavailable (e.g. tests/no token).
    const file = findFile(capture, path);
    if (!file) {
      return null;
    }
    const reconstructed = patchToNewContent(file.patch);
    const value = reconstructed.length > 0
      ? reconstructed
      : `# content unavailable for ${path}; diff patch follows\n${file.patch}`;
    fileCache.set(path, value);
    return value;
  }

  private coerceFinding(runId: string, args: Record<string, unknown>): ReviewFinding | null {
    const title = String(args.title || "").trim();
    const finding = String(args.finding || "").trim();
    const filePath = String(args.filePath || args.path || "").trim();
    if (title.length === 0 || finding.length === 0 || filePath.length === 0) {
      return null;
    }
    const severity = normalizeSeverity(String(args.severity || "medium"));
    const evidence = Array.isArray(args.evidence)
      ? args.evidence.map((item) => String(item)).filter((item) => item.length > 0)
      : [];
    const lineRaw = Number(args.line);
    const confidenceRaw = Number(args.confidence);
    return {
      id: createId("finding"),
      runId,
      severity,
      // Findings carry the TCSRTC gate they were raised under (the field name
      // is legacy; `gate` in the tool schema, `passName` in storage).
      passName: toTcsrtcGate(String(args.gate ?? args.passName ?? "Review")),
      filePath,
      line: Number.isFinite(lineRaw) && lineRaw > 0 ? lineRaw : undefined,
      title,
      finding,
      evidence,
      suggestedFix: args.suggestedFix ? String(args.suggestedFix) : undefined,
      suggestion: parseSuggestion(args.suggestion),
      confidence: Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0.6,
    };
  }

  private mergeFindings(
    runId: string,
    baseline: readonly ReviewFinding[],
    agentFindings: readonly ReviewFinding[],
  ): ReviewFinding[] {
    const seen = new Set<string>();
    const merged: ReviewFinding[] = [];
    // Agent findings take precedence, then baseline fills coverage gaps.
    for (const finding of [...agentFindings, ...baseline]) {
      const normalized = { ...finding, runId };
      const key = `${normalized.passName}:${normalized.filePath}:${normalized.title.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(normalized);
    }
    return merged.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  }

  private async generateLlmReport(
    capture: ReviewCapture,
    findings: readonly ReviewFinding[],
    verdict: string,
    summary: string,
    config: PlannerChatConfig,
    unexaminedHotPaths: string[] = [],
  ): Promise<string | null> {
    const userMessage = buildReportUserMessage(capture, findings, verdict, summary, unexaminedHotPaths);
    const reply = await plannerChat(config, REVIEW_REPORT_PROMPT, userMessage, {
      maxOutputTokens: 2200,
      temperature: 0.2,
    });
    if (!reply.ok || !reply.value) {
      return null;
    }
    const content = reply.value.content.trim();
    return content.length > 0 ? content : null;
  }
}

// --- pure helpers ----------------------------------------------------------

/**
 * Compact PR-comment body for a completed review: verdict, summary, counts,
 * and the model that drove it. GitHub supplies the timestamp on the comment.
 */
export function buildPrSummaryComment(record: ReviewAgentRunRecord): string {
  const lines: string[] = [];
  lines.push(`### Capillary Code Review — **${record.verdict}**`);
  lines.push("");
  if (record.summary.trim().length > 0) {
    lines.push(record.summary.trim());
    lines.push("");
  }
  lines.push(
    `**Findings:** ${record.findingCount} ` +
      `(${record.blockerCount} blocker, ${record.highCount} high) · ` +
      `**Files:** ${record.changedFileCount} · **Cycles:** ${record.cycleCount}`,
  );
  lines.push(`**Model:** \`${record.model || "deterministic"}\``);
  lines.push("");
  lines.push(
    `<sub>Posted by [Capillary](https://github.com/Solesius/capillary-cr) · ` +
      `TCSRTC gated review · run \`${record.runId}\`</sub>`,
  );
  return lines.join("\n");
}

function toCapturedFile(file: DiffFile): CapturedFile {
  return {
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    isTest: file.isTest,
    patch: file.patch ?? "",
  };
}

function toCaptureManifest(capture: ReviewCapture): Record<string, unknown> {
  return {
    runId: capture.runId,
    pullRequestId: capture.pullRequestId,
    repositoryId: capture.repositoryId,
    headRef: capture.headRef,
    title: capture.title,
    summary: capture.summary,
    dag: capture.dag,
    changedFiles: capture.changedFiles.map((file) => ({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      isTest: file.isTest,
    })),
    neighborFiles: capture.neighborFiles.map((file) => file.path),
    riskSurfaces: capture.riskSurfaces.map((surface) => ({
      kind: surface.kind,
      path: surface.path,
      riskScore: surface.riskScore,
      reason: surface.reason,
    })),
    topShapeSamples: capture.shapeSamples,
  };
}

function listFiles(files: readonly CapturedFile[]): string {
  if (files.length === 0) {
    return "(none)";
  }
  return files
    .map((file) => `${file.path} [${file.status}] +${file.additions}/-${file.deletions}${file.isTest ? " (test)" : ""}`)
    .join("\n");
}

function findFile(capture: ReviewCapture, path: string): CapturedFile | null {
  const target = path.trim();
  return capture.changedFiles.find((file) => file.path === target) ??
    capture.neighborFiles.find((file) => file.path === target) ??
    null;
}

// Terse by design: this block rides in every planner turn, so each line must
// earn its tokens. Internal geometry (curvature/torsion) stays out — the
// planner acts on ranked paths, not raw telemetry.
function describeTorus(capture: ReviewCapture): string {
  const lines: string[] = [];
  lines.push(
    `graph: ${capture.dag.nodeCount}n/${capture.dag.edgeCount}e ` +
      `changed=${capture.dag.changedNodeCount} flow=${capture.dag.flowCompleteness.toFixed(2)}`,
  );
  lines.push("hot paths (examine every one before Confirm):");
  if (capture.riskSurfaces.length === 0) {
    lines.push("  (none)");
  } else {
    for (const surface of capture.riskSurfaces) {
      lines.push(`  - ${surface.path} ${surface.riskScore.toFixed(2)} ${surface.reason}`);
    }
  }
  if (capture.semanticPairs.length > 0) {
    lines.push("semantic siblings (meaning-coupled, no import edge — check both sides agree):");
    for (const pair of capture.semanticPairs) {
      lines.push(`  - ${pair}`);
    }
  }
  return lines.join("\n");
}

function patchToNewContent(patch: string): string {
  if (!patch) {
    return "";
  }
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) {
      continue;
    }
    if (line.startsWith("-")) {
      continue;
    }
    if (line.startsWith("+")) {
      out.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      out.push(line.slice(1));
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

function clamp(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
}

function parseSuggestion(raw: unknown): ReviewSuggestion | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;
  const startLine = Math.floor(Number(candidate.startLine));
  const endLineRaw = Math.floor(Number(candidate.endLine));
  const code = typeof candidate.code === "string" ? candidate.code : "";
  if (!Number.isFinite(startLine) || startLine < 1 || code.length === 0) {
    return undefined;
  }
  const endLine = Number.isFinite(endLineRaw) && endLineRaw >= startLine ? endLineRaw : startLine;
  return { startLine, endLine, code };
}

function normalizeSeverity(raw: string): ReviewSeverity {
  const value = raw.trim().toLowerCase();
  if (value === "blocker" || value === "high" || value === "medium" || value === "low" || value === "note") {
    return value;
  }
  if (value === "critical") {
    return "blocker";
  }
  return "medium";
}

function deriveVerdict(blockerCount: number, highCount: number, total: number): string {
  if (blockerCount > 0 || highCount > 0) {
    return "request_changes";
  }
  if (total > 0) {
    return "comment";
  }
  return "approve";
}

function deriveSummary(capture: ReviewCapture, findings: readonly ReviewFinding[]): string {
  const blockers = findings.filter((finding) => finding.severity === "blocker").length;
  const highs = findings.filter((finding) => finding.severity === "high").length;
  return `Reviewed ${capture.changedFiles.length} changed file(s) across ${capture.dag.nodeCount} graph ` +
    `node(s). Surfaced ${findings.length} finding(s) (${blockers} blocker, ${highs} high) ` +
    `over ${capture.riskSurfaces.length} risk surface(s).`;
}

const SUGGESTION_DIRECTIVE =
  `Suggestions are ENABLED for this review. Whenever a finding has a concrete, ` +
  `mechanical fix, attach a suggestion object to recordFinding: ` +
  `{startLine, endLine, code} — the 1-indexed inclusive line range in filePath ` +
  `to replace and the exact replacement text (match the file's existing indentation). ` +
  `Read the file/diff first so the line range and replacement are exactly right; a ` +
  `wrong range produces a broken GitHub suggestion. Only attach a suggestion when ` +
  `you are confident; a prose suggestedFix is fine when the fix is not a precise edit.`;

const REVIEW_SYSTEM_PROMPT =
  `You are the Capillary code-review agent. You operate the TCSRTC Feature Process to produce an ` +
  `operationally correct code review of a pull request.\n\n` +
  `TCSRTC gates (apply in order, every gate produces developer-owned artifact insight):\n` +
  `1. Target — state exactly what changed and the blast radius; nothing outside scope.\n` +
  `2. Constrain — bound the review to the changed files; expand to a neighbor ONLY when a ` +
  `   contract/state/runtime dependency forces it (token-efficient: do not read the whole repo).\n` +
  `3. Sanitize — check inputs at system boundaries, auth, persistence, and untrusted data paths.\n` +
  `4. Review — read each changed hunk and actively hunt for the defect classes below.\n` +
  `5. Test — confirm tests cover the change; flag missing/weak coverage as findings.\n` +
  `6. Confirm — reach a verdict (approve | request_changes | comment) with justification.\n\n` +
  `Hunt for these defect classes in every changed hunk — for each one you spot, call recordFinding:\n` +
  `- Correctness: off-by-one, wrong operator/comparison, inverted condition, wrong variable, ` +
  `missing return, unhandled branch, promise not awaited.\n` +
  `- Null/undefined: unchecked access, missing optional-chaining, assuming a value is present.\n` +
  `- Errors: swallowed exceptions, unhandled rejection, error path that leaves inconsistent state, ` +
  `missing cleanup.\n` +
  `- Boundaries/security: unvalidated input at a boundary, injection, path traversal, authz gaps, ` +
  `secrets in code/logs.\n` +
  `- Resources/perf: leaks (handles, listeners, subscriptions), unbounded allocation, N+1, work in ` +
  `a hot path, blocking calls.\n` +
  `- Concurrency/state: races, unsynchronized shared state, reachable illegal states, stale cache.\n` +
  `- Contracts/API: changed signature/return/shape that breaks callers, type mismatch, removed field ` +
  `a consumer relies on.\n` +
  `- Tests: new logic with no test, a changed branch left uncovered, an assertion that can't fail.\n` +
  `A defect need not be a blocker to be worth recording — use note/low for minor issues, ` +
  `medium/high/blocker for real risk. Be specific, cite the line, back it with evidence.\n\n` +
  `You work by calling tools. Available tools:\n` +
  `- listChangedFiles {} — list changed files in scope.\n` +
  `- readDiff {path} — read the unified diff for a changed file.\n` +
  `- readFile {path} — read the (approximate post-change) full file content.\n` +
  `- readFileSlice {path, startLine, endLine} — read a line range.\n` +
  `- listNeighbors {} — list dependency-wetted neighbor files.\n` +
  `- readNeighbor {path} — read a neighbor/impact file on demand (read-only).\n` +
  `- readTorus {} — DAG metrics, risk surfaces, hottest program-shape samples.\n` +
  `- recordFinding {severity, gate, filePath, line?, title, finding, evidence[], suggestedFix?, ` +
  `suggestion?, confidence} — suggestion is an OPTIONAL committable code fix: ` +
  `{startLine, endLine, code} where startLine/endLine are the 1-indexed inclusive ` +
  `lines in filePath to replace and code is the exact replacement text. Only include ` +
  `suggestion when you are confident of the precise replacement; omit it otherwise. ` +
  `   — severity is blocker|high|medium|low|note; gate is Target|Constrain|Sanitize|Review|Test|Confirm.\n` +
  `- complete {verdict, summary} — finish the review.\n\n` +
  `Each turn respond with STRICT JSON only:\n` +
  `{"phase":"<TCSRTC gate>","reasoning":"<brief>","toolCalls":[{"tool":"<name>","args":{...},"reason":"<why>"}],` +
  `"done":false}\n` +
  `When you have enough evidence, include a complete tool call (or set "done":true with "verdict" and ` +
  `"summary"). Record every defect via recordFinding before completing. Do not invent file paths; only ` +
  `reference paths returned by listChangedFiles/listNeighbors. Keep tool calls focused — a few per turn.\n\n` +
  `Coverage discipline:\n` +
  `- Read the diff of every changed file and every hot path once, and scrutinize each hunk against ` +
  `the defect classes above — do not skim. Once you have read a file its full content is provided ` +
  `back each turn; reason over it, do NOT read the same file again.\n` +
  `- Before you Confirm, you must have examined every changed file's diff. A verdict of approve on a ` +
  `PR whose diffs you did not read is invalid.\n` +
  `- Reaching Confirm does not require finding defects — but it does require having genuinely looked. ` +
  `If you examined the changes hunk by hunk and no real defect exists, that is a valid clean review: ` +
  `complete with approve and name the files that most warrant a human read.\n` +
  `- Semantic siblings (files coupled by meaning without an import edge) are prime drift sites: ` +
  `when one side of a pair changed, check the other side still agrees with it.\n` +
  `- Do not stall by re-reading; but do not rush to a clean verdict either — surface the note/low ` +
  `issues too, not only blockers.`;

const REVIEW_REPORT_PROMPT =
  `You write the final Capillary code-review report as GitHub-flavored Markdown. Use exactly these ` +
  `sections in order and nothing before the first heading:\n` +
  `# Code Review Report\n## Verdict\n## Target & Scope\n## Summary\n## Findings\n## Risk Surfaces\n` +
  `## TCSRTC Gates\n## Recommendations\n\n` +
  `Under Verdict state approve | request_changes | comment with one sentence of justification. ` +
  `Under Findings, group by severity (Blocker, High, Medium, Low, Note); for each finding give the ` +
  `file path (and line when known), the issue, and a concrete suggested fix. Under TCSRTC Gates, give ` +
  `one line per gate (Target, Constrain, Sanitize, Review, Test, Confirm). Be concise and operational.\n\n` +
  `Hard rules:\n` +
  `- Write in prose. A section is sentences that happen to name files, NOT a list of file paths ` +
  `followed by a colon. NEVER open a sentence with a comma-joined list of paths (e.g. ` +
  `"a.ts, b.ts, c.ts: this does X" is banned) — say what changed and why it matters, citing paths ` +
  `inline with backticks where relevant.\n` +
  `- Reference each file by its shortest unambiguous name (basename, or dir/basename only if two ` +
  `share a basename). Never repeat a long path more than once per section. Never cite a symbol ` +
  `anchor like \`file.ts#SomeType\` — anchor to files only.\n` +
  `- Never mention internal node ids, curvature, torsion, saturation, torus variance, or ` +
  `risk-gradient numbers — translate graph signal into plain language ("widely depended on", ` +
  `"no test coverage", "complex control flow").\n` +
  `- Target & Scope is ONE or TWO sentences describing what the PR does and its blast radius — ` +
  `not a file inventory. Risk Surfaces names at most the 3-4 files that most deserve a manual ` +
  `read, one short sentence each on why.\n` +
  `- When the findings set is empty, keep the whole report under ~15 lines: state plainly that no ` +
  `line-level defects were surfaced, name the 2-3 files that most deserve a manual read and why, ` +
  `and flag any test-coverage gap. Do not pad an empty review.`;

function buildPlannerUserMessage(
  capture: ReviewCapture,
  observations: readonly string[],
  recentResults: readonly { cycle: number; tool: string; path: string; output: string }[],
  recordedFindings: readonly ReviewFinding[],
  cycle: number,
  budget: number,
  coverage: { hot: number; examined: number; unexamined: string[]; overRead: string[] },
): string {
  const lines: string[] = [];
  lines.push(`Pull request: ${capture.title}`);
  lines.push(`Summary: ${capture.summary}`);
  lines.push(`Cycle ${cycle} of ${budget}. Findings recorded so far: ${recordedFindings.length}.`);
  if (coverage.hot > 0) {
    const remaining = coverage.unexamined.slice(0, 6).join(", ");
    lines.push(
      `Hot-path coverage: ${coverage.examined}/${coverage.hot}` +
        (remaining ? ` — unexamined: ${remaining}` : " — all examined."),
    );
  }
  if (coverage.overRead.length > 0) {
    lines.push(
      `Already read enough — do NOT read again: ${coverage.overRead.join(", ")}. ` +
        `Record a finding on it or move on.`,
    );
  }
  lines.push("");
  lines.push("Changed files in scope:");
  lines.push(listFiles(capture.changedFiles));
  lines.push("");
  lines.push("Torus snapshot:");
  lines.push(describeTorus(capture));
  // Full content of recent reads — reason over THIS, not the short history.
  if (recentResults.length > 0) {
    lines.push("");
    lines.push("Recent tool results (full content):");
    for (const result of recentResults) {
      lines.push(`--- ${result.tool} ${result.path} (cycle ${result.cycle}) ---`);
      lines.push(result.output);
    }
  }
  const olderObservations = observations.slice(-16, -4);
  if (olderObservations.length > 0) {
    lines.push("");
    lines.push("Earlier tool history (summaries):");
    lines.push(olderObservations.join("\n"));
  }
  lines.push("");
  lines.push(
    "Decide the next TCSRTC step. The full content above is what you have already read — reason " +
      "over it directly; do not re-read a file you can already see. Record any defect via " +
      "recordFinding, then complete. If you have examined the hot paths and no line-level defects " +
      "exist, that is a valid clean result: complete with approve or comment. Respond with strict JSON only.",
  );
  return lines.join("\n");
}

function buildReportUserMessage(
  capture: ReviewCapture,
  findings: readonly ReviewFinding[],
  verdict: string,
  summary: string,
  unexaminedHotPaths: string[] = [],
): string {
  const lines: string[] = [];
  lines.push(`Pull request: ${capture.title}`);
  lines.push(`Proposed verdict: ${verdict}`);
  if (summary.trim().length > 0) {
    lines.push(`Reviewer summary: ${summary}`);
  }
  lines.push(`Changed files: ${capture.changedFiles.length}; risk surfaces: ${capture.riskSurfaces.length}.`);
  if (unexaminedHotPaths.length > 0) {
    lines.push(
      `Unexamined hot paths (MUST appear in the report as explicit follow-ups): ` +
        unexaminedHotPaths.join(", "),
    );
  }
  lines.push("");
  lines.push("Findings (compact JSON):");
  // Single-line JSON, no nulls: every byte here is model input.
  lines.push(JSON.stringify(
    findings.map((finding) => ({
      severity: finding.severity,
      gate: finding.passName,
      filePath: finding.filePath,
      ...(finding.line ? { line: finding.line } : {}),
      title: finding.title,
      finding: finding.finding,
      ...(finding.suggestedFix ? { suggestedFix: finding.suggestedFix } : {}),
    })),
  ));
  lines.push("");
  lines.push("Risk surfaces:");
  lines.push(describeTorus(capture));
  return lines.join("\n");
}

function buildDeterministicReport(
  capture: ReviewCapture,
  findings: readonly ReviewFinding[],
  verdict: string,
  summary: string,
  unexaminedHotPaths: string[] = [],
): string {
  const lines: string[] = [];
  lines.push("# Code Review Report");
  lines.push("");
  lines.push("## Verdict");
  lines.push(`**${verdict}** — generated from deterministic TCSRTC analysis.`);
  lines.push("");
  lines.push("## Target & Scope");
  lines.push(`Pull request: ${capture.title}`);
  lines.push(
    `Scope: ${capture.changedFiles.length} changed file(s) touching ` +
      `${capture.dag.changedNodeCount} of ${capture.dag.nodeCount} graph node(s).`,
  );
  lines.push("");
  lines.push("Changed files:");
  for (const file of capture.changedFiles) {
    lines.push(`- \`${file.path}\` [${file.status}] +${file.additions}/-${file.deletions}`);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push(summary.trim().length > 0 ? summary : deriveSummary(capture, findings));
  lines.push("");
  lines.push("## Findings");
  if (findings.length === 0) {
    lines.push("No findings surfaced.");
  } else {
    const order: ReviewSeverity[] = ["blocker", "high", "medium", "low", "note"];
    for (const severity of order) {
      const group = findings.filter((finding) => finding.severity === severity);
      if (group.length === 0) {
        continue;
      }
      lines.push(`### ${severity[0].toUpperCase()}${severity.slice(1)} (${group.length})`);
      for (const finding of group) {
        const loc = finding.line ? `${finding.filePath}:${finding.line}` : finding.filePath;
        lines.push(`- **${finding.title}** — \`${loc}\` (${finding.passName})`);
        lines.push(`  - ${finding.finding}`);
        if (finding.suggestedFix) {
          lines.push(`  - Suggested fix: ${finding.suggestedFix}`);
        }
      }
    }
  }
  lines.push("");
  lines.push("## Risk Surfaces");
  if (capture.riskSurfaces.length === 0) {
    lines.push("No elevated risk surfaces detected.");
  } else {
    for (const surface of capture.riskSurfaces) {
      lines.push(`- **${surface.kind}** \`${surface.path}\`: ${surface.reason}`);
    }
  }
  if (unexaminedHotPaths.length > 0) {
    lines.push("");
    lines.push("### Unexamined hot paths — require manual review");
    for (const path of unexaminedHotPaths) {
      lines.push(`- \`${path}\``);
    }
  }
  lines.push("");
  lines.push("## TCSRTC Gates");
  lines.push(`- **Target**: ${capture.changedFiles.length} file(s) in scope; blast radius ${capture.dag.changedNodeCount} node(s).`);
  lines.push(`- **Constrain**: review bounded to changed files; neighbors expanded on demand.`);
  lines.push(`- **Sanitize**: ${capture.riskSurfaces.length} risk surface(s) evaluated for boundary/auth/persistence exposure.`);
  lines.push(`- **Review**: ${findings.length} finding(s) recorded across plan/diff/risk analysis.`);
  const testFiles = capture.changedFiles.filter((file) => file.isTest).length;
  lines.push(`- **Test**: ${testFiles} test file(s) touched; ${testFiles === 0 ? "no test changes — verify coverage" : "coverage present"}.`);
  lines.push(`- **Confirm**: verdict **${verdict}**.`);
  lines.push("");
  lines.push("## Recommendations");
  const blockers = findings.filter((finding) => finding.severity === "blocker").length;
  const highs = findings.filter((finding) => finding.severity === "high").length;
  if (blockers > 0 || highs > 0) {
    lines.push(`Resolve ${blockers} blocker(s) and ${highs} high finding(s) before merge.`);
  } else if (findings.length > 0) {
    lines.push("Address the recorded findings; none block merge.");
  } else {
    lines.push("No line-level defects surfaced. Files most worth a manual read:");
    for (const sample of capture.shapeSamples.slice(0, 4)) {
      lines.push(`- \`${sample.path}\``);
    }
    if (capture.shapeSamples.length === 0) {
      lines.push("- (no hotspot signal — standard author validation applies)");
    }
  }
  return lines.join("\n");
}

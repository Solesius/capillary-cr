// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { AppError } from "../domain/errors.ts";
import {
  ReviewAgentRunListItem,
  ReviewAgentRunRecord,
  ReviewFinding,
  ReviewRun,
} from "../domain/entities.ts";
import {
  ReviewCycleSummary,
  ReviewPass,
  ReviewRunEvent,
  ReviewRunResult,
} from "../domain/review_phase.ts";
import { enforceDefensiveInput } from "../lib/validation.ts";
import { ReviewRepository } from "../repositories/review_repository.ts";
import { ArtifactService } from "./artifact_service.ts";
import { ClickClackCoordinationService } from "./click_clack_coordination_service.ts";
import { DiffDagService } from "./diff_dag_service.ts";
import { GitHubOakService } from "./github_service.ts";
import { LlmProviderService } from "./llm_provider_service.ts";
import { TcsrctReviewService } from "./tcsrct_review_service.ts";
import { ReviewAgentService } from "./review_agent_service.ts";
import {
  accumulatePassRisk,
  computeReviewProgress,
  explainPassSelection,
  type ReviewLoopState,
  selectNextReviewPass,
} from "./agentic_review_logic.ts";

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

export interface AgenticReviewRequest {
  pullRequestId: string;
  repositoryId?: string;
  maxCycles?: number;
  /** When true, retain the full tool trace + capture manifest and gate bundle export. */
  trace?: boolean;
  /** When true, ask the agent to emit committable code suggestions on findings. */
  suggest?: boolean;
}

type EmitFn = (event: ReviewRunEvent) => void;

const NOOP_EMIT: EmitFn = () => {};
const MAX_AGENTIC_CYCLES = 6;

/**
 * Truly-agentic RETV review orchestrator. Replaces the linear batch pipeline
 * with an observe -> plan -> execute -> cycle -> done loop that streams typed
 * events over SSE, mirroring the CDP RETV agent's contract. The agentic
 * decision (which TCSRCT pass to surface next) is delegated to pure,
 * unit-tested logic in agentic_review_logic.ts.
 */
export class AgenticReviewService {
  constructor(
    private readonly repository: ReviewRepository,
    private readonly clickClack: ClickClackCoordinationService,
    private readonly diffDagService: DiffDagService,
    private readonly githubService: GitHubOakService,
    private readonly tcsrct: TcsrctReviewService,
    private readonly artifacts: ArtifactService,
    private readonly llmProvider?: LlmProviderService,
  ) {
    // The TCSRTC review agent is constructed from services already held here,
    // so wiring it in requires no constructor/DI signature changes.
    this.reviewAgent = new ReviewAgentService(repository, githubService, tcsrct);
  }

  private readonly reviewAgent: ReviewAgentService;

  /**
   * Runs with a pending stop request. cancelReview() only used to flip the
   * stored status — the loop never looked, so Stop was decorative and the
   * model kept burning tokens. The loop and the agent's tool loop now consult
   * this set at every boundary (and race in-flight planner calls against it),
   * so a stop lands within moments, not at the end of the run.
   */
  readonly #cancelRequested = new Set<string>();

  async beginReview(pullRequestId: string, repositoryId?: string): Promise<ReviewRun> {
    const { runId, resolvedRepositoryId } = await this.createRun(pullRequestId, repositoryId);
    await this.executeReviewLoop(runId, pullRequestId, resolvedRepositoryId, NOOP_EMIT);
    return this.repository.getReviewRun(runId);
  }

  async beginReviewAsync(pullRequestId: string, repositoryId?: string): Promise<ReviewRun> {
    const { runId, resolvedRepositoryId } = await this.createRun(pullRequestId, repositoryId);

    queueMicrotask(() => {
      this.executeReviewLoop(runId, pullRequestId, resolvedRepositoryId, NOOP_EMIT)
        .catch((error) => this.failRun(runId, error));
    });

    return this.repository.getReviewRun(runId);
  }

  /**
   * Run the agentic review and stream typed events to the caller. Used by the
   * SSE endpoint so the frontend can render the live observe/plan/execute loop.
   */
  async runReviewStream(
    request: AgenticReviewRequest,
    onEvent?: EmitFn,
  ): Promise<ReviewRunResult> {
    const emit: EmitFn = (event) => {
      if (!onEvent) {
        return;
      }
      try {
        onEvent(event);
      } catch {
        // Streaming consumers must never break the review loop.
      }
    };

    const { runId, resolvedRepositoryId } = await this.createRun(
      request.pullRequestId,
      request.repositoryId,
    );

    try {
      return await this.executeReviewLoop(
        runId,
        request.pullRequestId,
        resolvedRepositoryId,
        emit,
        request.maxCycles,
        request.trace ?? false,
        request.suggest ?? false,
      );
    } catch (error) {
      await this.failRun(runId, error);
      const message = error instanceof AppError ? error.code : "review_pipeline_failed";
      emit({ type: "log", level: "error", message });
      const run = await this.repository.getReviewRun(runId);
      const result: ReviewRunResult = {
        runId,
        pullRequestId: request.pullRequestId,
        phase: "failed",
        stopReason: message,
        goalAchieved: false,
        findingCount: run.findingCount,
        blockerCount: run.blockerCount,
        highCount: run.highCount,
        progress: computeReviewProgress({
          coveredPasses: [],
          passRisk: {},
          findingCount: run.findingCount,
        }),
        cycles: [],
      };
      emit({ type: "done", result });
      return result;
    }
  }

  private async createRun(
    pullRequestId: string,
    repositoryId?: string,
  ): Promise<{ runId: string; resolvedRepositoryId: string }> {
    enforceDefensiveInput(pullRequestId, "pull_request_id");

    const resolvedRepositoryId = repositoryId ||
      await this.repository.findPullRequestRepositoryId(pullRequestId);
    if (!resolvedRepositoryId) {
      throw new AppError("repository_id_required", 400, "repository_id_required");
    }

    await this.githubService.getPullRequest(resolvedRepositoryId, pullRequestId);
    await this.githubService.getPullRequestDiff(resolvedRepositoryId, pullRequestId);

    const run: ReviewRun = {
      id: createId("run"),
      pullRequestId,
      status: "queued",
      startedAt: new Date().toISOString(),
      currentPhase: "queued",
      findingCount: 0,
      blockerCount: 0,
      highCount: 0,
    };

    await this.repository.createReviewRun(run);
    this.clickClack.announceReviewRun(run.id);

    return { runId: run.id, resolvedRepositoryId };
  }

  /** Terminal path for a stopped run: settle state, emit a cancelled done. */
  async #finishCancelled(
    runId: string,
    pullRequestId: string,
    emit: EmitFn,
    cycles: ReviewCycleSummary[],
  ): Promise<ReviewRunResult> {
    this.#cancelRequested.delete(runId);
    await this.repository.updateReviewRun(runId, (current) => ({
      ...current,
      status: "cancelled",
      currentPhase: "cancelled",
      finishedAt: current.finishedAt ?? new Date().toISOString(),
    }));
    await this.repository.appendReviewEvent(runId, "phase:cancelled");
    const run = await this.repository.getReviewRun(runId);
    const result: ReviewRunResult = {
      runId,
      pullRequestId,
      phase: "cancelled",
      stopReason: "cancelled_by_user",
      goalAchieved: false,
      findingCount: run.findingCount,
      blockerCount: run.blockerCount,
      highCount: run.highCount,
      progress: computeReviewProgress({
        coveredPasses: cycles.map((cycle) => cycle.pass),
        passRisk: {},
        findingCount: run.findingCount,
      }),
      cycles,
    };
    emit({ type: "done", result });
    return result;
  }

  private async failRun(runId: string, error: unknown): Promise<void> {
    this.#cancelRequested.delete(runId);
    const message = error instanceof AppError ? error.code : "review_pipeline_failed";
    await this.repository.updateReviewRun(runId, (current) => ({
      ...current,
      status: "failed",
      currentPhase: "failed",
      finishedAt: new Date().toISOString(),
    }));
    await this.repository.appendReviewEvent(runId, `phase:failed:${message}`);
  }

  private async executeReviewLoop(
    runId: string,
    pullRequestId: string,
    repositoryId: string,
    emit: EmitFn,
    maxCycles?: number,
    trace = false,
    suggest = false,
  ): Promise<ReviewRunResult> {
    emit({ type: "run_start", runId, pullRequestId, phase: "queued" });
    const isCancelled = () => this.#cancelRequested.has(runId);

    // Phase: diff_dag — observe the change surface.
    await this.repository.updateReviewRun(runId, (current) => ({
      ...current,
      status: "graphing",
      currentPhase: "diff_dag",
    }));
    this.clickClack.recordReviewProgress(runId, "diff_dag");
    emit({ type: "phase", phase: "diff_dag" });

    const dag = await this.diffDagService.buildDiffDag(pullRequestId, repositoryId);
    await this.diffDagService.expandDependencyWetting(dag.id);
    const semanticEdgeCount = await this.diffDagService.enrichSemanticEdges(dag.id);
    await this.repository.appendReviewEvent(
      runId,
      `dag:built:nodes=${dag.nodeCount}:edges=${dag.edgeCount}:semantic=${semanticEdgeCount}`,
    );
    emit({ type: "graph", nodeCount: dag.nodeCount, edgeCount: dag.edgeCount });
    if (semanticEdgeCount > 0) {
      emit({
        type: "log",
        level: "info",
        message: `Semantic pass — ${semanticEdgeCount} meaning edge${
          semanticEdgeCount === 1 ? "" : "s"
        } joined the graph.`,
      });
    }

    // Phase: program_shape — derive risk surfaces that drive agentic planning.
    await this.repository.updateReviewRun(runId, (current) => ({
      ...current,
      status: "wetting",
      currentPhase: "program_shape",
    }));
    this.clickClack.recordReviewProgress(runId, "program_shape");
    emit({ type: "phase", phase: "program_shape" });

    await this.diffDagService.computeProgramShape(dag.id);
    await this.diffDagService.deriveRiskSurfaces(dag.id);

    // Phase: tcsrct — agentic observe/plan/execute/cycle over the six passes.
    await this.repository.updateReviewRun(runId, (current) => ({
      ...current,
      status: "reviewing",
      currentPhase: "tcsrct",
    }));
    this.clickClack.recordReviewProgress(runId, "tcsrct");
    emit({ type: "phase", phase: "tcsrct" });

    const packet = await this.tcsrct.buildReviewPacket(runId);
    const baselineFindings = await this.tcsrct.runModifiedTcsrct(runId);
    await this.repository.appendReviewEvent(
      runId,
      `tcsrct:baseline_findings=${baselineFindings.length}`,
    );

    // Baseline pass coverage is computed silently: the TCSRTC agent below is
    // the visible pipeline, and its thinking/tool/cycle events are the live
    // narrative. The pass summaries only feed the final result's progress.
    const cycles = this.runAgenticPassCycles(runId, baselineFindings, maxCycles);

    // Tool-driven TCSRTC review agent: capture the torus to disk, expose
    // read-only review tools, run the gated review loop, then enrich findings
    // and emit/persist an exportable report + run record. Supersedes the prior
    // single-shot provider pass; deterministic findings remain the fallback.
    if (isCancelled()) {
      return await this.#finishCancelled(runId, pullRequestId, emit, cycles);
    }

    await this.reviewAgent.runReviewPass({
      runId,
      pullRequestId,
      repositoryId,
      packetId: packet.id,
      baselineFindings: await this.repository.getFindings(runId),
      maxCycles,
      trace,
      suggest,
      isCancelled,
      emit,
    });
    if (isCancelled()) {
      return await this.#finishCancelled(runId, pullRequestId, emit, cycles);
    }
    await this.tcsrct.produceAuthorChecklist(runId);

    await this.artifacts.exportGraphJson(runId);
    await this.artifacts.exportMarkdownReview(runId);
    this.clickClack.completeReviewRun(runId);

    const finalRun = await this.repository.getReviewRun(runId);
    const finalState: ReviewLoopState = {
      coveredPasses: cycles.map((cycle) => cycle.pass),
      passRisk: accumulatePassRisk(await this.repository.getFindings(runId)),
      findingCount: finalRun.findingCount,
    };
    const progress = computeReviewProgress({
      ...finalState,
      coveredPasses: cycles.map((cycle) => cycle.pass),
    });

    const result: ReviewRunResult = {
      runId,
      pullRequestId,
      phase: "completed",
      stopReason: progress.goalAchieved ? "goal_achieved" : "passes_exhausted",
      goalAchieved: progress.goalAchieved,
      findingCount: finalRun.findingCount,
      blockerCount: finalRun.blockerCount,
      highCount: finalRun.highCount,
      progress,
      cycles,
    };
    this.#cancelRequested.delete(runId);
    emit({ type: "done", result });
    return result;
  }

  /**
   * Baseline pass-coverage loop: each cycle the pure planner picks the
   * highest-risk uncovered TCSRCT pass and surfaces that pass's deterministic
   * findings. Runs silently — no stream events — because the tool-driven
   * TCSRTC agent owns the live narrative; these summaries only shape the
   * final result's coverage/progress accounting.
   */
  private runAgenticPassCycles(
    runId: string,
    baselineFindings: readonly ReviewFinding[],
    maxCycles?: number,
  ): ReviewCycleSummary[] {
    const passRisk = accumulatePassRisk(baselineFindings);
    const findingsByPass = groupFindingsByPass(baselineFindings);
    const budget = Math.max(1, Math.min(MAX_AGENTIC_CYCLES, maxCycles ?? MAX_AGENTIC_CYCLES));

    const cycles: ReviewCycleSummary[] = [];
    const covered: ReviewPass[] = [];
    let surfacedCount = 0;

    for (let cycle = 1; cycle <= budget; cycle += 1) {
      const state: ReviewLoopState = {
        coveredPasses: covered,
        passRisk,
        findingCount: surfacedCount,
      };
      const pass = selectNextReviewPass(state);
      if (!pass) {
        break;
      }

      const reason = explainPassSelection(pass, state);
      const passFindings = findingsByPass.get(pass) ?? [];
      covered.push(pass);
      surfacedCount += passFindings.length;

      const progress = computeReviewProgress({
        coveredPasses: covered,
        passRisk,
        findingCount: surfacedCount,
      });

      cycles.push({ cycle, pass, reason, findingCount: passFindings.length, progress });
    }

    return cycles;
  }

  private async applyRetvProviderPass(
    runId: string,
    packetId: string,
    emit: EmitFn,
  ): Promise<void> {
    if (!this.llmProvider) {
      return;
    }

    await this.repository.updateReviewRun(runId, (current) => ({
      ...current,
      status: "reviewing",
      currentPhase: "llm_provider",
    }));
    this.clickClack.recordReviewProgress(runId, "llm_provider");
    await this.repository.appendReviewEvent(runId, "llm:request_dispatched");
    emit({ type: "phase", phase: "llm_provider" });

    const generated = await this.llmProvider.reviewPacketWithModel(packetId);
    const enrichedGenerated = await this.backfillGeneratedFindingLines(runId, generated);

    await this.repository.appendReviewEvent(
      runId,
      `llm:response_received:findings=${enrichedGenerated.length}`,
    );
    if (enrichedGenerated.length === 0) {
      await this.repository.appendReviewEvent(runId, "llm:response_empty");
      emit({ type: "phase", phase: "llm_merged", detail: "no_model_findings" });
      return;
    }

    const existing = await this.repository.getFindings(runId);
    const quality = evaluateGeneratedReviewQuality(enrichedGenerated);
    const shouldReplaceBaseline = quality.shouldReplaceBaseline;
    await this.repository.appendReviewEvent(
      runId,
      `llm:merge_strategy=${
        shouldReplaceBaseline ? "replace_baseline" : "augment_baseline"
      }:actionable=${quality.actionableCount}:passes=${quality.uniquePassCount}`,
    );

    const merged = dedupeFindingsBySignature(
      (shouldReplaceBaseline ? [] : existing).concat(
        enrichedGenerated.map((finding) => ({
          ...finding,
          runId,
          id: createId("finding"),
        })),
      ),
    );

    await this.repository.saveFindings(runId, merged);

    const blockerCount = merged.filter((finding) => finding.severity === "blocker").length;
    const highCount = merged.filter((finding) => finding.severity === "high").length;
    await this.repository.updateReviewRun(runId, (current) => ({
      ...current,
      status: "completed",
      findingCount: merged.length,
      blockerCount,
      highCount,
      currentPhase: "llm_merged",
      finishedAt: new Date().toISOString(),
    }));
    emit({ type: "phase", phase: "llm_merged" });
  }

  private async backfillGeneratedFindingLines(
    runId: string,
    findings: ReviewFinding[],
  ): Promise<ReviewFinding[]> {
    const run = await this.repository.getReviewRun(runId);
    const repositoryId = await this.repository.findPullRequestRepositoryId(run.pullRequestId);
    if (!repositoryId) {
      return findings;
    }

    const diffByPath = new Map(
      (await this.repository.getPullRequestDiff(repositoryId, run.pullRequestId))
        .map((diff) => [normalizePath(diff.path), diff]),
    );

    return findings.map((finding) => {
      if (typeof finding.line === "number" && finding.line > 0) {
        return finding;
      }

      const normalizedPath = normalizePath(finding.filePath);
      const sourceDiff = diffByPath.get(normalizedPath);
      const anchor = `${finding.title} ${finding.finding}`;
      const line = estimateLineFromPatch(sourceDiff?.patch, anchor);
      return {
        ...finding,
        filePath: normalizedPath || finding.filePath,
        line,
      };
    });
  }

  getReviewRun(runId: string): Promise<ReviewRun> {
    enforceDefensiveInput(runId, "run_id");
    return this.repository.getReviewRun(runId);
  }

  streamReviewEvents(runId: string): Promise<string[]> {
    enforceDefensiveInput(runId, "run_id");
    return this.repository.listReviewEvents(runId);
  }

  async cancelReview(runId: string): Promise<boolean> {
    enforceDefensiveInput(runId, "run_id");
    this.#cancelRequested.add(runId);
    await this.repository.updateReviewRun(runId, (current) => ({
      ...current,
      status: "cancelled",
      currentPhase: "cancelled",
      finishedAt: new Date().toISOString(),
    }));
    this.clickClack.recordReviewProgress(runId, "cancelled");
    return true;
  }

  /** List persisted TCSRTC review-agent runs (history rows). */
  listReviewAgentRuns(): Promise<ReviewAgentRunListItem[]> {
    return this.repository.listReviewAgentRuns();
  }

  /** Fetch a persisted review-agent run record (report + optional trace). */
  getReviewAgentRun(runId: string): Promise<ReviewAgentRunRecord | null> {
    enforceDefensiveInput(runId, "run_id");
    return this.repository.getReviewAgentRun(runId);
  }

  /** Build the exportable review bundle; null when the run is missing/untraced. */
  buildReviewExport(runId: string): Promise<Uint8Array | null> {
    enforceDefensiveInput(runId, "run_id");
    return this.reviewAgent.buildReviewExport(runId);
  }
}

function groupFindingsByPass(findings: readonly ReviewFinding[]): Map<ReviewPass, ReviewFinding[]> {
  const grouped = new Map<ReviewPass, ReviewFinding[]>();
  for (const finding of findings) {
    const pass = finding.passName as ReviewPass;
    const bucket = grouped.get(pass);
    if (bucket) {
      bucket.push(finding);
    } else {
      grouped.set(pass, [finding]);
    }
  }
  return grouped;
}

function evaluateGeneratedReviewQuality(findings: ReviewFinding[]): {
  shouldReplaceBaseline: boolean;
  actionableCount: number;
  uniquePassCount: number;
} {
  const actionable = findings.filter((finding) => finding.severity !== "note");
  const actionableCount = actionable.length;
  const uniquePassCount = new Set(actionable.map((finding) => finding.passName)).size;
  const likelyFallback = findings.some((finding) => {
    const title = finding.title.toLowerCase();
    return title.includes("unstructured review narrative") ||
      title.includes("provider unavailable") ||
      title.includes("provider rate-limited");
  });

  const hasEnoughCoverage = actionableCount >= 5 || (actionableCount >= 3 && uniquePassCount >= 3);
  return {
    shouldReplaceBaseline: !likelyFallback && hasEnoughCoverage,
    actionableCount,
    uniquePassCount,
  };
}

function dedupeFindingsBySignature(findings: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  const unique: ReviewFinding[] = [];

  for (const finding of findings) {
    const key = `${finding.passName}:${finding.filePath}:${finding.title}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(finding);
  }

  return unique;
}

function normalizePath(path?: string): string {
  if (!path) {
    return "";
  }
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function estimateLineFromPatch(patch?: string, anchor?: string): number | undefined {
  if (!patch) {
    return undefined;
  }

  let currentLine: number | undefined;
  let firstChangedLine: number | undefined;
  const anchorTokens = toAnchorTokens(anchor);

  for (const raw of patch.split("\n")) {
    const hunk = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(raw);
    if (hunk) {
      currentLine = Number(hunk[1]);
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
      if (containsAnchorToken(content, anchorTokens)) {
        return currentLine;
      }
      currentLine += 1;
      continue;
    }

    if (raw.startsWith(" ")) {
      const content = raw.slice(1).trim().toLowerCase();
      if (containsAnchorToken(content, anchorTokens)) {
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
      if (containsAnchorToken(content, anchorTokens)) {
        return currentLine;
      }
    }
  }

  return firstChangedLine;
}

function toAnchorTokens(anchor?: string): string[] {
  if (!anchor) {
    return [];
  }

  return anchor
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 10);
}

function containsAnchorToken(content: string, tokens: string[]): boolean {
  if (tokens.length === 0) {
    return false;
  }

  return tokens.some((token) => content.includes(token));
}

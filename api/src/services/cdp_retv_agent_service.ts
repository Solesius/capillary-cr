// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { ReviewRepository } from "../repositories/review_repository.ts";
import { AppError } from "../domain/errors.ts";
import type {
  RetvCdpRunListItem,
  RetvCdpRunRecord,
  RetvCdpRunTrace,
  RetvCdpTraceCycle,
} from "../domain/entities.ts";
import {
  CdpDriverService,
  CdpWorkStep,
  CdpWorkStepResult,
  CdpWorkUnitResult,
} from "./cdp_driver_service.ts";
import {
  buildProviderFromKind,
  type ProviderKind,
  providerUsesGithubToken,
} from "./providers/provider_registry.ts";
import { chat, chatStream } from "./providers/provider_client.ts";
import type { ProviderStreamEvent } from "./providers/provider_core.ts";
import { createZipArchive, type ZipEntryInput } from "./storage/zip_writer.ts";

// Agent runs are bounded by a wall-clock budget so big features that keep making
// progress aren't cut short by a fixed iteration count. Default 10 minutes;
// override per-request or globally via RETV_AGENT_MAX_DURATION_MS.
const DEFAULT_AGENT_MAX_DURATION_MS = 600_000;
const MIN_AGENT_MAX_DURATION_MS = 30_000;
const MAX_AGENT_MAX_DURATION_MS = 3_600_000;
// Hard safety ceiling on iterations so a pathological fast-looping run cannot
// spin indefinitely within the time budget. Real cycles take seconds, so the
// wall clock is the effective limit in practice.
const HARD_CYCLE_CAP = 500;

function resolveAgentMaxDurationMs(requestedMs?: number): number {
  const clamp = (value: number) =>
    Math.min(MAX_AGENT_MAX_DURATION_MS, Math.max(MIN_AGENT_MAX_DURATION_MS, Math.trunc(value)));

  if (typeof requestedMs === "number" && Number.isFinite(requestedMs) && requestedMs > 0) {
    return clamp(requestedMs);
  }

  const raw = Deno.env.get("RETV_AGENT_MAX_DURATION_MS");
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return clamp(parsed);
  }

  return DEFAULT_AGENT_MAX_DURATION_MS;
}

export type RetvPlannerProviderKind = ProviderKind | "openai_compatible";

export interface RetvPlannerConfig {
  providerKind: RetvPlannerProviderKind;
  model: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * Request-facing planner update. Deliberately omits any credential field:
 * API keys are sourced exclusively from the API server environment, so a
 * request can neither inject nor exfiltrate one. Only `openai_compatible`
 * honors a `baseUrl` override (its endpoint is operator-run); for every other
 * provider the base URL and model are pinned to documented registry defaults.
 */
export interface RetvPlannerConfigUpdate {
  providerKind?: RetvPlannerProviderKind;
  model?: string;
  baseUrl?: string;
}

export interface RetvPlannerConfigView {
  providerKind: RetvPlannerProviderKind;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  availableProviderKinds: RetvPlannerProviderKind[];
}

export interface RetvCdpToolDefinition {
  name: "navigate" | "waitForSelector" | "click" | "type" | "extractText" | "assertText" | "evaluate" | "readPage";
  description: string;
  requiredArgs: string[];
}

export interface RetvCdpToolCall {
  tool: RetvCdpToolDefinition["name"];
  args: Record<string, unknown>;
  reason: string;
}

export interface RetvCdpStructuredPlan {
  milestones: string[];
  successCriteria: string[];
  antiDriftRules: string[];
}

export interface RetvCdpProgress {
  percent: number;
  completedMilestones: number;
  totalMilestones: number;
  nextMilestone: string;
  roundsWithoutProgress: number;
  driftWarnings: number;
  goalAchieved: boolean;
}

export interface RetvCdpObservation {
  url: string;
  title: string;
  activePageTab: string;
  activeRunTab: string;
  buttonLabels: string[];
  headings: string[];
  interactiveLabels: string[];
  visibleText: string;
  timestamp: string;
}

export interface RetvCdpCycleSummary {
  cycle: number;
  observation: RetvCdpObservation;
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

export interface RetvCdpRunRequest {
  goal: string;
  sessionId?: string;
  startUrl?: string;
  maxCycles?: number;
  maxDurationMs?: number;
  allowedOrigins?: string[];
  /**
   * When true, retain the full per-step trace + screenshots and allow the run
   * to be exported as a downloadable bundle. When false (the default, e.g. for
   * throwaway testing runs) only the report + metadata are persisted.
   */
  trace?: boolean;
}

export type RetvCdpRunEvent =
  | { type: "run_start"; runId: string; sessionId: string; goal: string; allowedOrigin: string }
  | { type: "plan"; structuredPlan: RetvCdpStructuredPlan }
  | { type: "observation"; cycle: number; observation: RetvCdpObservation }
  | { type: "planner_delta"; cycle: number; text: string }
  | { type: "planner"; cycle: number; rawContent: string; toolCalls: RetvCdpToolCall[]; findings: string[] }
  | { type: "screenshot"; cycle: number; dataUrl: string }
  | { type: "cycle"; cycle: RetvCdpCycleSummary; progress: RetvCdpProgress }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "summary"; summary: string }
  | { type: "report"; report: string }
  | { type: "done"; result: RetvCdpRunResult };

export interface RetvCdpRunResult {
  runId: string;
  sessionId: string;
  goal: string;
  allowedOrigin: string;
  stopReason: string;
  functionalTestSucceeded: boolean;
  goalAchieved: boolean;
  structuredPlan: RetvCdpStructuredPlan;
  progress: RetvCdpProgress;
  cycles: RetvCdpCycleSummary[];
  findings: string[];
  summary: string;
  /** Structured markdown report — always generated, previewable in the app. */
  report: string;
  /** Whether the full trace was retained and a bundle export is available. */
  traceEnabled: boolean;
}

interface PlannerResult {
  structuredPlan?: RetvCdpStructuredPlan;
  nextToolCalls: RetvCdpToolCall[];
  progress?: {
    percent?: number;
    completedMilestones?: number;
    goalAchieved?: boolean;
    nextMilestone?: string;
  };
  findings: string[];
  rawContent?: string;
}

const AVAILABLE_PLANNER_PROVIDER_KINDS: RetvPlannerProviderKind[] = [
  "github_copilot",
  "openrouter",
  "anthropic",
  "gemini",
  "ihhi_bedrock",
  "codex_app_server",
  "claude_code",
  "openai_compatible",
];

function normalizePlannerProviderKind(raw: string): RetvPlannerProviderKind | null {
  const normalized = raw.trim().toLowerCase();
  switch (normalized) {
    case "github_copilot":
    case "openrouter":
    case "anthropic":
    case "gemini":
    case "ihhi_bedrock":
    case "codex_app_server":
    case "openai_compatible":
      return normalized as RetvPlannerProviderKind;
    case "copilot":
    case "github":
      return "github_copilot";
    case "bedrock":
      return "ihhi_bedrock";
    case "codex":
    case "codefx":
    case "codeex":
    case "codex-app-server":
      return "codex_app_server";
    case "claude_code":
    case "claude-code":
    case "claude_cli":
    case "claudecode":
      return "claude_code";
    case "openai-compatible":
      return "openai_compatible";
    default:
      return null;
  }
}

const TOOL_CATALOG: RetvCdpToolDefinition[] = [
  {
    name: "navigate",
    description: "Navigate browser to a URL.",
    requiredArgs: ["url"],
  },
  {
    name: "waitForSelector",
    description: "Wait until a selector exists before acting.",
    requiredArgs: ["selector"],
  },
  {
    name: "click",
    description: "Click an element by selector.",
    requiredArgs: ["selector"],
  },
  {
    name: "type",
    description: "Type text into an input element.",
    requiredArgs: ["selector", "text"],
  },
  {
    name: "extractText",
    description: "Extract text from selector for evidence.",
    requiredArgs: ["selector"],
  },
  {
    name: "assertText",
    description: "Assert selector text contains expected text.",
    requiredArgs: ["selector", "includes"],
  },
  {
    name: "evaluate",
    description: "Run safe page-state expression for observation.",
    requiredArgs: ["expression"],
  },
  {
    name: "readPage",
    description:
      "Read the raw page DOM via CDP: returns title, trimmed HTML, and a list of interactive elements with valid CSS selectors. Use this to discover real selectors when a click/assert fails or when unsure how to locate an element.",
    requiredArgs: [],
  },
];

interface CdpRetvAgentServiceOptions {
  kind?: ProviderKind;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
}

/**
 * Transport-security floor: a provider that carries a bearer API key must never
 * send it over cleartext http to a non-loopback host. https, stdio://, ws:// and
 * cli:// transports, plus loopback dev endpoints, are exempt.
 */
function assertSecureProviderBaseUrl(baseUrl: string): void {
  const trimmed = baseUrl.trim();
  if (!trimmed || !trimmed.toLowerCase().startsWith("http://")) {
    return;
  }
  let host = "";
  try {
    host = new URL(trimmed).hostname;
  } catch {
    throw new AppError("planner_base_url_invalid", 400, "planner_base_url_invalid");
  }
  if (!isLoopbackHost(host)) {
    throw new AppError(
      "planner_base_url_insecure",
      400,
      "planner_base_url_insecure: refusing to send an API key over cleartext http to a non-loopback host; use https",
    );
  }
}

export class CdpRetvAgentService {
  #plannerConfig: RetvPlannerConfig;

  constructor(
    private readonly repository: ReviewRepository,
    private readonly cdpDriver: CdpDriverService,
    options: CdpRetvAgentServiceOptions = {},
  ) {
    const providerKind = options.kind || this.resolveProviderKindFromEnv();
    const provider = buildProviderFromKind(providerKind, {
      kind: providerKind,
      model: options.model,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
    });

    this.#plannerConfig = {
      providerKind,
      model: provider.model,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
    };

    this.repository.setRuntimeLlmConfig({
      providerKind: this.#plannerConfig.providerKind,
      model: this.#plannerConfig.model,
      baseUrl: this.#plannerConfig.baseUrl,
      apiKey: this.#plannerConfig.apiKey,
    });
  }

  #resolvePlannerApiKey(): string {
    // Only fall back to the connected GitHub token for providers it actually
    // authenticates (Copilot / Codex-via-Copilot); never leak it to a
    // third-party LLM endpoint.
    if (this.#plannerConfig.apiKey.trim().length > 0) {
      return this.#plannerConfig.apiKey;
    }
    return providerUsesGithubToken(this.#plannerConfig.providerKind)
      ? (this.repository.getGithubToken() || "")
      : "";
  }

  getPlannerConfig(): RetvPlannerConfigView {
    return {
      providerKind: this.#plannerConfig.providerKind,
      model: this.#plannerConfig.model,
      baseUrl: this.#plannerConfig.baseUrl,
      hasApiKey: this.#plannerConfig.apiKey.trim().length > 0,
      availableProviderKinds: AVAILABLE_PLANNER_PROVIDER_KINDS.slice(),
    };
  }

  setPlannerConfig(input: RetvPlannerConfigUpdate): RetvPlannerConfigView {
    const nextKind = normalizePlannerProviderKind(
      String(input.providerKind || this.#plannerConfig.providerKind),
    );

    if (!nextKind || !AVAILABLE_PLANNER_PROVIDER_KINDS.includes(nextKind)) {
      throw new AppError("planner_provider_kind_invalid", 400, "planner_provider_kind_invalid");
    }

    // Credentials are never accepted over the wire: every provider resolves its
    // key exclusively from the API server's environment. Any `input.apiKey` is
    // ignored by design so a request can neither inject nor exfiltrate a key.
    const sameKind = this.#plannerConfig.providerKind === nextKind;

    if (nextKind === "openai_compatible") {
      // The local/self-hosted provider is the *only* kind whose endpoint may be
      // overridden per request; its key still comes solely from the env var.
      const requestedBaseUrl = input.baseUrl?.trim();
      const nextBaseUrl = requestedBaseUrl || (sameKind ? this.#plannerConfig.baseUrl : "") ||
        "http://localhost:1234/v1";
      const descriptor = {
        model: input.model?.trim() || (sameKind ? this.#plannerConfig.model : "local-model"),
        baseUrl: nextBaseUrl,
        apiKey: Deno.env.get("CAPILLARY_LLM_API_KEY") || "",
      };

      if (descriptor.apiKey.trim()) {
        assertSecureProviderBaseUrl(descriptor.baseUrl);
      }

      this.#plannerConfig = {
        providerKind: nextKind,
        model: descriptor.model,
        baseUrl: descriptor.baseUrl,
        apiKey: descriptor.apiKey,
      };

      this.repository.setRuntimeLlmConfig({
        providerKind: this.#plannerConfig.providerKind,
        model: this.#plannerConfig.model,
        baseUrl: this.#plannerConfig.baseUrl,
        apiKey: this.#plannerConfig.apiKey,
      });

      return this.getPlannerConfig();
    }

    // Every documented cloud/CLI provider is fully described by its registry
    // defaults: baseUrl and model are fixed, and the key resolves from that
    // provider's env chain. Request-supplied baseUrl/apiKey are ignored; only a
    // model refinement against the same provider is honored.
    const descriptor = buildProviderFromKind(nextKind, {
      kind: nextKind,
      model: input.model?.trim() || (sameKind ? this.#plannerConfig.model : undefined),
    });

    if (descriptor.apiKey.trim()) {
      assertSecureProviderBaseUrl(descriptor.baseUrl);
    }

    this.#plannerConfig = {
      providerKind: nextKind,
      model: descriptor.model,
      baseUrl: descriptor.baseUrl,
      apiKey: descriptor.apiKey,
    };

    this.repository.setRuntimeLlmConfig({
      providerKind: this.#plannerConfig.providerKind,
      model: this.#plannerConfig.model,
      baseUrl: this.#plannerConfig.baseUrl,
      apiKey: this.#plannerConfig.apiKey,
    });

    return this.getPlannerConfig();
  }

  async runGoalRound(
    request: RetvCdpRunRequest,
    onEvent?: (event: RetvCdpRunEvent) => void,
  ): Promise<RetvCdpRunResult> {
    const emit = (event: RetvCdpRunEvent) => {
      if (!onEvent) {
        return;
      }
      try {
        onEvent(event);
      } catch {
        // Streaming consumers must never break the planner loop.
      }
    };

    const goal = String(request.goal || "").trim();
    if (!goal) {
      throw new AppError("goal_required", 400, "goal_required");
    }

    const requestedMaxCycles = Number(request.maxCycles);
    // maxCycles is now an OPTIONAL hard cap; when omitted the run is bounded by
    // the wall-clock budget (plus the natural goal/drift/no-progress stops).
    const explicitMaxCycles =
      Number.isFinite(requestedMaxCycles) && requestedMaxCycles > 0
        ? Math.min(HARD_CYCLE_CAP, Math.trunc(requestedMaxCycles))
        : undefined;
    const maxDurationMs = resolveAgentMaxDurationMs(request.maxDurationMs);
    const deadlineAt = Date.now() + maxDurationMs;
    const startUrl = String(request.startUrl || "http://localhost:4200").trim() || "http://localhost:4200";
    const allowedOriginSet = resolveAllowedOrigins(startUrl, request.allowedOrigins);
    const driftScopeDisabled = allowedOriginSet.has("*");
    const allowedOrigin = driftScopeDisabled
      ? "*"
      : Array.from(allowedOriginSet).join(", ") || safeOrigin(startUrl);

    const sessionId = request.sessionId && request.sessionId.trim().length > 0
      ? request.sessionId
      : (await this.cdpDriver.createSession(startUrl)).sessionId;

    const runId = `retv_cdp_${crypto.randomUUID().slice(0, 8)}`;
    const traceEnabled = request.trace === true;
    const startedAt = new Date().toISOString();
    emit({ type: "run_start", runId, sessionId, goal, allowedOrigin });

    let structuredPlan = this.defaultPlan(goal);
    emit({ type: "plan", structuredPlan });
    const cycles: RetvCdpCycleSummary[] = [];
    const traceCycles: RetvCdpTraceCycle[] = [];
    const traceScreenshots: { cycle: number; dataUrl: string }[] = [];
    let roundsWithoutProgress = 0;
    let driftWarnings = 0;
    let completedMilestones = 0;
    let goalAchieved = false;

    // Retry resilience: a single failed step no longer aborts the run. We keep
    // cycling so the planner can read the raw page and try a different selector,
    // only bailing once the SAME step/action has failed MAX_STEP_ATTEMPTS times
    // (or the wall-clock budget is exhausted).
    const MAX_STEP_ATTEMPTS = 20;
    const stepFailureCounts = new Map<string, number>();
    let maxStepFailures = 0;
    let stopReason = "time_budget_exhausted";

    let cycle = 0;
    while (true) {
      cycle += 1;
      if (cycle > 1 && Date.now() >= deadlineAt) {
        stopReason = "time_budget_exhausted";
        break;
      }
      if (cycle > HARD_CYCLE_CAP) {
        stopReason = "iteration_budget_exhausted";
        break;
      }
      const observation = await this.observePageState(sessionId, cycle);
      emit({ type: "observation", cycle, observation });
      if (!driftScopeDisabled && isDrift(observation.url, allowedOriginSet)) {
        driftWarnings += 1;
      }

      const planner = await this.planNextCycle(
        goal,
        cycle,
        allowedOrigin,
        observation,
        cycles,
        structuredPlan,
        runId,
        (text) => {
          if (!text) {
            return;
          }
          emit({ type: "planner_delta", cycle, text });
        },
      );
      if (planner.structuredPlan) {
        structuredPlan = planner.structuredPlan;
        emit({ type: "plan", structuredPlan });
      }

      const plannedCalls = planner.nextToolCalls.length > 0
        ? planner.nextToolCalls
        : this.fallbackToolCalls(goal, cycle, startUrl);

      emit({
        type: "planner",
        cycle,
        rawContent: planner.rawContent || "",
        toolCalls: plannedCalls,
        findings: planner.findings,
      });

      const steps = this.toCdpSteps(plannedCalls, startUrl);
      const workUnit = await this.cdpDriver.executeWorkUnit(sessionId, {
        name: `retv_goal_cycle_${cycle}`,
        stopOnFailure: true,
        steps,
      });

      const screenshot = await this.captureCycleScreenshot(sessionId);
      if (screenshot) {
        emit({ type: "screenshot", cycle, dataUrl: screenshot });
      }

      const failedSteps = workUnit.steps.filter((step) => !step.ok).length;
      const toolOutputs = summarizeToolOutputs(plannedCalls, steps, workUnit.steps);
      const cycleFindings = this.collectCycleFindings(workUnit, planner.findings, driftWarnings);

      const progress = this.normalizeProgress(
        planner.progress,
        structuredPlan,
        completedMilestones,
        failedSteps === 0,
        !planner.findings.some((finding) => finding.startsWith("planner_unavailable")),
        roundsWithoutProgress,
        driftWarnings,
      );

      if (progress.completedMilestones > completedMilestones) {
        roundsWithoutProgress = 0;
        // Forward progress is the opposite of drift: decay accumulated
        // warnings so early-run turbulence cannot pause a recovering run.
        driftWarnings = 0;
      } else {
        roundsWithoutProgress += 1;
      }

      completedMilestones = progress.completedMilestones;
      goalAchieved = progress.goalAchieved ||
        (
          !planner.findings.some((finding) => finding.startsWith("planner_unavailable")) &&
          progress.completedMilestones >= progress.totalMilestones
        );

      const cycleSummary: RetvCdpCycleSummary = {
        cycle,
        observation,
        toolCalls: plannedCalls,
        workUnit: {
          name: workUnit.name,
          success: workUnit.success,
          failedSteps,
        },
        toolOutputs,
        findings: cycleFindings,
        plannerRaw: planner.rawContent,
        screenshot,
      };
      cycles.push(cycleSummary);
      emit({ type: "cycle", cycle: cycleSummary, progress });

      if (traceEnabled) {
        traceCycles.push({
          cycle,
          startedAt: observation.timestamp || new Date().toISOString(),
          url: observation.url,
          title: observation.title,
          headings: observation.headings.slice(),
          interactiveLabels: observation.interactiveLabels.slice(),
          plannerRaw: planner.rawContent,
          toolCalls: plannedCalls.map((call) => ({
            tool: call.tool,
            args: call.args,
            reason: call.reason,
          })),
          steps: workUnit.steps.map((step, index) => ({
            index,
            action: step.action,
            ok: step.ok,
            durationMs: step.durationMs,
            output: traceStepOutput(step.output),
            error: step.error,
          })),
          workUnitName: workUnit.name,
          workUnitSuccess: workUnit.success,
          failedSteps,
          findings: cycleFindings.slice(),
        });
        if (screenshot) {
          traceScreenshots.push({ cycle, dataUrl: screenshot });
        }
      }

      if (!workUnit.success) {
        workUnit.steps.forEach((result, index) => {
          if (result.ok) {
            return;
          }
          const signature = stepFailureSignature(steps[index], result);
          const attempts = (stepFailureCounts.get(signature) || 0) + 1;
          stepFailureCounts.set(signature, attempts);
          maxStepFailures = Math.max(maxStepFailures, attempts);
        });

        if (maxStepFailures >= MAX_STEP_ATTEMPTS) {
          stopReason = "step_failed";
          break;
        }

        // Recoverable failure: keep cycling (within the time budget) so the
        // planner can call readPage to find a valid selector and retry.
        stopReason = "step_retry";
        continue;
      }

      if (goalAchieved) {
        stopReason = "goal_achieved";
        break;
      }

      if (driftWarnings >= 2) {
        stopReason = "drift_pause";
        break;
      }

      if (roundsWithoutProgress >= 3) {
        stopReason = "no_progress_pause";
        break;
      }

      if (explicitMaxCycles !== undefined && cycle >= explicitMaxCycles) {
        stopReason = "iteration_budget_exhausted";
        break;
      }
    }

    const findings = dedupe(cycles.flatMap((cycle) => cycle.findings));
    const progress = {
      percent: Math.round((completedMilestones / Math.max(1, structuredPlan.milestones.length)) * 100),
      completedMilestones,
      totalMilestones: structuredPlan.milestones.length,
      nextMilestone: structuredPlan.milestones[completedMilestones] || "complete",
      roundsWithoutProgress,
      driftWarnings,
      goalAchieved,
    };

    const functionalTestSucceeded = goalAchieved && cycles.every((cycle) => cycle.workUnit.success);
    const summary = await this.summarizeRun({
      runId,
      goal,
      stopReason,
      functionalTestSucceeded,
      goalAchieved,
      structuredPlan,
      progress,
      cycles,
      findings,
    });
    emit({ type: "summary", summary });

    const report = await this.generateRunReport({
      runId,
      goal,
      allowedOrigin,
      stopReason,
      functionalTestSucceeded,
      goalAchieved,
      structuredPlan,
      progress,
      cycles,
      findings,
      summary,
    });
    emit({ type: "report", report });

    const finishedAt = new Date().toISOString();
    const trace: RetvCdpRunTrace | undefined = traceEnabled
      ? { cycles: traceCycles, screenshots: traceScreenshots }
      : undefined;
    const record: RetvCdpRunRecord = {
      runId,
      sessionId,
      goal,
      allowedOrigin,
      stopReason,
      functionalTestSucceeded,
      goalAchieved,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      cycleCount: cycles.length,
      milestonesCompleted: progress.completedMilestones,
      milestonesTotal: progress.totalMilestones,
      percent: progress.percent,
      findings,
      summary,
      report,
      traceEnabled,
      trace,
    };
    this.repository.saveRetvRun(record);

    const result: RetvCdpRunResult = {
      runId,
      sessionId,
      goal,
      allowedOrigin,
      stopReason,
      functionalTestSucceeded,
      goalAchieved,
      structuredPlan,
      progress,
      cycles,
      findings,
      summary,
      report,
      traceEnabled,
    };
    emit({ type: "done", result });
    return result;
  }

  private async summarizeRun(input: {
    runId: string;
    goal: string;
    stopReason: string;
    functionalTestSucceeded: boolean;
    goalAchieved: boolean;
    structuredPlan: RetvCdpStructuredPlan;
    progress: RetvCdpProgress;
    cycles: RetvCdpCycleSummary[];
    findings: string[];
  }): Promise<string> {
    const deterministic = this.deterministicSummary(input);

    const plannerConfig = {
      ...this.#plannerConfig,
      apiKey: this.#resolvePlannerApiKey(),
    };

    const systemPrompt = [
      "You are RetV Functional Agent writing the final verdict for a browser functional-test run.",
      "Write a concise plain-text summary (3-6 sentences, no markdown).",
      "Cover: what was tested, what the agent observed, whether the goal was met, why it stopped, and the most important findings or blockers.",
      "Be specific and evidence-based; do not invent results that are not in the data.",
    ].join("\n");

    const userMessage = JSON.stringify({
      goal: input.goal,
      verdict: {
        functionalTestSucceeded: input.functionalTestSucceeded,
        goalAchieved: input.goalAchieved,
        stopReason: input.stopReason,
      },
      progress: input.progress,
      plan: input.structuredPlan,
      findings: input.findings.slice(0, 12),
      cycles: input.cycles.map((cycle) => ({
        cycle: cycle.cycle,
        url: cycle.observation.url,
        title: cycle.observation.title,
        headings: cycle.observation.headings,
        tools: cycle.toolCalls.map((call) => call.tool),
        success: cycle.workUnit.success,
        failedSteps: cycle.workUnit.failedSteps,
        toolOutputs: cycle.toolOutputs,
        findings: cycle.findings,
      })),
    });

    try {
      const response = plannerConfig.providerKind === "openai_compatible"
        ? await this.chatOpenAiCompatible(systemPrompt, userMessage, plannerConfig)
        : await this.chatProviderBacked(systemPrompt, userMessage, plannerConfig, input.runId);

      const content = response.ok ? response.value?.content?.trim() : "";
      if (content) {
        return content;
      }
    } catch {
      // Summary is best-effort; fall back to the deterministic verdict.
    }

    return deterministic;
  }

  private deterministicSummary(input: {
    goal: string;
    stopReason: string;
    functionalTestSucceeded: boolean;
    goalAchieved: boolean;
    progress: RetvCdpProgress;
    findings: string[];
  }): string {
    const verdict = input.functionalTestSucceeded
      ? "passed"
      : input.goalAchieved
      ? "reached the goal but had step failures"
      : "did not pass";
    const blockers = input.findings.filter((finding) => finding.startsWith("step_failed") || finding.startsWith("planner_"));
    const blockerText = blockers.length > 0 ? ` Key blockers: ${blockers.slice(0, 3).join("; ")}.` : "";
    return `Functional test for "${input.goal}" ${verdict} (stop=${input.stopReason}). ` +
      `Completed ${input.progress.completedMilestones}/${input.progress.totalMilestones} milestones ` +
      `(${input.progress.percent}%).${blockerText}`;
  }

  private async generateRunReport(input: {
    runId: string;
    goal: string;
    allowedOrigin: string;
    stopReason: string;
    functionalTestSucceeded: boolean;
    goalAchieved: boolean;
    structuredPlan: RetvCdpStructuredPlan;
    progress: RetvCdpProgress;
    cycles: RetvCdpCycleSummary[];
    findings: string[];
    summary: string;
  }): Promise<string> {
    const deterministic = buildDeterministicReport(input);

    const plannerConfig = {
      ...this.#plannerConfig,
      apiKey: this.#resolvePlannerApiKey(),
    };

    const systemPrompt = [
      "You are RetV Functional Agent writing the final test-run report for a browser functional test.",
      "Produce a well-structured GitHub-flavoured Markdown document and nothing else (no code fences around the whole document).",
      "Use exactly these top-level sections in this order:",
      "# Functional Test Report",
      "## Verdict — one line stating pass/fail, goal achieved, and why it stopped.",
      "## Goal — restate the goal under test.",
      "## Summary — 3-6 sentence narrative of what happened.",
      "## Milestones — a markdown table of milestone | status (completed/pending).",
      "## Findings — bulleted list of the most important findings/blockers (or 'None observed').",
      "## Cycle Log — a markdown table: Cycle | URL | Tools | Result | Failed Steps.",
      "## Recommendations — actionable next steps.",
      "Be specific and evidence-based; never invent results that are not in the provided data.",
    ].join("\n");

    const userMessage = JSON.stringify({
      goal: input.goal,
      allowedOrigin: input.allowedOrigin,
      verdict: {
        functionalTestSucceeded: input.functionalTestSucceeded,
        goalAchieved: input.goalAchieved,
        stopReason: input.stopReason,
      },
      progress: input.progress,
      plan: input.structuredPlan,
      summary: input.summary,
      findings: input.findings.slice(0, 20),
      cycles: input.cycles.map((cycle) => ({
        cycle: cycle.cycle,
        url: cycle.observation.url,
        title: cycle.observation.title,
        tools: cycle.toolCalls.map((call) => call.tool),
        success: cycle.workUnit.success,
        failedSteps: cycle.workUnit.failedSteps,
        toolOutputs: cycle.toolOutputs,
        findings: cycle.findings,
      })),
    });

    try {
      const response = plannerConfig.providerKind === "openai_compatible"
        ? await this.chatOpenAiCompatible(systemPrompt, userMessage, plannerConfig)
        : await this.chatProviderBacked(systemPrompt, userMessage, plannerConfig, input.runId);

      const content = response.ok ? response.value?.content?.trim() : "";
      if (content) {
        return content;
      }
    } catch {
      // Report is best-effort; fall back to the deterministic markdown.
    }

    return deterministic;
  }

  /** List persisted RetV runs (most recent first), without heavy payloads. */
  listRuns(): RetvCdpRunListItem[] {
    return this.repository.listRetvRuns();
  }

  /** Fetch a full persisted run record (report + optional trace), or null. */
  getRun(runId: string): RetvCdpRunRecord | null {
    return this.repository.getRetvRun(runId);
  }

  /**
   * Build a downloadable bundle for a traced run: report.md + run.json + each
   * cycle screenshot. Returns null when the run is unknown or was not traced.
   */
  buildRunExport(runId: string): { filename: string; bytes: Uint8Array } | null {
    const record = this.repository.getRetvRun(runId);
    if (!record || !record.traceEnabled || !record.trace) {
      return null;
    }

    const encoder = new TextEncoder();
    const entries: ZipEntryInput[] = [];
    entries.push({ name: "report.md", data: encoder.encode(record.report) });

    const manifest = {
      runId: record.runId,
      sessionId: record.sessionId,
      goal: record.goal,
      allowedOrigin: record.allowedOrigin,
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
      findings: record.findings,
      summary: record.summary,
      trace: { cycles: record.trace.cycles },
    };
    entries.push({ name: "run.json", data: encoder.encode(JSON.stringify(manifest, null, 2)) });

    for (const shot of record.trace.screenshots) {
      const decoded = decodeDataUrl(shot.dataUrl);
      if (decoded) {
        entries.push({ name: `screenshots/cycle-${shot.cycle}.${decoded.ext}`, data: decoded.bytes });
      }
    }

    return { filename: `${record.runId}.zip`, bytes: createZipArchive(entries) };
  }

  private async captureCycleScreenshot(sessionId: string): Promise<string | undefined> {
    try {
      const shot = await this.cdpDriver.executeWorkUnit(sessionId, {
        name: "retv_screenshot",
        stopOnFailure: true,
        steps: [{ action: "screenshot", format: "jpeg", quality: 55 }],
      });
      const step = shot.steps[0];
      if (step?.ok && step.output && typeof step.output === "object") {
        const out = step.output as { format?: string; dataBase64?: string };
        if (out.dataBase64) {
          const mime = out.format === "png" ? "png" : "jpeg";
          return `data:image/${mime};base64,${out.dataBase64}`;
        }
      }
    } catch {
      // Screenshots are best-effort visual aid; never fail the round on them.
    }
    return undefined;
  }

  private async observePageState(sessionId: string, cycle: number): Promise<RetvCdpObservation> {
    const result = await this.cdpDriver.executeWorkUnit(sessionId, {
      name: `retv_observe_cycle_${cycle}`,
      stopOnFailure: true,
      steps: [
        {
          action: "evaluate",
          returnByValue: true,
          expression: `(() => {
            const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
            const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role=heading]'))
              .map((node) => clean(node.textContent)).filter(Boolean).slice(0, 10);
            const interactiveLabels = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=tab],[role=link]'))
              .map((node) => clean(node.textContent || node.value || node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.getAttribute('name')))
              .filter(Boolean).slice(0, 20);
            const visibleText = clean(document.body ? document.body.innerText : '').slice(0, 1200);
            return {
              url: location.href,
              title: document.title,
              activePageTab: clean(document.querySelector('.cap-page-tab.active')?.textContent),
              activeRunTab: clean(document.querySelector('.cap-run-tab.active')?.textContent),
              buttonLabels: Array.from(document.querySelectorAll('button')).map((button) => clean(button.textContent)).filter(Boolean).slice(0, 12),
              headings,
              interactiveLabels,
              visibleText,
              timestamp: new Date().toISOString(),
            };
          })()`,
        },
      ],
    });

    const output = result.steps[0]?.output;
    if (!result.success || !output || typeof output !== "object") {
      throw new AppError("retv_observe_failed", 502, "retv_observe_failed");
    }

    const payload = output as Record<string, unknown>;
    const asStrings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    return {
      url: String(payload.url || ""),
      title: String(payload.title || ""),
      activePageTab: String(payload.activePageTab || ""),
      activeRunTab: String(payload.activeRunTab || ""),
      buttonLabels: asStrings(payload.buttonLabels),
      headings: asStrings(payload.headings),
      interactiveLabels: asStrings(payload.interactiveLabels),
      visibleText: String(payload.visibleText || ""),
      timestamp: String(payload.timestamp || new Date().toISOString()),
    };
  }

  private async planNextCycle(
    goal: string,
    cycle: number,
    allowedOrigin: string,
    observation: RetvCdpObservation,
    history: RetvCdpCycleSummary[],
    currentPlan: RetvCdpStructuredPlan,
    runContextId: string,
    onPlannerDelta?: (text: string) => void,
  ): Promise<PlannerResult> {
    const plannerConfig = {
      ...this.#plannerConfig,
      apiKey: this.#resolvePlannerApiKey(),
    };

    const lastCycle = history[history.length - 1];
    const lastReadPageOutputs = lastCycle && lastCycle.workUnit.success &&
        lastCycle.toolCalls.some((call) => call.tool === "readPage")
      ? lastCycle.toolOutputs.filter((output) => output.startsWith("readPage:"))
      : [];
    const antiReadLoopSteer = lastReadPageOutputs.length > 0
      ? [
        "CRITICAL: You ALREADY called readPage in the previous cycle and its DOM result is in recentHistory[].toolOutputs (also shown below).",
        "Do NOT call readPage again this cycle. Use the interactive[].selector values from that result to act now (type/click).",
        `Previous readPage result: ${lastReadPageOutputs.join(" ").slice(0, 1800)}`,
      ]
      : [];

    const systemPrompt = [
      "You are RetV Functional Agent for browser testing.",
      "RetV loop: Reason -> Toolform -> Act -> Observe -> Update -> Decide.",
      "Tools are first-class objects; never skip Toolform.",
      "Return ONLY JSON and no markdown.",
      "JSON schema:",
      '{"structuredPlan":{"milestones":[],"successCriteria":[],"antiDriftRules":[]},"nextToolCalls":[{"tool":"click","args":{},"reason":""}],"progress":{"percent":0,"completedMilestones":0,"goalAchieved":false,"nextMilestone":""},"findings":[]}',
      `Allowed tools: ${TOOL_CATALOG.map((tool) => `${tool.name}(${tool.requiredArgs.join(",")})`).join(" | ")}`,
      `Allowed origin: ${allowedOrigin || "none"}`,
      "Prefer 1-3 tool calls per cycle, but always make forward progress — every cycle should act (type/click/assert), not just observe.",
      "Selectors must be valid CSS only; never use xpath=, :contains(), or text= pseudo-selectors.",
      "The observation already contains the page's visibleText, headings, and interactiveLabels — READ it before acting. If it already answers the goal, record findings and mark progress instead of re-reading.",
      "recentHistory[].toolOutputs holds the actual results of your previous tool calls (including readPage DOM). Treat those outputs as ground truth; do not claim you could not read the page when toolOutputs contains content.",
      "Call readPage AT MOST ONCE for a given page state. After one readPage, you MUST act on the selectors it returned — never call readPage two cycles in a row.",
      "To fill a login form: type the email into the email/text input, type the password into the password input, then click the submit button. Extract concrete values (emails, passwords) directly from the goal text.",
      "If no safe progress action exists, return evaluate/extractText tool calls for evidence instead of random browsing.",
      ...antiReadLoopSteer,
    ].join("\n");

    const userMessage = JSON.stringify({
      goal,
      cycle,
      observation,
      currentPlan,
      recentHistory: history.slice(-2).map((entry) => ({
        cycle: entry.cycle,
        url: entry.observation.url,
        title: entry.observation.title,
        tools: entry.toolCalls.map((call) => ({ tool: call.tool, args: call.args })),
        success: entry.workUnit.success,
        toolOutputs: entry.toolOutputs,
        findings: entry.findings,
      })),
    });

    const response = plannerConfig.providerKind === "openai_compatible"
      ? await this.chatOpenAiCompatible(systemPrompt, userMessage, plannerConfig)
      : onPlannerDelta
      ? await this.chatProviderBackedStream(
        systemPrompt,
        userMessage,
        plannerConfig,
        (event) => {
          if (event.kind === "chunk" && typeof event.text === "string" && event.text.length > 0) {
            onPlannerDelta(event.text);
          }
        },
        runContextId,
      )
      : await this.chatProviderBacked(systemPrompt, userMessage, plannerConfig, runContextId);

    if (!response.ok || !response.value) {
      const detail = response.error?.message ? `:${response.error.message}` : "";
      return {
        nextToolCalls: [],
        findings: [`planner_unavailable:${response.error?.kind || "unknown"}${detail}`],
        rawContent: response.error?.message
          ? `provider error (${response.error?.kind || "unknown"}): ${response.error.message}`
          : `provider unavailable: ${response.error?.kind || "unknown"}`,
      };
    }

    const rawContent = response.value.content;

    let payload = this.parsePlannerPayload(response.value.content);
    let repaired = false;

    if (!payload) {
      payload = await this.repairPlannerPayload(plannerConfig, response.value.content, runContextId);
      repaired = Boolean(payload);
    }

    if (!payload) {
      payload = this.coercePlannerPayloadFromText(goal, response.value.content);
    }

    if (!payload) {
      return {
        nextToolCalls: [],
        findings: ["planner_invalid_json"],
        rawContent,
      };
    }

    const findings = Array.isArray(payload.findings)
      ? payload.findings.filter((value): value is string => typeof value === "string").slice(0, 5)
      : [];

    if (repaired) {
      findings.unshift("planner_json_repaired");
    }

    return {
      structuredPlan: this.normalizePlan(payload.structuredPlan),
      nextToolCalls: this.normalizeToolCalls(payload.nextToolCalls),
      progress: this.normalizePlannerProgress(payload.progress),
      findings: dedupe(findings),
      rawContent,
    };
  }

  private fallbackToolCalls(goal: string, cycle: number, startUrl: string): RetvCdpToolCall[] {
    const keyword = goal.toLowerCase();

    if (cycle === 1) {
      return [
        {
          tool: "navigate",
          args: { url: startUrl },
          reason: "Establish baseline at configured start URL.",
        },
        {
          tool: "waitForSelector",
          args: { selector: "body" },
          reason: "Ensure document is ready before probing.",
        },
      ];
    }

    if (keyword.includes("count") && keyword.includes("page")) {
      return [
        {
          tool: "evaluate",
          args: {
            expression: "(() => ({ pageTabCount: document.querySelectorAll('.cap-page-tab').length, runTabCount: document.querySelectorAll('.cap-run-tab').length }))()",
          },
          reason: "Gather explicit page and run tab counts for goal evidence.",
        },
      ];
    }

    return [
      {
        tool: "extractText",
        args: { selector: "body" },
        reason: "Collect current text evidence when planner is unavailable.",
      },
    ];
  }

  private toCdpSteps(toolCalls: RetvCdpToolCall[], startUrl: string): CdpWorkStep[] {
    const steps: CdpWorkStep[] = [];

    for (const call of toolCalls.slice(0, 5)) {
      switch (call.tool) {
        case "navigate": {
          const url = stringArg(call.args.url) || startUrl;
          steps.push({ action: "navigate", url, waitUntil: "domcontentloaded" });
          break;
        }
        case "waitForSelector": {
          const selector = stringArg(call.args.selector);
          if (selector) {
            steps.push({ action: "waitForSelector", selector, timeoutMs: 6000 });
          }
          break;
        }
        case "click": {
          const selector = stringArg(call.args.selector);
          if (selector) {
            steps.push({ action: "click", selector, timeoutMs: 6000 });
          }
          break;
        }
        case "type": {
          const selector = stringArg(call.args.selector);
          const text = stringArg(call.args.text);
          if (selector && text) {
            steps.push({ action: "type", selector, text, clear: true, timeoutMs: 6000 });
          }
          break;
        }
        case "extractText": {
          const selector = stringArg(call.args.selector);
          if (selector) {
            steps.push({ action: "extractText", selector, timeoutMs: 6000 });
          }
          break;
        }
        case "assertText": {
          const selector = stringArg(call.args.selector);
          const includes = stringArg(call.args.includes);
          if (selector && includes) {
            steps.push({ action: "assertText", selector, includes, timeoutMs: 6000 });
          }
          break;
        }
        case "evaluate": {
          const expression = stringArg(call.args.expression);
          if (expression) {
            steps.push({ action: "evaluate", expression, returnByValue: true });
          }
          break;
        }
        case "readPage": {
          const requested = Number(call.args.maxElements);
          const limit = Number.isFinite(requested) && requested > 0
            ? Math.min(80, Math.floor(requested))
            : 40;
          steps.push({ action: "evaluate", expression: pageSnapshotExpression(limit), returnByValue: true });
          break;
        }
      }
    }

    if (steps.length === 0) {
      steps.push({
        action: "evaluate",
        expression: "(() => ({ url: location.href, title: document.title }))()",
        returnByValue: true,
      });
    }

    return steps;
  }

  private normalizePlan(value: unknown): RetvCdpStructuredPlan | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const payload = value as Record<string, unknown>;
    const milestones = asStringArray(payload.milestones);
    if (milestones.length === 0) {
      return undefined;
    }

    return {
      milestones,
      successCriteria: asStringArray(payload.successCriteria),
      antiDriftRules: asStringArray(payload.antiDriftRules),
    };
  }

  private normalizeToolCalls(value: unknown): RetvCdpToolCall[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const allowed = new Set<RetvCdpToolDefinition["name"]>(TOOL_CATALOG.map((tool) => tool.name));
    const definitions = new Map(TOOL_CATALOG.map((tool) => [tool.name, tool]));
    const parsed: RetvCdpToolCall[] = [];

    for (const item of value) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const payload = item as Record<string, unknown>;
      const tool = normalizeToolName(stringArg(payload.tool));
      if (!tool || !allowed.has(tool)) {
        continue;
      }

      const args = normalizeToolArgs(tool, payload.args);
      const required = definitions.get(tool)?.requiredArgs || [];
      if (!required.every((arg) => stringArg(args[arg]).length > 0)) {
        continue;
      }

      parsed.push({
        tool,
        args,
        reason: stringArg(payload.reason) || "",
      });
    }

    return parsed.slice(0, 5);
  }

  private normalizePlannerProgress(value: unknown): PlannerResult["progress"] {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const payload = value as Record<string, unknown>;
    return {
      percent: numberArg(payload.percent),
      completedMilestones: numberArg(payload.completedMilestones),
      goalAchieved: Boolean(payload.goalAchieved),
      nextMilestone: stringArg(payload.nextMilestone),
    };
  }

  private normalizeProgress(
    plannerProgress: PlannerResult["progress"],
    structuredPlan: RetvCdpStructuredPlan,
    completedMilestones: number,
    cycleSucceeded: boolean,
    allowAutoAdvance: boolean,
    roundsWithoutProgress: number,
    driftWarnings: number,
  ): RetvCdpProgress {
    const totalMilestones = Math.max(1, structuredPlan.milestones.length);
    const nextCompleted = reconcileCompletedMilestones({
      plannerReported: plannerProgress?.completedMilestones,
      prior: completedMilestones,
      cycleSucceeded,
      allowAutoAdvance,
      totalMilestones,
    });

    const percentFromPlanner = plannerProgress?.percent;
    const percent = Number.isFinite(percentFromPlanner)
      ? Math.max(0, Math.min(100, Number(percentFromPlanner)))
      : Math.round((nextCompleted / totalMilestones) * 100);

    return {
      percent,
      completedMilestones: nextCompleted,
      totalMilestones,
      nextMilestone: stringArg(plannerProgress?.nextMilestone) || structuredPlan.milestones[nextCompleted] || "complete",
      roundsWithoutProgress,
      driftWarnings,
      goalAchieved: Boolean(plannerProgress?.goalAchieved) || (allowAutoAdvance && nextCompleted >= totalMilestones),
    };
  }

  private async chatProviderBacked(
    systemPrompt: string,
    userMessage: string,
    plannerConfig: RetvPlannerConfig,
    runContextId?: string,
  ) {
    const provider = buildProviderFromKind(plannerConfig.providerKind as ProviderKind, {
      kind: plannerConfig.providerKind as ProviderKind,
      model: plannerConfig.model,
      baseUrl: plannerConfig.baseUrl,
      apiKey: plannerConfig.apiKey,
    });

    return await chat(provider, {
      systemPrompt,
      model: provider.model,
      temperature: 0.1,
      maxOutputTokens: 1200,
      runContextId,
      messages: [{ role: "user", content: userMessage }],
    });
  }

  private async chatProviderBackedStream(
    systemPrompt: string,
    userMessage: string,
    plannerConfig: RetvPlannerConfig,
    onStream: (event: ProviderStreamEvent) => void,
    runContextId?: string,
  ) {
    const provider = buildProviderFromKind(plannerConfig.providerKind as ProviderKind, {
      kind: plannerConfig.providerKind as ProviderKind,
      model: plannerConfig.model,
      baseUrl: plannerConfig.baseUrl,
      apiKey: plannerConfig.apiKey,
    });

    return await chatStream(
      provider,
      {
        systemPrompt,
        model: provider.model,
        temperature: 0.1,
        maxOutputTokens: 1200,
        runContextId,
        messages: [{ role: "user", content: userMessage }],
      },
      onStream,
    );
  }

  private parsePlannerPayload(content: string): Record<string, unknown> | null {
    const parsed = extractJsonObject(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const payload = parsed as Record<string, unknown>;
    if (
      Array.isArray(payload.nextToolCalls) ||
      payload.structuredPlan ||
      payload.progress ||
      Array.isArray(payload.findings)
    ) {
      return payload;
    }

    for (const key of ["result", "payload", "data", "output"]) {
      const candidate = payload[key];
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        continue;
      }

      const nested = candidate as Record<string, unknown>;
      if (
        Array.isArray(nested.nextToolCalls) ||
        nested.structuredPlan ||
        nested.progress ||
        Array.isArray(nested.findings)
      ) {
        return nested;
      }
    }

    return null;
  }

  private async repairPlannerPayload(
    plannerConfig: RetvPlannerConfig,
    malformedContent: string,
    runContextId?: string,
  ): Promise<Record<string, unknown> | null> {
    const repairPrompt = [
      "You repair malformed planner JSON for a browser-testing agent.",
      "Return ONLY valid JSON and no markdown.",
      "Preserve intent from input while enforcing this schema:",
      '{"structuredPlan":{"milestones":[],"successCriteria":[],"antiDriftRules":[]},"nextToolCalls":[{"tool":"click","args":{},"reason":""}],"progress":{"percent":0,"completedMilestones":0,"goalAchieved":false,"nextMilestone":""},"findings":[]}',
      `Allowed tools: ${TOOL_CATALOG.map((tool) => tool.name).join(",")}`,
      "If input is unusable, return empty arrays and default progress object fields.",
    ].join("\n");

    const clippedInput = malformedContent.slice(0, 12000);
    const response = plannerConfig.providerKind === "openai_compatible"
      ? await this.chatOpenAiCompatible(repairPrompt, clippedInput, plannerConfig)
      : await this.chatProviderBacked(repairPrompt, clippedInput, plannerConfig, runContextId);

    if (!response.ok || !response.value) {
      return null;
    }

    return this.parsePlannerPayload(response.value.content);
  }

  private coercePlannerPayloadFromText(goal: string, content: string): Record<string, unknown> | null {
    const trimmed = content.trim();

    const nextToolCalls = inferToolCallsFromPlannerText(trimmed, goal);
    const progress = inferPlannerProgressFromText(trimmed);
    const extractedFindings = inferPlannerFindingsFromText(trimmed);

    if (nextToolCalls.length === 0 && !progress && extractedFindings.length === 0) {
      return null;
    }

    return {
      nextToolCalls,
      progress,
      findings: dedupe(["planner_text_coerced", ...extractedFindings]),
    };
  }

  private async chatOpenAiCompatible(
    systemPrompt: string,
    userMessage: string,
    plannerConfig: RetvPlannerConfig,
  ): Promise<{
    ok: boolean;
    value?: { content: string };
    error?: { kind: string; message: string };
  }> {
    const base = plannerConfig.baseUrl.replace(/\/+$/, "");
    const endpoint = `${base}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (plannerConfig.apiKey.trim().length > 0) {
      headers.authorization = `Bearer ${plannerConfig.apiKey.trim()}`;
    }

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: plannerConfig.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          temperature: 0.1,
          max_tokens: 1200,
          stream: false,
        }),
      });

      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) {
        const message = String(payload?.message || (payload?.error as Record<string, unknown> | undefined)?.message || `HTTP ${response.status}`);
        const kind = response.status === 401 || response.status === 403 ? "auth" : "network";
        return {
          ok: false,
          error: {
            kind,
            message,
          },
        };
      }

      const first = (payload?.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const content = first && typeof first === "object"
        ? String((first.message as Record<string, unknown> | undefined)?.content || "")
        : "";

      if (!content) {
        return {
          ok: false,
          error: {
            kind: "invalid_request",
            message: "provider_response_invalid",
          },
        };
      }

      return {
        ok: true,
        value: { content },
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: "network",
          message: error instanceof Error ? error.message : "network_error",
        },
      };
    }
  }

  private collectCycleFindings(
    workUnit: CdpWorkUnitResult,
    plannerFindings: string[],
    driftWarnings: number,
  ): string[] {
    const findings = plannerFindings.slice(0, 5);

    for (const failed of workUnit.steps.filter((step) => !step.ok)) {
      findings.push(`step_failed:${failed.action}:${failed.error || "unknown_error"}`);
    }

    if (driftWarnings > 0) {
      findings.push(`drift_warnings=${driftWarnings}`);
    }

    if (findings.length === 0) {
      findings.push("no_issues_reported_this_cycle");
    }

    return dedupe(findings);
  }

  private defaultPlan(goal: string): RetvCdpStructuredPlan {
    return {
      milestones: [
        "Capture baseline page state",
        `Reach feature context for goal: ${goal}`,
        "Validate feature behavior with assertions",
        "Summarize evidence and verdict",
      ],
      successCriteria: [
        "No critical step failures",
        "Goal evidence captured in observations",
      ],
      antiDriftRules: [
        "Stay within allowed origin unless goal explicitly requires otherwise",
        "Prefer extraction/assertion over random navigation when uncertain",
      ],
    };
  }

  private resolveProviderKindFromEnv(): ProviderKind {
    const raw = Deno.env.get("CAPILLARY_LLM_PROVIDER") || "github_copilot";
    const normalized = normalizePlannerProviderKind(raw);
    if (!normalized || normalized === "openai_compatible") {
      return "github_copilot";
    }
    return normalized;
  }
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const direct = tryParseJson(trimmed);
  if (direct !== undefined) {
    return direct;
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/im.exec(trimmed);
  if (fenced && fenced[1]) {
    const fencedParsed = extractJsonObject(fenced[1]);
    if (fencedParsed !== null) {
      return fencedParsed;
    }
  }

  const balanced = findFirstBalancedJsonObject(trimmed);
  if (balanced) {
    const parsedBalanced = tryParseJson(balanced);
    if (parsedBalanced !== undefined) {
      return parsedBalanced;
    }

    const repaired = tryParseJson(repairLooseJson(balanced));
    if (repaired !== undefined) {
      return repaired;
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = trimmed.slice(start, end + 1);
    const parsedSliced = tryParseJson(sliced);
    if (parsedSliced !== undefined) {
      return parsedSliced;
    }
  }

  return null;
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function repairLooseJson(value: string): string {
  return value
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, group: string) => `"${group.replace(/"/g, "\\\"")}"`);
}

function findFirstBalancedJsonObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      if (start === -1) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}") {
      if (depth <= 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function normalizeToolName(value: string): RetvCdpToolDefinition["name"] | "" {
  const raw = value.trim();
  if (!raw) {
    return "";
  }

  const normalized = raw.replaceAll(/[_\-\s]+/g, "").toLowerCase();
  const aliases: Record<string, RetvCdpToolDefinition["name"]> = {
    navigate: "navigate",
    goto: "navigate",
    waitforselector: "waitForSelector",
    waitselector: "waitForSelector",
    click: "click",
    type: "type",
    extracttext: "extractText",
    gettext: "extractText",
    asserttext: "assertText",
    evaluate: "evaluate",
    eval: "evaluate",
    readpage: "readPage",
    rawpage: "readPage",
    getpage: "readPage",
    pagesource: "readPage",
    readdom: "readPage",
    snapshot: "readPage",
    inspect: "readPage",
  };

  return aliases[normalized] || "";
}

function normalizeToolArgs(tool: RetvCdpToolDefinition["name"], raw: unknown): Record<string, unknown> {
  if (tool === "readPage") {
    const src = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const max = Number(src.maxElements);
    return Number.isFinite(max) && max > 0 ? { maxElements: Math.min(80, Math.floor(max)) } : {};
  }

  if (typeof raw === "string") {
    if (tool === "evaluate") {
      return { expression: raw };
    }
    if (tool === "navigate") {
      return { url: raw };
    }
    return { selector: raw };
  }

  const src = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const out: Record<string, unknown> = { ...src };

  const selector = stringArg(src.selector) || stringArg(src.css) || stringArg(src.target);
  const url = stringArg(src.url) || stringArg(src.href);
  const text = stringArg(src.text) || stringArg(src.value);
  const includes = stringArg(src.includes) || stringArg(src.contains) || stringArg(src.expect);
  const expression = stringArg(src.expression) || stringArg(src.script) || stringArg(src.code);

  if (selector) {
    out.selector = selector;
  }
  if (url) {
    out.url = url;
  }
  if (text) {
    out.text = text;
  }
  if (includes) {
    out.includes = includes;
  }
  if (expression) {
    out.expression = expression;
  }

  return out;
}

function inferToolCallsFromPlannerText(text: string, goal: string): RetvCdpToolCall[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const calls: RetvCdpToolCall[] = [];
  const globalUrl = /https?:\/\/[^\s)"']+/i.exec(text)?.[0] || "";

  for (const line of lines) {
    const lower = line.toLowerCase();

    if (/\b(navigate|goto)\b/.test(lower)) {
      const url = /https?:\/\/[^\s)"']+/i.exec(line)?.[0] || globalUrl;
      if (url) {
        calls.push({
          tool: "navigate",
          args: { url },
          reason: "Coerced from planner text",
        });
      }
      continue;
    }

    if (/\b(waitforselector|wait selector|wait for selector|wait)\b/.test(lower)) {
      const selector = extractSelectorCandidate(line);
      if (selector) {
        calls.push({
          tool: "waitForSelector",
          args: { selector },
          reason: "Coerced from planner text",
        });
      }
      continue;
    }

    if (/\bclick\b/.test(lower)) {
      const selector = extractSelectorCandidate(line);
      if (selector) {
        calls.push({
          tool: "click",
          args: { selector },
          reason: "Coerced from planner text",
        });
      }
      continue;
    }

    if (/\btype\b/.test(lower)) {
      const typed = /type\s+(.+?)\s*(?:=>|:|with)\s+(.+)$/i.exec(line);
      const selector = typed ? extractSelectorCandidate(typed[1]) : extractSelectorCandidate(line);
      const textValue = typed ? typed[2].trim().replace(/^['"`]|['"`]$/g, "") : "";
      if (selector && textValue) {
        calls.push({
          tool: "type",
          args: { selector, text: textValue },
          reason: "Coerced from planner text",
        });
      }
      continue;
    }

    if (/\b(extract text|extracttext|get text|gettext)\b/.test(lower)) {
      const selector = extractSelectorCandidate(line) || "body";
      calls.push({
        tool: "extractText",
        args: { selector },
        reason: "Coerced from planner text",
      });
      continue;
    }

    if (/\b(assert|verify|expect)\b/.test(lower) && /\b(includes|contains)\b/.test(lower)) {
      const match = /(?:assert|verify|expect)\s+(.+?)\s+(?:includes|contains)\s+(.+)$/i.exec(line);
      const selector = match ? extractSelectorCandidate(match[1]) : extractSelectorCandidate(line);
      const includes = match ? match[2].trim().replace(/^['"`]|['"`]$/g, "") : "";
      if (selector && includes) {
        calls.push({
          tool: "assertText",
          args: { selector, includes },
          reason: "Coerced from planner text",
        });
      }
      continue;
    }

    if (/\b(evaluate|eval|execute js|run script)\b/.test(lower)) {
      const codeBlock = /```(?:javascript|js)?\s*([\s\S]*?)```/i.exec(line)?.[1];
      const inline = /(?:evaluate|eval)\s*[:=]\s*(.+)$/i.exec(line)?.[1];
      const expression = (codeBlock || inline || "").trim();
      if (expression) {
        calls.push({
          tool: "evaluate",
          args: { expression },
          reason: "Coerced from planner text",
        });
      }
      continue;
    }
  }

  if (calls.length === 0 && goal.toLowerCase().includes("count") && goal.toLowerCase().includes("tab")) {
    calls.push({
      tool: "evaluate",
      args: {
        expression: "(() => ({ pageTabCount: document.querySelectorAll('.cap-page-tab').length, runTabCount: document.querySelectorAll('.cap-run-tab').length, activePageTab: document.querySelector('.cap-page-tab.active')?.textContent?.trim() || '', activeRunTab: document.querySelector('.cap-run-tab.active')?.textContent?.trim() || '' }))()",
      },
      reason: "Fallback coercion for tab counting goal",
    });
  }

  return dedupeToolCalls(calls).slice(0, 5);
}

function extractSelectorCandidate(line: string): string {
  const quoted = /["'`]([.#][A-Za-z0-9_:\-\[\]=\"'\s>+~]+)["'`]/.exec(line)?.[1];
  if (quoted) {
    return quoted.trim();
  }

  const shorthand = /(^|\s)([.#][A-Za-z0-9_:\-]+)/.exec(line)?.[2];
  if (shorthand) {
    return shorthand.trim();
  }

  const selectorHint = /selector\s*[:=]\s*([^,;]+)/i.exec(line)?.[1];
  if (selectorHint) {
    return selectorHint.trim().replace(/^['"`]|['"`]$/g, "");
  }

  return "";
}

function inferPlannerProgressFromText(text: string): PlannerResult["progress"] | undefined {
  const percent = /\b(\d{1,3})\s*%/.exec(text)?.[1];
  const completed = /\bcompleted(?:Milestones)?\b\s*[:=]\s*(\d+)/i.exec(text)?.[1];
  const nextMilestone = /\bnextMilestone\b\s*[:=]\s*([^\n,;]+)/i.exec(text)?.[1]?.trim().replace(/^['"`]|['"`]$/g, "");
  const goalTrue = /\bgoalAchieved\b\s*[:=]\s*true\b/i.test(text) || /\bgoal achieved\b/i.test(text);
  const goalFalse = /\bgoalAchieved\b\s*[:=]\s*false\b/i.test(text) || /\bgoal not achieved\b/i.test(text);

  if (!percent && !completed && !nextMilestone && !goalTrue && !goalFalse) {
    return undefined;
  }

  return {
    percent: percent ? Number(percent) : undefined,
    completedMilestones: completed ? Number(completed) : undefined,
    goalAchieved: goalTrue ? true : goalFalse ? false : undefined,
    nextMilestone,
  };
}

function inferPlannerFindingsFromText(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const findings: string[] = [];
  for (const line of lines) {
    if (!/\b(error|warning|risk|blocked|failed|invalid)\b/i.test(line)) {
      continue;
    }

    const compact = line.replace(/^[-*]\s*/, "").slice(0, 120);
    if (compact) {
      findings.push(`planner_note:${compact}`);
    }
  }

  return dedupe(findings).slice(0, 3);
}

function dedupeToolCalls(calls: RetvCdpToolCall[]): RetvCdpToolCall[] {
  const seen = new Set<string>();
  const out: RetvCdpToolCall[] = [];
  for (const call of calls) {
    const key = `${call.tool}:${JSON.stringify(call.args)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(call);
  }
  return out;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 12);
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Stable signature for a failed step so repeated failures of the SAME
 * step/action (e.g. a click on an unfindable selector) can be counted toward
 * the retry-attempt cap. Derived from the planned step's action + primary
 * target, falling back to the result action + error text.
 */
function stepFailureSignature(step: CdpWorkStep | undefined, result: CdpWorkStepResult): string {
  if (step) {
    let target = "";
    if ("selector" in step && step.selector) {
      target = step.selector;
    } else if ("url" in step && step.url) {
      target = step.url;
    } else if ("expression" in step && step.expression) {
      target = step.expression;
    }
    return `${step.action}:${target}`;
  }
  return `${result.action}:${result.error || "unknown_error"}`;
}

function traceStepOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) {
    return undefined;
  }
  let rendered: string;
  if (typeof output === "string") {
    rendered = output;
  } else {
    try {
      rendered = JSON.stringify(output);
    } catch {
      rendered = String(output);
    }
  }
  rendered = rendered.replace(/\s+/g, " ").trim();
  if (!rendered) {
    return undefined;
  }
  // Trace fidelity matters, but a single huge DOM dump shouldn't bloat the
  // persisted record; cap at a generous-but-bounded length.
  return rendered.slice(0, 4000);
}

function decodeDataUrl(dataUrl: string): { ext: string; bytes: Uint8Array } | null {
  const match = /^data:image\/(png|jpe?g);base64,(.*)$/i.exec(dataUrl);
  if (!match) {
    return null;
  }
  const ext = match[1].toLowerCase() === "png" ? "png" : "jpeg";
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return { ext, bytes };
  } catch {
    return null;
  }
}

function mdCell(value: string): string {
  return String(value || "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function buildDeterministicReport(input: {
  runId: string;
  goal: string;
  allowedOrigin: string;
  stopReason: string;
  functionalTestSucceeded: boolean;
  goalAchieved: boolean;
  structuredPlan: RetvCdpStructuredPlan;
  progress: RetvCdpProgress;
  cycles: RetvCdpCycleSummary[];
  findings: string[];
  summary: string;
}): string {
  const verdict = input.functionalTestSucceeded
    ? "PASS"
    : input.goalAchieved
    ? "PASS (with step failures)"
    : "FAIL";
  const milestoneRows = input.structuredPlan.milestones.length > 0
    ? input.structuredPlan.milestones
      .map((milestone, index) =>
        `| ${mdCell(milestone)} | ${index < input.progress.completedMilestones ? "completed" : "pending"} |`
      )
      .join("\n")
    : "| _none_ | _n/a_ |";
  const findingRows = input.findings.length > 0
    ? input.findings.map((finding) => `- ${mdCell(finding)}`).join("\n")
    : "- None observed";
  const cycleRows = input.cycles.length > 0
    ? input.cycles
      .map((cycle) =>
        `| ${cycle.cycle} | ${mdCell(cycle.observation.url)} | ${
          mdCell(cycle.toolCalls.map((call) => call.tool).join(", ") || "none")
        } | ${cycle.workUnit.success ? "ok" : "failed"} | ${cycle.workUnit.failedSteps} |`
      )
      .join("\n")
    : "| _none_ | _n/a_ | _n/a_ | _n/a_ | 0 |";

  return [
    "# Functional Test Report",
    "",
    "## Verdict",
    `**${verdict}** — goal achieved: ${input.goalAchieved ? "yes" : "no"}; stopped because \`${input.stopReason}\`.`,
    "",
    "## Goal",
    mdCell(input.goal),
    "",
    "## Summary",
    input.summary || "No summary available.",
    "",
    "## Milestones",
    `Completed ${input.progress.completedMilestones}/${input.progress.totalMilestones} (${input.progress.percent}%).`,
    "",
    "| Milestone | Status |",
    "| --- | --- |",
    milestoneRows,
    "",
    "## Findings",
    findingRows,
    "",
    "## Cycle Log",
    "| Cycle | URL | Tools | Result | Failed Steps |",
    "| --- | --- | --- | --- | --- |",
    cycleRows,
    "",
    "## Recommendations",
    input.functionalTestSucceeded
      ? "- Functional path verified; keep this run as a regression baseline."
      : "- Review the failing cycles above and the listed blockers, then re-run after fixes.",
    "",
    `_Run \`${input.runId}\` · scope ${mdCell(input.allowedOrigin)}._`,
  ].join("\n");
}

/**
 * Render successful tool/step outputs into compact strings the planner can read
 * back as ground truth (e.g. the readPage DOM snapshot or extracted text). Keeps
 * payloads bounded so the planner context stays small.
 */
function summarizeToolOutputs(
  toolCalls: RetvCdpToolCall[],
  steps: CdpWorkStep[],
  results: CdpWorkStepResult[],
): string[] {
  const outputs: string[] = [];
  results.forEach((result, index) => {
    const action = result.action || steps[index]?.action || "step";
    const call = toolCalls[index];
    // Prefer a content-based label for readPage so the anti-loop steer can find
    // it regardless of toolCall<->step index alignment (readPage maps to evaluate).
    const isReadPage = call?.tool === "readPage" ||
      (result.output !== null && typeof result.output === "object" &&
        Array.isArray((result.output as Record<string, unknown>).interactive));
    const label = isReadPage ? "readPage" : (call?.tool || action);
    if (!result.ok) {
      outputs.push(`${label}: FAILED ${result.error || "unknown_error"}`);
      return;
    }
    if (result.output === undefined || result.output === null) {
      return;
    }
    let rendered: string;
    if (typeof result.output === "string") {
      rendered = result.output;
    } else {
      try {
        rendered = JSON.stringify(result.output);
      } catch {
        rendered = String(result.output);
      }
    }
    rendered = rendered.replace(/\s+/g, " ").trim();
    if (!rendered) {
      return;
    }
    outputs.push(`${label}: ${rendered.slice(0, isReadPage ? 2800 : 1500)}`);
  });
  return outputs.slice(0, 6);
}

/**
 * Build a CDP evaluate expression that returns a raw-page snapshot: title,
 * trimmed HTML, and interactive elements with valid CSS selectors the planner
 * can act on. Backs the readPage tool.
 */
function pageSnapshotExpression(maxElements: number): string {
  return `(() => {
    const cssEscape = (value) => (window.CSS && CSS.escape) ? CSS.escape(String(value)) : String(value);
    const selectorFor = (el) => {
      if (el.id) return '#' + cssEscape(el.id);
      const name = el.getAttribute('name');
      if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
      const parts = [el.tagName.toLowerCase()];
      const cls = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 2);
      for (const c of cls) parts.push('.' + cssEscape(c));
      let selector = parts.join('');
      try {
        if (el.parentElement && document.querySelectorAll(selector).length > 1) {
          const index = Array.prototype.indexOf.call(el.parentElement.children, el) + 1;
          selector += ':nth-child(' + index + ')';
        }
      } catch (_error) { /* keep best-effort selector */ }
      return selector;
    };
    const nodes = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=tab],[role=link],[onclick],[contenteditable=true]'));
    const interactive = nodes.slice(0, ${maxElements}).map((el) => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      text: (el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 80),
      selector: selectorFor(el),
    }));
    // interactive[] (with selectors) is listed FIRST so it survives downstream
    // truncation; html is a trimmed fallback for additional context.
    return {
      url: location.href,
      title: document.title,
      interactiveCount: nodes.length,
      interactive,
      html: (document.body ? document.body.innerHTML : document.documentElement.outerHTML).replace(/\\s+/g, ' ').slice(0, 2000),
    };
  })()`;
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * Resolve the set of origins a run is allowed to roam across. Always includes
 * the start origin; callers may broaden it with extra domains/origins from the
 * form. A literal "*" entry disables drift scoping entirely (roam anywhere).
 */
function resolveAllowedOrigins(startUrl: string, extra?: string[]): Set<string> {
  const origins = new Set<string>();
  const startOrigin = canonicalOrigin(startUrl);
  if (startOrigin) {
    origins.add(startOrigin);
  }

  for (const raw of extra ?? []) {
    const token = String(raw || "").trim();
    if (!token) {
      continue;
    }
    if (token === "*") {
      origins.add("*");
      continue;
    }
    const origin = normalizeOriginToken(token);
    if (origin) {
      origins.add(canonicalOrigin(origin) || origin);
    }
  }

  return origins;
}

/** Coerce a user-typed domain or URL into a comparable origin. */
function normalizeOriginToken(token: string): string {
  const direct = safeOrigin(token);
  if (direct) {
    return direct;
  }
  // Bare domains/hosts (e.g. "example.com", "example.com:8443") get https://.
  const withScheme = safeOrigin(`https://${token}`);
  return withScheme;
}

// localhost, 127.0.0.1, and host.docker.internal are the same machine seen
// from different network namespaces — the CDP driver's loopback auto-rewrite
// moves between them mid-run, and that must never read as scope drift.
const LOOPBACK_EQUIVALENT_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "0.0.0.0",
  "host.docker.internal",
]);

/**
 * Milestone accounting that trusts evidence over bookkeeping. Weak planner
 * models chronically under-report their own milestone counts (prose says
 * "successful", JSON still says 2 of 4), which starved progress and killed
 * runs with no_progress_pause. A clean cycle (every step succeeded, planner
 * reachable) always advances at least one milestone; a planner reporting
 * AHEAD of that is trusted; progress never regresses; capped at total.
 */
export function reconcileCompletedMilestones(input: {
  plannerReported: number | undefined;
  prior: number;
  cycleSucceeded: boolean;
  allowAutoAdvance: boolean;
  totalMilestones: number;
}): number {
  const { plannerReported, prior, cycleSucceeded, allowAutoAdvance, totalMilestones } = input;
  const plannerCount = Number.isFinite(plannerReported)
    ? Math.max(0, Math.min(totalMilestones, Number(plannerReported)))
    : 0;
  const evidenceFloor = allowAutoAdvance && cycleSucceeded
    ? Math.min(totalMilestones, prior + 1)
    : prior;
  return Math.max(plannerCount, evidenceFloor, prior);
}

export function canonicalOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    if (LOOPBACK_EQUIVALENT_HOSTS.has(parsed.hostname)) {
      parsed.hostname = "localhost";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

export function isDrift(url: string, allowedOrigins: Set<string>): boolean {
  const current = canonicalOrigin(url);
  if (allowedOrigins.has("*") || allowedOrigins.size === 0 || !current) {
    return false;
  }
  return !allowedOrigins.has(current);
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

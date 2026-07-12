// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { computed, Injectable, signal } from "@angular/core";
import {
  AgentConsoleLine,
  AgentTranscriptItem,
  CdpSessionSummary,
  CdpWorkStep,
  CdpWorkUnitResult,
  GitHubRepository,
  GraphSnapshotView,
  PullRequest,
  PullRequestDiffFile,
  RetvCdpRunEvent,
  RetvCdpRunListItem,
  RetvCdpRunResult,
  RetvCdpToolCall,
  RetvPlannerConfigUpdate,
  RetvPlannerConfigView,
  ReviewAgentRunListItem,
  ReviewChecklistItem,
  ReviewCycleSummary,
  ReviewFinding,
  ReviewNarrativeEntry,
  ReviewProgress,
  ReviewRun,
  ReviewRunEvent,
  ReviewSessionSummary,
  TcsrtcGate,
} from "../models";
import { ApiClientService } from "../services/api-client.service";
import { countOpenPullRequests } from "./rules";

interface FunctionalGoalMilestone {
  id: string;
  title: string;
  status: "pending" | "active" | "done";
}

interface FunctionalGoalPlan {
  goal: string;
  allowedOrigin: string;
  milestones: FunctionalGoalMilestone[];
  createdAt: string;
}

interface FunctionalGoalProgress {
  completedMilestones: number;
  totalMilestones: number;
  percent: number;
  nextMilestone: string;
  roundsWithoutProgress: number;
  driftWarnings: number;
  lastUpdatedAt: string;
}

interface PageObservationSnapshot {
  label: string;
  url: string;
  title: string;
  activePageTab: string;
  activeRunTab: string;
  buttonLabels: string[];
  timestamp: string;
}

interface FunctionalRunSummary {
  status: "running" | "paused" | "completed" | "failed";
  runName: string;
  goal: string;
  stopReason?: string;
  finishedAt: string;
  functionalSuccess: boolean;
  goalAchieved: boolean;
  cycle: number;
  milestonesCompleted: number;
  milestonesTotal: number;
  failedStepCount: number;
  findings: string[];
  summary?: string;
}

interface AgentWorkOptions {
  goalAware?: boolean;
  cycle?: number;
  maxCycles?: number;
}

interface AgentPlannerToolEntry {
  id: string;
  cycle: number;
  tool: string;
  reason: string;
  at: string;
}

type AgentRunPhase = "idle" | "connecting" | "observing" | "planning" | "acting" | "completing";

@Injectable({ providedIn: "root" })
export class CapillaryStore {
  readonly repositories = signal<GitHubRepository[]>([]);
  readonly pullRequests = signal<PullRequest[]>([]);
  /**
   * Genuinely-open PRs in the loaded list. The "Open PRs" stat must count by
   * state, not list length — with the closed/history filter active, the raw
   * length is merged/closed PRs and reads as a wildly wrong open count.
   * Predicate lives in rules.ts (pure, spec-covered, defensive on missing state).
   */
  readonly openPullRequestCount = computed(() => countOpenPullRequests(this.pullRequests()));
  readonly findings = signal<ReviewFinding[]>([]);
  readonly checklist = signal<ReviewChecklistItem[]>([]);
  readonly reviewEvents = signal<string[]>([]);
  readonly markdownPreview = signal<string>("");
  readonly reviewGraph = signal<GraphSnapshotView | null>(null);
  readonly reviewProgress = signal<ReviewProgress | null>(null);
  readonly reviewCycles = signal<ReviewCycleSummary[]>([]);
  readonly reviewReport = signal<string | null>(null);
  readonly reviewToolActivity = signal<string[]>([]);
  readonly reviewNarrative = signal<ReviewNarrativeEntry[]>([]);
  readonly reviewGatesCovered = signal<TcsrtcGate[]>([]);
  readonly reviewCurrentGate = signal<TcsrtcGate | null>(null);
  readonly prCommentState = signal<"idle" | "posting" | "posted" | "failed">("idle");
  readonly prCommentUrl = signal<string | null>(null);
  readonly reviewTraceEnabled = signal(false);
  readonly reviewSuggestEnabled = signal(false);
  /** Cumulative model tokens for the active run (input + output). */
  readonly reviewTokensUsed = signal(0);
  readonly reviewInputTokens = signal(0);
  readonly reviewOutputTokens = signal(0);
  /** Current agent cycle number, streamed live. */
  readonly reviewCycle = signal(0);
  toggleReviewSuggest(on: boolean): void {
    this.reviewSuggestEnabled.set(on);
  }
  readonly reviewRunHistory = signal<ReviewAgentRunListItem[]>([]);
  readonly selectedReviewRunId = signal<string | null>(null);
  readonly selectedReviewTraceEnabled = signal(false);

  readonly githubConnected = signal(false);
  readonly selectedRepositoryId = signal<string | null>(null);
  readonly selectedPullRequestId = signal<string | null>(null);
  readonly prStateFilter = signal<"open" | "closed">("open");
  readonly reviewRun = signal<ReviewRun | null>(null);
  readonly status = signal("idle");
  readonly progress = signal(0);
  readonly lastError = signal<string | null>(null);

  readonly cdpSessions = signal<CdpSessionSummary[]>([]);
  readonly activeCdpSessionId = signal<string | null>(null);
  readonly agentTranscript = signal<AgentTranscriptItem[]>([]);
  readonly cdpRoundRunning = signal(false);
  readonly cdpQueueDepth = signal(0);
  readonly cdpGoal = signal("");
  readonly cdpGoalPlan = signal<FunctionalGoalPlan | null>(null);
  readonly cdpGoalProgress = signal<FunctionalGoalProgress | null>(null);
  readonly cdpLastObservation = signal<PageObservationSnapshot | null>(null);
  readonly cdpRunSummary = signal<FunctionalRunSummary | null>(null);
  readonly cdpTraceEnabled = signal(false);
  readonly cdpRunReport = signal<string | null>(null);
  readonly cdpRunHistory = signal<RetvCdpRunListItem[]>([]);
  readonly cdpSelectedRunId = signal<string | null>(null);
  readonly cdpSelectedRunTraceEnabled = signal(false);
  readonly retvPlannerConfig = signal<RetvPlannerConfigView | null>(null);
  readonly cdpStartUrl = signal("http://localhost:4200");
  readonly cdpAllowedDomains = signal("");
  readonly lastCdpResult = signal<CdpWorkUnitResult | null>(null);

  readonly agentConsole = signal<AgentConsoleLine[]>([]);
  readonly agentScreenshot = signal<string | null>(null);
  readonly agentStreaming = signal(false);
  readonly agentPlannerCycle = signal<number | null>(null);
  readonly agentPlannerLiveText = signal("");
  readonly agentPlannerToolHistory = signal<AgentPlannerToolEntry[]>([]);
  readonly agentRunPhase = signal<AgentRunPhase>("idle");
  readonly agentRunPhaseLabel = computed(() => {
    const phase = this.agentRunPhase();
    switch (phase) {
      case "connecting":
        return "connecting browser";
      case "observing":
        return "observing state";
      case "planning":
        return "planner reasoning";
      case "acting":
        return "executing tools";
      case "completing":
        return "finalizing verdict";
      default:
        return "idle";
    }
  });
  readonly pendingNavigation = signal<string | null>(null);
  #agentStream: EventSource | null = null;
  #reviewStream: EventSource | null = null;
  #plannerDeltaBuffer = "";
  #plannerDeltaCycle: number | null = null;
  #plannerDeltaFlushTimer: number | null = null;

  readonly activeCdpSession = computed(() =>
    this.cdpSessions().find((session) => session.sessionId === this.activeCdpSessionId()) ?? null
  );

  /**
   * True when a review for the currently selected PR is already running. Guards
   * against the double-run token-burn footgun: the same PR cannot be reviewed
   * twice concurrently (a different PR still can).
   */
  readonly selectedReviewInProgress = computed(() => {
    const prId = this.selectedPullRequestId();
    return Boolean(prId) && this.reviewSessions().some((s) => s.active && s.pullRequestId === prId);
  });

  readonly canBegin = computed(() =>
    Boolean(this.selectedPullRequestId()) &&
    this.status() !== "reviewing" &&
    this.status() !== "graphing" &&
    !this.selectedReviewInProgress()
  );

  readonly canCancel = computed(() => {
    const run = this.reviewRun();
    return Boolean(run && run.status !== "completed" && run.status !== "cancelled");
  });

  readonly selectedRepository = computed(() =>
    this.repositories().find((repo) => repo.id === this.selectedRepositoryId()) ?? null
  );

  readonly selectedPullRequest = computed(() =>
    this.pullRequests().find((pr) => pr.id === this.selectedPullRequestId()) ?? null
  );

  readonly findingCount = computed(() => this.findings().length);

  readonly highRiskCount = computed(() =>
    this.findings().filter((finding) =>
      finding.severity === "high" || finding.severity === "blocker"
    ).length
  );

  readonly checklistCompletion = computed(() => {
    const items = this.checklist();
    if (items.length === 0) {
      return 0;
    }
    const completed = items.filter((item) => item.completed).length;
    return Math.round((completed / items.length) * 100);
  });

  #cdpQueue: Promise<void> = Promise.resolve();

  constructor(private readonly api: ApiClientService) {
    // Reconnect to any server-side review sessions that outlived the last
    // page: reviews are durable, the browser is just a viewport.
    void this.restoreReviewSessions();
    setInterval(() => {
      if (this.reviewSessions().some((session) => session.active)) {
        void this.refreshReviewSessions();
      }
    }, 20_000);
  }

  async refreshCdpSessions(): Promise<void> {
    try {
      const sessions = await this.api.listCdpSessions();
      this.cdpSessions.set(sessions);
      if (!this.activeCdpSessionId() && sessions.length > 0) {
        this.activeCdpSessionId.set(sessions[0].sessionId);
      }
      if (
        this.activeCdpSessionId() &&
        !sessions.some((session) => session.sessionId === this.activeCdpSessionId())
      ) {
        this.activeCdpSessionId.set(sessions[0]?.sessionId || null);
      }
    } catch (error) {
      this.pushAgentMessage("system", `Failed to list CDP sessions: ${toMessage(error)}`, "error");
    }
  }

  async launchAgentBrowser(startUrl = this.cdpStartUrl()): Promise<void> {
    try {
      const session = await this.api.createCdpSession(startUrl || "about:blank");
      this.activeCdpSessionId.set(session.sessionId);
      this.cdpSessions.update((current) =>
        [session].concat(current.filter((item) => item.sessionId !== session.sessionId))
      );
      this.pushAgentMessage("system", `Browser session launched at ${session.targetUrl}.`, "info");
    } catch (error) {
      this.pushAgentMessage(
        "system",
        `Unable to launch browser session: ${toMessage(error)}`,
        "error",
      );
      this.lastError.set("Unable to launch browser session.");
    }
  }

  async closeAgentBrowser(): Promise<void> {
    const sessionId = this.activeCdpSessionId();
    if (!sessionId) {
      return;
    }

    try {
      await this.api.closeCdpSession(sessionId);
      this.pushAgentMessage("system", "Browser session closed.", "info");
      await this.refreshCdpSessions();
    } catch (error) {
      this.pushAgentMessage(
        "system",
        `Failed to close browser session: ${toMessage(error)}`,
        "error",
      );
    }
  }

  async refreshRetvPlannerConfig(): Promise<void> {
    try {
      const config = await this.api.getRetvPlannerConfig();
      this.retvPlannerConfig.set(config);
    } catch (error) {
      this.pushAgentMessage(
        "system",
        `Failed to load RetV planner config: ${toMessage(error)}`,
        "error",
      );
    }
  }

  async saveRetvPlannerConfig(update: RetvPlannerConfigUpdate): Promise<void> {
    try {
      const saved = await this.api.setRetvPlannerConfig(update);
      this.retvPlannerConfig.set(saved);
      this.pushAgentMessage(
        "system",
        `RetV planner configured: provider=${saved.providerKind}, model=${saved.model}, endpoint=${saved.baseUrl}`,
        "info",
      );
    } catch (error) {
      this.pushAgentMessage(
        "system",
        `Failed to save RetV planner config: ${toMessage(error)}`,
        "error",
      );
      this.lastError.set("Failed to save RetV planner config.");
    }
  }

  beginAgentFunctionalRound(goal: string): void {
    const normalizedGoal = goal.trim();
    if (!normalizedGoal) {
      this.pushAgentMessage(
        "agent",
        "Please provide a goal so I can build the functional test round.",
        "question",
      );
      return;
    }

    this.cdpGoal.set(normalizedGoal);
    const plan = this.buildStructuredGoalPlan(normalizedGoal);
    this.cdpGoalPlan.set(plan);
    this.cdpGoalProgress.set(this.computeGoalProgress(plan, 0, 0));
    this.cdpLastObservation.set(null);
    this.cdpRunSummary.set(null);
    this.pushAgentMessage("user", normalizedGoal, "info");
    this.pushAgentMessage("system", this.buildStructuredPlanningPrompt(plan), "info");
    this.pushAgentMessage("agent", this.renderPlanSummary(plan), "info");
    this.enqueueRetvGoalRound(normalizedGoal);
  }

  streamAgentFunctionalRound(goal: string): void {
    const normalizedGoal = goal.trim();
    if (!normalizedGoal) {
      this.pushAgentMessage(
        "agent",
        "Please provide a goal so I can run the functional test round.",
        "question",
      );
      return;
    }
    if (this.agentStreaming()) {
      this.pushConsole(
        "system",
        "A streaming round is already running. Stop it before starting another.",
      );
      return;
    }

    this.cdpGoal.set(normalizedGoal);
    this.agentConsole.set([]);
    this.agentScreenshot.set(null);
    this.resetPlannerTelemetry();
    this.pushAgentMessage("user", normalizedGoal, "info");
    this.pushConsole("user", `goal: ${normalizedGoal}`);

    const sessionId = this.activeCdpSessionId() || undefined;
    const startUrl = this.cdpStartUrl();
    const allowedDomains = this.cdpAllowedDomains().trim();
    const url = this.api.buildRetvCdpStreamUrl({
      goal: normalizedGoal,
      sessionId,
      startUrl,
      trace: this.cdpTraceEnabled(),
      allowedDomains: allowedDomains || undefined,
    });

    let source: EventSource;
    try {
      source = new EventSource(url);
    } catch (error) {
      this.pushConsole("system", `Unable to open stream: ${toMessage(error)}`);
      return;
    }

    this.#agentStream = source;
    this.agentStreaming.set(true);
    this.cdpRoundRunning.set(true);
    this.agentRunPhase.set("connecting");

    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as RetvCdpRunEvent;
        this.handleStreamEvent(event);
      } catch {
        this.pushConsole("system", `unparseable event: ${String(message.data).slice(0, 200)}`);
      }
    };

    source.onerror = () => {
      if (this.agentStreaming()) {
        this.pushConsole("system", "stream closed");
      }
      this.stopAgentStream();
    };
  }

  stopAgentStream(): void {
    if (this.#agentStream) {
      this.#agentStream.close();
      this.#agentStream = null;
    }
    this.agentStreaming.set(false);
    this.cdpRoundRunning.set(false);
    this.agentRunPhase.set("idle");
    this.flushPlannerDeltaBuffer();
  }

  clearAgentConsole(): void {
    this.agentConsole.set([]);
    this.agentScreenshot.set(null);
  }

  requestNavigation(rawUrl: string): void {
    const url = this.normalizeNavigationUrl(rawUrl);
    if (!url) {
      this.pushConsole("system", `Not a valid URL: ${rawUrl.trim() || "(empty)"}`);
      return;
    }
    this.pendingNavigation.set(url);
  }

  cancelNavigation(): void {
    this.pendingNavigation.set(null);
  }

  confirmNavigation(): void {
    const url = this.pendingNavigation();
    this.pendingNavigation.set(null);
    if (!url) {
      return;
    }
    this.cdpStartUrl.set(url);
    this.pushConsole("user", `navigate → ${url}`);
    this.enqueueAgentWork(`navigate:${url.slice(0, 48)}`, [
      { action: "navigate", url, waitUntil: "domcontentloaded" },
    ], true);
  }

  navigationIsOffOrigin(targetUrl: string | null): boolean {
    if (!targetUrl) {
      return false;
    }
    const base = this.cdpLastObservation()?.url || this.cdpStartUrl();
    const targetOrigin = this.safeOrigin(targetUrl);
    const baseOrigin = this.safeOrigin(base);
    if (!targetOrigin || !baseOrigin) {
      return false;
    }
    return targetOrigin !== baseOrigin;
  }

  private normalizeNavigationUrl(rawUrl: string): string | null {
    const trimmed = rawUrl.trim();
    if (!trimmed) {
      return null;
    }
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return null;
      }
      return url.toString();
    } catch {
      return null;
    }
  }

  private handleStreamEvent(event: RetvCdpRunEvent): void {
    switch (event.type) {
      case "run_start":
        this.agentRunPhase.set("observing");
        this.resetPlannerTelemetry();
        this.pushConsole(
          "system",
          `run ${event.runId} started · session ${event.sessionId} · origin ${event.allowedOrigin}`,
        );
        if (event.sessionId) {
          this.activeCdpSessionId.set(event.sessionId);
        }
        break;
      case "plan":
        this.pushConsole(
          "plan",
          `plan: ${
            event.structuredPlan.milestones.map((milestone, index) => `${index + 1}. ${milestone}`)
              .join("  ")
          }`,
        );
        break;
      case "observation":
        this.agentRunPhase.set("planning");
        this.pushConsole(
          "observe",
          `cycle ${event.cycle} observe · ${event.observation.title} @ ${event.observation.url}`,
        );
        break;
      case "planner_delta":
        this.agentRunPhase.set("planning");
        this.appendPlannerDelta(event.cycle, event.text);
        break;
      case "planner":
        this.agentRunPhase.set("acting");
        this.mergePlannerRaw(event.cycle, event.rawContent);
        this.recordPlannerToolHistory(event.cycle, event.toolCalls);
        for (const call of event.toolCalls) {
          this.pushConsole(
            "tool",
            `cycle ${event.cycle} → ${call.tool}(${JSON.stringify(call.args)}) — ${call.reason}`,
          );
        }
        if (event.rawContent.trim()) {
          this.pushConsole("llm", `cycle ${event.cycle} thinking:\n${event.rawContent.trim()}`);
        }
        for (const finding of event.findings) {
          this.pushConsole("finding", `cycle ${event.cycle} finding: ${finding}`);
        }
        break;
      case "screenshot":
        this.agentScreenshot.set(event.dataUrl);
        this.pushConsole("observe", `cycle ${event.cycle} screenshot captured`);
        break;
      case "cycle":
        this.agentRunPhase.set("observing");
        this.pushConsole(
          "result",
          `cycle ${event.cycle.cycle} done · success=${event.cycle.workUnit.success} · progress ${event.progress.completedMilestones}/${event.progress.totalMilestones} (${event.progress.percent}%)`,
        );
        break;
      case "log":
        this.pushConsole("system", `${event.level}: ${event.message}`);
        break;
      case "summary":
        this.agentRunPhase.set("completing");
        if (event.summary.trim()) {
          this.pushConsole("llm", `final summary:\n${event.summary.trim()}`);
          this.pushAgentMessage("agent", event.summary.trim(), "result");
        }
        break;
      case "report":
        this.cdpRunReport.set(event.report);
        this.pushConsole("result", "final report generated");
        break;
      case "done":
        this.agentRunPhase.set("completing");
        this.applyRetvGoalRoundResult(event.result);
        this.pushConsole(
          "result",
          `RUN COMPLETE · stop=${event.result.stopReason} · functionalSuccess=${event.result.functionalTestSucceeded} · goalAchieved=${event.result.goalAchieved}`,
        );
        this.pushAgentMessage(
          "agent",
          `RetV completed: stop=${event.result.stopReason}, goalAchieved=${event.result.goalAchieved}`,
          "result",
        );
        this.stopAgentStream();
        break;
    }
  }

  private resetPlannerTelemetry(): void {
    if (this.#plannerDeltaFlushTimer !== null) {
      window.clearTimeout(this.#plannerDeltaFlushTimer);
      this.#plannerDeltaFlushTimer = null;
    }
    this.#plannerDeltaBuffer = "";
    this.#plannerDeltaCycle = null;
    this.agentPlannerCycle.set(null);
    this.agentPlannerLiveText.set("");
    this.agentPlannerToolHistory.set([]);
  }

  private appendPlannerDelta(cycle: number, text: string): void {
    const delta = text || "";
    if (!delta) {
      return;
    }

    if (this.#plannerDeltaCycle !== null && this.#plannerDeltaCycle !== cycle) {
      this.flushPlannerDeltaBuffer();
    }

    this.#plannerDeltaCycle = cycle;
    this.#plannerDeltaBuffer += delta;

    if (this.#plannerDeltaFlushTimer !== null) {
      return;
    }

    this.#plannerDeltaFlushTimer = window.setTimeout(() => {
      this.#plannerDeltaFlushTimer = null;
      this.flushPlannerDeltaBuffer();
    }, 45);
  }

  private flushPlannerDeltaBuffer(): void {
    if (!this.#plannerDeltaBuffer || this.#plannerDeltaCycle === null) {
      return;
    }

    const cycle = this.#plannerDeltaCycle;
    const chunk = this.#plannerDeltaBuffer;
    this.#plannerDeltaBuffer = "";

    if (this.agentPlannerCycle() !== cycle) {
      this.agentPlannerCycle.set(cycle);
      this.agentPlannerLiveText.set(chunk.slice(-4000));
      return;
    }

    this.agentPlannerLiveText.update((current) => `${current}${chunk}`.slice(-4000));
  }

  private mergePlannerRaw(cycle: number, rawContent: string): void {
    this.flushPlannerDeltaBuffer();
    const normalized = (rawContent || "").trim();
    if (!normalized) {
      return;
    }

    if (this.agentPlannerCycle() !== cycle) {
      this.agentPlannerCycle.set(cycle);
      this.agentPlannerLiveText.set(normalized.slice(-4000));
      return;
    }

    this.agentPlannerLiveText.update((current) => {
      if (normalized.length > current.length) {
        return normalized.slice(-4000);
      }
      return current;
    });
  }

  private recordPlannerToolHistory(cycle: number, toolCalls: RetvCdpToolCall[]): void {
    if (!toolCalls.length) {
      return;
    }

    const at = new Date().toLocaleTimeString();
    const entries = toolCalls.map((call, index) => ({
      id: `pt_${cycle}_${index}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      cycle,
      tool: call.tool,
      reason: call.reason,
      at,
    }));

    this.agentPlannerToolHistory.update((history) => history.concat(entries).slice(-24));
  }

  private pushConsole(channel: AgentConsoleLine["channel"], text: string): void {
    this.agentConsole.update((lines) =>
      lines.concat({
        id: `console_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toLocaleTimeString(),
        channel,
        text,
      }).slice(-400)
    );
  }

  steerAgentRound(instruction: string): void {
    const normalized = instruction.trim();
    if (!normalized) {
      return;
    }

    const parsed = this.parseInstructionToSteps(normalized);
    if (parsed.length === 0) {
      this.pushAgentMessage(
        "agent",
        "I could not parse that instruction. Try: navigate <url>, click <selector>, type <selector> => <text>, wait <selector>, extract <selector>, assert <selector> includes <text>.",
        "question",
      );
      return;
    }

    this.pushAgentMessage("user", normalized, "info");
    this.enqueueAgentWork(`steer:${normalized.slice(0, 24)}`, parsed, false);
  }

  setActiveCdpSession(sessionId: string): void {
    this.activeCdpSessionId.set(sessionId);
  }

  async connect(token?: string): Promise<void> {
    this.lastError.set(null);
    try {
      await this.api.connectGithub(token);
      await this.refreshGithubConnectedState();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      if (message.includes("github_auth_failed")) {
        this.lastError.set(
          "GitHub authentication failed. Check PAT value or GITHUB_TOKEN on the API process.",
        );
      } else if (message.includes("github_token_required") || message.includes("unauthorized")) {
        this.lastError.set(
          "GitHub token required. Paste a PAT and click Connect PAT (or set GITHUB_TOKEN). ",
        );
      } else {
        this.lastError.set("Failed to connect GitHub.");
      }
      this.status.set("failed");
    }
  }

  async connectWithGithubOAuth(webOrigin: string, fallbackToken?: string): Promise<void> {
    this.lastError.set(null);
    let deviceUserCode: string | null = null;
    let deviceAuthorizeUrl: string | null = null;

    try {
      let oauth;
      try {
        oauth = await this.api.startGithubOAuth(webOrigin);
      } catch (error) {
        const message = error instanceof Error ? error.message : "github_oauth_failed";
        // In environments where GitHub auth is already brokered, OAuth app credentials are optional.
        if (message.includes("github_oauth_not_configured")) {
          if (fallbackToken?.trim()) {
            await this.connect(fallbackToken.trim());
            return;
          }

          try {
            const repos = await this.api.listRepositories();
            this.githubConnected.set(true);
            this.repositories.set(repos);
            this.selectedRepositoryId.set(null);
            this.selectedPullRequestId.set(null);
            this.pullRequests.set([]);
            this.status.set("connected");
            this.reviewEvents.set(["github_connected"]);
            return;
          } catch {
            try {
              await this.connect();
            } catch (fallbackError) {
              const fallbackMessage = fallbackError instanceof Error
                ? fallbackError.message
                : "unknown_error";
              if (
                fallbackMessage.includes("github_token_required") ||
                fallbackMessage.includes("unauthorized")
              ) {
                throw new Error("github_oauth_not_configured");
              }
              throw fallbackError;
            }
          }
          return;
        }
        throw error;
      }

      const popup = this.openOAuthPopup(oauth.authorizeUrl);
      if (oauth.mode === "device") {
        deviceUserCode = oauth.userCode;
        deviceAuthorizeUrl = oauth.authorizeUrl;
        this.lastError.set(
          `Complete GitHub login with code ${oauth.userCode}. If not auto-filled, enter it at github.com/login/device.`,
        );
      }

      if (!popup) {
        if (oauth.mode === "device") {
          throw new Error("oauth_popup_blocked_device");
        }
        throw new Error("oauth_popup_blocked");
      }

      if (oauth.mode === "device") {
        await this.waitForGithubDeviceOAuthResult(
          oauth.sessionId,
          oauth.intervalSeconds,
          oauth.expiresAt,
          popup,
        );
      } else {
        await this.waitForGithubOAuthResult(popup, this.api.getApiOrigin(), oauth.expiresAt);
      }

      await this.refreshGithubConnectedState();
      this.lastError.set(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "github_oauth_failed";
      if (message.includes("oauth_popup_blocked_device")) {
        this.lastError.set(
          `Popup blocked. Open ${
            deviceAuthorizeUrl || "https://github.com/login/device"
          } and enter code ${deviceUserCode || "(not available)"}.`,
        );
      } else if (message.includes("oauth_popup_blocked")) {
        this.lastError.set("Popup blocked. Allow popups for localhost to complete GitHub OAuth.");
      } else if (message.includes("github_oauth_not_configured")) {
        this.lastError.set(
          "Browser OAuth requires GITHUB_OAUTH_CLIENT_ID on the API process. For now, use Connect PAT or set GITHUB_TOKEN.",
        );
      } else if (message.includes("oauth_popup_closed")) {
        this.lastError.set("GitHub OAuth was cancelled before completion.");
      } else if (message.includes("oauth_timeout")) {
        this.lastError.set("GitHub OAuth timed out. Try connecting again.");
      } else if (message.includes("github_oauth_access_denied")) {
        this.lastError.set("GitHub OAuth access was denied.");
      } else {
        this.lastError.set("GitHub OAuth failed.");
      }
      this.status.set("failed");
    }
  }

  async selectRepository(repositoryId: string, stateFilter = this.prStateFilter()): Promise<void> {
    this.selectedRepositoryId.set(repositoryId);
    this.selectedPullRequestId.set(null);
    this.prStateFilter.set(stateFilter);
    this.pullRequests.set([]);
    this.lastError.set(null);
    this.reviewRun.set(null);
    this.progress.set(0);
    this.findings.set([]);
    this.checklist.set([]);
    this.markdownPreview.set("");
    this.reviewGraph.set(null);

    try {
      const pullRequests = await this.api.listPullRequests(repositoryId, stateFilter);
      this.pullRequests.set(pullRequests);
      this.status.set("repository_selected");
      this.reviewEvents.set([`repository_selected:${repositoryId}:${stateFilter}`]);
    } catch {
      this.lastError.set("Failed to load pull requests.");
      this.status.set("failed");
    }
  }

  async setPullRequestFilter(stateFilter: "open" | "closed"): Promise<void> {
    this.prStateFilter.set(stateFilter);
    const repositoryId = this.selectedRepositoryId();
    if (!repositoryId) {
      return;
    }

    await this.selectRepository(repositoryId, stateFilter);
  }

  selectPullRequest(pullRequestId: string): void {
    this.selectedPullRequestId.set(pullRequestId);
    this.status.set("pull_request_selected");
    this.reviewEvents.update((events) => events.concat(`pull_request_selected:${pullRequestId}`));
  }

  // --- durable review sessions --------------------------------------------
  // Runs live on the server; the browser only attaches. Bouncing between
  // screens, reloading, or switching sessions never interrupts a review —
  // re-attaching replays the full narrative, then tails live.

  readonly reviewSessions = signal<ReviewSessionSummary[]>([]);
  readonly activeSessionRunId = signal<string | null>(null);
  readonly newSessionWarningVisible = signal(false);

  async refreshReviewSessions(): Promise<void> {
    try {
      this.reviewSessions.set(await this.api.listReviewSessions());
    } catch {
      // Session list is advisory UI state; never surface a poll failure.
    }
  }

  /** Reconnect to server-side sessions on app load (survives reloads). */
  async restoreReviewSessions(): Promise<void> {
    await this.refreshReviewSessions();
    const latestActive = this.reviewSessions().find((session) => session.active);
    if (latestActive && !this.#reviewStream) {
      this.attachToSession(latestActive.runId);
    }
  }

  /**
   * Entry point for the Begin Review button. When other sessions are still
   * running, surface the token-cost warning first — each concurrent session
   * drives its own model turns.
   */
  async beginReview(): Promise<void> {
    if (!this.selectedPullRequestId() || !this.selectedRepositoryId()) {
      return;
    }
    // Same PR already under review: hard stop, no confirm bypass — this is the
    // double-run footgun the guard exists to kill.
    if (this.selectedReviewInProgress()) {
      this.lastError.set("A review for this pull request is already in progress.");
      return;
    }
    // A different PR under review is allowed, but confirm so it is deliberate.
    if (this.reviewSessions().some((session) => session.active)) {
      this.newSessionWarningVisible.set(true);
      return;
    }
    await this.startNewSession();
  }

  /**
   * Post every commentable finding (one that resolved to a real diff line) as an
   * inline PR comment, sequentially to stay under GitHub's secondary rate limit,
   * skipping any already posted. This is the "come back, post them all for the
   * author" flow.
   */
  readonly postingAllComments = signal(false);
  async postAllFindingComments(): Promise<void> {
    if (this.postingAllComments()) {
      return;
    }
    this.postingAllComments.set(true);
    try {
      // Exclude terminal AND in-flight states: a finding whose individual post
      // is mid-flight when this snapshot is taken must not be queued again, or
      // it lands twice on the PR. postFindingComment re-checks per item too,
      // since a state can change while the batch walks the queue.
      const pending = this.findings().filter((finding) => {
        const state = this.commentState()[finding.id];
        return Boolean(finding.line) && state !== "posted" && state !== "posting";
      });
      for (const finding of pending) {
        await this.postFindingComment(finding.id);
      }
    } finally {
      this.postingAllComments.set(false);
    }
  }

  async confirmNewSession(): Promise<void> {
    this.newSessionWarningVisible.set(false);
    await this.startNewSession();
  }

  dismissNewSessionWarning(): void {
    this.newSessionWarningVisible.set(false);
  }

  private async startNewSession(): Promise<void> {
    const pullRequestId = this.selectedPullRequestId();
    const repositoryId = this.selectedRepositoryId();
    if (!pullRequestId || !repositoryId) {
      return;
    }

    this.lastError.set(null);
    try {
      const session = await this.api.createReviewSession({
        pullRequestId,
        repositoryId,
        trace: this.reviewTraceEnabled(),
        suggest: this.reviewSuggestEnabled(),
      });
      await this.refreshReviewSessions();
      this.attachToSession(session.runId);
    } catch (error) {
      this.status.set("failed");
      this.lastError.set(`Unable to start review session: ${toMessage(error)}`);
    }
  }

  /** Switch the viewport to a session; the previous one keeps running. */
  switchToSession(runId: string): void {
    if (runId === this.activeSessionRunId()) {
      return;
    }
    this.attachToSession(runId);
  }

  private attachToSession(runId: string): void {
    this.stopReviewStream();
    this.#resetReviewViewState();
    this.activeSessionRunId.set(runId);

    let source: EventSource;
    try {
      source = new EventSource(this.api.buildSessionStreamUrl(runId));
    } catch (error) {
      this.status.set("failed");
      this.lastError.set(`Unable to attach to session: ${toMessage(error)}`);
      return;
    }

    this.#reviewStream = source;
    this.status.set("graphing");

    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as ReviewRunEvent;
        void this.handleReviewStreamEvent(event);
      } catch {
        this.reviewEvents.update((events) =>
          events.concat(`unparseable:${String(message.data).slice(0, 160)}`)
        );
      }
    };

    source.onerror = () => {
      // The server closes the stream after `done` — that is a normal end,
      // not a failure. Only flag streams that die mid-run.
      const status = this.status();
      if (this.#reviewStream && status !== "completed" && status !== "failed") {
        this.lastError.set("Review stream closed before completion.");
        this.status.set("failed");
      }
      this.stopReviewStream();
      void this.refreshReviewSessions();
    };
  }

  #resetReviewViewState(): void {
    this.status.set("queued");
    this.progress.set(4);
    this.lastError.set(null);
    this.reviewTokensUsed.set(0);
    this.reviewInputTokens.set(0);
    this.reviewOutputTokens.set(0);
    this.reviewCycle.set(0);
    this.reviewEvents.set(["phase:queued"]);
    this.findings.set([]);
    this.checklist.set([]);
    this.markdownPreview.set("");
    this.reviewGraph.set(null);
    this.reviewProgress.set(null);
    this.reviewCycles.set([]);
    this.reviewReport.set(null);
    this.reviewToolActivity.set([]);
    this.reviewNarrative.set([]);
    this.reviewGatesCovered.set([]);
    this.reviewCurrentGate.set(null);
    this.prCommentState.set("idle");
    this.prCommentUrl.set(null);
    this.#liveRunId = null;
  }

  stopReviewStream(): void {
    if (this.#reviewStream) {
      this.#reviewStream.close();
      this.#reviewStream = null;
    }
  }

  #narrativeSeq = 0;
  #liveRunId: string | null = null;

  #pushNarrative(entry: Omit<ReviewNarrativeEntry, "id">): void {
    this.#narrativeSeq += 1;
    this.reviewNarrative.update((entries) =>
      entries.concat({ ...entry, id: `nar_${this.#narrativeSeq}` })
    );
  }

  /**
   * Pull the persisted graph snapshot mid-run so the torus is viewable the
   * moment it is mapped, not only after completion. Best-effort: a failed
   * fetch never disturbs the stream.
   */
  async #refreshLiveGraph(runId: string): Promise<void> {
    try {
      const graph = await this.api.getGraph(runId);
      if (this.#liveRunId === runId) {
        this.reviewGraph.set(graph);
      }
    } catch {
      // Snapshot not ready yet; a later phase or completion will retry.
    }
  }

  private async handleReviewStreamEvent(event: ReviewRunEvent): Promise<void> {
    switch (event.type) {
      case "run_start":
        this.#liveRunId = event.runId;
        this.reviewRun.update((run) => (run ? { ...run, id: event.runId } : run));
        this.reviewEvents.update((events) => events.concat(`run_start:${event.runId}`));
        break;
      case "phase": {
        this.status.set(reviewStatusForPhase(event.phase));
        this.progress.set(reviewProgressFromPhase(event.phase));
        this.reviewEvents.update((events) =>
          events.concat(
            event.detail ? `phase:${event.phase}:${event.detail}` : `phase:${event.phase}`,
          )
        );
        const stage = reviewStageNarrative(event.phase);
        if (stage) {
          this.#pushNarrative({ kind: "stage", text: stage });
        }
        // Shape samples land right before the tcsrct phase: refresh the live
        // torus so nodes sit at their real curvature-bearing positions.
        if (event.phase === "tcsrct" && this.#liveRunId) {
          void this.#refreshLiveGraph(this.#liveRunId);
        }
        break;
      }
      case "graph":
        this.reviewEvents.update((events) =>
          events.concat(`dag:built:nodes=${event.nodeCount}:edges=${event.edgeCount}`)
        );
        this.#pushNarrative({
          kind: "stage",
          text: `Torus mapped — ${event.nodeCount} nodes, ${event.edgeCount} edges.`,
        });
        if (this.#liveRunId) {
          void this.#refreshLiveGraph(this.#liveRunId);
        }
        break;
      case "log":
        this.reviewEvents.update((events) => events.concat(`${event.level}:${event.message}`));
        break;
      case "thinking":
        this.reviewCurrentGate.set(event.gate);
        this.reviewGatesCovered.update((gates) =>
          gates.includes(event.gate) ? gates : gates.concat(event.gate)
        );
        this.reviewEvents.update((events) => events.concat(`thinking:${event.gate}:${event.text}`));
        this.#pushNarrative({
          kind: "thinking",
          cycle: event.cycle,
          gate: event.gate,
          text: event.text,
        });
        break;
      case "tool":
        this.reviewToolActivity.update((items) =>
          items.concat(
            `#${event.cycle} ${event.tool} ${event.ok ? "ok" : "fail"}: ${event.summary}`,
          )
        );
        this.reviewEvents.update((events) =>
          events.concat(`tool:${event.tool}:cycle=${event.cycle}:${event.ok ? "ok" : "fail"}`)
        );
        this.#pushNarrative({
          kind: "tool",
          cycle: event.cycle,
          tool: event.tool,
          ok: event.ok,
          text: event.reason || event.summary,
        });
        break;
      case "finding":
        this.findings.update((current) =>
          current.some((finding) => finding.id === event.finding.id)
            ? current
            : current.concat(event.finding)
        );
        this.reviewEvents.update((events) =>
          events.concat(`finding:${event.finding.severity}:${event.finding.title}`)
        );
        this.#pushNarrative({
          kind: "finding",
          severity: event.finding.severity,
          text: `${event.finding.title} — ${event.finding.filePath}${
            event.finding.line ? `:${event.finding.line}` : ""
          }`,
        });
        break;
      case "cycle": {
        const percent = event.gatesTotal > 0
          ? Math.round((event.gatesCovered / event.gatesTotal) * 100)
          : 0;
        this.progress.set(reviewProgressFromPhase("tcsrct", percent));
        this.reviewCycle.set(event.cycle);
        if (event.tokensUsed > 0) {
          this.reviewTokensUsed.set(event.tokensUsed);
          this.reviewInputTokens.set(event.inputTokens);
          this.reviewOutputTokens.set(event.outputTokens);
        }
        this.reviewEvents.update((events) =>
          events.concat(
            `gate:${event.gate}:cycle=${event.cycle}:tools=${event.toolCount}:findings=${event.findingCount}`,
          )
        );
        this.#pushNarrative({
          kind: "gate",
          cycle: event.cycle,
          gate: event.gate,
          text: `${event.toolCount} tool call${event.toolCount === 1 ? "" : "s"}, ` +
            `${event.findingCount} finding${event.findingCount === 1 ? "" : "s"}`,
        });
        break;
      }
      case "report":
        this.reviewReport.set(event.markdown);
        this.markdownPreview.set(event.markdown);
        break;
      case "done":
        this.reviewProgress.set(event.result.progress);
        this.reviewCycles.set(event.result.cycles);
        this.stopReviewStream();
        void this.refreshReviewSessions();
        if (event.result.phase === "failed") {
          this.status.set("failed");
          this.lastError.set(`Review failed: ${event.result.stopReason}`);
          return;
        }
        this.selectedReviewRunId.set(event.result.runId);
        this.selectedReviewTraceEnabled.set(this.reviewTraceEnabled());
        await this.loadReviewArtifacts(event.result.runId);
        void this.loadReviewRunHistory();
        break;
    }
  }

  private async loadReviewArtifacts(runId: string): Promise<void> {
    const [events, markdown, graph, findingsResult, checklistResult] = await Promise.all([
      this.api.getReviewEvents(runId),
      this.api.getMarkdown(runId),
      this.api.getGraph(runId),
      this.api.getReviewFindings(runId),
      this.api.getReviewChecklist(runId),
    ]);

    const parsed = this.#parseMarkdown(markdown);
    this.findings.set(
      findingsResult.findings.length > 0 ? findingsResult.findings : parsed.findings,
    );
    this.checklist.set(
      checklistResult.checklist.length > 0 ? checklistResult.checklist : parsed.checklist,
    );
    this.reviewEvents.set(events.events);
    this.markdownPreview.set(markdown);
    this.reviewGraph.set(graph);

    this.progress.set(100);
    this.status.set("completed");
  }

  /** Post the completed review's summary as a PR conversation comment. */
  async postReviewSummaryToPr(): Promise<void> {
    const runId = this.selectedReviewRunId() ?? this.reviewRun()?.id;
    if (!runId || this.prCommentState() === "posting") {
      return;
    }
    this.prCommentState.set("posting");
    try {
      const result = await this.api.postReviewSummaryToPr(runId);
      this.prCommentUrl.set(result.url);
      this.prCommentState.set("posted");
    } catch (error) {
      this.prCommentState.set("failed");
      this.lastError.set(`Posting to PR failed: ${toMessage(error)}`);
    }
  }

  // Per-finding suggestion posting: state keyed by finding id so each card
  // tracks its own idle/posting/posted/failed independently.
  readonly suggestionState = signal<Record<string, "idle" | "posting" | "posted" | "failed">>({});
  readonly suggestionUrl = signal<Record<string, string>>({});

  async postFindingSuggestion(findingId: string): Promise<void> {
    const runId = this.selectedReviewRunId() ?? this.reviewRun()?.id;
    if (!runId || this.suggestionState()[findingId] === "posting") {
      return;
    }
    this.suggestionState.update((map) => ({ ...map, [findingId]: "posting" }));
    try {
      const result = await this.api.postFindingSuggestion(runId, findingId);
      this.suggestionUrl.update((map) => ({ ...map, [findingId]: result.url }));
      this.suggestionState.update((map) => ({ ...map, [findingId]: "posted" }));
    } catch (error) {
      this.suggestionState.update((map) => ({ ...map, [findingId]: "failed" }));
      this.lastError.set(`Posting suggestion failed: ${toMessage(error)}`);
    }
  }

  // Per-finding inline-comment posting, tracked separately from suggestions.
  readonly commentState = signal<Record<string, "idle" | "posting" | "posted" | "failed">>({});
  readonly commentUrl = signal<Record<string, string>>({});

  async postFindingComment(findingId: string): Promise<void> {
    const runId = this.selectedReviewRunId() ?? this.reviewRun()?.id;
    // Idempotent: never double-post — bail when already in flight OR already
    // landed (the batch loop takes its snapshot before individual posts settle).
    const state = this.commentState()[findingId];
    if (!runId || state === "posting" || state === "posted") {
      return;
    }
    this.commentState.update((map) => ({ ...map, [findingId]: "posting" }));
    try {
      const result = await this.api.postFindingComment(runId, findingId);
      this.commentUrl.update((map) => ({ ...map, [findingId]: result.url }));
      this.commentState.update((map) => ({ ...map, [findingId]: "posted" }));
    } catch (error) {
      this.commentState.update((map) => ({ ...map, [findingId]: "failed" }));
      this.lastError.set(`Posting comment failed: ${toMessage(error)}`);
    }
  }

  async cancelReview(): Promise<void> {
    this.stopReviewStream();
    const runId = this.reviewRun()?.id;
    if (!runId) {
      this.status.set("cancelled");
      this.reviewEvents.update((events) => events.concat("review_cancelled"));
      return;
    }

    try {
      await this.api.cancelReview(runId);
    } catch {
      // Best-effort; the local stream is already stopped and the UI should remain responsive.
    }

    this.status.set("cancelled");
    this.reviewEvents.update((events) => events.concat("review_cancelled"));
  }

  private enqueueAgentWork(
    name: string,
    steps: CdpWorkStep[],
    stopOnFailure = true,
    options: AgentWorkOptions = {},
  ): void {
    const executionSteps = options.goalAware
      ? this.withObservationCheckpoints(steps, options.cycle || 1)
      : steps;

    this.cdpQueueDepth.update((depth) => depth + 1);

    this.#cdpQueue = this.#cdpQueue
      .then(async () => {
        this.cdpRoundRunning.set(true);
        this.agentRunPhase.set("acting");

        if (!this.activeCdpSessionId()) {
          await this.launchAgentBrowser(this.cdpStartUrl());
        }

        const sessionId = this.activeCdpSessionId();
        if (!sessionId) {
          throw new Error("No active CDP session");
        }

        this.pushAgentMessage(
          "agent",
          `Executing ${executionSteps.length} step(s): ${name}`,
          "info",
        );
        const result = await this.api.executeCdpWorkUnit(sessionId, {
          name,
          stopOnFailure,
          steps: executionSteps,
        });

        this.lastCdpResult.set(result);
        const observations = this.extractObservations(result);
        if (observations.length > 0) {
          const latest = observations[observations.length - 1];
          this.cdpLastObservation.set(latest);
          this.pushAgentMessage("agent", this.summarizeObservation(latest), "info");
        }

        this.pushAgentMessage(
          "agent",
          result.success
            ? `Round completed: ${result.name}`
            : `Round finished with failures: ${result.name}`,
          result.success ? "result" : "error",
        );

        for (const step of result.steps) {
          if (step.ok) {
            continue;
          }

          this.pushAgentMessage(
            "agent",
            `Step ${step.action} failed: ${step.error || "unknown_error"}`,
            "error",
          );
          this.pushAgentMessage(
            "agent",
            "Provide a steering instruction or answer so I can continue. Example: click .retry-button",
            "question",
          );
          break;
        }

        if (options.goalAware) {
          this.handleGoalAwareRoundResult(result, options, observations);
        }

        await this.refreshCdpSessions();
      })
      .catch((error) => {
        if (options.goalAware) {
          const plan = this.cdpGoalPlan();
          const progress = this.cdpGoalProgress();
          if (plan && progress) {
            this.cdpRunSummary.set(this.buildFunctionalRunSummary({
              status: "failed",
              runName: name,
              goal: plan.goal,
              goalAchieved: false,
              cycle: options.cycle || 1,
              milestonesCompleted: progress.completedMilestones,
              milestonesTotal: progress.totalMilestones,
              failedStepCount: 1,
              findings: [`round execution failed: ${toMessage(error)}`],
            }));
          }
        }
        this.pushAgentMessage("agent", `Round execution failed: ${toMessage(error)}`, "error");
      })
      .finally(() => {
        this.cdpRoundRunning.set(false);
        if (!this.agentStreaming()) {
          this.agentRunPhase.set("idle");
        }
        this.cdpQueueDepth.update((depth) => Math.max(0, depth - 1));
      });
  }

  private openOAuthPopup(authorizeUrl: string): Window | null {
    return window.open(
      authorizeUrl,
      "capillary_github_oauth",
      "popup=yes,width=620,height=760,resizable,scrollbars",
    );
  }

  private async refreshGithubConnectedState(): Promise<void> {
    const repos = await this.api.listRepositories();
    this.githubConnected.set(true);
    this.repositories.set(repos);
    this.selectedRepositoryId.set(null);
    this.selectedPullRequestId.set(null);
    this.pullRequests.set([]);
    this.status.set("connected");
    this.reviewEvents.set(["github_connected"]);
  }

  private waitForGithubOAuthResult(
    popup: Window,
    apiOrigin: string,
    expiresAt: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const defaultTimeoutMs = 2 * 60 * 1000;
      const expiresAtMs = Date.parse(expiresAt);
      const timeoutMs = Number.isFinite(expiresAtMs)
        ? Math.max(15_000, Math.min(defaultTimeoutMs, expiresAtMs - Date.now() + 5_000))
        : defaultTimeoutMs;

      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("oauth_timeout"));
      }, timeoutMs);

      const closedCheckId = window.setInterval(() => {
        if (popup.closed) {
          cleanup();
          reject(new Error("oauth_popup_closed"));
        }
      }, 500);

      const onMessage = (event: MessageEvent) => {
        if (event.origin !== apiOrigin) {
          return;
        }

        const data = event.data as { source?: string; ok?: boolean; message?: string } | undefined;
        if (!data || data.source !== "capillary-github-oauth") {
          return;
        }

        cleanup();
        if (data.ok) {
          resolve();
          return;
        }

        reject(new Error(data.message || "github_oauth_failed"));
      };

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        window.clearInterval(closedCheckId);
        window.removeEventListener("message", onMessage);
      };

      window.addEventListener("message", onMessage);
    });
  }

  private waitForGithubDeviceOAuthResult(
    sessionId: string,
    intervalSeconds: number,
    expiresAt: string,
    popup: Window,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const expiresAtMs = Date.parse(expiresAt);
      const timeoutMs = Number.isFinite(expiresAtMs)
        ? Math.max(15_000, expiresAtMs - Date.now() + 5_000)
        : 2 * 60 * 1000;

      let pollMs = Math.max(2000, (intervalSeconds || 5) * 1000);
      let pollTimer: number | null = null;

      const closedCheckId = window.setInterval(() => {
        if (popup.closed) {
          cleanup();
          reject(new Error("oauth_popup_closed"));
        }
      }, 500);

      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("oauth_timeout"));
      }, timeoutMs);

      const schedulePoll = () => {
        pollTimer = window.setTimeout(async () => {
          try {
            const result = await this.api.pollGithubOAuth(sessionId);
            if (result.status === "connected") {
              cleanup();
              try {
                popup.close();
              } catch {
                // ignore
              }
              resolve();
              return;
            }
            if (result.status === "failed") {
              cleanup();
              reject(new Error(result.message || "github_oauth_failed"));
              return;
            }

            pollMs = Math.max(2000, (result.retryAfterSeconds || intervalSeconds || 5) * 1000);
            schedulePoll();
          } catch (error) {
            cleanup();
            reject(error instanceof Error ? error : new Error("github_oauth_failed"));
          }
        }, pollMs);
      };

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        window.clearInterval(closedCheckId);
        if (pollTimer !== null) {
          window.clearTimeout(pollTimer);
        }
      };

      schedulePoll();
    });
  }

  private enqueueGoalAwareRound(cycle: number): void {
    const goal = this.cdpGoal().trim();
    if (!goal) {
      return;
    }

    this.enqueueAgentWork(
      `functional_round:${goal.slice(0, 32)}:cycle_${cycle}`,
      this.buildGoalDrivenSteps(goal, cycle),
      true,
      { goalAware: true, cycle, maxCycles: 6 },
    );
  }

  private enqueueRetvGoalRound(goal: string): void {
    this.resetPlannerTelemetry();
    this.cdpQueueDepth.update((depth) => depth + 1);

    this.#cdpQueue = this.#cdpQueue
      .then(async () => {
        this.cdpRoundRunning.set(true);
        this.agentRunPhase.set("planning");

        if (!this.activeCdpSessionId()) {
          await this.launchAgentBrowser(this.cdpStartUrl());
        }

        const sessionId = this.activeCdpSessionId();
        if (!sessionId) {
          throw new Error("No active CDP session");
        }

        this.pushAgentMessage(
          "agent",
          "Executing RetV toolforming round with first-class CDP tools.",
          "info",
        );

        const result = await this.api.runRetvCdpGoalRound({
          goal,
          sessionId,
          startUrl: this.cdpStartUrl(),
          maxCycles: 6,
        });

        this.applyRetvGoalRoundResult(result);
        await this.refreshCdpSessions();
      })
      .catch((error) => {
        const progress = this.cdpGoalProgress();
        this.cdpRunSummary.set(this.buildFunctionalRunSummary({
          status: "failed",
          runName: "retv_goal_round",
          goal,
          stopReason: "execution_error",
          goalAchieved: false,
          cycle: 1,
          milestonesCompleted: progress?.completedMilestones || 0,
          milestonesTotal: progress?.totalMilestones ||
            (this.cdpGoalPlan()?.milestones.length || 0),
          failedStepCount: 1,
          findings: [`retv execution failed: ${toMessage(error)}`],
        }));
        this.pushAgentMessage("agent", `RetV round failed: ${toMessage(error)}`, "error");
      })
      .finally(() => {
        this.cdpRoundRunning.set(false);
        if (!this.agentStreaming()) {
          this.agentRunPhase.set("idle");
        }
        this.cdpQueueDepth.update((depth) => Math.max(0, depth - 1));
      });
  }

  private applyRetvGoalRoundResult(result: RetvCdpRunResult): void {
    const milestones = this.mapRetvMilestonesToUi(
      result.structuredPlan.milestones,
      result.progress.completedMilestones,
    );

    this.cdpGoalPlan.set({
      goal: result.goal,
      allowedOrigin: result.allowedOrigin,
      createdAt: new Date().toISOString(),
      milestones,
    });

    this.cdpGoalProgress.set({
      percent: result.progress.percent,
      completedMilestones: result.progress.completedMilestones,
      totalMilestones: result.progress.totalMilestones,
      nextMilestone: result.progress.nextMilestone,
      roundsWithoutProgress: result.progress.roundsWithoutProgress,
      driftWarnings: result.progress.driftWarnings,
      lastUpdatedAt: new Date().toISOString(),
    });

    const lastCycle = result.cycles[result.cycles.length - 1];
    this.agentPlannerToolHistory.set(
      result.cycles
        .flatMap((cycle) =>
          cycle.toolCalls.map((call, index) => ({
            id: `pt_result_${result.runId}_${cycle.cycle}_${index}`,
            cycle: cycle.cycle,
            tool: call.tool,
            reason: call.reason,
            at: new Date().toLocaleTimeString(),
          }))
        )
        .slice(-24),
    );

    if (lastCycle) {
      this.agentPlannerCycle.set(lastCycle.cycle);
      this.agentPlannerLiveText.set((lastCycle.plannerRaw || "").slice(-4000));
    }

    if (lastCycle) {
      this.cdpLastObservation.set({
        label: `cycle_${lastCycle.cycle}`,
        url: lastCycle.observation.url,
        title: lastCycle.observation.title,
        activePageTab: lastCycle.observation.activePageTab,
        activeRunTab: lastCycle.observation.activeRunTab,
        buttonLabels: lastCycle.observation.buttonLabels,
        timestamp: lastCycle.observation.timestamp,
      });
    }

    for (const cycle of result.cycles) {
      const tools = cycle.toolCalls.map((call) => call.tool).join(" -> ");
      this.pushAgentMessage("agent", `RetV cycle ${cycle.cycle} tools: ${tools || "none"}`, "info");
      for (const finding of cycle.findings.slice(0, 2)) {
        this.pushAgentMessage("agent", `Cycle ${cycle.cycle} finding: ${finding}`, "info");
      }
    }

    const status = result.functionalTestSucceeded
      ? "completed"
      : result.stopReason.includes("pause") || result.stopReason === "iteration_budget_exhausted"
      ? "paused"
      : "failed";

    const failedSteps = result.cycles.reduce((sum, cycle) => sum + cycle.workUnit.failedSteps, 0);

    this.cdpRunSummary.set(this.buildFunctionalRunSummary({
      status,
      runName: result.runId,
      goal: result.goal,
      stopReason: result.stopReason,
      goalAchieved: result.goalAchieved,
      cycle: result.cycles.length,
      milestonesCompleted: result.progress.completedMilestones,
      milestonesTotal: result.progress.totalMilestones,
      failedStepCount: failedSteps,
      findings: result.findings,
      summary: result.summary,
    }));

    const verdict = result.functionalTestSucceeded ? "succeeded" : "did not fully succeed";
    this.pushAgentMessage(
      "agent",
      `RetV completed: functional test ${verdict}; goal achieved=${result.goalAchieved}; stop=${result.stopReason}`,
      result.functionalTestSucceeded ? "result" : "question",
    );

    this.cdpRunReport.set(result.report);
    this.cdpSelectedRunId.set(result.runId);
    this.cdpSelectedRunTraceEnabled.set(result.traceEnabled);
    void this.loadRetvRunHistory();
  }

  async loadRetvRunHistory(): Promise<void> {
    try {
      this.cdpRunHistory.set(await this.api.listRetvRuns());
    } catch (error) {
      this.pushConsole("system", `Unable to load run history: ${toMessage(error)}`);
    }
  }

  async openRunFromHistory(runId: string): Promise<void> {
    try {
      const record = await this.api.getRetvRun(runId);
      this.cdpRunReport.set(record.report);
      this.cdpSelectedRunId.set(record.runId);
      this.cdpSelectedRunTraceEnabled.set(record.traceEnabled);
      this.pushConsole("result", `loaded report for ${record.runId}`);
    } catch (error) {
      this.pushConsole("system", `Unable to load run ${runId}: ${toMessage(error)}`);
    }
  }

  exportSelectedRun(): void {
    const runId = this.cdpSelectedRunId();
    if (!runId) {
      return;
    }
    window.open(this.api.buildRetvRunExportUrl(runId), "_blank");
  }

  downloadSelectedReport(): void {
    const report = this.cdpRunReport();
    const runId = this.cdpSelectedRunId();
    if (!report || !runId) {
      return;
    }
    const blob = new Blob([report], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${runId}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  toggleReviewTrace(enabled: boolean): void {
    this.reviewTraceEnabled.set(enabled);
  }

  async loadReviewRunHistory(): Promise<void> {
    try {
      this.reviewRunHistory.set(await this.api.listReviewAgentRuns());
    } catch (error) {
      this.reviewEvents.update((events) => events.concat(`history_error:${toMessage(error)}`));
    }
  }

  async openReviewFromHistory(runId: string): Promise<void> {
    try {
      const record = await this.api.getReviewAgentRun(runId);
      this.reviewReport.set(record.report);
      this.markdownPreview.set(record.report);
      this.findings.set(record.findings);
      this.selectedReviewRunId.set(record.runId);
      this.selectedReviewTraceEnabled.set(record.traceEnabled);
      this.prCommentState.set("idle");
      this.prCommentUrl.set(null);
    } catch (error) {
      this.reviewEvents.update((events) => events.concat(`history_open_error:${toMessage(error)}`));
    }
  }

  exportSelectedReview(): void {
    const runId = this.selectedReviewRunId();
    if (!runId) {
      return;
    }
    window.open(this.api.buildReviewExportUrl(runId), "_blank");
  }

  // --- file explorer (left fly-out, lazy content) ---------------------------
  readonly explorerOpen = signal(false);
  readonly explorerFiles = signal<PullRequestDiffFile[]>([]);
  readonly explorerActivePath = signal<string | null>(null);
  /** Line to reveal when the active file renders; consumed by the viewer. */
  readonly explorerRevealLine = signal<number | null>(null);
  /**
   * The loaded file as an atomic {path, content} pair. Kept whole so the Monaco
   * viewer never sees a path/content mismatch mid-switch — and never unmounts:
   * the previous file stays on screen under the loader overlay until the next
   * one arrives, instead of tearing the editor down per click (the jitter).
   */
  readonly explorerFile = signal<{ path: string; content: string } | null>(null);
  /** Base-side (target branch) body for the diff view's original pane. */
  readonly explorerBaseContent = signal<string | null>(null);
  /** Diff view toggle: side-by-side base vs head instead of plain read. */
  readonly explorerDiffMode = signal(false);
  readonly explorerLoading = signal(false);
  readonly explorerError = signal<string | null>(null);
  /** The repo:pr the current tree map belongs to — re-keyed on PR switch. */
  #explorerFilesKey: string | null = null;
  /** Findings anchored to the file currently open in the explorer. */
  readonly explorerFindings = computed(() => {
    const path = this.explorerActivePath();
    if (!path) return [];
    return this.findings().filter((finding) => finding.filePath === path);
  });
  /**
   * Session cache of fetched file bodies, keyed repo:pr:side:path. The explorer
   * loads the tree map from the cached diff and fetches file bodies one at a
   * time on click — re-opens are served from here, so browsing never fans out
   * into a GitHub rate-limit burst.
   */
  readonly #fileContentCache = new Map<string, string>();

  /** Open the fly-out; (re)load the tree map when the selected PR changed. */
  async openExplorer(): Promise<void> {
    this.explorerOpen.set(true);
    const ids = this.#explorerIds();
    if (!ids) {
      return;
    }
    const key = `${ids.repositoryId}:${ids.pullRequestId}`;
    if (this.#explorerFilesKey === key && this.explorerFiles().length > 0) {
      return;
    }
    // Different PR than the tree on screen: the previous map, open file and
    // bodies belong to another diff — reset before loading the new map.
    this.#resetExplorerView();
    this.#explorerFilesKey = key;
    try {
      this.explorerFiles.set(
        await this.api.getPullRequestDiffFiles(ids.repositoryId, ids.pullRequestId),
      );
    } catch (error) {
      this.explorerError.set(`Failed to load file map: ${toMessage(error)}`);
    }
  }

  #resetExplorerView(): void {
    this.explorerFiles.set([]);
    this.explorerActivePath.set(null);
    this.explorerRevealLine.set(null);
    this.explorerFile.set(null);
    this.explorerBaseContent.set(null);
    this.explorerError.set(null);
  }

  closeExplorer(): void {
    this.explorerOpen.set(false);
  }

  /** Toggle diff view; lazily fetch the base side for the open file. */
  async toggleExplorerDiff(on: boolean): Promise<void> {
    this.explorerDiffMode.set(on);
    const path = this.explorerActivePath();
    if (on && path && this.explorerBaseContent() === null) {
      await this.#loadBaseSide(path);
    }
  }

  /** Deep-link from a finding (or a tree click) to a file at a line. */
  async openFileInExplorer(path: string, line: number | null = null): Promise<void> {
    await this.openExplorer();
    this.explorerActivePath.set(path);
    this.explorerRevealLine.set(line);
    this.explorerError.set(null);
    this.explorerBaseContent.set(null);

    const ids = this.#explorerIds();
    if (!ids) {
      this.explorerError.set("Select a repository and pull request first.");
      return;
    }
    // Deliberately do NOT clear explorerFile here: the previous file stays
    // rendered under the loader overlay, so the editor never unmounts.
    this.explorerLoading.set(true);
    try {
      const content = await this.#fetchFileSide(ids, path, "head");
      // Stale-response guard: the user may have clicked another file while
      // this one was in flight — only the latest selection may render.
      if (this.explorerActivePath() !== path) {
        return;
      }
      this.explorerFile.set({ path, content });
      if (this.explorerDiffMode()) {
        await this.#loadBaseSide(path);
      }
    } catch (error) {
      if (this.explorerActivePath() === path) {
        this.explorerError.set(`Unable to load ${path}: ${toMessage(error)}`);
      }
    } finally {
      if (this.explorerActivePath() === path) {
        this.explorerLoading.set(false);
      }
    }
  }

  #explorerIds(): { repositoryId: string; pullRequestId: string } | null {
    const repositoryId = this.selectedRepositoryId();
    const pullRequestId = this.selectedPullRequestId();
    return repositoryId && pullRequestId ? { repositoryId, pullRequestId } : null;
  }

  async #loadBaseSide(path: string): Promise<void> {
    const ids = this.#explorerIds();
    if (!ids) return;
    // A file added by the PR has no base side — an empty original pane is the
    // correct diff, not an error.
    const status = this.explorerFiles().find((file) => file.path === path)?.status;
    if (status === "added") {
      this.explorerBaseContent.set("");
      return;
    }
    try {
      const base = await this.#fetchFileSide(ids, path, "base");
      // Stale-response guard: only the still-active file's base side may land.
      if (this.explorerActivePath() === path) {
        this.explorerBaseContent.set(base);
      }
    } catch {
      if (this.explorerActivePath() === path) {
        this.explorerBaseContent.set("");
      }
    }
  }

  async #fetchFileSide(
    ids: { repositoryId: string; pullRequestId: string },
    path: string,
    side: "head" | "base",
  ): Promise<string> {
    const cacheKey = `${ids.repositoryId}:${ids.pullRequestId}:${side}:${path}`;
    const cached = this.#fileContentCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const file = await this.api.getPullRequestFileContent(
      ids.repositoryId,
      ids.pullRequestId,
      path,
      side,
    );
    this.#fileContentCache.set(cacheKey, file.content);
    return file.content;
  }

  downloadSelectedReviewReport(): void {
    const report = this.reviewReport();
    const runId = this.selectedReviewRunId();
    if (!report || !runId) {
      return;
    }
    const blob = new Blob([report], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `review-${runId}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private mapRetvMilestonesToUi(
    milestoneTitles: string[],
    completedMilestones: number,
  ): FunctionalGoalMilestone[] {
    const normalized = milestoneTitles.length > 0
      ? milestoneTitles
      : ["Capture baseline", "Reach goal context", "Validate behavior", "Summarize verdict"];

    return normalized.map((title, index) => {
      let status: FunctionalGoalMilestone["status"] = "pending";
      if (index < completedMilestones) {
        status = "done";
      } else if (index === completedMilestones) {
        status = "active";
      }

      return {
        id: `m${index + 1}`,
        title,
        status,
      };
    });
  }

  private buildGoalDrivenSteps(goal: string, cycle: number): CdpWorkStep[] {
    const keyword = goal.toLowerCase();
    const progress = this.cdpGoalProgress();
    const steps: CdpWorkStep[] = [];
    const preferredPage = this.selectPreferredPageTab(keyword);
    const preferredRunTab = this.selectPreferredRunTab(keyword);
    const validationSelector = this.selectValidationSelector(keyword);
    const lastObservation = this.cdpLastObservation();
    const startUrl = this.cdpStartUrl() || "http://localhost:4200";
    const allowedOrigin = this.cdpGoalPlan()?.allowedOrigin || this.safeOrigin(startUrl);

    if (cycle === 1) {
      steps.push(
        {
          action: "navigate",
          url: startUrl,
          waitUntil: "domcontentloaded",
        },
        {
          action: "waitForSelector",
          selector: "body",
        },
      );
    }

    if (lastObservation && this.isDriftFromGoal(lastObservation.url, allowedOrigin)) {
      steps.push(
        {
          action: "navigate",
          url: startUrl,
          waitUntil: "domcontentloaded",
        },
        {
          action: "waitForSelector",
          selector: "body",
        },
      );
    }

    if (
      progress && progress.completedMilestones <= 1 && preferredPage &&
      !this.isActiveTab(lastObservation?.activePageTab, preferredPage.label)
    ) {
      steps.push({ action: "click", selector: preferredPage.selector });
    } else if (
      progress &&
      progress.completedMilestones <= 2 &&
      preferredRunTab &&
      !this.isActiveTab(lastObservation?.activeRunTab, preferredRunTab.label)
    ) {
      steps.push({ action: "click", selector: ".cap-page-tab:nth-child(1)" });
      steps.push({ action: "click", selector: preferredRunTab.selector });
    } else {
      steps.push({ action: "extractText", selector: validationSelector, timeoutMs: 5000 });
    }

    if (keyword.includes("login") || keyword.includes("sign in")) {
      steps.push({
        action: "waitForSelector",
        selector: "input[type='password']",
        timeoutMs: 3000,
      });
    }

    return steps;
  }

  private withObservationCheckpoints(steps: CdpWorkStep[], cycle: number): CdpWorkStep[] {
    const instrumented: CdpWorkStep[] = [this.buildObservationStep(`cycle_${cycle}_start`)];

    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      instrumented.push(step);

      if (step.action !== "evaluate") {
        instrumented.push(this.buildObservationStep(`cycle_${cycle}_after_step_${index + 1}`));
      }
    }

    return instrumented;
  }

  private buildObservationStep(label: string): CdpWorkStep {
    return {
      action: "evaluate",
      returnByValue: true,
      expression: `(() => {
          const activePageTab = document.querySelector('.cap-page-tab.active')?.textContent?.trim() || '';
          const activeRunTab = document.querySelector('.cap-run-tab.active')?.textContent?.trim() || '';
          const buttonLabels = Array.from(document.querySelectorAll('button'))
            .map((button) => (button.textContent || '').trim())
            .filter(Boolean)
            .slice(0, 10);
          return {
            label: ${JSON.stringify(label)},
            url: location.href,
            title: document.title,
            activePageTab,
            activeRunTab,
            buttonLabels,
            timestamp: new Date().toISOString(),
          };
        })()`,
    };
  }

  private extractObservations(result: CdpWorkUnitResult): PageObservationSnapshot[] {
    const observations: PageObservationSnapshot[] = [];

    for (const step of result.steps) {
      if (
        !step.ok || step.action !== "evaluate" || !step.output || typeof step.output !== "object"
      ) {
        continue;
      }

      const output = step.output as Record<string, unknown>;
      const url = typeof output.url === "string" ? output.url : "";
      const title = typeof output.title === "string" ? output.title : "";
      if (!url || !title) {
        continue;
      }

      observations.push({
        label: typeof output.label === "string" ? output.label : "observation",
        url,
        title,
        activePageTab: typeof output.activePageTab === "string" ? output.activePageTab : "",
        activeRunTab: typeof output.activeRunTab === "string" ? output.activeRunTab : "",
        buttonLabels: Array.isArray(output.buttonLabels)
          ? output.buttonLabels.filter((value): value is string => typeof value === "string")
          : [],
        timestamp: typeof output.timestamp === "string"
          ? output.timestamp
          : new Date().toISOString(),
      });
    }

    return observations;
  }

  private summarizeObservation(observation: PageObservationSnapshot): string {
    const page = observation.activePageTab || "unknown";
    const run = observation.activeRunTab || "none";
    return `Observed ${observation.label}: ${page}/${run} at ${observation.url}`;
  }

  private handleGoalAwareRoundResult(
    result: CdpWorkUnitResult,
    options: AgentWorkOptions,
    observations: PageObservationSnapshot[],
  ): void {
    const currentPlan = this.cdpGoalPlan();
    const currentProgress = this.cdpGoalProgress();
    const cycle = options.cycle || 1;
    const maxCycles = options.maxCycles || 6;
    if (!currentPlan || !currentProgress) {
      return;
    }

    const nextPlan = this.advancePlan(currentPlan, result.success);
    let roundsWithoutProgress = currentProgress.roundsWithoutProgress;
    let driftWarnings = currentProgress.driftWarnings;

    if (nextPlan.advanced) {
      roundsWithoutProgress = 0;
      this.pushAgentMessage("agent", `Milestone completed: ${nextPlan.completedTitle}`, "result");
    } else {
      roundsWithoutProgress += 1;
    }

    const latest = observations[observations.length - 1] || this.cdpLastObservation();
    if (latest && this.isDriftFromGoal(latest.url, currentPlan.allowedOrigin)) {
      driftWarnings += 1;
      this.pushAgentMessage(
        "agent",
        `Drift warning: page origin moved away from allowed scope (${
          currentPlan.allowedOrigin || "none"
        }).`,
        "error",
      );
    }

    const updatedPlan = nextPlan.plan;
    this.cdpGoalPlan.set(updatedPlan);
    const updatedProgress = this.computeGoalProgress(
      updatedPlan,
      roundsWithoutProgress,
      driftWarnings,
    );
    this.cdpGoalProgress.set(updatedProgress);

    const goalAchieved = updatedProgress.completedMilestones >= updatedProgress.totalMilestones;
    const failedSteps = result.steps.filter((step) => !step.ok);
    const findings = this.collectFunctionalRunFindings(
      result,
      failedSteps.length,
      roundsWithoutProgress,
      driftWarnings,
    );
    const status = !result.success
      ? "failed"
      : goalAchieved
      ? "completed"
      : driftWarnings >= 2 || roundsWithoutProgress >= 2 || cycle >= maxCycles
      ? "paused"
      : "running";

    this.cdpRunSummary.set(this.buildFunctionalRunSummary({
      status,
      runName: result.name,
      goal: currentPlan.goal,
      goalAchieved,
      cycle,
      milestonesCompleted: updatedProgress.completedMilestones,
      milestonesTotal: updatedProgress.totalMilestones,
      failedStepCount: failedSteps.length,
      findings,
    }));

    this.pushAgentMessage(
      "agent",
      `Goal progress ${updatedProgress.completedMilestones}/${updatedProgress.totalMilestones} (${updatedProgress.percent}%). Next: ${updatedProgress.nextMilestone}`,
      "info",
    );

    if (!result.success) {
      return;
    }

    if (updatedProgress.completedMilestones >= updatedProgress.totalMilestones) {
      this.pushAgentMessage("agent", "Goal-aligned functional round complete.", "result");
      return;
    }

    if (driftWarnings >= 2 || roundsWithoutProgress >= 2) {
      this.pushAgentMessage(
        "agent",
        "I paused auto-navigation to avoid drift. Provide a steering instruction to continue goal-focused testing.",
        "question",
      );
      return;
    }

    if (cycle >= maxCycles) {
      this.pushAgentMessage(
        "agent",
        "Reached the cycle cap for this round. Provide steering input to continue.",
        "question",
      );
      return;
    }

    this.enqueueGoalAwareRound(cycle + 1);
  }

  private buildStructuredGoalPlan(goal: string): FunctionalGoalPlan {
    return {
      goal,
      allowedOrigin: this.safeOrigin(this.cdpStartUrl()),
      createdAt: new Date().toISOString(),
      milestones: [
        {
          id: "m1",
          title: "Capture baseline page state and controls",
          status: "active",
        },
        {
          id: "m2",
          title: `Reach goal context: ${goal}`,
          status: "pending",
        },
        {
          id: "m3",
          title: "Validate expected behavior using extraction/assertion",
          status: "pending",
        },
        {
          id: "m4",
          title: "Summarize evidence and unresolved gaps",
          status: "pending",
        },
      ],
    };
  }

  private buildStructuredPlanningPrompt(plan: FunctionalGoalPlan): string {
    return [
      "RetV Functional Prompt",
      `goal=${plan.goal}`,
      `allowed_origin=${plan.allowedOrigin || "none"}`,
      "Before action, produce a structured JSON plan exactly with keys: goal, milestones, success_criteria, anti_drift_rules.",
      "Loop contract: Observe -> choose best next step -> Act -> Observe -> Update progress -> Decide.",
      "Anti-drift: do not navigate outside allowed_origin unless the goal explicitly requires it.",
      "Progress rule: after each cycle, mark one milestone done or report why no progress was made.",
    ].join("\n");
  }

  private renderPlanSummary(plan: FunctionalGoalPlan): string {
    const lines = ["Functional plan created:"];
    for (const milestone of plan.milestones) {
      lines.push(`- [${milestone.status === "done" ? "x" : " "}] ${milestone.title}`);
    }
    return lines.join("\n");
  }

  private computeGoalProgress(
    plan: FunctionalGoalPlan,
    roundsWithoutProgress: number,
    driftWarnings: number,
  ): FunctionalGoalProgress {
    const totalMilestones = plan.milestones.length;
    const completedMilestones =
      plan.milestones.filter((milestone) => milestone.status === "done").length;
    const nextMilestone = plan.milestones.find((milestone) => milestone.status !== "done")?.title ||
      "complete";

    return {
      completedMilestones,
      totalMilestones,
      percent: Math.round((completedMilestones / Math.max(1, totalMilestones)) * 100),
      nextMilestone,
      roundsWithoutProgress,
      driftWarnings,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  private advancePlan(plan: FunctionalGoalPlan, allowAdvance: boolean): {
    plan: FunctionalGoalPlan;
    advanced: boolean;
    completedTitle: string;
  } {
    if (!allowAdvance) {
      return {
        plan,
        advanced: false,
        completedTitle: "",
      };
    }

    let advanced = false;
    let completedTitle = "";
    const milestones = plan.milestones.map((milestone, index) => {
      if (advanced) {
        return milestone;
      }

      if (milestone.status === "active" || milestone.status === "pending") {
        advanced = true;
        completedTitle = milestone.title;
        return {
          ...milestone,
          status: "done" as const,
        };
      }

      return milestone;
    });

    if (advanced) {
      const nextIndex = milestones.findIndex((milestone) => milestone.status === "pending");
      if (nextIndex >= 0) {
        milestones[nextIndex] = {
          ...milestones[nextIndex],
          status: "active",
        };
      }
    }

    return {
      plan: {
        ...plan,
        milestones,
      },
      advanced,
      completedTitle,
    };
  }

  private selectPreferredPageTab(keyword: string): { selector: string; label: string } | null {
    if (
      keyword.includes("github") || keyword.includes("repo") || keyword.includes("pull request")
    ) {
      return { selector: ".cap-page-tab:nth-child(2)", label: "github" };
    }

    if (keyword.includes("agent") || keyword.includes("cdp") || keyword.includes("browser")) {
      return { selector: ".cap-page-tab:nth-child(3)", label: "agent" };
    }

    if (
      keyword.includes("setup") || keyword.includes("config") || keyword.includes("environment")
    ) {
      return { selector: ".cap-page-tab:nth-child(4)", label: "setup" };
    }

    return { selector: ".cap-page-tab:nth-child(1)", label: "run" };
  }

  private selectPreferredRunTab(keyword: string): { selector: string; label: string } | null {
    if (keyword.includes("graph")) {
      return { selector: ".cap-run-tab:nth-child(2)", label: "graph" };
    }
    if (keyword.includes("finding")) {
      return { selector: ".cap-run-tab:nth-child(3)", label: "findings" };
    }
    if (keyword.includes("checklist")) {
      return { selector: ".cap-run-tab:nth-child(4)", label: "checklist" };
    }
    if (keyword.includes("event")) {
      return { selector: ".cap-run-tab:nth-child(5)", label: "events" };
    }
    if (keyword.includes("overview") || keyword.includes("run")) {
      return { selector: ".cap-run-tab:nth-child(1)", label: "overview" };
    }
    return null;
  }

  private selectValidationSelector(keyword: string): string {
    if (
      keyword.includes("github") || keyword.includes("repo") || keyword.includes("pull request")
    ) {
      return ".cap-page-content";
    }
    if (keyword.includes("agent") || keyword.includes("cdp") || keyword.includes("browser")) {
      return ".cap-transcript";
    }
    if (keyword.includes("setup")) {
      return ".cap-event-line";
    }
    return "body";
  }

  private isActiveTab(currentTab: string | undefined, expectedLabel: string): boolean {
    return (currentTab || "").trim().toLowerCase().includes(expectedLabel.toLowerCase());
  }

  private safeOrigin(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return "";
    }
  }

  private isDriftFromGoal(url: string, allowedOrigin: string): boolean {
    const currentOrigin = this.safeOrigin(url);
    if (!allowedOrigin || !currentOrigin) {
      return false;
    }
    return currentOrigin !== allowedOrigin;
  }

  private collectFunctionalRunFindings(
    result: CdpWorkUnitResult,
    failedStepCount: number,
    roundsWithoutProgress: number,
    driftWarnings: number,
  ): string[] {
    const findings: string[] = [];

    for (const failed of result.steps.filter((step) => !step.ok).slice(0, 4)) {
      findings.push(`step ${failed.action} failed: ${failed.error || "unknown_error"}`);
    }

    if (failedStepCount === 0) {
      findings.push("no step failures in latest cycle");
    }

    if (driftWarnings > 0) {
      findings.push(`drift warnings raised: ${driftWarnings}`);
    }

    if (roundsWithoutProgress > 0) {
      findings.push(`rounds without milestone progress: ${roundsWithoutProgress}`);
    }

    return findings;
  }

  private buildFunctionalRunSummary(input: {
    status: "running" | "paused" | "completed" | "failed";
    runName: string;
    goal: string;
    stopReason?: string;
    goalAchieved: boolean;
    cycle: number;
    milestonesCompleted: number;
    milestonesTotal: number;
    failedStepCount: number;
    findings: string[];
    summary?: string;
  }): FunctionalRunSummary {
    return {
      status: input.status,
      runName: input.runName,
      goal: input.goal,
      stopReason: input.stopReason,
      finishedAt: new Date().toISOString(),
      functionalSuccess: input.goalAchieved && input.failedStepCount === 0,
      goalAchieved: input.goalAchieved,
      cycle: input.cycle,
      milestonesCompleted: input.milestonesCompleted,
      milestonesTotal: input.milestonesTotal,
      failedStepCount: input.failedStepCount,
      findings: input.findings,
      summary: input.summary,
    };
  }

  private parseInstructionToSteps(instruction: string): CdpWorkStep[] {
    const navigateMatch = /^navigate\s+(.+)$/i.exec(instruction);
    if (navigateMatch) {
      return [{ action: "navigate", url: navigateMatch[1].trim(), waitUntil: "domcontentloaded" }];
    }

    const clickMatch = /^click\s+(.+)$/i.exec(instruction);
    if (clickMatch) {
      return [{ action: "click", selector: clickMatch[1].trim() }];
    }

    const waitMatch = /^wait\s+(.+)$/i.exec(instruction);
    if (waitMatch) {
      return [{ action: "waitForSelector", selector: waitMatch[1].trim() }];
    }

    const extractMatch = /^extract\s+(.+)$/i.exec(instruction);
    if (extractMatch) {
      return [{ action: "extractText", selector: extractMatch[1].trim() }];
    }

    const assertIncludesMatch = /^assert\s+(.+?)\s+includes\s+(.+)$/i.exec(instruction);
    if (assertIncludesMatch) {
      return [{
        action: "assertText",
        selector: assertIncludesMatch[1].trim(),
        includes: assertIncludesMatch[2].trim(),
      }];
    }

    const typeMatch = /^type\s+(.+?)\s*=>\s*(.+)$/i.exec(instruction);
    if (typeMatch) {
      return [{ action: "type", selector: typeMatch[1].trim(), text: typeMatch[2], clear: true }];
    }

    return [];
  }

  private pushAgentMessage(
    role: AgentTranscriptItem["role"],
    message: string,
    kind: AgentTranscriptItem["kind"] = "info",
  ): void {
    this.agentTranscript.update((items) =>
      items.concat({
        id: `agent_msg_${crypto.randomUUID().slice(0, 8)}`,
        role,
        message,
        kind,
        at: new Date().toISOString(),
      })
    );
  }

  #parseMarkdown(markdown: string): {
    findings: ReviewFinding[];
    checklist: ReviewChecklistItem[];
  } {
    const lines = markdown.split("\n");
    const findings: ReviewFinding[] = [];
    const checklist: ReviewChecklistItem[] = [];

    let section: "none" | "findings" | "checklist" = "none";

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (line.startsWith("## Findings")) {
        section = "findings";
        continue;
      }

      if (line === "## Checklist") {
        section = "checklist";
        continue;
      }

      if (!line.startsWith("-")) {
        continue;
      }

      if (section === "findings") {
        const match =
          /^- \[(blocker|high|medium|low|note)\]\s+(.+?)\s+\((.+?):(\d+|n\/a)\)(?:\s+\[(?:gate|pass)=(.+?);\s*confidence=([0-9]*\.?[0-9]+)\])?$/
            .exec(line);
        if (!match) {
          continue;
        }

        const parsedConfidence = match[6] ? Number(match[6]) : NaN;
        findings.push({
          id: `finding_${findings.length + 1}`,
          severity: match[1] as ReviewFinding["severity"],
          title: match[2],
          passName: match[5] || "Unknown",
          filePath: match[3],
          line: match[4] === "n/a" ? undefined : Number(match[4]),
          finding: match[2],
          confidence: Number.isFinite(parsedConfidence) ? parsedConfidence : 0.5,
        });
      }

      if (section === "checklist") {
        const commandMatch = /^- command:\s+(.+)$/.exec(line.replace(/^\s+/, ""));
        if (commandMatch && checklist.length > 0) {
          const last = checklist[checklist.length - 1];
          checklist[checklist.length - 1] = {
            ...last,
            command: commandMatch[1],
          };
          continue;
        }

        const checkMatch = /^- \[( |x)\]\s+(.+)$/.exec(line);
        if (!checkMatch) {
          continue;
        }

        checklist.push({
          id: `check_${checklist.length + 1}`,
          completed: checkMatch[1] === "x",
          description: checkMatch[2],
        });
      }
    }

    if (checklist.length === 0) {
      checklist.push({
        id: "check_default",
        description: "Run make test before merging",
        command: "make test",
        completed: false,
      });
    }

    return { findings, checklist };
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown_error";
}

function reviewStatusForPhase(phase: string): string {
  switch (phase) {
    case "queued":
      return "queued";
    case "diff_dag":
      return "graphing";
    case "program_shape":
      return "wetting";
    case "tcsrct":
    case "llm_provider":
    case "llm_merged":
      return "reviewing";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "reviewing";
  }
}

/** Human-readable stage line for pipeline phases worth narrating; null skips. */
function reviewStageNarrative(phase: string): string | null {
  switch (phase) {
    case "diff_dag":
      return "Observing the change surface — building the diff DAG.";
    case "program_shape":
      return "Deriving program shape and risk surfaces from the graph.";
    case "tcsrct":
      return "Agent engaged — walking the TCSRTC gates.";
    case "failed":
      return "Review failed.";
    case "cancelled":
      return "Review cancelled.";
    default:
      return null;
  }
}

function reviewProgressFromPhase(phase: string, passPercent = 0): number {
  switch (phase) {
    case "queued":
      return 8;
    case "diff_dag":
      return 20;
    case "program_shape":
      return 38;
    case "tcsrct":
      return 56 + Math.round((passPercent / 100) * 16);
    case "llm_provider":
      return 80;
    case "llm_merged":
      return 92;
    case "completed":
      return 100;
    default:
      return 12;
  }
}

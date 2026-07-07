type PlannerProviderKind =
  | "github_copilot"
  | "openrouter"
  | "anthropic"
  | "gemini"
  | "ihhi_bedrock"
  | "codex_app_server"
  | "openai_compatible";

interface RetvPlannerConfigView {
  providerKind: PlannerProviderKind;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  availableProviderKinds: PlannerProviderKind[];
}

interface RetvPlannerConfigUpdate {
  providerKind?: PlannerProviderKind;
  model?: string;
  baseUrl?: string;
}

interface RetvCdpRunResult {
  runId: string;
  sessionId: string;
  goal: string;
  stopReason: string;
  functionalTestSucceeded: boolean;
  goalAchieved: boolean;
  progress: {
    percent: number;
    completedMilestones: number;
    totalMilestones: number;
    roundsWithoutProgress: number;
    driftWarnings: number;
  };
  findings: string[];
  cycles: Array<{
    cycle: number;
    toolCalls: Array<{ tool: string; reason: string }>;
    findings: string[];
    workUnit: {
      success: boolean;
      failedSteps: number;
    };
  }>;
}

interface CliOptions {
  apiBaseUrl: string;
  startUrl: string;
  goals: string[];
  providerKind?: PlannerProviderKind;
  model?: string;
  providerBaseUrl?: string;
  maxCycles: number;
  reuseSession: boolean;
  allowMissingAuth: boolean;
  outputJson: boolean;
}

const DEFAULT_API_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_START_URL = "http://127.0.0.1:4200";

const PROVIDER_ENV_CHAIN: Record<PlannerProviderKind, string[]> = {
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "CAPILLARY_LLM_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "CAPILLARY_LLM_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY", "CAPILLARY_LLM_API_KEY"],
  ihhi_bedrock: ["BEDROCK_API_KEY", "AWS_BEARER_TOKEN", "CAPILLARY_LLM_API_KEY"],
  github_copilot: ["GITHUB_COPILOT_TOKEN", "GITHUB_TOKEN", "CAPILLARY_LLM_API_KEY"],
  codex_app_server: ["CODEX_APP_SERVER_API_KEY", "GITHUB_COPILOT_TOKEN", "GITHUB_TOKEN", "CAPILLARY_LLM_API_KEY"],
  openai_compatible: ["OPENAI_API_KEY", "CAPILLARY_LLM_API_KEY"],
};

function printUsage(): void {
  console.log([
    "Capillary RetV CDP pipeline runner",
    "",
    "Usage:",
    "  deno run --allow-net --allow-env --allow-read scripts/cdp_retv_pipeline.ts [options]",
    "",
    "Required:",
    "  --goal \"<instruction>\"             Natural-language functional test instruction",
    "  or",
    "  --goal-file <path>                    File with one goal per non-empty line",
    "",
    "Options:",
    "  --api-base-url <url>                  API origin (default http://127.0.0.1:8080)",
    "  --start-url <url>                     App URL to test (default http://127.0.0.1:4200)",
    "  --provider <kind>                     Provider: gemini|anthropic|openrouter|ihhi_bedrock|github_copilot|codex_app_server|openai_compatible",
    "  --model <name>                        Override model (refines the active provider)",
    "  --provider-base-url <url>             Override base URL (openai_compatible only)",
    "  --max-cycles <n>                      Planner cycles per goal (default 5)",
    "  --reuse-session                       Reuse CDP session across multiple goals",
    "  --allow-missing-auth                  Continue even when provider has no API key",
    "  --json                                Emit final machine-readable JSON summary",
    "  --help                                Show this help",
    "",
    "Examples:",
    "  deno task cdp:retv --provider gemini --goal \"Open Run page, click Findings tab, verify findings panel text is visible\"",
    "  deno task cdp:retv --provider anthropic --goal-file ./scripts/goals/view-items.txt --reuse-session",
  ].join("\n"));
}

function parseProviderKind(value: string): PlannerProviderKind {
  const normalized = value.trim() as PlannerProviderKind;
  const allowed = new Set<PlannerProviderKind>([
    "gemini",
    "anthropic",
    "openrouter",
    "ihhi_bedrock",
    "github_copilot",
    "codex_app_server",
    "openai_compatible",
  ]);

  if (!allowed.has(normalized)) {
    throw new Error(`invalid_provider_kind:${value}`);
  }

  return normalized;
}

function normalizeApiBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function normalizeGoalLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

async function readGoalsFromFile(path: string): Promise<string[]> {
  const content = await Deno.readTextFile(path);
  return normalizeGoalLines(content);
}

async function parseCliOptions(args: string[]): Promise<CliOptions> {
  const options: CliOptions = {
    apiBaseUrl: DEFAULT_API_BASE_URL,
    startUrl: DEFAULT_START_URL,
    goals: [],
    maxCycles: 5,
    reuseSession: false,
    allowMissingAuth: false,
    outputJson: false,
  };

  let goalFilePath = "";

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    const readValue = (inline?: string): string => {
      if (inline !== undefined) {
        return inline;
      }
      const next = args[index + 1];
      if (!next) {
        throw new Error(`missing_value:${token}`);
      }
      index += 1;
      return next;
    };

    const [flag, inlineValue] = token.split("=", 2);
    switch (flag) {
      case "--help":
      case "-h":
        printUsage();
        Deno.exit(0);
        break;
      case "--api-base-url":
        options.apiBaseUrl = readValue(inlineValue);
        break;
      case "--start-url":
        options.startUrl = readValue(inlineValue);
        break;
      case "--goal":
        options.goals.push(readValue(inlineValue).trim());
        break;
      case "--goal-file":
        goalFilePath = readValue(inlineValue).trim();
        break;
      case "--provider":
        options.providerKind = parseProviderKind(readValue(inlineValue));
        break;
      case "--model":
        options.model = readValue(inlineValue).trim();
        break;
      case "--provider-base-url":
        options.providerBaseUrl = readValue(inlineValue).trim();
        break;
      case "--max-cycles": {
        const parsed = Number(readValue(inlineValue));
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new Error("invalid_max_cycles");
        }
        options.maxCycles = Math.round(parsed);
        break;
      }
      case "--reuse-session":
        options.reuseSession = true;
        break;
      case "--allow-missing-auth":
        options.allowMissingAuth = true;
        break;
      case "--json":
        options.outputJson = true;
        break;
      default:
        throw new Error(`unknown_option:${token}`);
    }
  }

  if (goalFilePath) {
    const fileGoals = await readGoalsFromFile(goalFilePath);
    options.goals = options.goals.concat(fileGoals);
  }

  options.goals = options.goals
    .map((goal) => goal.trim())
    .filter((goal) => goal.length > 0);

  if (options.goals.length === 0) {
    throw new Error("goal_required");
  }

  options.apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl || DEFAULT_API_BASE_URL);
  options.startUrl = options.startUrl.trim() || DEFAULT_START_URL;

  return options;
}

async function toApiError(response: Response): Promise<Error> {
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  const message = String(payload?.message || payload?.error || `HTTP ${response.status}`);
  return new Error(message);
}

async function getJson<T>(apiBaseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`);
  if (!response.ok) {
    throw await toApiError(response);
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(apiBaseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw await toApiError(response);
  }

  return response.json() as Promise<T>;
}

function collectPlannerFindings(run: RetvCdpRunResult): string[] {
  const findings = new Set<string>();

  for (const finding of run.findings || []) {
    findings.add(finding);
  }

  for (const cycle of run.cycles || []) {
    for (const finding of cycle.findings || []) {
      findings.add(finding);
    }
  }

  return Array.from(findings);
}

function hasBlockingPlannerFinding(run: RetvCdpRunResult): boolean {
  const allFindings = collectPlannerFindings(run);
  return allFindings.some((finding) =>
    finding.startsWith("planner_unavailable") ||
    finding.includes("planner_invalid_json")
  );
}

function printRunSummary(run: RetvCdpRunResult): void {
  console.log(`runId=${run.runId}`);
  console.log(`goal=${run.goal}`);
  console.log(`functionalTestSucceeded=${run.functionalTestSucceeded}`);
  console.log(`goalAchieved=${run.goalAchieved}`);
  console.log(`stopReason=${run.stopReason}`);
  console.log(
    `progress=${run.progress.completedMilestones}/${run.progress.totalMilestones} (${run.progress.percent}%) drift=${run.progress.driftWarnings} noProgressRounds=${run.progress.roundsWithoutProgress}`,
  );

  for (const cycle of run.cycles || []) {
    const calls = cycle.toolCalls.map((call) => call.tool).join(",") || "none";
    const findings = cycle.findings.join(" | ") || "none";
    console.log(
      `cycle=${cycle.cycle} success=${cycle.workUnit.success} failedSteps=${cycle.workUnit.failedSteps} tools=${calls} findings=${findings}`,
    );
  }
}

async function main(): Promise<void> {
  const options = await parseCliOptions(Deno.args);

  const currentConfig = await getJson<RetvPlannerConfigView>(options.apiBaseUrl, "/api/cdp/retv/config");
  const providerKind = options.providerKind || currentConfig.providerKind;

  const configUpdate: RetvPlannerConfigUpdate = {
    providerKind,
  };

  if (options.model) {
    configUpdate.model = options.model;
  }

  if (options.providerBaseUrl) {
    configUpdate.baseUrl = options.providerBaseUrl;
  }

  const configured = await postJson<RetvPlannerConfigView>(
    options.apiBaseUrl,
    "/api/cdp/retv/config",
    configUpdate,
  );

  console.log(
    `planner.provider=${configured.providerKind} planner.model=${configured.model} planner.baseUrl=${configured.baseUrl} planner.hasApiKey=${configured.hasApiKey}`,
  );

  if (!configured.hasApiKey && configured.providerKind !== "openai_compatible" && !options.allowMissingAuth) {
    const hintEnvs = PROVIDER_ENV_CHAIN[configured.providerKind].join(", ");
    throw new Error(`planner_auth_missing:set_one_of(${hintEnvs})_on_the_api_server`);
  }

  const runResults: RetvCdpRunResult[] = [];
  let sessionId = "";

  for (let index = 0; index < options.goals.length; index += 1) {
    const goal = options.goals[index];
    const request: Record<string, unknown> = {
      goal,
      startUrl: options.startUrl,
      maxCycles: options.maxCycles,
    };

    if (options.reuseSession && sessionId) {
      request.sessionId = sessionId;
    }

    console.log(`--- goal ${index + 1}/${options.goals.length} ---`);
    const run = await postJson<RetvCdpRunResult>(options.apiBaseUrl, "/api/cdp/retv/run", request);
    printRunSummary(run);
    runResults.push(run);

    if (options.reuseSession) {
      sessionId = run.sessionId;
    }
  }

  const hadBlockingPlannerFinding = runResults.some((run) => hasBlockingPlannerFinding(run));
  const allSucceeded = runResults.every((run) => run.functionalTestSucceeded);

  if (options.outputJson) {
    console.log(JSON.stringify({
      provider: configured,
      runs: runResults,
      allSucceeded,
      hadBlockingPlannerFinding,
    }, null, 2));
  }

  if (hadBlockingPlannerFinding) {
    Deno.exit(2);
  }

  if (!allSucceeded) {
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
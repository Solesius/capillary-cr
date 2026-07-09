// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { ReviewFinding } from "../domain/entities.ts";
import { AppError } from "../domain/errors.ts";
import { toTcsrtcGate } from "../domain/review_phase.ts";
import { ReviewRepository } from "../repositories/review_repository.ts";
import {
  buildProviderFromKind,
  type ProviderKind,
  providerUsesGithubToken,
} from "./providers/provider_registry.ts";
import { chat } from "./providers/provider_client.ts";
import { runRetvLoop } from "./providers/retv_loop.ts";
import { buildRetvTcsrctSystemPrompt } from "./providers/retv_system_prompt.ts";

interface LlmProviderServiceOptions {
  kind?: ProviderKind;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

const RECOMMENDED_CODEX_MODEL = "gpt-5.4-mini";

function normalizeProviderKind(raw: string): ProviderKind | null {
  const normalized = raw.trim().toLowerCase();
  switch (normalized) {
    case "gemini":
    case "ihhi_bedrock":
    case "openrouter":
    case "anthropic":
    case "github_copilot":
    case "codex_app_server":
      return normalized as ProviderKind;
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
    default:
      return null;
  }
}

function normalizeRuntimeModel(kind: ProviderKind, rawModel: string): string {
  const model = rawModel.trim();
  // Keep older saved configs interoperable with current Codex defaults.
  if (
    kind === "codex_app_server" &&
    (model.toLowerCase() === "gpt-5.3-codex" || model.toLowerCase() === "gpt-5.3")
  ) {
    return RECOMMENDED_CODEX_MODEL;
  }
  return model;
}

function normalizeRuntimeProviderKind(raw: string): ProviderKind | "openai_compatible" | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "openai_compatible" || normalized === "openai-compatible") {
    return "openai_compatible";
  }
  return normalizeProviderKind(normalized);
}

export class LlmProviderService {
  readonly #defaultProvider;

  constructor(
    private readonly repository: ReviewRepository,
    options: LlmProviderServiceOptions = {},
  ) {
    const providerKind = options.kind || this.resolveProviderKindFromEnv();
    this.#defaultProvider = buildProviderFromKind(providerKind, {
      kind: providerKind,
      model: options.model,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
    });
  }

  async reviewPacketWithModel(packetId: string): Promise<ReviewFinding[]> {
    const packet = this.repository.getReviewPacket(packetId);

    if (packet.summary.toLowerCase().includes("secret")) {
      throw new AppError("secret_redaction_required", 400, "secret_redaction_required");
    }

    const graph = this.repository.getGraphSnapshot(packet.diffDagId);
    const prompt = buildRetvTcsrctSystemPrompt({
      runId: `llm_${packet.id}`,
      pullRequestId: packet.pullRequestId,
      graph: {
        nodeCount: graph.dag.nodeCount,
        edgeCount: graph.dag.edgeCount,
        changedNodeCount: graph.dag.changedNodeCount,
        flowCompleteness: graph.dag.flowCompleteness,
        torusVariance: graph.dag.torusVariance,
        saturation: graph.dag.saturation,
        completenessNotes: graph.dag.completenessNotes,
      },
      passes: packet.tcsrctPasses.map((pass) => pass.name),
    });

    const loop = runRetvLoop(packet);
    const provider = this.resolveRuntimeProvider();

    const providerResponse = await chat(provider, {
      systemPrompt: prompt,
      model: provider.model,
      // Use a dedicated run context so Codex app-server does not reuse the
      // global default thread across unrelated reviews (prevents context bloat
      // and timeout drift).
      runContextId: `review:${packet.pullRequestId}:${packet.id}`,
      messages: [
        {
          role: "user",
          content: [
            "Review this pull request using graph-first TCSRCT analysis.",
            "Return ONLY valid JSON.",
            "Schema:",
            "{\"findings\":[{\"severity\":\"blocker|high|medium|low|note\",\"gate\":\"Target|Constrain|Sanitize|Review|Test|Confirm\",\"filePath\":\"path/to/file\",\"line\":123,\"title\":\"short title\",\"finding\":\"detailed finding\",\"evidence\":[\"e1\",\"e2\"],\"confidence\":0.0}]}",
            "If confidence is uncertain, return lower confidence values.",
            "Packet JSON:",
            JSON.stringify(buildModelReviewInput(packet, graph)),
          ].join("\n"),
        },
      ],
    });

    if (!providerResponse.ok || !providerResponse.value) {
      const providerErrorKind = providerResponse.error?.kind || "unknown";
      const providerErrorMessage = providerResponse.error?.message || "unknown";
      const isRateLimited = providerErrorKind === "rate_limit";
      const primaryPath = selectPrimaryChangedPath(packet);
      return [{
        id: "llm_finding_0",
        runId: "llm",
        severity: "note",
        passName: "Review",
        filePath: primaryPath,
        title: isRateLimited
          ? "LLM provider rate-limited for DAG review"
          : "LLM provider unavailable for DAG review",
        finding: isRateLimited
          ? `No model findings were generated because provider ${provider.kind} is currently rate-limited or quota-limited: ${providerErrorMessage}.`
          : `No model findings were generated because provider ${provider.kind} was unavailable: ${providerErrorMessage}.`,
        evidence: [
          `provider.kind=${provider.kind}`,
          `provider.error=${providerErrorKind}`,
          "retv.loop=reason->toolform->act->observe->update->decide",
          "tdd_gate=enabled",
          `dag.flow_completeness=${graph.dag.flowCompleteness.toFixed(3)}`,
        ],
        confidence: 0.95,
      }];
    }
    const providerPayload = providerResponse.value;

    const parsedFindings = parseModelFindings(providerPayload.content);
    if (parsedFindings.length === 0) {
      return [{
        id: "llm_finding_0",
        runId: "llm",
        severity: "medium",
        passName: "Review",
        filePath: selectPrimaryChangedPath(packet),
        title: "LLM returned unstructured review narrative",
        finding: providerPayload.content,
        evidence: [
          `provider.kind=${providerPayload.providerKind}`,
          `provider.model=${providerPayload.model}`,
          "retv.loop=reason->toolform->act->observe->update->decide",
          "tdd_gate=enabled",
          `retv.stop_reason=${loop.stopReason}`,
          `dag.flow_completeness=${graph.dag.flowCompleteness.toFixed(3)}`,
        ],
        confidence: 0.55,
      }];
    }

    return parsedFindings.map((finding, index) => {
      const loopIteration = loop.iterations[index] || loop.iterations[loop.iterations.length - 1];
      return {
        id: `llm_finding_${index}`,
        runId: "llm",
        severity: finding.severity,
        passName: finding.passName,
        filePath: finding.filePath || selectPrimaryChangedPath(packet),
        line: finding.line,
        title: finding.title,
        finding: finding.finding,
        evidence: [
          ...(finding.evidence || []),
          `provider.kind=${providerPayload.providerKind}`,
          `provider.model=${providerPayload.model}`,
          "retv.loop=reason->toolform->act->observe->update->decide",
          `retv.iteration=${loopIteration?.iterationId || "retv_0"}`,
          `retv.task=${loopIteration?.selectedTask || "graph.expand_runtime_path"}`,
          `retv.decision=${loopIteration?.decision || "continue"}`,
          "tdd_gate=enabled",
          `retv.stop_reason=${loop.stopReason}`,
          `dag.flow_completeness=${graph.dag.flowCompleteness.toFixed(3)}`,
        ],
        confidence: clampConfidence(finding.confidence),
      };
    });
  }

  summarizeGraphRisk(packetId: string): string {
    const packet = this.repository.getReviewPacket(packetId);
    const maxRisk = packet.riskSurfaces.reduce((best, current) => Math.max(best, current.riskScore), 0);
    const graph = this.repository.getGraphSnapshot(packet.diffDagId);
    return `Top graph risk score: ${maxRisk.toFixed(2)} across ${packet.riskSurfaces.length} surfaces (flow completeness ${graph.dag.flowCompleteness.toFixed(2)}, torus variance ${graph.dag.torusVariance.toFixed(2)})`;
  }

  private resolveProviderKindFromEnv(): ProviderKind {
    const raw = Deno.env.get("CAPILLARY_LLM_PROVIDER") || "github_copilot";
    return normalizeProviderKind(raw) || "github_copilot";
  }

  private resolveRuntimeProvider() {
    const runtime = this.repository.getRuntimeLlmConfig();

    // Only fall back to the connected GitHub token for providers it actually
    // authenticates (Copilot / Codex-via-Copilot); never leak it elsewhere.
    const githubFallback = (kind: string): string =>
      providerUsesGithubToken(kind) ? (this.repository.getGithubToken() || "") : "";

    if (!runtime) {
      return {
        ...this.#defaultProvider,
        apiKey: this.#defaultProvider.apiKey || githubFallback(this.#defaultProvider.kind),
      };
    }

    const normalizedRuntimeKind = normalizeRuntimeProviderKind(runtime.providerKind);

    if (normalizedRuntimeKind === "openai_compatible") {
      return {
        kind: "openrouter" as const,
        model: runtime.model.trim() || this.#defaultProvider.model,
        baseUrl: runtime.baseUrl.trim() || this.#defaultProvider.baseUrl,
        apiKey: runtime.apiKey.trim() || this.#defaultProvider.apiKey,
      };
    }

    if (!normalizedRuntimeKind) {
      return {
        ...this.#defaultProvider,
        apiKey: this.#defaultProvider.apiKey || githubFallback(this.#defaultProvider.kind),
      };
    }

    const descriptor = buildProviderFromKind(normalizedRuntimeKind, {
      kind: normalizedRuntimeKind,
      model: normalizeRuntimeModel(normalizedRuntimeKind, runtime.model) || undefined,
      baseUrl: runtime.baseUrl.trim() || undefined,
      apiKey: runtime.apiKey.trim() || undefined,
    });

    return {
      ...descriptor,
      apiKey: descriptor.apiKey || githubFallback(normalizedRuntimeKind),
    };
  }
}

interface ParsedModelFinding {
  severity: ReviewFinding["severity"];
  passName: string;
  filePath: string;
  line?: number;
  title: string;
  finding: string;
  evidence: string[];
  confidence: number;
}

function buildModelReviewInput(packet: {
  pullRequestId: string;
  summary: string;
  changedFiles: Array<{ path: string; status: string; additions: number; deletions: number }>;
  neighborFiles: Array<{ path: string }>;
  riskSurfaces: Array<{ id: string; surfaceKind: string; entryNodeId: string; riskScore: number; reason: string }>;
  tcsrctPasses: Array<{ name: string }>;
}, graph: {
  dag: {
    nodeCount: number;
    edgeCount: number;
    changedNodeCount: number;
    flowCompleteness: number;
    torusVariance: number;
    saturation: number;
    completenessNotes: string[];
  };
  nodes: Array<{ id: string; path: string; kind: string; changed: boolean; weight: number }>;
  edges: Array<{ fromNodeId: string; toNodeId: string; kind: string; weight: number }>;
  shapeSamples: Array<{ nodeId: string; curvature: number; torsion: number; riskGradient: number }>;
}): Record<string, unknown> {
  const hottestShapes = graph.shapeSamples
    .slice()
    .sort((left, right) => right.riskGradient - left.riskGradient)
    .slice(0, 40);

  return {
    pullRequestId: packet.pullRequestId,
    summary: packet.summary,
    dag: graph.dag,
    passes: packet.tcsrctPasses.map((item) => item.name),
    changedFiles: packet.changedFiles.slice(0, 400),
    neighborFileSample: packet.neighborFiles.slice(0, 120).map((item) => item.path),
    riskSurfaces: packet.riskSurfaces
      .slice()
      .sort((left, right) => right.riskScore - left.riskScore)
      .slice(0, 120),
    nodeSample: graph.nodes.slice(0, 300),
    edgeSample: graph.edges.slice(0, 450),
    hottestShapes,
  };
}

function parseModelFindings(content: string): ParsedModelFinding[] {
  const payload = parseJsonLoose(content);
  if (!payload) {
    return [];
  }

  const items = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { findings?: unknown[] }).findings)
    ? (payload as { findings: unknown[] }).findings
    : [];

  const out: ParsedModelFinding[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const candidate = item as Record<string, unknown>;
    const severity = normalizeSeverity(candidate.severity);
    const title = asString(candidate.title);
    const finding = asString(candidate.finding);
    if (!title || !finding) {
      continue;
    }

    out.push({
      severity,
      passName: toTcsrtcGate(asString(candidate.gate) || asString(candidate.passName) || "Review"),
      filePath: asString(candidate.filePath) || "unknown",
      line: normalizeLine(candidate.line),
      title,
      finding,
      evidence: normalizeEvidence(candidate.evidence),
      confidence: clampConfidence(candidate.confidence),
    });
  }

  return out;
}

function parseJsonLoose(content: string): unknown {
  const direct = tryParseJson(content);
  if (direct !== undefined) {
    return direct;
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/im.exec(content);
  if (fenced && fenced[1]) {
    const parsed = tryParseJson(fenced[1]);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryParseJson(content.slice(start, end + 1));
  }

  return undefined;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizeSeverity(value: unknown): ReviewFinding["severity"] {
  const text = asString(value).toLowerCase();
  if (text === "blocker" || text === "high" || text === "medium" || text === "low" || text === "note") {
    return text;
  }
  return "medium";
}

function normalizeEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => asString(item))
    .filter((item) => item.length > 0)
    .slice(0, 12);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLine(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

function clampConfidence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return 0.6;
  }
  return Math.min(0.99, Math.max(0.3, parsed));
}

function selectPrimaryChangedPath(packet: { changedFiles: Array<{ path: string }> }): string {
  for (const file of packet.changedFiles) {
    const path = file.path || "";
    const normalized = path.includes("#") ? path.split("#")[0] : path;
    if (normalized.trim().length > 0) {
      return normalized;
    }
  }
  return "unknown";
}

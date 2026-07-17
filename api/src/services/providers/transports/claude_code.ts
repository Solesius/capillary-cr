// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import {
  errorResult,
  okResult,
  ProviderDescriptor,
  ProviderError,
  ProviderOps,
  ProviderRequest,
  ProviderResponse,
  ProviderResult,
  ProviderStreamCallback,
} from "../provider_core.ts";
import { invalidRequest } from "./common.ts";
import { estimateTokens } from "../provider_helpers.ts";
import { logRawUsageOnce, normalizeClaudeCliUsage } from "../usage.ts";

// Claude Code transport.
//
// This mirrors the codex_app_server provider: it shells out to the locally
// installed `claude` CLI in non-interactive print mode and relies on the
// CLI's own subscription OAuth login (`claude login` / `claude setup-token`).
// No API key is ever sent — in fact we strip ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
// from the child environment so the CLI always authenticates via the user's
// OAuth credentials, exactly like Codex uses its own auth.
//
// baseUrl convention: `stdio://claude-code` (also accepts `cli://claude`).

const DEFAULT_CLAUDE_BIN = "claude";

export interface ClaudeCliInvocation {
  args: string[];
  stdin: string;
  env: Record<string, string>;
  clearEnv: boolean;
}

export interface ClaudeCliProcess {
  stdout: ReadableStream<Uint8Array>;
  status: Promise<{ success: boolean; code: number }>;
  stderr(): Promise<string>;
}

export type ClaudeCliSpawner = (invocation: ClaudeCliInvocation) => ClaudeCliProcess;

export function isClaudeCliBaseUrl(baseUrl: string): boolean {
  const normalized = baseUrl.trim().toLowerCase();
  return normalized.startsWith("stdio://claude") || normalized.startsWith("cli://claude");
}

export function isClaudeWsBaseUrl(baseUrl: string): boolean {
  const normalized = baseUrl.trim().toLowerCase();
  return normalized.startsWith("ws://") || normalized.startsWith("wss://");
}

function isExecutableFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

// Resolve an absolute path to the `claude` binary. Deno.Command will not search
// PATH for a bare program name when the child env is replaced (clearEnv), so we
// resolve it ourselves and fall back to the bare name otherwise.
function resolveClaudeBin(): string {
  let configured = "";
  try {
    configured = Deno.env.get("CLAUDE_CODE_BIN")?.trim() || "";
  } catch {
    configured = "";
  }
  if (configured) {
    return configured;
  }

  let pathEnv = "";
  try {
    pathEnv = Deno.env.get("PATH") || "";
  } catch {
    pathEnv = "";
  }

  let home = "";
  try {
    home = Deno.env.get("HOME") || "";
  } catch {
    home = "";
  }

  // PATH directories first, then common per-user install locations that are
  // often missing from a service process PATH (e.g. ~/.local/bin).
  const searchDirs = pathEnv.split(":");
  if (home) {
    searchDirs.push(
      `${home}/.local/bin`,
      `${home}/.claude/local`,
      `${home}/.npm-global/bin`,
      `${home}/bin`,
    );
  }
  searchDirs.push("/usr/local/bin", "/usr/bin");

  for (const dir of searchDirs) {
    if (!dir) {
      continue;
    }
    const candidate = `${dir.replace(/\/+$/, "")}/${DEFAULT_CLAUDE_BIN}`;
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return DEFAULT_CLAUDE_BIN;
}

// Force subscription OAuth auth: never leak an API key to the child CLI.
function buildClaudeChildEnv(): { env: Record<string, string>; clearEnv: boolean } {
  try {
    const env = Deno.env.toObject();
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return { env, clearEnv: true };
  } catch {
    // Without env access, inherit the parent environment as-is.
    return { env: {}, clearEnv: false };
  }
}

// Hermetic working directory for the CLI. The review is grounded ONLY in the
// packet capillary sends — but an agentic CLI will happily grep whatever repo
// its cwd happens to be, and when that checkout is a DIFFERENT project than
// the PR under review, the model either hallucinates a mismatch report or
// (correctly) refuses to review at all. An empty scratch dir removes the
// entire class: there is nothing on disk to consult.
let hermeticCwd: string | null = null;
function resolveHermeticCwd(): string {
  if (!hermeticCwd) {
    hermeticCwd = Deno.makeTempDirSync({ prefix: "capillary_claude_hermetic_" });
  }
  return hermeticCwd;
}

function defaultClaudeCliSpawner(invocation: ClaudeCliInvocation): ClaudeCliProcess {
  const command = new Deno.Command(resolveClaudeBin(), {
    args: invocation.args,
    cwd: resolveHermeticCwd(),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: invocation.env,
    clearEnv: invocation.clearEnv,
  });
  const child = command.spawn();

  const writer = child.stdin.getWriter();
  void writer.write(new TextEncoder().encode(invocation.stdin))
    .then(() => writer.close())
    .catch(() => {
      // Broken pipe (CLI exited early) is surfaced through the exit status.
    });

  let stderrPromise: Promise<string> | undefined;
  return {
    stdout: child.stdout,
    status: child.status,
    stderr: () => {
      if (!stderrPromise) {
        stderrPromise = new Response(child.stderr).text().catch(() => "");
      }
      return stderrPromise;
    },
  };
}

// WebSocket spawner: drives a `claude` CLI that lives on another machine via
// scripts/claude_ws_bridge.ts (e.g. container → host passthrough, mirroring
// the codex ws channel). Envelope protocol, one JSON object per text frame:
//   client → bridge:  { args, stdin }            (sent once, on open)
//   bridge → client:  { stream: "stdout"|"stderr", data } | { exit: code }
// env/clearEnv are intentionally not forwarded — the bridge owns its own
// environment and strips API-key variables itself.
export function createClaudeWsSpawner(baseUrl: string): ClaudeCliSpawner {
  return (invocation: ClaudeCliInvocation): ClaudeCliProcess => {
    const encoder = new TextEncoder();
    let stderrText = "";
    let settled = false;
    let resolveStatus: (status: { success: boolean; code: number }) => void;
    const status = new Promise<{ success: boolean; code: number }>((resolve) => {
      resolveStatus = resolve;
    });

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });

    const settle = (code: number) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        controller.close();
      } catch {
        // already closed
      }
      resolveStatus({ success: code === 0, code });
    };

    const socket = new WebSocket(baseUrl);
    socket.onopen = () => {
      socket.send(JSON.stringify({ args: invocation.args, stdin: invocation.stdin }));
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isRecord(envelope)) {
        return;
      }
      if (typeof envelope.exit === "number") {
        settle(envelope.exit);
        socket.close();
        return;
      }
      const data = asString(envelope.data);
      if (!data) {
        return;
      }
      if (envelope.stream === "stdout" && !settled) {
        controller.enqueue(encoder.encode(data));
      } else if (envelope.stream === "stderr") {
        stderrText += data;
      }
    };
    socket.onerror = () => {
      stderrText = stderrText || `claude_ws_connect_failed: ${baseUrl}`;
      settle(1);
    };
    socket.onclose = () => {
      // Close without an exit envelope means the bridge or network died mid-turn.
      stderrText = settled ? stderrText : stderrText || "claude_ws_closed_before_exit";
      settle(1);
    };

    return {
      stdout,
      status,
      stderr: () => Promise.resolve(stderrText),
    };
  };
}

interface ClaudePrompt {
  systemPrompt: string;
  userText: string;
}

function buildClaudePrompt(request: ProviderRequest): ClaudePrompt {
  const systemPrompt = request.systemPrompt?.trim() || "";
  const parts: string[] = [];
  for (const message of request.messages) {
    const content = message.content?.trim();
    if (!content) {
      continue;
    }
    if (message.role === "user") {
      parts.push(content);
    } else if (message.role === "assistant") {
      parts.push(`[assistant]\n${content}`);
    } else {
      parts.push(content);
    }
  }
  return { systemPrompt, userText: parts.join("\n\n") };
}

function buildClaudeArgs(
  model: string,
  systemPrompt: string,
  outputFormat: "json" | "stream-json",
): string[] {
  const args = [
    "-p",
    "--model",
    model,
    "--output-format",
    outputFormat,
    "--no-session-persistence",
    // The CLI is a text model here, not an agent. "--tools \"\"" removes the
    // built-in tool set and "--system-prompt" REPLACES the Claude Code agent
    // prompt instead of appending to it — with append, the model kept its
    // Claude Code identity plus environment framing, saw the bridge's
    // deliberately empty scratch cwd ("not a git checkout"), and wrote review
    // reports disclaiming that it could not open the diff. Requires a CLI
    // with --tools/--system-prompt in print mode (>= 2.1.x); older CLIs and
    // bridges reject these flags, and dispatch() retries once with
    // buildLegacyClaudeArgs when that happens.
    "--tools",
    "",
  ];
  if (outputFormat === "stream-json") {
    args.push("--verbose", "--include-partial-messages");
  }
  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }
  return args;
}

// Pre-#60 flag shape: agent prompt appended, no tool control. Only used as a
// one-shot retry when the modern contract is rejected by an older CLI
// ("unknown option") or an older bridge allowlist — never as the first choice.
function buildLegacyClaudeArgs(
  model: string,
  systemPrompt: string,
  outputFormat: "json" | "stream-json",
): string[] {
  const args = [
    "-p",
    "--model",
    model,
    "--output-format",
    outputFormat,
    "--no-session-persistence",
  ];
  if (outputFormat === "stream-json") {
    args.push("--verbose", "--include-partial-messages");
  }
  if (systemPrompt) {
    args.push("--append-system-prompt", systemPrompt);
  }
  return args;
}

/**
 * Does this failure mean the OTHER SIDE doesn't speak the modern flag
 * contract (--system-prompt/--tools)? Two known dialects: an older claude CLI
 * rejects the flags ("unknown option"), and an older ws bridge allowlist
 * rejects the whole invocation ("claude_bridge_args_rejected"). Both fail
 * immediately with no streamed output, so a legacy retry is safe. Exported
 * for direct unit testing.
 */
export function isLegacyContractError(message: string): boolean {
  const haystack = message.toLowerCase();
  return haystack.includes("unknown option") ||
    haystack.includes("unrecognized option") ||
    haystack.includes("unknown argument") ||
    haystack.includes("claude_bridge_args_rejected");
}

function mapClaudeResultError(subtype: string, message: string): ProviderError {
  const haystack = `${subtype} ${message}`.toLowerCase();
  if (
    haystack.includes("rate") || haystack.includes("limit") || haystack.includes("credit") ||
    haystack.includes("overage")
  ) {
    return { kind: "rate_limit", message: message || subtype || "claude_code_rate_limited" };
  }
  if (haystack.includes("auth") || haystack.includes("login") || haystack.includes("unauthor")) {
    return { kind: "auth", message: message || subtype || "claude_code_auth_required" };
  }
  return { kind: "server_error", message: message || subtype || "claude_code_error" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

interface ClaudeOutcome {
  content: string;
  finishReason: "completed" | "failed";
  error: ProviderError | null;
  inputTokens: number;
  outputTokens: number;
}

function applyResultEvent(event: Record<string, unknown>, streamedText: string): ClaudeOutcome {
  const isError = event.is_error === true;
  const resultText = asString(event.result) || streamedText;
  // Canonical accounting (see providers/usage.ts): the CLI's dialect varies
  // by version — flat Anthropic-shaped usage, nested cache_creation, or cache
  // fields living only in the camelCase per-model modelUsage map. A flat-only
  // parse produced the live "IN 2" miscount; the mapper takes the richer
  // reading. Input is never estimated from resultText (that is the OUTPUT).
  const usage = normalizeClaudeCliUsage(event);
  logRawUsageOnce("claude_code", { usage: event.usage, modelUsage: event.modelUsage });
  const inputTokens = usage.inputTotal;
  const outputTokens = usage.output || estimateTokens(resultText);

  if (isError) {
    return {
      content: resultText,
      finishReason: "failed",
      error: mapClaudeResultError(asString(event.subtype), asString(event.error) || resultText),
      inputTokens,
      outputTokens,
    };
  }

  return {
    content: resultText,
    finishReason: "completed",
    error: null,
    inputTokens,
    outputTokens,
  };
}

function extractDeltaText(event: Record<string, unknown>): string {
  if (asString(event.type) !== "stream_event") {
    return "";
  }
  const inner = isRecord(event.event) ? event.event : null;
  if (!inner || asString(inner.type) !== "content_block_delta") {
    return "";
  }
  const delta = isRecord(inner.delta) ? inner.delta : null;
  if (!delta || asString(delta.type) !== "text_delta") {
    return "";
  }
  return asString(delta.text);
}

async function runClaudeStream(
  spawner: ClaudeCliSpawner,
  invocation: ClaudeCliInvocation,
  model: string,
  onStream: ProviderStreamCallback | undefined,
): Promise<ProviderResult<ProviderResponse>> {
  const startedAt = Date.now();

  let proc: ClaudeCliProcess;
  try {
    proc = spawner(invocation);
  } catch (error) {
    return errorResult(
      "network",
      `claude_code_spawn_failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamedText = "";
  let outcome: ClaudeOutcome | null = null;
  let streamFinalized = false;

  const emit = (
    event: { kind: "chunk" | "completed" | "error"; text?: string; error?: string },
  ) => {
    if (!onStream || streamFinalized) {
      return;
    }
    try {
      onStream(event);
    } catch {
      // A failing stream consumer must not break the transport.
    }
    if (event.kind === "completed" || event.kind === "error") {
      streamFinalized = true;
    }
  };

  const handleLine = (line: string) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(event)) {
      return;
    }
    const deltaText = extractDeltaText(event);
    if (deltaText) {
      streamedText += deltaText;
      emit({ kind: "chunk", text: deltaText });
      return;
    }
    if (asString(event.type) === "result") {
      outcome = applyResultEvent(event, streamedText);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          handleLine(line);
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
  } catch (error) {
    const message = `claude_code_stream_failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    emit({ kind: "error", error: message });
    return errorResult("network", message);
  } finally {
    reader.releaseLock();
  }

  const tail = buffer.trim();
  if (tail) {
    handleLine(tail);
  }

  const status = await proc.status;

  if (!outcome) {
    if (!status.success) {
      const stderr = (await proc.stderr()).trim();
      const message = stderr || `claude_code_exited_with_code_${status.code}`;
      emit({ kind: "error", error: message });
      return errorResult("network", message);
    }
    // Process succeeded but produced no result event — fall back to streamed text.
    outcome = {
      content: streamedText,
      finishReason: streamedText ? "completed" : "failed",
      error: streamedText ? null : { kind: "server_error", message: "claude_code_empty_response" },
      inputTokens: estimateTokens(streamedText),
      outputTokens: estimateTokens(streamedText),
    };
  }

  const resolved: ClaudeOutcome = outcome;

  if (resolved.error) {
    emit({ kind: "error", error: resolved.error.message });
    return errorResult(resolved.error.kind, resolved.error.message, resolved.error.statusCode);
  }

  emit({ kind: "completed", text: resolved.content });

  return okResult<ProviderResponse>({
    providerKind: "claude_code",
    content: resolved.content,
    model,
    finishReason: resolved.finishReason,
    inputTokens: resolved.inputTokens,
    outputTokens: resolved.outputTokens,
    latencyMs: Date.now() - startedAt,
  });
}

export function createClaudeCodeProviderOps(
  spawner: ClaudeCliSpawner = defaultClaudeCliSpawner,
): ProviderOps {
  const dispatch = async (
    provider: ProviderDescriptor,
    request: ProviderRequest,
    onStream?: ProviderStreamCallback,
  ): Promise<ProviderResult<ProviderResponse>> => {
    if (!request.messages || request.messages.length === 0) {
      return invalidRequest("messages_required");
    }

    const baseUrl = provider.baseUrl.trim();
    const useWs = isClaudeWsBaseUrl(baseUrl);
    if (!isClaudeCliBaseUrl(baseUrl) && !useWs) {
      return invalidRequest("invalid_provider_base_url");
    }

    const model = (request.model || provider.model).trim() || "sonnet";
    const { systemPrompt, userText } = buildClaudePrompt(request);
    const { env, clearEnv } = buildClaudeChildEnv();

    // Every caller of this transport is an LLM text channel (planner and
    // report turns) — built-in tools are intentionally never available, so
    // the tool-free modern contract is global, not review-specific.
    const invocation: ClaudeCliInvocation = {
      args: buildClaudeArgs(model, systemPrompt, "stream-json"),
      stdin: userText,
      env,
      clearEnv,
    };

    const activeSpawner = useWs ? createClaudeWsSpawner(baseUrl) : spawner;
    const result = await runClaudeStream(activeSpawner, invocation, model, onStream);
    if (result.ok || !isLegacyContractError(result.error?.message ?? "")) {
      return result;
    }

    // The counterpart doesn't speak the modern contract yet (older CLI or
    // older bridge). These rejections fail before any output streams, so one
    // legacy retry is lossless. The legacy shape re-appends the agent prompt,
    // which is exactly the report-disclaimer bug on newer CLIs — but on the
    // old versions that reach this path, append was the working behavior.
    console.warn(
      "[claude_code] modern flag contract rejected (" + (result.error?.message ?? "") +
        "); retrying with legacy args — upgrade the claude CLI/bridge to >= 2.1.x",
    );
    const legacyInvocation: ClaudeCliInvocation = {
      args: buildLegacyClaudeArgs(model, systemPrompt, "stream-json"),
      stdin: userText,
      env,
      clearEnv,
    };
    return await runClaudeStream(activeSpawner, legacyInvocation, model, onStream);
  };

  return {
    send: (provider, request) => dispatch(provider, request),
    sendStream: (provider, request, onStream) => dispatch(provider, request, onStream),
  };
}

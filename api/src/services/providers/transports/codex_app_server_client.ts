// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { ProviderError, ProviderRequest, ProviderStreamCallback, ProviderStreamEvent } from "../provider_core.ts";

// Minimal JSON-RPC 2.0 client for the Codex app-server protocol.
//
// The app-server is NOT an OpenAI-compatible REST endpoint. It speaks
// newline/frame-delimited JSON-RPC 2.0 (with the "jsonrpc" header omitted on
// the wire) over stdio, a unix socket, or a websocket. A request drives this
// lifecycle:
//   initialize -> initialized (notification) -> thread/start -> turn/start
// and then reads streamed notifications (item/agentMessage/delta,
// item/completed, turn/completed) until the turn finishes.

export interface CodexRpcChannel {
  send(message: unknown): void | Promise<void>;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: (error?: Error) => void): void;
  close(): void | Promise<void>;
}

export type CodexChannelFactory = (baseUrl: string) => Promise<CodexRpcChannel>;

export interface CodexTurnResult {
  content: string;
  finishReason: "completed" | "failed";
}

export interface CodexTurnError {
  error: ProviderError;
}

export type CodexTurnOutcome = CodexTurnResult | CodexTurnError;

const CLIENT_NAME = "capillary";
const CLIENT_TITLE = "Capillary";
const CLIENT_VERSION = "1.0.0";
const DEFAULT_RUN_CONTEXT_ID = "__default__";
const MAX_CONTEXT_THREADS = 128;

function readTimeoutMsFromEnv(
  envName: string,
  fallbackMs: number,
  minMs: number,
  maxMs: number,
): number {
  const raw = Deno.env.get(envName);
  if (!raw || raw.trim().length === 0) {
    return fallbackMs;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallbackMs;
  }

  return Math.min(maxMs, Math.max(minMs, Math.trunc(parsed)));
}

const DEFAULT_TURN_TIMEOUT_MS = readTimeoutMsFromEnv(
  "CODEX_APP_SERVER_TURN_TIMEOUT_MS",
  300_000,
  30_000,
  3_600_000,
);
const DEFAULT_REVIEW_TURN_TIMEOUT_MS = readTimeoutMsFromEnv(
  "CODEX_APP_SERVER_REVIEW_TURN_TIMEOUT_MS",
  600_000,
  30_000,
  3_600_000,
);
// Agent-mode (RetV loop) runs validate many behaviors across cycles; each
// planner turn shares one thread but the per-turn budget must comfortably cover
// a heavy cycle (large DOM + growing history), so it gets its own larger budget.
const DEFAULT_AGENT_TURN_TIMEOUT_MS = readTimeoutMsFromEnv(
  "CODEX_APP_SERVER_AGENT_TURN_TIMEOUT_MS",
  600_000,
  30_000,
  3_600_000,
);
const REQUEST_TIMEOUT_MS = readTimeoutMsFromEnv(
  "CODEX_APP_SERVER_REQUEST_TIMEOUT_MS",
  60_000,
  5_000,
  600_000,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isAgentRunContext(normalized: string): boolean {
  return normalized.startsWith("agent:") ||
    normalized.startsWith("retv:") ||
    normalized.startsWith("retv_cdp_");
}

function resolveTurnTimeoutMs(runContextId: string | undefined, requestedMs?: number): number {
  if (typeof requestedMs === "number" && Number.isFinite(requestedMs)) {
    return Math.min(3_600_000, Math.max(30_000, Math.trunc(requestedMs)));
  }

  const normalized = runContextId?.trim().toLowerCase() || "";
  if (normalized.startsWith("review:")) {
    return DEFAULT_REVIEW_TURN_TIMEOUT_MS;
  }
  if (isAgentRunContext(normalized)) {
    return DEFAULT_AGENT_TURN_TIMEOUT_MS;
  }

  return DEFAULT_TURN_TIMEOUT_MS;
}

const VALID_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high"]);

function normalizeReasoningEffort(raw: string | undefined): string | undefined {
  const value = raw?.trim().toLowerCase();
  return value && VALID_REASONING_EFFORTS.has(value) ? value : undefined;
}

// Reasoning effort is the biggest latency lever for Codex turns. The RetV
// planner only emits small JSON tool-calls, so agent threads default to "low"
// for speed, while review threads keep full (server-default) reasoning for
// quality. A global override applies to every thread when set.
function resolveReasoningEffort(runContextId: string | undefined): string | undefined {
  const global = normalizeReasoningEffort(Deno.env.get("CODEX_APP_SERVER_REASONING_EFFORT"));
  if (global) {
    return global;
  }

  const normalized = runContextId?.trim().toLowerCase() || "";
  if (isAgentRunContext(normalized)) {
    return normalizeReasoningEffort(Deno.env.get("CODEX_APP_SERVER_AGENT_REASONING_EFFORT")) || "low";
  }

  return undefined;
}

export function isWebSocketBaseUrl(baseUrl: string): boolean {
  const normalized = baseUrl.trim().toLowerCase();
  return normalized.startsWith("ws://") || normalized.startsWith("wss://");
}

export function isStdioBaseUrl(baseUrl: string): boolean {
  return baseUrl.trim().toLowerCase().startsWith("stdio://");
}

export function buildTurnText(request: ProviderRequest): string {
  const parts: string[] = [];
  const system = request.systemPrompt?.trim();
  if (system) {
    parts.push(system);
  }
  for (const message of request.messages) {
    const content = message.content?.trim();
    if (!content) {
      continue;
    }
    if (message.role === "user") {
      parts.push(content);
    } else {
      parts.push(`[${message.role}]\n${content}`);
    }
  }
  return parts.join("\n\n");
}

function mapCodexError(payload: unknown): ProviderError {
  const record = isRecord(payload) ? payload : {};
  const info = isRecord(record.codexErrorInfo) ? record.codexErrorInfo : {};
  const message = asString(record.message) ||
    asString(info.message) ||
    asString(record.type) ||
    "codex_app_server_error";
  const statusCode = typeof info.httpStatusCode === "number" ? info.httpStatusCode : undefined;
  const normalized = `${message} ${asString(info.type)} ${asString(record.type)}`.toLowerCase();

  if (statusCode === 401 || normalized.includes("unauthorized") || normalized.includes("auth")) {
    return { kind: "auth", message, statusCode: statusCode ?? 401 };
  }
  if (
    normalized.includes("usagelimit") ||
    normalized.includes("rate") ||
    normalized.includes("quota") ||
    statusCode === 429
  ) {
    return { kind: "rate_limit", message, statusCode: statusCode ?? 429 };
  }
  if (statusCode === 400 || normalized.includes("badrequest") || normalized.includes("invalid")) {
    return { kind: "invalid_request", message, statusCode: statusCode ?? 400 };
  }
  if (typeof statusCode === "number" && statusCode >= 500) {
    return { kind: "server_error", message, statusCode };
  }
  return { kind: "server_error", message, statusCode };
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: ProviderError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface TurnState {
  agentText: string;
  finalAgentText: string;
  turnError: ProviderError | null;
  onStream?: ProviderStreamCallback;
  streamFinalized: boolean;
  done: Promise<void>;
  resolveDone: () => void;
  finished: boolean;
}

function buildClosedError(error?: Error): ProviderError {
  return {
    kind: "network",
    message: error?.message || "codex_app_server_connection_closed",
  };
}

export class CodexAppServerSession {
  #channel: CodexRpcChannel;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #initialized = false;
  #initializing: Promise<void> | null = null;
  #closed = false;
  #activeTurn: TurnState | null = null;
  #turnQueue: Promise<void> = Promise.resolve();
  #threadByContext = new Map<string, string>();

  constructor(channel: CodexRpcChannel) {
    this.#channel = channel;
    this.#channel.onMessage((message) => this.handleMessage(message));
    this.#channel.onClose((error) => this.handleClose(error));
  }

  isClosed(): boolean {
    return this.#closed;
  }

  async runTurn(
    request: ProviderRequest,
    model: string,
    turnTimeoutMs?: number,
    onStream?: ProviderStreamCallback,
  ): Promise<CodexTurnOutcome> {
    return await this.withTurnLock(async () => {
      if (this.#closed) {
        return { error: buildClosedError() };
      }

      const effectiveTurnTimeoutMs = resolveTurnTimeoutMs(request.runContextId, turnTimeoutMs);

      try {
        await this.ensureInitialized();
        const contextKey = this.buildContextKey(request, model);
        let threadId = await this.getOrCreateThreadId(contextKey, model);

        const turnText = buildTurnText(request);
        const turn = this.beginTurn(onStream);

        let turnStarted = false;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await this.request("turn/start", {
              threadId,
              input: [{ type: "text", text: turnText }],
              model,
            });
            this.emitStream(turn, { kind: "tool_use_started", toolName: "turn/start" });
            turnStarted = true;
            break;
          } catch (error) {
            const mapped: ProviderError = (isRecord(error) && "kind" in error)
              ? (error as unknown as ProviderError)
              : {
                kind: "network",
                message: error instanceof Error ? error.message : "codex_error",
              };

            if (attempt === 0 && this.isThreadInvalidError(mapped)) {
              this.#threadByContext.delete(contextKey);
              threadId = await this.getOrCreateThreadId(contextKey, model);
              continue;
            }

            throw mapped;
          }
        }

        if (!turnStarted) {
          return { error: { kind: "server_error", message: "codex_turn_start_failed" } };
        }

        await this.waitForTurnCompletion(turn, effectiveTurnTimeoutMs);

        if (turn.turnError) {
          return { error: turn.turnError };
        }

        const content = turn.finalAgentText || turn.agentText;
        if (!content.trim()) {
          this.emitStream(turn, { kind: "error", error: "codex_empty_response" });
          return { error: { kind: "server_error", message: "codex_empty_response" } };
        }

        this.emitStream(turn, { kind: "completed" });

        return { content, finishReason: "completed" };
      } catch (error) {
        const mapped: ProviderError = (isRecord(error) && "kind" in error)
          ? (error as unknown as ProviderError)
          : { kind: "network", message: error instanceof Error ? error.message : "codex_error" };
        return { error: mapped };
      } finally {
        this.#activeTurn = null;
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#threadByContext.clear();
    const closedError = buildClosedError();
    this.failAllPending(closedError);
    this.failActiveTurn(closedError);
    await Promise.resolve(this.#channel.close()).catch(() => {});
  }

  private async ensureInitialized(): Promise<void> {
    if (this.#initialized) {
      return;
    }
    if (this.#initializing) {
      await this.#initializing;
      return;
    }

    this.#initializing = (async () => {
      await this.request("initialize", {
        clientInfo: { name: CLIENT_NAME, title: CLIENT_TITLE, version: CLIENT_VERSION },
      });
      this.notify("initialized", {});
      this.#initialized = true;
    })();

    try {
      await this.#initializing;
    } finally {
      this.#initializing = null;
    }
  }

  private buildContextKey(request: ProviderRequest, model: string): string {
    const runContextId = request.runContextId?.trim() || DEFAULT_RUN_CONTEXT_ID;
    return `${model}::${runContextId}`;
  }

  private async getOrCreateThreadId(contextKey: string, model: string): Promise<string> {
    const existing = this.#threadByContext.get(contextKey);
    if (existing) {
      return existing;
    }

    const runContextId = contextKey.split("::").slice(1).join("::");
    const reasoningEffort = resolveReasoningEffort(runContextId);
    const baseParams: Record<string, unknown> = {
      model,
      approvalPolicy: "never",
      sandbox: "read-only",
    };

    let threadResult: unknown;
    if (reasoningEffort) {
      try {
        threadResult = await this.request("thread/start", {
          ...baseParams,
          config: { model_reasoning_effort: reasoningEffort },
        });
      } catch {
        // Older app-servers may reject config overrides; fall back to the
        // known-good params so the run never breaks on an optional speed hint.
        threadResult = await this.request("thread/start", baseParams);
      }
    } else {
      threadResult = await this.request("thread/start", baseParams);
    }
    const threadRecord = isRecord(threadResult) ? threadResult : {};
    const thread = isRecord(threadRecord.thread) ? threadRecord.thread : threadRecord;
    const threadId = asString(thread.id) || asString(threadRecord.threadId);
    if (!threadId) {
      throw { kind: "server_error", message: "codex_thread_start_no_id" } as ProviderError;
    }

    this.#threadByContext.set(contextKey, threadId);
    if (this.#threadByContext.size > MAX_CONTEXT_THREADS) {
      const oldest = this.#threadByContext.keys().next().value;
      if (typeof oldest === "string") {
        this.#threadByContext.delete(oldest);
      }
    }

    return threadId;
  }

  private isThreadInvalidError(error: ProviderError): boolean {
    if (error.kind !== "invalid_request") {
      return false;
    }
    const message = (error.message || "").toLowerCase();
    return message.includes("thread") || message.includes("unknown") || message.includes("not found");
  }

  private beginTurn(onStream?: ProviderStreamCallback): TurnState {
    let resolveDone: (() => void) | undefined;
    const turn: TurnState = {
      agentText: "",
      finalAgentText: "",
      turnError: null,
      onStream,
      streamFinalized: false,
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
      resolveDone: () => {},
      finished: false,
    };

    turn.resolveDone = () => {
      if (turn.finished) {
        return;
      }
      turn.finished = true;
      resolveDone?.();
    };

    this.#activeTurn = turn;
    return turn;
  }

  private async waitForTurnCompletion(turn: TurnState, turnTimeoutMs: number): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        this.markTurnError(turn, { kind: "network", message: "codex_turn_timeout" });
        turn.resolveDone();
        resolve();
      }, turnTimeoutMs);
    });

    try {
      await Promise.race([turn.done, timeout]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) {
      throw buildClosedError();
    }

    const id = this.#nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject({ kind: "network", message: `codex_${method}_timeout` } as ProviderError);
      }, REQUEST_TIMEOUT_MS);

      this.#pending.set(id, { resolve, reject, timer });
      Promise.resolve(this.#channel.send({ id, method, params })).catch((error) => {
        const entry = this.#pending.get(id);
        if (entry) {
          this.#pending.delete(id);
          clearTimeout(entry.timer);
        }
        reject({
          kind: "network",
          message: error instanceof Error ? error.message : "codex_send_failed",
        } as ProviderError);
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (this.#closed) {
      return;
    }
    Promise.resolve(this.#channel.send({ method, params })).catch(() => {});
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) {
      return;
    }

    if (typeof message.id === "number" && (("result" in message) || ("error" in message))) {
      const entry = this.#pending.get(message.id);
      if (!entry) {
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(entry.timer);
      if ("error" in message) {
        entry.reject(mapCodexError(message.error));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    const turn = this.#activeTurn;
    if (!turn) {
      return;
    }

    const method = asString(message.method);
    const params = isRecord(message.params) ? message.params : {};

    if (method === "item/agentMessage/delta") {
      const delta = asString(params.delta) || asString(params.text);
      turn.agentText += delta;
      if (delta) {
        this.emitStream(turn, { kind: "chunk", text: delta });
      }
      return;
    }

    if (method === "item/completed") {
      const item = isRecord(params.item) ? params.item : {};
      if (asString(item.type) === "agentMessage") {
        const text = asString(item.text);
        if (text) {
          turn.finalAgentText = text;
        }
      }
      return;
    }

    if (method === "turn/completed") {
      const completedTurn = isRecord(params.turn) ? params.turn : params;
      const status = asString(completedTurn.status);
      if (status === "failed" || status === "interrupted") {
        this.markTurnError(
          turn,
          mapCodexError(completedTurn.error ?? { message: `codex_turn_${status || "failed"}` }),
        );
      }
      turn.resolveDone();
      return;
    }

    if (method === "error" || method.endsWith("/error")) {
      this.markTurnError(turn, mapCodexError(params.error ?? params));
      turn.resolveDone();
    }
  }

  private handleClose(error?: Error): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    const closedError = buildClosedError(error);
    this.failAllPending(closedError);
    this.failActiveTurn(closedError);
  }

  private failAllPending(error: ProviderError): void {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
  }

  private failActiveTurn(error: ProviderError): void {
    const turn = this.#activeTurn;
    if (!turn) {
      return;
    }

    this.markTurnError(turn, error);
    turn.resolveDone();
  }

  private markTurnError(turn: TurnState, error: ProviderError): void {
    if (turn.turnError) {
      return;
    }
    turn.turnError = error;
    this.emitStream(turn, { kind: "error", error: error.message });
  }

  private emitStream(turn: TurnState, event: ProviderStreamEvent): void {
    if (!turn.onStream || turn.streamFinalized) {
      return;
    }

    try {
      turn.onStream(event);
    } catch {
      // Stream callback errors must not break the transport session.
    }

    if (event.kind === "completed" || event.kind === "error") {
      turn.streamFinalized = true;
    }
  }

  private async withTurnLock<T>(work: () => Promise<T>): Promise<T> {
    let release = () => {};
    const previous = this.#turnQueue;
    this.#turnQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

export async function createCodexAppServerSession(
  baseUrl: string,
  channelFactory: CodexChannelFactory = defaultCodexChannelFactory,
): Promise<CodexAppServerSession> {
  const channel = await channelFactory(baseUrl);
  return new CodexAppServerSession(channel);
}

export function openWebSocketChannel(baseUrl: string): Promise<CodexRpcChannel> {
  return new Promise<CodexRpcChannel>((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(baseUrl);
    } catch (error) {
      reject(error instanceof Error ? error : new Error("codex_ws_invalid_url"));
      return;
    }

    let messageHandler: (message: unknown) => void = () => {};
    let closeHandler: (error?: Error) => void = () => {};
    let opened = false;

    socket.onopen = () => {
      opened = true;
      resolve({
        send(message: unknown) {
          socket.send(JSON.stringify(message));
        },
        onMessage(handler) {
          messageHandler = handler;
        },
        onClose(handler) {
          closeHandler = handler;
        },
        close() {
          try {
            socket.close();
          } catch {
            // ignore
          }
        },
      });
    };

    socket.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (!raw) {
        return;
      }
      try {
        messageHandler(JSON.parse(raw));
      } catch {
        // ignore malformed frames
      }
    };

    socket.onerror = () => {
      if (!opened) {
        reject(new Error("codex_ws_connect_failed"));
      }
    };

    socket.onclose = (event) => {
      if (opened) {
        closeHandler(event.reason ? new Error(event.reason) : undefined);
      }
    };
  });
}

function resolveStdioCommandCandidates(baseUrl: string): { command: string; args: string[] }[] {
  const override = Deno.env.get("CODEX_APP_SERVER_CMD");
  if (override && override.trim()) {
    const parts = override.trim().split(/\s+/);
    return [{ command: parts[0], args: parts.slice(1) }];
  }

  // Optional override via the stdio:// host segment, e.g. stdio:///usr/bin/codex.
  const withoutScheme = baseUrl.trim().replace(/^stdio:\/\//i, "").trim();
  if (withoutScheme && withoutScheme !== "codex-app-server") {
    const parts = withoutScheme.split(/\s+/);
    return [{
      command: parts[0],
      args: parts.slice(1).length ? parts.slice(1) : ["app-server"],
    }];
  }

  // The API process PATH frequently differs from the user's interactive shell
  // (e.g. ~/.local/bin is absent), so try bare PATH lookup first, then fall back
  // to well-known install locations. We cannot stat files without --allow-read,
  // so candidates are attempted by spawning until one succeeds.
  const candidates: { command: string; args: string[] }[] = [
    { command: "codex", args: ["app-server"] },
  ];
  const home = Deno.env.get("HOME");
  const knownDirs = [
    home ? `${home}/.local/bin` : "",
    home ? `${home}/.codex/bin` : "",
    "/usr/local/bin",
    "/usr/bin",
  ].filter((dir) => dir.length > 0);
  for (const dir of knownDirs) {
    candidates.push({ command: `${dir}/codex`, args: ["app-server"] });
  }
  return candidates;
}

export function openStdioChannel(baseUrl: string): Promise<CodexRpcChannel> {
  const candidates = resolveStdioCommandCandidates(baseUrl);

  let child: Deno.ChildProcess | null = null;
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      child = new Deno.Command(candidate.command, {
        args: candidate.args,
        stdin: "piped",
        stdout: "piped",
        stderr: "inherit",
      }).spawn();
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("codex_stdio_spawn_failed");
    }
  }

  if (!child) {
    return Promise.reject(
      new Error(
        `codex_stdio_spawn_failed: could not launch 'codex app-server' (tried ${
          candidates.map((c) => c.command).join(", ")
        }). Set CODEX_APP_SERVER_CMD to the codex binary path.${
          lastError ? ` Last error: ${lastError.message}` : ""
        }`,
      ),
    );
  }

  return Promise.resolve(buildStdioChannel(child));
}

function buildStdioChannel(child: Deno.ChildProcess): CodexRpcChannel {
  const writer = child.stdin.getWriter();
  const encoder = new TextEncoder();
  let messageHandler: (message: unknown) => void = () => {};
  let closeHandler: (error?: Error) => void = () => {};
  let closed = false;

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  (async () => {
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
            try {
              messageHandler(JSON.parse(line));
            } catch {
              // ignore non-JSON log lines
            }
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }
    } catch (error) {
      if (!closed) {
        closeHandler(error instanceof Error ? error : undefined);
      }
    } finally {
      if (!closed) {
        closeHandler();
      }
    }
  })();

  return {
    async send(message: unknown) {
      await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    async close() {
      closed = true;
      try {
        await writer.close();
      } catch {
        // ignore
      }
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      try {
        child.kill();
      } catch {
        // ignore
      }
      try {
        await child.status;
      } catch {
        // ignore
      }
    },
  };
}

export function defaultCodexChannelFactory(baseUrl: string): Promise<CodexRpcChannel> {
  if (isWebSocketBaseUrl(baseUrl)) {
    return openWebSocketChannel(baseUrl);
  }
  if (isStdioBaseUrl(baseUrl)) {
    return openStdioChannel(baseUrl);
  }
  return Promise.reject(new Error("codex_unsupported_base_url"));
}

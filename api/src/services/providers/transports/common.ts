// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import {
  ChatMessage,
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
import { emitTextStream, estimateTokens, JSON_CONTENT_TYPE } from "../provider_helpers.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export const OPENAI_CHAT_COMPLETIONS_PATH = "/chat/completions";
export const GITHUB_MODELS_INFERENCE_CHAT_COMPLETIONS_PATH = "/inference/chat/completions";
export const GITHUB_API_VERSION_HEADER = "2026-03-10";
export const GITHUB_ACCEPT_HEADER = "application/vnd.github+json";
export const ANTHROPIC_MESSAGES_PATH = "/messages";
export const ANTHROPIC_VERSION_HEADER = "2023-06-01";
const SUPPORTED_ENDPOINT_PROTOCOLS = ["http:", "https:"] as const;

interface OpenAiChoice {
  message?: { content?: string };
  finish_reason?: string;
}

export interface OpenAiParsedResponse {
  content: string;
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
}

interface OpenAiCompatibleRequestInput {
  fetchLike: FetchLike;
  provider: ProviderDescriptor;
  request: ProviderRequest;
  headers: Record<string, string>;
  model?: string;
  path?: string;
  body?: Record<string, unknown>;
}

type ProviderSendFn = (
  provider: ProviderDescriptor,
  request: ProviderRequest,
) => Promise<ProviderResult<ProviderResponse>>;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function isSupportedEndpointProtocol(
  protocol: string,
): protocol is (typeof SUPPORTED_ENDPOINT_PROTOCOLS)[number] {
  return SUPPORTED_ENDPOINT_PROTOCOLS.includes(
    protocol as (typeof SUPPORTED_ENDPOINT_PROTOCOLS)[number],
  );
}

export function resolveHttpEndpoint(baseUrl: string, path: string): string | null {
  try {
    const parsedBase = new URL(baseUrl);
    if (!isSupportedEndpointProtocol(parsedBase.protocol)) {
      return null;
    }

    const normalizedBase = parsedBase.toString().replace(/\/+$/, "") + "/";
    const normalizedPath = path.replace(/^\/+/, "");
    return new URL(normalizedPath, normalizedBase).toString();
  } catch {
    return null;
  }
}

export function normalizeMessages(request: ProviderRequest): ChatMessage[] {
  const system = request.systemPrompt?.trim();
  const source = request.messages.slice();
  if (system) {
    source.unshift({ role: "system", content: system });
  }
  return source;
}

export function buildOpenAiCompatibleBody(
  request: ProviderRequest,
  model: string,
  stream: boolean,
): Record<string, unknown> {
  return {
    model,
    messages: normalizeMessages(request).map((message) => ({
      role: message.role,
      content: message.content,
    })),
    temperature: request.temperature,
    max_tokens: request.maxOutputTokens,
    stream,
  };
}

function usesMaxCompletionTokens(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.includes("gpt-5");
}

export function buildGithubModelsBody(
  request: ProviderRequest,
  model: string,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: normalizeMessages(request).map((message) => ({
      role: message.role,
      content: message.content,
    })),
    temperature: request.temperature,
    stream,
  };

  if (typeof request.maxOutputTokens === "number") {
    const tokenField = usesMaxCompletionTokens(model) ? "max_completion_tokens" : "max_tokens";
    body[tokenField] = request.maxOutputTokens;
  }

  return body;
}

export function parseOpenAiCompatibleResponse(payload: unknown): OpenAiParsedResponse | null {
  const data = payload as Record<string, unknown> | null;
  const choice = (data?.choices as OpenAiChoice[] | undefined)?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string") {
    return null;
  }

  const usage = (data?.usage as Record<string, unknown>) || {};
  return {
    content,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : "completed",
    promptTokens: Number(usage.prompt_tokens || estimateTokens(content)) || 0,
    completionTokens: Number(usage.completion_tokens || estimateTokens(content)) || 0,
  };
}

export async function parseJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function invalidRequest(message: string): ProviderResult<ProviderResponse> {
  return errorResult("invalid_request", message, 400);
}

export function authMissing(kind: ProviderDescriptor["kind"]): ProviderResult<ProviderResponse> {
  return errorResult("auth", `${kind}_api_key_missing`, 401);
}

export function mapHttpError(payload: unknown, status: number): ProviderError {
  const data = payload as Record<string, unknown> | null;
  const nested = (data?.error as Record<string, unknown>) || null;
  const message = String(nested?.message || data?.message || "provider_http_error");

  if (status === 401) {
    return { kind: "auth", message, statusCode: status };
  }
  if (status === 403) {
    const normalized = message.toLowerCase();
    if (
      normalized.includes("budget") ||
      normalized.includes("quota") ||
      normalized.includes("billing") ||
      normalized.includes("limit")
    ) {
      return { kind: "rate_limit", message, statusCode: status };
    }
    return { kind: "auth", message, statusCode: status };
  }
  if (status === 429) {
    return { kind: "rate_limit", message, statusCode: status };
  }
  if (status >= 500) {
    return { kind: "server_error", message, statusCode: status };
  }
  return { kind: "invalid_request", message, statusCode: status };
}

export function toResponse(
  provider: ProviderDescriptor,
  model: string,
  content: string,
  finishReason: "completed" | "failed",
  inputTokens: number,
  outputTokens: number,
): ProviderResult<ProviderResponse> {
  return okResult({
    providerKind: provider.kind,
    model,
    content,
    finishReason,
    inputTokens,
    outputTokens,
    latencyMs: 0,
  });
}

export function endpoint(baseUrl: string, path: string): string {
  return joinUrl(baseUrl, path);
}

export async function sendOpenAiCompatibleRequest(
  input: OpenAiCompatibleRequestInput,
): Promise<ProviderResult<ProviderResponse>> {
  const model = input.model || input.request.model || input.provider.model;
  const url = resolveHttpEndpoint(
    input.provider.baseUrl,
    input.path || OPENAI_CHAT_COMPLETIONS_PATH,
  );
  if (!url) {
    return invalidRequest("invalid_provider_base_url");
  }

  const posted = await postJson(
    input.fetchLike,
    url,
    input.headers,
    input.body || buildOpenAiCompatibleBody(input.request, model, false),
  );

  if (!posted.ok) {
    const mapped = posted.error;
    return errorResult(
      mapped?.kind || "network",
      mapped?.message || "network_error",
      mapped?.statusCode,
    );
  }

  const parsed = parseOpenAiCompatibleResponse(posted.payload);
  if (!parsed) {
    return errorResult("server_error", "provider_response_invalid", 502);
  }

  return toResponse(
    input.provider,
    model,
    parsed.content,
    parsed.finishReason === "completed" || parsed.finishReason === "stop" ? "completed" : "failed",
    parsed.promptTokens,
    parsed.completionTokens,
  );
}

export async function postJson(
  fetchLike: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{
  ok: boolean;
  payload?: unknown;
  error?: ProviderError;
}> {
  try {
    const response = await fetchLike(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const payload = await parseJsonSafe(response);
    if (!response.ok) {
      return {
        ok: false,
        error: mapHttpError(payload, response.status),
      };
    }

    return { ok: true, payload };
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

export function emitCompletedText(content: string, onStream: ProviderStreamCallback): void {
  emitTextStream(content, onStream, 0);
}

export function createBufferedProviderOps(send: ProviderSendFn): ProviderOps {
  return {
    send,
    async sendStream(provider, request, onStream) {
      const result = await send(provider, request);
      if (!result.ok || !result.value) {
        return result;
      }

      emitCompletedText(result.value.content, onStream);
      return result;
    },
  };
}

export const CONTENT_TYPE_JSON_HEADER: Readonly<Record<string, string>> = {
  "content-type": JSON_CONTENT_TYPE,
};

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { errorResult, ProviderOps, ProviderRequest } from "../provider_core.ts";
import {
  ANTHROPIC_MESSAGES_PATH,
  ANTHROPIC_VERSION_HEADER,
  authMissing,
  CONTENT_TYPE_JSON_HEADER,
  createBufferedProviderOps,
  endpoint,
  FetchLike,
  invalidRequest,
  postJson,
  toResponse,
} from "./common.ts";
import { estimateTokens } from "../provider_helpers.ts";
import { logRawUsageOnce, normalizeAnthropicUsage } from "../usage.ts";

function anthropicHeaders(apiKey: string): Record<string, string> {
  if (apiKey.startsWith("sk-ant-")) {
    return {
      ...CONTENT_TYPE_JSON_HEADER,
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION_HEADER,
    };
  }

  return {
    ...CONTENT_TYPE_JSON_HEADER,
    authorization: `Bearer ${apiKey}`,
    "anthropic-version": ANTHROPIC_VERSION_HEADER,
  };
}

function toAnthropicMessages(request: ProviderRequest): Array<Record<string, unknown>> {
  return request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: [{ type: "text", text: message.content }],
    }));
}

function parseAnthropicResponse(payload: unknown): {
  content: string;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
} | null {
  const data = payload as Record<string, unknown> | null;
  const content = ((data?.content as Array<Record<string, unknown>> | undefined) || [])
    .flatMap((item) => item.type === "text" ? [String(item.text || "")] : [])
    .join("\n")
    .trim();

  if (!content) {
    return null;
  }

  // Canonical accounting (see providers/usage.ts): cache-aware input incl.
  // nested cache_creation breakdowns; input never estimated from output.
  const usage = normalizeAnthropicUsage(data?.usage);
  logRawUsageOnce("anthropic", data?.usage);
  return {
    content,
    stopReason: String(data?.stop_reason || "completed"),
    inputTokens: usage.inputTotal,
    outputTokens: usage.output || estimateTokens(content),
  };
}

export function createAnthropicProviderOps(fetchLike: FetchLike = fetch): ProviderOps {
  return createBufferedProviderOps(async (provider, request) => {
    if (!request.messages || request.messages.length === 0) {
      return invalidRequest("messages_required");
    }
    if (!provider.apiKey.trim()) {
      return authMissing("anthropic");
    }

    const model = request.model || provider.model;
    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxOutputTokens || 4096,
      temperature: request.temperature,
      messages: toAnthropicMessages(request),
    };
    if (request.systemPrompt?.trim()) {
      body.system = request.systemPrompt.trim();
    }

    const posted = await postJson(
      fetchLike,
      endpoint(provider.baseUrl, ANTHROPIC_MESSAGES_PATH),
      anthropicHeaders(provider.apiKey),
      body,
    );

    if (!posted.ok) {
      const mapped = posted.error;
      return errorResult(
        mapped?.kind || "network",
        mapped?.message || "network_error",
        mapped?.statusCode,
      );
    }

    const parsed = parseAnthropicResponse(posted.payload);
    if (!parsed) {
      return errorResult("server_error", "provider_response_invalid", 502);
    }

    return toResponse(
      provider,
      model,
      parsed.content,
      parsed.stopReason === "completed" || parsed.stopReason === "end_turn"
        ? "completed"
        : "failed",
      parsed.inputTokens,
      parsed.outputTokens,
    );
  });
}

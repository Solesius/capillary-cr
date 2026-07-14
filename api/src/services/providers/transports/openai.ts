// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Native OpenAI transport — the Responses API (`POST {base}/responses`), not
// the chat-completions compatibility dialect (that lane already exists via
// openai_compatible/openrouter). Native matters for the reasoning models:
// typed output items (reasoning blocks arrive alongside the message and must
// be skipped, never concatenated), `max_output_tokens` without the
// max_tokens/max_completion_tokens guessing game, and the Responses usage
// dialect (input_tokens/output_tokens with cached split).
import { errorResult, ProviderOps } from "../provider_core.ts";
import { estimateTokens } from "../provider_helpers.ts";
import { logRawUsageOnce, normalizeOpenAiResponsesUsage } from "../usage.ts";
import {
  authMissing,
  CONTENT_TYPE_JSON_HEADER,
  createBufferedProviderOps,
  FetchLike,
  invalidRequest,
  postJson,
  resolveHttpEndpoint,
  toResponse,
} from "./common.ts";

export const OPENAI_RESPONSES_PATH = "/responses";

interface ResponsesOutputPart {
  type?: string;
  text?: string;
}

interface ResponsesOutputItem {
  type?: string;
  content?: ResponsesOutputPart[];
}

/**
 * Extract assistant text from a Responses payload: message items' output_text
 * parts, in order. Reasoning/tool items are structural, not prose — skipped.
 */
export function parseOpenAiResponsesText(payload: unknown): string | null {
  const data = payload as Record<string, unknown> | null;
  const output = data?.output as ResponsesOutputItem[] | undefined;
  if (!Array.isArray(output)) {
    return null;
  }
  const parts: string[] = [];
  for (const item of output) {
    if (item?.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

export function createOpenAiProviderOps(fetchLike: FetchLike = fetch): ProviderOps {
  return createBufferedProviderOps(async (provider, request) => {
    if (!request.messages || request.messages.length === 0) {
      return invalidRequest("messages_required");
    }
    if (!provider.apiKey.trim()) {
      return authMissing("openai");
    }

    const model = request.model || provider.model;
    const url = resolveHttpEndpoint(provider.baseUrl, OPENAI_RESPONSES_PATH);
    if (!url) {
      return invalidRequest("invalid_provider_base_url");
    }

    const body: Record<string, unknown> = {
      model,
      input: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    };
    if (typeof request.maxOutputTokens === "number") {
      body.max_output_tokens = request.maxOutputTokens;
    }
    if (typeof request.temperature === "number") {
      body.temperature = request.temperature;
    }

    const posted = await postJson(fetchLike, url, {
      ...CONTENT_TYPE_JSON_HEADER,
      authorization: `Bearer ${provider.apiKey}`,
    }, body);
    if (!posted.ok) {
      const mapped = posted.error;
      return errorResult(
        mapped?.kind || "network",
        mapped?.message || "network_error",
        mapped?.statusCode,
      );
    }

    const data = posted.payload as Record<string, unknown> | null;
    const content = parseOpenAiResponsesText(posted.payload);
    if (content === null) {
      return errorResult("server_error", "provider_response_invalid", 502);
    }

    const usage = normalizeOpenAiResponsesUsage(data?.usage);
    logRawUsageOnce("openai_responses", data?.usage);
    return toResponse(
      provider,
      model,
      content,
      data?.status === "completed" ? "completed" : "failed",
      usage.inputTotal,
      usage.output || estimateTokens(content),
    );
  });
}

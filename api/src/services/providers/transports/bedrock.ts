// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { errorResult, ProviderOps, ProviderRequest } from "../provider_core.ts";
import { estimateTokens } from "../provider_helpers.ts";
import {
  authMissing,
  CONTENT_TYPE_JSON_HEADER,
  createBufferedProviderOps,
  endpoint,
  FetchLike,
  invalidRequest,
  postJson,
  toResponse,
} from "./common.ts";

function buildBedrockConversePath(model: string): string {
  return `/model/${encodeURIComponent(model.trim())}/converse`;
}

function toBedrockMessages(request: ProviderRequest): Array<Record<string, unknown>> {
  return request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: [{ text: message.content }],
    }));
}

function parseBedrockResponse(payload: unknown): {
  content: string;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
} | null {
  const data = payload as Record<string, unknown> | null;
  const message = (data?.output as Record<string, unknown> | undefined)?.message as
    | Record<string, unknown>
    | undefined;
  const contentItems = (message?.content as Array<Record<string, unknown>> | undefined) || [];
  const text = contentItems
    .flatMap((item) => typeof item.text === "string" ? [item.text] : [])
    .join("\n")
    .trim();

  const fallbackText = typeof data?.outputText === "string" ? data.outputText.trim() : "";
  const content = text || fallbackText;
  if (!content) {
    return null;
  }

  const usage = (data?.usage as Record<string, unknown>) || {};
  return {
    content,
    stopReason: String(data?.stopReason || "completed"),
    inputTokens: Number(usage.inputTokens || estimateTokens(content)) || 0,
    outputTokens: Number(usage.outputTokens || estimateTokens(content)) || 0,
  };
}

function bedrockHeaders(apiKey: string): Record<string, string> {
  // Some Bedrock proxy deployments accept bearer; some expect x-api-key.
  return {
    ...CONTENT_TYPE_JSON_HEADER,
    accept: "application/json",
    authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
  };
}

export function createBedrockProviderOps(fetchLike: FetchLike = fetch): ProviderOps {
  return createBufferedProviderOps(async (provider, request) => {
    if (!request.messages || request.messages.length === 0) {
      return invalidRequest("messages_required");
    }
    if (!provider.apiKey.trim()) {
      return authMissing("ihhi_bedrock");
    }

    const model = request.model || provider.model;
    const body: Record<string, unknown> = {
      messages: toBedrockMessages(request),
      inferenceConfig: {
        temperature: request.temperature,
        maxTokens: request.maxOutputTokens,
      },
    };

    if (request.systemPrompt?.trim()) {
      body.system = [{ text: request.systemPrompt.trim() }];
    }

    const posted = await postJson(
      fetchLike,
      endpoint(provider.baseUrl, buildBedrockConversePath(model)),
      bedrockHeaders(provider.apiKey),
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

    const parsed = parseBedrockResponse(posted.payload);
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

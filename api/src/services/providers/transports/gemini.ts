// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import {
  ProviderOps,
  ProviderRequest,
  errorResult,
} from "../provider_core.ts";
import { estimateTokens } from "../provider_helpers.ts";
import {
  CONTENT_TYPE_JSON_HEADER,
  FetchLike,
  authMissing,
  createBufferedProviderOps,
  endpoint,
  invalidRequest,
  mapHttpError,
  parseJsonSafe,
  toResponse,
} from "./common.ts";

function buildGeminiUrl(baseUrl: string, model: string, apiKey: string): string {
  const encodedModel = encodeURIComponent(model.trim());
  const path = `/models/${encodedModel}:generateContent`;
  const url = endpoint(baseUrl, path);
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}key=${encodeURIComponent(apiKey)}`;
}

function toGeminiContents(request: ProviderRequest): Array<Record<string, unknown>> {
  return request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));
}

function parseGeminiResponse(payload: unknown): {
  content: string;
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
} | null {
  const data = payload as Record<string, unknown> | null;
  const candidates = (data?.candidates as Array<Record<string, unknown>> | undefined) || [];
  const first = candidates[0] || null;
  const parts = (first?.content as Record<string, unknown> | undefined)?.parts as Array<Record<string, unknown>> | undefined;
  const content = (parts || [])
    .map((part) => String(part.text || ""))
    .join("\n")
    .trim();

  if (!content) {
    return null;
  }

  const usage = (data?.usageMetadata as Record<string, unknown>) || {};
  return {
    content,
    finishReason: String(first?.finishReason || "STOP"),
    inputTokens: Number(usage.promptTokenCount || estimateTokens(content)) || 0,
    outputTokens: Number(usage.candidatesTokenCount || estimateTokens(content)) || 0,
  };
}

export function createGeminiProviderOps(fetchLike: FetchLike = fetch): ProviderOps {
  return createBufferedProviderOps(async (provider, request) => {
      if (!request.messages || request.messages.length === 0) {
        return invalidRequest("messages_required");
      }
      if (!provider.apiKey.trim()) {
        return authMissing("gemini");
      }

      const model = request.model || provider.model;
      const url = buildGeminiUrl(provider.baseUrl, model, provider.apiKey);

      const body: Record<string, unknown> = {
        contents: toGeminiContents(request),
        generationConfig: {
          temperature: request.temperature,
          maxOutputTokens: request.maxOutputTokens,
        },
      };

      if (request.systemPrompt?.trim()) {
        body.systemInstruction = {
          role: "user",
          parts: [{ text: request.systemPrompt.trim() }],
        };
      }

      try {
        const response = await fetchLike(url, {
          method: "POST",
          headers: {
            ...CONTENT_TYPE_JSON_HEADER,
          },
          body: JSON.stringify(body),
        });

        const payload = await parseJsonSafe(response);
        if (!response.ok) {
          const mapped = mapHttpError(payload, response.status);
          return errorResult(mapped.kind, mapped.message, mapped.statusCode);
        }

        const parsed = parseGeminiResponse(payload);
        if (!parsed) {
          return errorResult("server_error", "provider_response_invalid", 502);
        }

        return toResponse(
          provider,
          model,
          parsed.content,
          parsed.finishReason === "STOP" || parsed.finishReason === "MAX_TOKENS" ? "completed" : "failed",
          parsed.inputTokens,
          parsed.outputTokens,
        );
      } catch (error) {
        return errorResult("network", error instanceof Error ? error.message : "network_error");
      }
    });
}
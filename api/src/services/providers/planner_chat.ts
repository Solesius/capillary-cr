// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
// planner_chat.ts — shared LLM "planner" chat + JSON-extraction helpers.
//
// Both the CDP RetV functional-test agent and the TCSRTC review agent drive a
// provider-backed reasoning loop that returns structured JSON. This module
// centralizes the three concerns those loops share:
//   1. provider-backed chat (github_copilot/codex/anthropic/... via the registry)
//   2. OpenAI-compatible chat (local servers, e.g. http://localhost:1234/v1)
//   3. robust extraction of a single JSON object from a possibly-noisy reply
//
// The review agent reuses these so we do not duplicate the provider plumbing.

import {
  buildProviderFromKind,
  type ProviderKind,
} from "./provider_registry.ts";
import { chat, chatStream } from "./provider_client.ts";
import type { ProviderStreamEvent } from "./provider_core.ts";

export type PlannerProviderKind = ProviderKind | "openai_compatible";

export interface PlannerChatConfig {
  providerKind: PlannerProviderKind;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface PlannerChatResult {
  ok: boolean;
  value?: { content: string; inputTokens?: number; outputTokens?: number };
  error?: { kind: string; message: string };
}

export interface PlannerChatOptions {
  runContextId?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

const DEFAULT_TEMPERATURE = 0.1;
const DEFAULT_MAX_OUTPUT_TOKENS = 1600;

/** Single-shot planner chat, transparently routing provider vs OpenAI-compatible. */
export async function plannerChat(
  config: PlannerChatConfig,
  systemPrompt: string,
  userMessage: string,
  options: PlannerChatOptions = {},
): Promise<PlannerChatResult> {
  if (config.providerKind === "openai_compatible") {
    return await openAiCompatibleChat(config, systemPrompt, userMessage, options);
  }

  const provider = buildProviderFromKind(config.providerKind, {
    kind: config.providerKind,
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });

  const response = await chat(provider, {
    systemPrompt,
    model: provider.model,
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    runContextId: options.runContextId,
    messages: [{ role: "user", content: userMessage }],
  });

  if (!response.ok || !response.value) {
    return {
      ok: false,
      error: {
        kind: response.error?.kind || "unknown",
        message: response.error?.message || "provider_unavailable",
      },
    };
  }

  return { ok: true, value: { content: response.value.content, inputTokens: response.value.inputTokens, outputTokens: response.value.outputTokens } };
}

/** Streaming planner chat (provider-backed only; OpenAI-compatible falls back to single-shot). */
export async function plannerChatStream(
  config: PlannerChatConfig,
  systemPrompt: string,
  userMessage: string,
  onStream: (event: ProviderStreamEvent) => void,
  options: PlannerChatOptions = {},
): Promise<PlannerChatResult> {
  if (config.providerKind === "openai_compatible") {
    return await openAiCompatibleChat(config, systemPrompt, userMessage, options);
  }

  const provider = buildProviderFromKind(config.providerKind, {
    kind: config.providerKind,
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });

  const response = await chatStream(
    provider,
    {
      systemPrompt,
      model: provider.model,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      runContextId: options.runContextId,
      messages: [{ role: "user", content: userMessage }],
    },
    onStream,
  );

  if (!response.ok || !response.value) {
    return {
      ok: false,
      error: {
        kind: response.error?.kind || "unknown",
        message: response.error?.message || "provider_unavailable",
      },
    };
  }

  return { ok: true, value: { content: response.value.content, inputTokens: response.value.inputTokens, outputTokens: response.value.outputTokens } };
}

async function openAiCompatibleChat(
  config: PlannerChatConfig,
  systemPrompt: string,
  userMessage: string,
  options: PlannerChatOptions,
): Promise<PlannerChatResult> {
  const base = config.baseUrl.replace(/\/+$/, "");
  const endpoint = `${base}/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey.trim().length > 0) {
    headers.authorization = `Bearer ${config.apiKey.trim()}`;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: options.temperature ?? DEFAULT_TEMPERATURE,
        max_tokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        stream: false,
      }),
    });

    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const message = String(
        payload?.message ||
          (payload?.error as Record<string, unknown> | undefined)?.message ||
          `HTTP ${response.status}`,
      );
      const kind = response.status === 401 || response.status === 403 ? "auth" : "network";
      return { ok: false, error: { kind, message } };
    }

    const first = (payload?.choices as Array<Record<string, unknown>> | undefined)?.[0];
    const content = first && typeof first === "object"
      ? String((first.message as Record<string, unknown> | undefined)?.content || "")
      : "";

    if (!content) {
      return { ok: false, error: { kind: "invalid_request", message: "provider_response_invalid" } };
    }

    return { ok: true, value: { content } };
  } catch (error) {
    return {
      ok: false,
      error: { kind: "network", message: error instanceof Error ? error.message : "network_error" },
    };
  }
}

/**
 * Extract a single JSON object from a possibly-noisy model reply. Tolerates
 * code fences, leading/trailing prose, trailing commas, single quotes, and
 * unquoted keys. Returns the parsed object, or null when nothing usable found.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();

  const direct = tryParseJson(trimmed);
  if (isPlainObject(direct)) {
    return direct;
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/im.exec(trimmed);
  if (fenced && fenced[1]) {
    const fencedParsed = extractJsonObject(fenced[1]);
    if (fencedParsed) {
      return fencedParsed;
    }
  }

  const balanced = findFirstBalancedJsonObject(trimmed);
  if (balanced) {
    const parsedBalanced = tryParseJson(balanced);
    if (isPlainObject(parsedBalanced)) {
      return parsedBalanced;
    }
    const repaired = tryParseJson(repairLooseJson(balanced));
    if (isPlainObject(repaired)) {
      return repaired;
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = trimmed.slice(start, end + 1);
    const parsedSliced = tryParseJson(sliced);
    if (isPlainObject(parsedSliced)) {
      return parsedSliced;
    }
    const repairedSliced = tryParseJson(repairLooseJson(sliced));
    if (isPlainObject(repairedSliced)) {
      return repairedSliced;
    }
  }

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function repairLooseJson(value: string): string {
  return value
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, group: string) => `"${group.replace(/"/g, "\\\"")}"`);
}

function findFirstBalancedJsonObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      if (start === -1) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === "}") {
      if (depth <= 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

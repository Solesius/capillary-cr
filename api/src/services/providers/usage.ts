// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// usage.ts — one canonical token-usage shape, with a pure mapper per provider
// dialect. Every provider reports usage differently (flat snake_case, nested
// cache objects, camelCase per-model maps, "prompt includes cached", …) and
// ad-hoc parsing produced live miscounts — a Fable run reported IN 2 after
// three full-file reads because the claude CLI's cache fields live in a shape
// the flat parser never looked at. Rules enforced here, uniformly:
//
//   * input = fresh + cache-read + cache-write, whatever the dialect calls them
//   * input is NEVER estimated from the response text (that is the output)
//   * absent usage yields honest zeros with source:"absent", not fiction
//
// All mappers are pure and pinned by fixture tests; a plausibility sentinel
// (usageLooksSuspect) lets callers flag readings that undershoot the prompt
// they just sent — dishonesty is always detectable even when a new dialect
// appears before its mapper does.

export interface NormalizedUsage {
  /** Uncached input tokens, billed at the full input rate. */
  inputFresh: number;
  /** Tokens read from the prompt cache. */
  inputCacheRead: number;
  /** Tokens written into the prompt cache. */
  inputCacheWrite: number;
  /** Context-true total input: fresh + cacheRead + cacheWrite. */
  inputTotal: number;
  output: number;
  /** "provider" when any usage was reported; "absent" for honest zeros. */
  source: "provider" | "absent";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function build(
  fresh: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
): NormalizedUsage {
  const inputTotal = fresh + cacheRead + cacheWrite;
  return {
    inputFresh: fresh,
    inputCacheRead: cacheRead,
    inputCacheWrite: cacheWrite,
    inputTotal,
    output,
    source: inputTotal + output > 0 ? "provider" : "absent",
  };
}

export const ABSENT_USAGE: NormalizedUsage = Object.freeze(build(0, 0, 0, 0));

/**
 * Anthropic Messages API dialect: flat `input_tokens` (uncached slice only) +
 * `cache_read_input_tokens` + `cache_creation_input_tokens`; newer responses
 * additionally break creation down under a nested `cache_creation` object —
 * prefer the flat field, fall back to summing the nested breakdown.
 */
export function normalizeAnthropicUsage(usage: unknown): NormalizedUsage {
  const u = rec(usage);
  const nestedCreation = Object.values(rec(u.cache_creation)).reduce<number>(
    (sum, value) => sum + num(value),
    0,
  );
  return build(
    num(u.input_tokens),
    num(u.cache_read_input_tokens),
    num(u.cache_creation_input_tokens) || nestedCreation,
    num(u.output_tokens),
  );
}

/**
 * claude CLI result-event dialect. Newer CLIs report an Anthropic-shaped
 * `usage`, but depending on version the cache fields may only exist in the
 * per-model `modelUsage` map (camelCase keys) — the live "IN 2" miscount.
 * Take the richer of the two readings.
 */
export function normalizeClaudeCliUsage(event: unknown): NormalizedUsage {
  const e = rec(event);
  const fromUsage = normalizeAnthropicUsage(e.usage);

  let fresh = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  for (const perModel of Object.values(rec(e.modelUsage))) {
    const m = rec(perModel);
    fresh += num(m.inputTokens) || num(m.input_tokens);
    cacheRead += num(m.cacheReadInputTokens) || num(m.cache_read_input_tokens);
    cacheWrite += num(m.cacheCreationInputTokens) || num(m.cache_creation_input_tokens);
    output += num(m.outputTokens) || num(m.output_tokens);
  }
  const fromModelUsage = build(fresh, cacheRead, cacheWrite, output);

  return fromModelUsage.inputTotal > fromUsage.inputTotal
    ? {
      ...fromModelUsage,
      output: Math.max(fromModelUsage.output, fromUsage.output),
    }
    : fromUsage;
}

/**
 * OpenAI-compatible dialect (copilot / openrouter / generic endpoints):
 * `prompt_tokens` already INCLUDES the cached portion; the split lives in
 * `prompt_tokens_details.cached_tokens`. Fresh is therefore prompt − cached.
 */
export function normalizeOpenAiUsage(usage: unknown): NormalizedUsage {
  const u = rec(usage);
  const prompt = num(u.prompt_tokens);
  const cached = Math.min(prompt, num(rec(u.prompt_tokens_details).cached_tokens));
  return build(prompt - cached, cached, 0, num(u.completion_tokens));
}

/**
 * Gemini dialect: `promptTokenCount` includes `cachedContentTokenCount`;
 * output is `candidatesTokenCount`.
 */
export function normalizeGeminiUsage(usageMetadata: unknown): NormalizedUsage {
  const u = rec(usageMetadata);
  const prompt = num(u.promptTokenCount);
  const cached = Math.min(prompt, num(u.cachedContentTokenCount));
  return build(prompt - cached, cached, 0, num(u.candidatesTokenCount));
}

/** Bedrock converse dialect: camelCase, with optional cache read/write. */
export function normalizeBedrockUsage(usage: unknown): NormalizedUsage {
  const u = rec(usage);
  return build(
    num(u.inputTokens),
    num(u.cacheReadInputTokens),
    num(u.cacheWriteInputTokens) || num(u.cacheCreationInputTokens),
    num(u.outputTokens),
  );
}

/**
 * Plausibility sentinel: a reported input total that undershoots a quarter of
 * the crude chars/4 floor for the prompt we just sent is almost certainly a
 * dialect miss, not reality. Callers log/flag; they never "correct" the number
 * (fabrication is the failure mode this module exists to end).
 */
export function usageLooksSuspect(usage: NormalizedUsage, promptChars: number): boolean {
  if (promptChars < 2_000) {
    return false; // tiny prompts: estimation noise dwarfs the signal
  }
  const floor = Math.floor(promptChars / 16); // 25% of chars/4
  return usage.inputTotal < floor;
}

const rawLoggedFor = new Set<string>();

/**
 * One-shot raw-usage logger per provider per process, gated by
 * CAPILLARY_LOG_RAW_USAGE=1 — captures real payloads so new dialects become
 * frozen test fixtures instead of live miscounts.
 */
export function logRawUsageOnce(provider: string, raw: unknown): void {
  try {
    if (Deno.env.get("CAPILLARY_LOG_RAW_USAGE") !== "1" || rawLoggedFor.has(provider)) {
      return;
    }
    rawLoggedFor.add(provider);
    console.log(`[usage:${provider}] raw payload:`, JSON.stringify(raw));
  } catch {
    // Env access may be denied; raw logging is diagnostics, never load-bearing.
  }
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Fixture tests pinning every provider usage dialect to the canonical shape.
// Each fixture mirrors a real payload family; drift in a parser turns into a
// red test here instead of a live miscount (the "IN 2" class).
import { assert, assertEquals } from "jsr:@std/assert";
import {
  normalizeAnthropicUsage,
  normalizeBedrockUsage,
  normalizeClaudeCliUsage,
  normalizeGeminiUsage,
  normalizeOpenAiUsage,
  usageLooksSuspect,
} from "../src/services/providers/usage.ts";

Deno.test("anthropic: flat cache fields sum into inputTotal", () => {
  const u = normalizeAnthropicUsage({
    input_tokens: 42,
    cache_read_input_tokens: 18_000,
    cache_creation_input_tokens: 2_500,
    output_tokens: 350,
  });
  assertEquals(u.inputTotal, 20_542);
  assertEquals(u.inputCacheRead, 18_000);
  assertEquals(u.output, 350);
  assertEquals(u.source, "provider");
});

Deno.test("anthropic: nested cache_creation breakdown is summed when flat field absent", () => {
  const u = normalizeAnthropicUsage({
    input_tokens: 10,
    cache_read_input_tokens: 5_000,
    cache_creation: { ephemeral_5m_input_tokens: 1_200, ephemeral_1h_input_tokens: 300 },
    output_tokens: 90,
  });
  assertEquals(u.inputCacheWrite, 1_500);
  assertEquals(u.inputTotal, 6_510);
});

Deno.test("claude CLI: cache fields living only in camelCase modelUsage are recovered (the IN 2 bug)", () => {
  const u = normalizeClaudeCliUsage({
    usage: { input_tokens: 2, output_tokens: 468 },
    modelUsage: {
      "fable-5": {
        inputTokens: 2,
        cacheReadInputTokens: 21_000,
        cacheCreationInputTokens: 4_000,
        outputTokens: 468,
      },
    },
  });
  assertEquals(u.inputTotal, 25_002);
  assertEquals(u.output, 468);
});

Deno.test("claude CLI: rich flat usage wins when modelUsage is poorer or absent", () => {
  const u = normalizeClaudeCliUsage({
    usage: {
      input_tokens: 42,
      cache_read_input_tokens: 18_000,
      cache_creation_input_tokens: 2_500,
      output_tokens: 350,
    },
  });
  assertEquals(u.inputTotal, 20_542);
});

Deno.test("claude CLI: absent usage yields honest zeros, source absent", () => {
  const u = normalizeClaudeCliUsage({ result: "hello" });
  assertEquals(u.inputTotal, 0);
  assertEquals(u.source, "absent");
});

Deno.test("openai dialect: prompt includes cached; fresh is the difference", () => {
  const u = normalizeOpenAiUsage({
    prompt_tokens: 12_000,
    completion_tokens: 800,
    prompt_tokens_details: { cached_tokens: 11_000 },
  });
  assertEquals(u.inputTotal, 12_000);
  assertEquals(u.inputFresh, 1_000);
  assertEquals(u.inputCacheRead, 11_000);
});

Deno.test("gemini: promptTokenCount includes cachedContentTokenCount", () => {
  const u = normalizeGeminiUsage({
    promptTokenCount: 9_000,
    cachedContentTokenCount: 7_500,
    candidatesTokenCount: 420,
  });
  assertEquals(u.inputTotal, 9_000);
  assertEquals(u.inputFresh, 1_500);
  assertEquals(u.output, 420);
});

Deno.test("bedrock: camelCase with cache read/write", () => {
  const u = normalizeBedrockUsage({
    inputTokens: 100,
    cacheReadInputTokens: 4_000,
    cacheWriteInputTokens: 900,
    outputTokens: 250,
  });
  assertEquals(u.inputTotal, 5_000);
});

Deno.test("sentinel: flags an implausibly small input for a large prompt, never a small one", () => {
  const big = 80_000; // ~20k tokens of prompt
  assert(usageLooksSuspect(normalizeAnthropicUsage({ input_tokens: 2, output_tokens: 400 }), big));
  assert(
    !usageLooksSuspect(
      normalizeAnthropicUsage({ input_tokens: 50, cache_read_input_tokens: 19_000 }),
      big,
    ),
  );
  // Tiny prompts: estimation noise dwarfs the signal — never flag.
  assert(!usageLooksSuspect(normalizeAnthropicUsage({ input_tokens: 1 }), 500));
});

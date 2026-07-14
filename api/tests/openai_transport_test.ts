// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Native OpenAI Responses API transport — fully offline (mocked fetch).
import { assert, assertEquals } from "jsr:@std/assert";
import { buildProviderFromKind } from "../src/services/providers/provider_registry.ts";
import {
  createOpenAiProviderOps,
  parseOpenAiResponsesText,
} from "../src/services/providers/transports/openai.ts";
import { normalizeOpenAiResponsesUsage } from "../src/services/providers/usage.ts";

const provider = buildProviderFromKind("openai", { apiKey: "sk-test" });

const request = {
  messages: [
    { role: "system" as const, content: "You are terse." },
    { role: "user" as const, content: "Say hi." },
  ],
  model: "",
  maxOutputTokens: 128,
};

function mockFetch(payload: unknown, status = 200, capture?: { body?: unknown; url?: string }) {
  return (input: string, init?: RequestInit) => {
    if (capture) {
      capture.url = input;
      capture.body = JSON.parse(String(init?.body ?? "null"));
    }
    return Promise.resolve(
      new Response(JSON.stringify(payload), { status }),
    );
  };
}

const completedPayload = {
  status: "completed",
  output: [
    // Reasoning item first — structural, must never leak into content.
    { type: "reasoning", summary: [] },
    {
      type: "message",
      content: [
        { type: "output_text", text: "hi" },
        { type: "output_text", text: " there" },
      ],
    },
  ],
  usage: {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 60 },
    output_tokens: 12,
    output_tokens_details: { reasoning_tokens: 7 },
  },
};

Deno.test("should_post_to_the_responses_endpoint_with_native_fields", async () => {
  const capture: { body?: Record<string, unknown>; url?: string } = {};
  const ops = createOpenAiProviderOps(mockFetch(completedPayload, 200, capture));
  const result = await ops.send(provider, request);
  assert(result.ok);
  assertEquals(capture.url, "https://api.openai.com/v1/responses");
  assertEquals(capture.body?.model, "gpt-5.5");
  assertEquals(capture.body?.max_output_tokens, 128);
  assert(!("max_tokens" in (capture.body ?? {})));
  assert(!("max_completion_tokens" in (capture.body ?? {})));
});

Deno.test("should_concatenate_message_text_and_skip_reasoning_items", async () => {
  const ops = createOpenAiProviderOps(mockFetch(completedPayload));
  const result = await ops.send(provider, request);
  assert(result.ok);
  assertEquals(result.value?.content, "hi there");
  assertEquals(result.value?.finishReason, "completed");
});

Deno.test("should_normalize_responses_usage_with_cached_split", async () => {
  const ops = createOpenAiProviderOps(mockFetch(completedPayload));
  const result = await ops.send(provider, request);
  assert(result.ok);
  // input_tokens includes cached; canonical total stays 100, output stays 12
  // (reasoning tokens are billed output — never subtracted).
  assertEquals(result.value?.inputTokens, 100);
  assertEquals(result.value?.outputTokens, 12);
  const usage = normalizeOpenAiResponsesUsage(completedPayload.usage);
  assertEquals(usage.inputCacheRead, 60);
  assertEquals(usage.inputFresh, 40);
  assertEquals(usage.inputTotal, 100);
});

Deno.test("should_fail_auth_without_an_api_key", async () => {
  const keyless = buildProviderFromKind("openai", { apiKey: "" });
  const ops = createOpenAiProviderOps(mockFetch(completedPayload));
  const result = await ops.send(keyless, request);
  assert(!result.ok);
  assertEquals(result.error?.kind, "auth");
});

Deno.test("should_reject_a_payload_with_no_message_output", async () => {
  const ops = createOpenAiProviderOps(
    mockFetch({ status: "completed", output: [{ type: "reasoning" }] }),
  );
  const result = await ops.send(provider, request);
  assert(!result.ok);
  assertEquals(result.error?.kind, "server_error");
});

Deno.test("should_parse_only_output_text_parts", () => {
  assertEquals(
    parseOpenAiResponsesText({
      output: [
        { type: "message", content: [{ type: "refusal", text: "no" }] },
        { type: "message", content: [{ type: "output_text", text: "yes" }] },
      ],
    }),
    "yes",
  );
  assertEquals(parseOpenAiResponsesText({ output: "not-an-array" }), null);
});

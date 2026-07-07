// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import {
  ProviderDescriptor,
  ProviderRequest,
  ProviderResponse,
  ProviderResult,
  ProviderStreamCallback,
} from "./provider_core.ts";
import { resolveProviderOps } from "./provider_registry.ts";

export async function chat(
  provider: ProviderDescriptor,
  request: ProviderRequest,
): Promise<ProviderResult<ProviderResponse>> {
  const ops = resolveProviderOps(provider.kind);
  const started = Date.now();
  const result = await ops.send(provider, request);

  if (result.ok && result.value) {
    result.value.latencyMs = Math.max(result.value.latencyMs, Date.now() - started);
  }

  return result;
}

export async function chatStream(
  provider: ProviderDescriptor,
  request: ProviderRequest,
  onStream: ProviderStreamCallback,
): Promise<ProviderResult<ProviderResponse>> {
  const ops = resolveProviderOps(provider.kind);
  const started = Date.now();
  const result = await ops.sendStream(provider, request, onStream);

  if (result.ok && result.value) {
    result.value.latencyMs = Math.max(result.value.latencyMs, Date.now() - started);
  }

  return result;
}

export async function quickChat(
  provider: ProviderDescriptor,
  userMessage: string,
  systemPrompt?: string,
): Promise<ProviderResult<string>> {
  const response = await chat(provider, {
    model: provider.model,
    systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  if (!response.ok || !response.value) {
    return {
      ok: false,
      error: response.error,
    };
  }

  return {
    ok: true,
    value: response.value.content,
  };
}

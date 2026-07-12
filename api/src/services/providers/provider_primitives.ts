// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { ProviderDescriptor, ProviderKind } from "./provider_core.ts";

interface ProviderDefaults {
  baseUrl: string;
  model: string;
}

export function buildProviderDescriptor(
  kind: ProviderKind,
  defaults: ProviderDefaults,
  partial: Partial<ProviderDescriptor> = {},
): ProviderDescriptor {
  const envKey = partial.apiKey || Deno.env.get("CAPILLARY_LLM_API_KEY") || "";
  return {
    kind,
    apiKey: envKey,
    baseUrl: partial.baseUrl || defaults.baseUrl,
    model: partial.model || defaults.model,
    region: partial.region,
    awsProfile: partial.awsProfile,
    defaultRoute: partial.defaultRoute,
  };
}

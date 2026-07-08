// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { ProviderDescriptor, ProviderKind, ProviderOps } from "./provider_core.ts";
import { firstNonEmpty } from "./provider_helpers.ts";
import { buildProviderDescriptor } from "./provider_primitives.ts";
import {
  createAnthropicProviderOps,
  createBedrockProviderOps,
  createClaudeCodeProviderOps,
  createCopilotProviderOps,
  createCodexAppServerProviderOps,
  createGeminiProviderOps,
  createOpenRouterProviderOps,
} from "./transports/mod.ts";

const DEFAULT_CODEX_APP_SERVER_MODEL = "gpt-5.4-mini";
const DEFAULT_CLAUDE_CODE_MODEL = "sonnet";

const PROVIDER_DEFAULTS: Record<ProviderKind, { baseUrl: string; model: string }> = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-pro",
  },
  ihhi_bedrock: {
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-sonnet-4",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-20250514",
  },
  github_copilot: {
    baseUrl: "https://models.github.ai",
    model: "openai/gpt-4.1",
  },
  codex_app_server: {
    // Operator-set env override (e.g. ws://host.docker.internal:7899) lets a
    // containerized API reach a codex app-server bridged on the host — see
    // scripts/codex_ws_bridge.ts. Env-only, same trust posture as API keys;
    // request payloads still cannot repoint this provider.
    baseUrl: Deno.env.get("CODEX_APP_SERVER_URL")?.trim() || "stdio://codex-app-server",
    model: DEFAULT_CODEX_APP_SERVER_MODEL,
  },
  claude_code: {
    // Operator-set env override (e.g. ws://host.docker.internal:7898) lets a
    // containerized API reach a claude CLI bridged on the host — see
    // scripts/claude_ws_bridge.ts. Env-only, mirrors CODEX_APP_SERVER_URL.
    baseUrl: Deno.env.get("CLAUDE_CODE_URL")?.trim() || "stdio://claude-code",
    model: DEFAULT_CLAUDE_CODE_MODEL,
  },
};

const PROVIDER_OPS: Record<ProviderKind, ProviderOps> = {
  gemini: createGeminiProviderOps(),
  ihhi_bedrock: createBedrockProviderOps(),
  openrouter: createOpenRouterProviderOps(),
  anthropic: createAnthropicProviderOps(),
  github_copilot: createCopilotProviderOps(),
  codex_app_server: createCodexAppServerProviderOps(),
  claude_code: createClaudeCodeProviderOps(),
};

const ORDERED_PROVIDER_KINDS: ProviderKind[] = [
  "gemini",
  "ihhi_bedrock",
  "openrouter",
  "anthropic",
  "github_copilot",
  "codex_app_server",
  "claude_code",
];

const DEFAULT_PROVIDER_API_KEY_ENV = "CAPILLARY_LLM_API_KEY";

const PROVIDER_API_KEY_CHAIN: Record<ProviderKind, string[]> = {
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", DEFAULT_PROVIDER_API_KEY_ENV],
  ihhi_bedrock: ["BEDROCK_API_KEY", "AWS_BEARER_TOKEN", DEFAULT_PROVIDER_API_KEY_ENV],
  openrouter: ["OPENROUTER_API_KEY", DEFAULT_PROVIDER_API_KEY_ENV],
  anthropic: ["ANTHROPIC_API_KEY", DEFAULT_PROVIDER_API_KEY_ENV],
  github_copilot: ["GITHUB_COPILOT_TOKEN", "GITHUB_TOKEN", DEFAULT_PROVIDER_API_KEY_ENV],
  codex_app_server: ["CODEX_APP_SERVER_API_KEY", "GITHUB_COPILOT_TOKEN", "GITHUB_TOKEN", DEFAULT_PROVIDER_API_KEY_ENV],
  // Claude Code authenticates via its own subscription OAuth login; no API key is used.
  claude_code: [],
};

export function listProviderKinds(): ProviderKind[] {
  return ORDERED_PROVIDER_KINDS.slice();
}

export function resolveProviderOps(kind: ProviderKind): ProviderOps {
  return PROVIDER_OPS[kind];
}

export function buildProviderFromKind(
  kind: ProviderKind,
  partial: Partial<ProviderDescriptor> = {},
): ProviderDescriptor {
  const resolvedApiKey = partial.apiKey ?? resolveProviderApiKey(kind);
  return buildProviderDescriptor(kind, PROVIDER_DEFAULTS[kind], {
    ...partial,
    apiKey: resolvedApiKey,
  });
}

function resolveProviderApiKey(kind: ProviderKind): string {
  return firstNonEmpty(PROVIDER_API_KEY_CHAIN[kind].map((key) => Deno.env.get(key) || ""));
}

/**
 * Only these provider kinds are authenticated *by* the user's GitHub token
 * (Copilot REST + the Codex app-server when proxied through Copilot). Every
 * other provider talks to an unrelated vendor, so silently falling back to the
 * GitHub token there would leak that credential to a third-party endpoint.
 */
export function providerUsesGithubToken(kind: string): boolean {
  return kind === "github_copilot" || kind === "codex_app_server";
}

export type { ProviderKind } from "./provider_core.ts";

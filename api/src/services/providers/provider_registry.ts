// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { ProviderDescriptor, ProviderKind, ProviderOps } from "./provider_core.ts";
import { firstNonEmpty } from "./provider_helpers.ts";
import { buildProviderDescriptor } from "./provider_primitives.ts";
import {
  createAnthropicProviderOps,
  createBedrockProviderOps,
  createClaudeCodeProviderOps,
  createCodexAppServerProviderOps,
  createCopilotProviderOps,
  createGeminiProviderOps,
  createOpenAiProviderOps,
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
    baseUrl: "stdio://codex-app-server",
    model: DEFAULT_CODEX_APP_SERVER_MODEL,
  },
  claude_code: {
    baseUrl: "stdio://claude-code",
    model: DEFAULT_CLAUDE_CODE_MODEL,
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.5",
  },
};

// Operator-set env overrides (e.g. ws://host.docker.internal:7899) let a
// containerized API reach a CLI bridged on the host — see
// scripts/codex_ws_bridge.ts / scripts/claude_ws_bridge.ts. Env-only, same
// trust posture as API keys; request payloads still cannot repoint these
// providers. Read lazily (not at module load) so resolution always reflects
// the live environment.
const CLI_BASE_URL_ENV: Partial<Record<ProviderKind, string>> = {
  codex_app_server: "CODEX_APP_SERVER_URL",
  claude_code: "CLAUDE_CODE_URL",
};

function resolveProviderDefaults(kind: ProviderKind): { baseUrl: string; model: string } {
  const defaults = PROVIDER_DEFAULTS[kind];
  const envVar = CLI_BASE_URL_ENV[kind];
  const override = envVar ? Deno.env.get(envVar)?.trim() || "" : "";
  return override ? { ...defaults, baseUrl: override } : defaults;
}

const PROVIDER_OPS: Record<ProviderKind, ProviderOps> = {
  gemini: createGeminiProviderOps(),
  ihhi_bedrock: createBedrockProviderOps(),
  openrouter: createOpenRouterProviderOps(),
  anthropic: createAnthropicProviderOps(),
  github_copilot: createCopilotProviderOps(),
  codex_app_server: createCodexAppServerProviderOps(),
  claude_code: createClaudeCodeProviderOps(),
  openai: createOpenAiProviderOps(),
};

const ORDERED_PROVIDER_KINDS: ProviderKind[] = [
  "gemini",
  "ihhi_bedrock",
  "openrouter",
  "anthropic",
  "github_copilot",
  "codex_app_server",
  "claude_code",
  "openai",
];

const DEFAULT_PROVIDER_API_KEY_ENV = "CAPILLARY_LLM_API_KEY";

const PROVIDER_API_KEY_CHAIN: Record<ProviderKind, string[]> = {
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", DEFAULT_PROVIDER_API_KEY_ENV],
  ihhi_bedrock: ["BEDROCK_API_KEY", "AWS_BEARER_TOKEN", DEFAULT_PROVIDER_API_KEY_ENV],
  openrouter: ["OPENROUTER_API_KEY", DEFAULT_PROVIDER_API_KEY_ENV],
  anthropic: ["ANTHROPIC_API_KEY", DEFAULT_PROVIDER_API_KEY_ENV],
  github_copilot: ["GITHUB_COPILOT_TOKEN", "GITHUB_TOKEN", DEFAULT_PROVIDER_API_KEY_ENV],
  codex_app_server: [
    "CODEX_APP_SERVER_API_KEY",
    "GITHUB_COPILOT_TOKEN",
    "GITHUB_TOKEN",
    DEFAULT_PROVIDER_API_KEY_ENV,
  ],
  // Claude Code authenticates via its own subscription OAuth login; no API key is used.
  claude_code: [],
  openai: ["OPENAI_API_KEY", DEFAULT_PROVIDER_API_KEY_ENV],
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
  const defaults = resolveProviderDefaults(kind);
  // A persisted vanilla stdio:// base URL (e.g. runtime config rehydrated
  // from the durable store, saved before a ws bridge existed) must not pin a
  // CLI provider to in-process spawning once the operator points it at a
  // bridge via env. Explicit non-default values still win.
  const partialBaseUrl = partial.baseUrl?.trim() || "";
  const baseUrl = partialBaseUrl && partialBaseUrl !== PROVIDER_DEFAULTS[kind].baseUrl
    ? partialBaseUrl
    : defaults.baseUrl;
  return buildProviderDescriptor(kind, defaults, {
    ...partial,
    baseUrl,
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

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
export type ProviderKind =
  | "gemini"
  | "ihhi_bedrock"
  | "openrouter"
  | "anthropic"
  | "github_copilot"
  | "codex_app_server"
  | "claude_code";

export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "network"
  | "invalid_request"
  | "server_error"
  | "content_blocked";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderDescriptor {
  kind: ProviderKind;
  apiKey: string;
  baseUrl: string;
  model: string;
  region?: string;
  awsProfile?: string;
  defaultRoute?: "auto" | "haiku" | "opus";
}

export interface ProviderRequest {
  messages: ChatMessage[];
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  runContextId?: string;
}

export interface ProviderResponse {
  providerKind: ProviderKind;
  content: string;
  model: string;
  finishReason: "completed" | "failed";
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export type StreamEventKind = "chunk" | "completed" | "error" | "tool_use_started";

export interface ProviderStreamEvent {
  kind: StreamEventKind;
  text?: string;
  toolName?: string;
  error?: string;
}

export interface ProviderError {
  kind: ProviderErrorKind;
  message: string;
  statusCode?: number;
}

export interface ProviderResult<T> {
  ok: boolean;
  value?: T;
  error?: ProviderError;
}

export type ProviderStreamCallback = (event: ProviderStreamEvent) => void;

export interface ProviderOps {
  send(
    provider: ProviderDescriptor,
    request: ProviderRequest,
  ): Promise<ProviderResult<ProviderResponse>>;
  sendStream(
    provider: ProviderDescriptor,
    request: ProviderRequest,
    onStream: ProviderStreamCallback,
  ): Promise<ProviderResult<ProviderResponse>>;
}

export function okResult<T>(value: T): ProviderResult<T> {
  return { ok: true, value };
}

export function errorResult<T>(
  kind: ProviderErrorKind,
  message: string,
  statusCode?: number,
): ProviderResult<T> {
  return {
    ok: false,
    error: {
      kind,
      message,
      statusCode,
    },
  };
}

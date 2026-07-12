// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import {
  errorResult,
  okResult,
  ProviderDescriptor,
  ProviderOps,
  ProviderRequest,
  ProviderResponse,
  ProviderResult,
  ProviderStreamCallback,
} from "../provider_core.ts";
import {
  CONTENT_TYPE_JSON_HEADER,
  FetchLike,
  invalidRequest,
  sendOpenAiCompatibleRequest,
} from "./common.ts";
import { estimateTokens } from "../provider_helpers.ts";
import {
  buildTurnText,
  CodexAppServerSession,
  CodexChannelFactory,
  createCodexAppServerSession,
  defaultCodexChannelFactory,
  isStdioBaseUrl,
  isWebSocketBaseUrl,
} from "./codex_app_server_client.ts";

interface CodexSessionPool {
  get(baseUrl: string): Promise<CodexAppServerSession>;
  drop(baseUrl: string): Promise<void>;
}

export function createCodexAppServerProviderOps(
  fetchLike: FetchLike = fetch,
  channelFactory: CodexChannelFactory = defaultCodexChannelFactory,
): ProviderOps {
  const sessionPool = createCodexSessionPool(channelFactory);

  const send = async (
    provider: ProviderDescriptor,
    request: ProviderRequest,
  ): Promise<ProviderResult<ProviderResponse>> => {
    if (!request.messages || request.messages.length === 0) {
      return invalidRequest("messages_required");
    }

    const model = request.model || provider.model;
    const baseUrl = provider.baseUrl.trim();

    // Native app-server transports speak JSON-RPC 2.0 (not OpenAI REST) and use
    // the Codex CLI's own auth, so no apiKey is required here.
    if (isWebSocketBaseUrl(baseUrl) || isStdioBaseUrl(baseUrl)) {
      return await sendViaAppServer(sessionPool, provider, request, model);
    }

    // Allow pointing at an OpenAI-compatible REST shim over http(s).
    if (
      baseUrl.toLowerCase().startsWith("http://") || baseUrl.toLowerCase().startsWith("https://")
    ) {
      return await sendOpenAiCompatibleRequest({
        fetchLike,
        provider,
        request,
        model,
        headers: {
          ...CONTENT_TYPE_JSON_HEADER,
          ...(provider.apiKey.trim() ? { authorization: `Bearer ${provider.apiKey}` } : {}),
        },
      });
    }

    return invalidRequest("invalid_provider_base_url");
  };

  return {
    send,
    async sendStream(provider, request, onStream) {
      if (!request.messages || request.messages.length === 0) {
        return invalidRequest("messages_required");
      }

      const model = request.model || provider.model;
      const baseUrl = provider.baseUrl.trim();

      if (isWebSocketBaseUrl(baseUrl) || isStdioBaseUrl(baseUrl)) {
        return await sendViaAppServer(sessionPool, provider, request, model, onStream);
      }

      // Non-native transports remain buffered through send() for now.
      return await send(provider, request);
    },
  };
}

function createCodexSessionPool(channelFactory: CodexChannelFactory): CodexSessionPool {
  const sessions = new Map<string, Promise<CodexAppServerSession>>();

  const get = async (baseUrl: string): Promise<CodexAppServerSession> => {
    const key = baseUrl.trim();
    const existing = sessions.get(key);
    if (existing) {
      try {
        const session = await existing;
        if (!session.isClosed()) {
          return session;
        }
      } catch {
        // Fall through and recreate.
      }
      sessions.delete(key);
    }

    let createdPromise: Promise<CodexAppServerSession>;
    createdPromise = createCodexAppServerSession(key, channelFactory).catch((error) => {
      if (sessions.get(key) === createdPromise) {
        sessions.delete(key);
      }
      throw error;
    });

    sessions.set(key, createdPromise);
    return await createdPromise;
  };

  const drop = async (baseUrl: string): Promise<void> => {
    const key = baseUrl.trim();
    const existing = sessions.get(key);
    sessions.delete(key);
    if (!existing) {
      return;
    }

    const session = await existing.catch(() => null);
    if (session) {
      await session.close().catch(() => {});
    }
  };

  return { get, drop };
}

async function sendViaAppServer(
  sessionPool: CodexSessionPool,
  provider: ProviderDescriptor,
  request: ProviderRequest,
  model: string,
  onStream?: ProviderStreamCallback,
): Promise<ProviderResult<ProviderResponse>> {
  const baseUrl = provider.baseUrl.trim();
  let session: CodexAppServerSession;
  try {
    session = await sessionPool.get(baseUrl);
  } catch (error) {
    return errorResult(
      "network",
      error instanceof Error ? error.message : "codex_app_server_connect_failed",
    );
  }

  const outcome = await session.runTurn(request, model, undefined, onStream);
  if ("error" in outcome) {
    if (outcome.error.kind === "network" || session.isClosed()) {
      await sessionPool.drop(baseUrl);
    }
    return errorResult(outcome.error.kind, outcome.error.message, outcome.error.statusCode);
  }

  return okResult({
    providerKind: provider.kind,
    model,
    content: outcome.content,
    finishReason: outcome.finishReason,
    inputTokens: estimateTokens(buildTurnText(request)),
    outputTokens: estimateTokens(outcome.content),
    latencyMs: 0,
  });
}

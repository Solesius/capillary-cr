// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { errorResult, ProviderOps } from "../provider_core.ts";
import {
  authMissing,
  buildGithubModelsBody,
  buildOpenAiCompatibleBody,
  CONTENT_TYPE_JSON_HEADER,
  createBufferedProviderOps,
  endpoint,
  FetchLike,
  GITHUB_ACCEPT_HEADER,
  GITHUB_API_VERSION_HEADER,
  GITHUB_MODELS_INFERENCE_CHAT_COMPLETIONS_PATH,
  invalidRequest,
  OPENAI_CHAT_COMPLETIONS_PATH,
  parseOpenAiCompatibleResponse,
  postJson,
  toResponse,
} from "./common.ts";

const COPILOT_TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_TOKEN_EXCHANGE_CACHE_TTL_MS = 45 * 60 * 1000;
const COPILOT_API_BASE_URL = "https://api.githubcopilot.com";
const COPILOT_TOKEN_EXCHANGE_API_VERSION = "2025-04-01";

const githubToCopilotTokenCache = new Map<string, { token: string; expiresAtMs: number }>();

interface CopilotTokenExchangeDto {
  token?: string;
}

function normalizeCopilotApiModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed.includes("/")) {
    return trimmed;
  }

  const tail = trimmed.split("/").pop() || trimmed;
  return tail.trim() || trimmed;
}

function shouldAttemptCopilotTokenExchange(token: string): boolean {
  const normalized = token.trim();
  return normalized.startsWith("gho_") ||
    normalized.startsWith("ghu_") ||
    normalized.startsWith("ghp_") ||
    normalized.startsWith("ghs_") ||
    normalized.startsWith("github_pat_");
}

async function exchangeGithubTokenForCopilotToken(
  fetchLike: FetchLike,
  githubToken: string,
): Promise<string | null> {
  const source = githubToken.trim();
  if (!source || !shouldAttemptCopilotTokenExchange(source)) {
    return null;
  }

  const cached = githubToCopilotTokenCache.get(source);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.token;
  }

  try {
    const response = await fetchLike(COPILOT_TOKEN_EXCHANGE_URL, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `token ${source}`,
        "x-github-api-version": COPILOT_TOKEN_EXCHANGE_API_VERSION,
        "user-agent": "capillary",
        "editor-version": "capillary/0.1",
        "copilot-integration-id": "vscode-chat",
      },
    });

    const payload = await response.json().catch(() => null) as CopilotTokenExchangeDto | null;

    if (!response.ok) {
      return null;
    }

    const token = String(payload?.token || "").trim();
    if (!token) {
      return null;
    }

    githubToCopilotTokenCache.set(source, {
      token,
      expiresAtMs: Date.now() + COPILOT_TOKEN_EXCHANGE_CACHE_TTL_MS,
    });
    return token;
  } catch {
    return null;
  }
}

export function createCopilotProviderOps(fetchLike: FetchLike = fetch): ProviderOps {
  return createBufferedProviderOps(async (provider, request) => {
    if (!request.messages || request.messages.length === 0) {
      return invalidRequest("messages_required");
    }
    const baseApiKey = provider.apiKey.trim();
    if (!baseApiKey) {
      return authMissing("github_copilot");
    }

    const model = request.model || provider.model;
    const copilotApiModel = normalizeCopilotApiModel(model);
    const modelsUrl = endpoint(provider.baseUrl, GITHUB_MODELS_INFERENCE_CHAT_COMPLETIONS_PATH);
    const copilotUrl = endpoint(
      provider.baseUrl.includes("api.githubcopilot.com") ? provider.baseUrl : COPILOT_API_BASE_URL,
      OPENAI_CHAT_COMPLETIONS_PATH,
    );
    const useGithubModels = provider.baseUrl.includes("models.github.ai");

    const sendToGithubModels = (apiKey: string) =>
      postJson(fetchLike, modelsUrl, {
        ...CONTENT_TYPE_JSON_HEADER,
        accept: GITHUB_ACCEPT_HEADER,
        "x-github-api-version": GITHUB_API_VERSION_HEADER,
        authorization: `Bearer ${apiKey}`,
      }, buildGithubModelsBody(request, model, false));

    const sendToCopilotApi = (apiKey: string) =>
      postJson(fetchLike, copilotUrl, {
        ...CONTENT_TYPE_JSON_HEADER,
        accept: "application/json",
        "user-agent": "capillary",
        "editor-version": "capillary/0.1",
        "copilot-integration-id": "vscode-chat",
        "openai-intent": "conversation-panel",
        authorization: `Bearer ${apiKey}`,
      }, buildOpenAiCompatibleBody(request, copilotApiModel, false));

    let posted = useGithubModels
      ? await sendToGithubModels(baseApiKey)
      : await sendToCopilotApi(baseApiKey);
    if (!posted.ok && posted.error?.kind === "auth") {
      const exchanged = await exchangeGithubTokenForCopilotToken(fetchLike, baseApiKey);
      if (exchanged && exchanged !== baseApiKey) {
        posted = useGithubModels
          ? await sendToGithubModels(exchanged)
          : await sendToCopilotApi(exchanged);
      }
    }

    // GitHub Models can hit budget/rate limits for DAG review workloads.
    // If that happens, try Copilot API directly with exchanged token (IHHI-style path).
    if (!posted.ok && useGithubModels && posted.error?.kind === "rate_limit") {
      const exchanged = await exchangeGithubTokenForCopilotToken(fetchLike, baseApiKey);

      if (exchanged) {
        const exchangedPosted = await sendToCopilotApi(exchanged);
        if (exchangedPosted.ok) {
          posted = exchangedPosted;
        }
      }

      // Some device/OAuth tokens can call Copilot API directly even when exchange fails.
      if (!posted.ok) {
        const directPosted = await sendToCopilotApi(baseApiKey);
        if (directPosted.ok) {
          posted = directPosted;
        }
      }
    }

    if (!posted.ok) {
      const mapped = posted.error;
      return errorResult(
        mapped?.kind || "network",
        mapped?.message || "network_error",
        mapped?.statusCode,
      );
    }

    const parsed = parseOpenAiCompatibleResponse(posted.payload);
    if (!parsed) {
      return errorResult("server_error", "provider_response_invalid", 502);
    }

    return toResponse(
      provider,
      model,
      parsed.content,
      parsed.finishReason === "completed" || parsed.finishReason === "stop"
        ? "completed"
        : "failed",
      parsed.promptTokens,
      parsed.completionTokens,
    );
  });
}

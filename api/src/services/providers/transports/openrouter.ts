// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { ProviderOps } from "../provider_core.ts";
import {
  authMissing,
  CONTENT_TYPE_JSON_HEADER,
  createBufferedProviderOps,
  FetchLike,
  invalidRequest,
  sendOpenAiCompatibleRequest,
} from "./common.ts";

export function createOpenRouterProviderOps(fetchLike: FetchLike = fetch): ProviderOps {
  return createBufferedProviderOps(async (provider, request) => {
    if (!request.messages || request.messages.length === 0) {
      return invalidRequest("messages_required");
    }
    if (!provider.apiKey.trim()) {
      return authMissing("openrouter");
    }

    return await sendOpenAiCompatibleRequest({
      fetchLike,
      provider,
      request,
      headers: {
        ...CONTENT_TYPE_JSON_HEADER,
        authorization: `Bearer ${provider.apiKey}`,
      },
    });
  });
}

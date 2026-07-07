// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { InMemoryReviewRepository } from "../src/repositories/review_repository.ts";
import { CdpDriverService } from "../src/services/cdp_driver_service.ts";
import { CdpRetvAgentService } from "../src/services/cdp_retv_agent_service.ts";

function makeService(): { repo: InMemoryReviewRepository; service: CdpRetvAgentService } {
  const repo = new InMemoryReviewRepository();
  const driver = new CdpDriverService();
  const service = new CdpRetvAgentService(repo, driver, { kind: "anthropic" });
  return { repo, service };
}

/**
 * Run `fn` with the given environment overrides applied, restoring the prior
 * values afterward. `undefined` deletes the variable for the duration so a
 * stray key in the ambient environment cannot mask the behavior under test.
 */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const prior: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    prior[key] = Deno.env.get(key);
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

Deno.test("should_ignore_request_supplied_api_key_and_resolve_only_from_env", () => {
  withEnv({ ANTHROPIC_API_KEY: undefined, CAPILLARY_LLM_API_KEY: undefined }, () => {
    const { service } = makeService();

    // A request tries to inject a key inline; it must be ignored entirely because
    // credentials are sourced exclusively from the API server environment. The
    // cast simulates a raw JSON body carrying an extra, untyped `apiKey` field.
    const view = service.setPlannerConfig(
      { providerKind: "anthropic", apiKey: "sk-injected-by-request" } as unknown as Parameters<
        typeof service.setPlannerConfig
      >[0],
    );
    assertEquals(view.hasApiKey, false);
  });
});

Deno.test("should_load_api_key_from_provider_env_var", () => {
  withEnv({ ANTHROPIC_API_KEY: "sk-from-env", CAPILLARY_LLM_API_KEY: undefined }, () => {
    const { service } = makeService();

    const view = service.setPlannerConfig({ providerKind: "anthropic" });
    assertEquals(view.hasApiKey, true);
  });
});

Deno.test("should_pin_base_url_to_documented_default_for_cloud_providers", () => {
  withEnv({ ANTHROPIC_API_KEY: "sk-from-env", CAPILLARY_LLM_API_KEY: undefined }, () => {
    const { service } = makeService();

    // Even if a request tries to repoint a documented cloud provider, the base URL
    // stays pinned to its registry default so a key can never be steered elsewhere.
    const view = service.setPlannerConfig({
      providerKind: "anthropic",
      baseUrl: "https://evil.example.com",
    });
    assertEquals(view.baseUrl, "https://api.anthropic.com/v1");
  });
});

Deno.test("should_allow_base_url_override_only_for_local_provider", () => {
  withEnv({ CAPILLARY_LLM_API_KEY: undefined }, () => {
    const { service } = makeService();

    // The local/self-hosted provider is the only kind whose endpoint may be set
    // per request, since it points at an operator-run OpenAI-style server.
    const view = service.setPlannerConfig({
      providerKind: "openai_compatible",
      baseUrl: "http://localhost:1234/v1",
    });
    assertEquals(view.providerKind, "openai_compatible");
    assertEquals(view.baseUrl, "http://localhost:1234/v1");
  });
});

Deno.test("should_reject_cleartext_http_base_url_when_local_provider_carries_env_key", () => {
  withEnv({ CAPILLARY_LLM_API_KEY: "local-env-key" }, () => {
    const { service } = makeService();

    assertThrows(
      () =>
        service.setPlannerConfig({
          providerKind: "openai_compatible",
          baseUrl: "http://evil.example.com",
        }),
      Error,
      "planner_base_url_insecure",
    );
  });
});

Deno.test("should_allow_cleartext_http_to_loopback_for_local_models", () => {
  withEnv({ CAPILLARY_LLM_API_KEY: "local-env-key" }, () => {
    const { service } = makeService();

    const view = service.setPlannerConfig({
      providerKind: "openai_compatible",
      baseUrl: "http://localhost:1234/v1",
    });
    assertEquals(view.providerKind, "openai_compatible");
    assertEquals(view.hasApiKey, true);
  });
});

Deno.test("should_never_expose_the_raw_api_key_in_the_config_view", () => {
  withEnv({ ANTHROPIC_API_KEY: "sk-from-env", CAPILLARY_LLM_API_KEY: undefined }, () => {
    const { service } = makeService();

    service.setPlannerConfig({ providerKind: "anthropic" });

    const view = service.getPlannerConfig();
    assert(!("apiKey" in view));
    assertEquals(view.hasApiKey, true);
  });
});

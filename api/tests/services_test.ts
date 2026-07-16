// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { CelerReviewRepository } from "../src/repositories/review_repository.ts";
import { ArtifactService } from "../src/services/artifact_service.ts";
import { BuildOrchestrationService } from "../src/services/build_orchestration_service.ts";
import { ClickClackCoordinationService } from "../src/services/click_clack_coordination_service.ts";
import { DiffDagService } from "../src/services/diff_dag_service.ts";
import { GitHubOakService } from "../src/services/github_service.ts";
import { GraphMathService } from "../src/services/graph_math_service.ts";
import { LlmProviderService } from "../src/services/llm_provider_service.ts";
import { buildRetvLoop, runRetvLoop } from "../src/services/providers/retv_loop.ts";
import { buildRetvTcsrctSystemPrompt } from "../src/services/providers/retv_system_prompt.ts";
import {
  buildProviderFromKind,
  listProviderKinds,
  resolveProviderOps,
} from "../src/services/providers/provider_registry.ts";
import { createOpenRouterProviderOps } from "../src/services/providers/transports/mod.ts";
import { createCopilotProviderOps } from "../src/services/providers/transports/mod.ts";
import { createAnthropicProviderOps } from "../src/services/providers/transports/mod.ts";
import { createGeminiProviderOps } from "../src/services/providers/transports/mod.ts";
import { createBedrockProviderOps } from "../src/services/providers/transports/mod.ts";
import { createCodexAppServerProviderOps } from "../src/services/providers/transports/mod.ts";
import { createClaudeCodeProviderOps } from "../src/services/providers/transports/mod.ts";
import type {
  ClaudeCliInvocation,
  ClaudeCliProcess,
} from "../src/services/providers/transports/claude_code.ts";
import type { CodexRpcChannel } from "../src/services/providers/transports/codex_app_server_client.ts";
import { AgenticReviewService } from "../src/services/agentic_review_orchestrator_service.ts";
import { resolveChromeExecutablePath } from "../src/services/cdp_driver_service.ts";
import { TcsrctReviewService } from "../src/services/tcsrct_review_service.ts";

function createMockGitHubFetch(): typeof fetch {
  return (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

    if (url.endsWith("/user")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 38218017,
            login: "Solesius",
            name: "Khalil Warren",
            avatar_url: "https://avatars.githubusercontent.com/u/38218017?v=4",
          }),
          { status: 200 },
        ),
      );
    }

    if (url.includes("/user/repos")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: 1207713294,
              owner: { login: "Solesius" },
              name: "celer-mem",
              full_name: "Solesius/celer-mem",
              default_branch: "main",
              private: false,
              html_url: "https://github.com/Solesius/celer-mem",
              language: "C++",
              open_issues_count: 0,
            },
          ]),
          { status: 200 },
        ),
      );
    }

    // Direct lookup by numeric id — the catalog-miss fallback path.
    if (url.includes("/repositories/1207713294")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 1207713294,
            owner: { login: "Solesius" },
            name: "celer-mem",
            full_name: "Solesius/celer-mem",
            default_branch: "main",
            private: false,
            html_url: "https://github.com/Solesius/celer-mem",
            language: "C++",
            open_issues_count: 0,
          }),
          { status: 200 },
        ),
      );
    }

    if (url.includes("/repos/Solesius/celer-mem/pulls?")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              number: 8,
              title: "Amazon S3 backend and async streaming",
              user: { login: "Solesius" },
              head: { ref: "feat-async-s3" },
              base: { ref: "main" },
              state: "open",
              draft: false,
              html_url: "https://github.com/Solesius/celer-mem/pull/8",
              created_at: "2026-04-15T01:26:48Z",
              updated_at: "2026-04-15T11:12:53Z",
            },
          ]),
          { status: 200 },
        ),
      );
    }

    if (url.includes("/repos/Solesius/celer-mem/pulls/8/files")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              filename: "src/backend/s3.cpp",
              status: "modified",
              additions: 638,
              deletions: 0,
              patch:
                '@@ -1,5 +1,9 @@\n+#include "celer/core/async_stream.hpp"\n+#include "celer/core/scheduler.hpp"\n+\n+void init_s3_stream() {\n+  auto sched = Scheduler{};\n+  auto stream = AsyncStream{};\n+}\n',
            },
            {
              filename: "include/celer/core/async_stream.hpp",
              status: "added",
              additions: 477,
              deletions: 0,
              patch:
                "@@ -0,0 +1,8 @@\n+#pragma once\n+class AsyncStream {\n+public:\n+  void poll_next();\n+};\n+\n+class Scheduler;\n",
            },
          ]),
          { status: 200 },
        ),
      );
    }

    if (url.includes("/repos/Solesius/celer-mem/pulls/8")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            number: 8,
            title: "Amazon S3 backend and async streaming",
            user: { login: "Solesius" },
            head: { ref: "feat-async-s3" },
            base: { ref: "main" },
            state: "open",
            draft: false,
            html_url: "https://github.com/Solesius/celer-mem/pull/8",
            created_at: "2026-04-15T01:26:48Z",
            updated_at: "2026-04-15T11:12:53Z",
            additions: 5663,
            deletions: 27,
            changed_files: 28,
            merged_at: null,
          }),
          { status: 200 },
        ),
      );
    }

    return Promise.resolve(new Response(JSON.stringify({ message: "not_found" }), { status: 404 }));
  };
}

function buildFixture() {
  const repository = new CelerReviewRepository();
  const graphMath = new GraphMathService();
  // null embeddings: unit tests stay hermetic (no model download/inference).
  const diffDagService = new DiffDagService(repository, graphMath, null);
  const tcsrctService = new TcsrctReviewService(repository);
  const artifactService = new ArtifactService(repository);
  const clickClackService = new ClickClackCoordinationService(repository);
  const githubService = new GitHubOakService(repository, createMockGitHubFetch());
  const reviewService = new AgenticReviewService(
    repository,
    clickClackService,
    diffDagService,
    githubService,
    tcsrctService,
    artifactService,
  );

  return {
    repository,
    githubService,
    diffDagService,
    reviewService,
    artifactService,
    buildService: new BuildOrchestrationService(),
  };
}

function createMockGitHubOAuthDeviceFetch(): typeof fetch {
  let pollCount = 0;

  return (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

    if (url === "https://github.com/login/device/code") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: "dev_code_123",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            verification_uri_complete: "https://github.com/login/device?user_code=ABCD-EFGH",
            expires_in: 600,
            interval: 1,
          }),
          { status: 200 },
        ),
      );
    }

    if (url === "https://github.com/login/oauth/access_token") {
      pollCount += 1;
      if (pollCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: "authorization_pending",
              error_description: "waiting for user approval",
            }),
            { status: 200 },
          ),
        );
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "ghu_device_token",
            token_type: "bearer",
            scope: "repo read:org read:user",
          }),
          { status: 200 },
        ),
      );
    }

    if (url.endsWith("/user")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 38218017,
            login: "Solesius",
            name: "Khalil Warren",
            avatar_url: "https://avatars.githubusercontent.com/u/38218017?v=4",
          }),
          { status: 200 },
        ),
      );
    }

    return Promise.resolve(new Response(JSON.stringify({ message: "not_found" }), { status: 404 }));
  };
}

Deno.test("should_connect_github_when_oauth_state_is_valid", async () => {
  const { githubService } = buildFixture();
  const identity = await githubService.connectGithub("valid", "ghp_test_token");
  assertEquals(identity.connected, true);
});

Deno.test("should_start_device_oauth_when_secret_is_missing", async () => {
  const repository = new CelerReviewRepository();
  const githubService = new GitHubOakService(repository, createMockGitHubOAuthDeviceFetch());

  const previousClientId = Deno.env.get("GITHUB_OAUTH_CLIENT_ID");
  const previousClientSecret = Deno.env.get("GITHUB_OAUTH_CLIENT_SECRET");

  try {
    Deno.env.set("GITHUB_OAUTH_CLIENT_ID", "test-client-id");
    Deno.env.delete("GITHUB_OAUTH_CLIENT_SECRET");

    const start = await githubService.beginGithubOAuth(
      "http://localhost:8080",
      "http://localhost:4200",
    );
    assertEquals(start.mode, "device");
    if (start.mode !== "device") {
      throw new Error("expected device oauth mode");
    }
    assertEquals(start.sessionId.length > 0, true);
    assertEquals(start.userCode, "ABCD-EFGH");
  } finally {
    if (previousClientId === undefined) {
      Deno.env.delete("GITHUB_OAUTH_CLIENT_ID");
    } else {
      Deno.env.set("GITHUB_OAUTH_CLIENT_ID", previousClientId);
    }

    if (previousClientSecret === undefined) {
      Deno.env.delete("GITHUB_OAUTH_CLIENT_SECRET");
    } else {
      Deno.env.set("GITHUB_OAUTH_CLIENT_SECRET", previousClientSecret);
    }
  }
});

Deno.test("should_poll_device_oauth_session_until_connected", async () => {
  const repository = new CelerReviewRepository();
  const githubService = new GitHubOakService(repository, createMockGitHubOAuthDeviceFetch());

  const previousClientId = Deno.env.get("GITHUB_OAUTH_CLIENT_ID");
  const previousClientSecret = Deno.env.get("GITHUB_OAUTH_CLIENT_SECRET");

  try {
    Deno.env.set("GITHUB_OAUTH_CLIENT_ID", "test-client-id");
    Deno.env.delete("GITHUB_OAUTH_CLIENT_SECRET");

    const start = await githubService.beginGithubOAuth(
      "http://localhost:8080",
      "http://localhost:4200",
    );
    assertEquals(start.mode, "device");
    if (start.mode !== "device") {
      throw new Error("expected device oauth mode");
    }

    const pending = await githubService.pollGithubOAuthSession(start.sessionId);
    assertEquals(pending.status, "pending");

    const connected = await githubService.pollGithubOAuthSession(start.sessionId);
    assertEquals(connected.status, "connected");
    if (connected.status !== "connected") {
      throw new Error("expected connected oauth poll result");
    }
    assertEquals(connected.identity.connected, true);
    assertEquals(connected.identity.login, "Solesius");
  } finally {
    if (previousClientId === undefined) {
      Deno.env.delete("GITHUB_OAUTH_CLIENT_ID");
    } else {
      Deno.env.set("GITHUB_OAUTH_CLIENT_ID", previousClientId);
    }

    if (previousClientSecret === undefined) {
      Deno.env.delete("GITHUB_OAUTH_CLIENT_SECRET");
    } else {
      Deno.env.set("GITHUB_OAUTH_CLIENT_SECRET", previousClientSecret);
    }
  }
});

Deno.test("should_start_device_oauth_with_default_client_id_when_env_is_unset", async () => {
  const repository = new CelerReviewRepository();
  const githubService = new GitHubOakService(repository, createMockGitHubOAuthDeviceFetch());

  const previousClientId = Deno.env.get("GITHUB_OAUTH_CLIENT_ID");
  const previousClientSecret = Deno.env.get("GITHUB_OAUTH_CLIENT_SECRET");

  try {
    Deno.env.delete("GITHUB_OAUTH_CLIENT_ID");
    Deno.env.delete("GITHUB_OAUTH_CLIENT_SECRET");

    const start = await githubService.beginGithubOAuth(
      "http://localhost:8080",
      "http://localhost:4200",
    );
    assertEquals(start.mode, "device");
    if (start.mode !== "device") {
      throw new Error("expected device oauth mode");
    }
    assertEquals(start.sessionId.length > 0, true);
  } finally {
    if (previousClientId === undefined) {
      Deno.env.delete("GITHUB_OAUTH_CLIENT_ID");
    } else {
      Deno.env.set("GITHUB_OAUTH_CLIENT_ID", previousClientId);
    }

    if (previousClientSecret === undefined) {
      Deno.env.delete("GITHUB_OAUTH_CLIENT_SECRET");
    } else {
      Deno.env.set("GITHUB_OAUTH_CLIENT_SECRET", previousClientSecret);
    }
  }
});

Deno.test("should_reject_github_connection_when_oauth_state_is_invalid", async () => {
  const { githubService } = buildFixture();
  await assertRejects(() => githubService.connectGithub("invalid"));
});

Deno.test("should_reject_github_connection_when_token_is_missing", async () => {
  const { githubService } = buildFixture();
  const previousToken = Deno.env.get("GITHUB_TOKEN");
  try {
    Deno.env.delete("GITHUB_TOKEN");
    await assertRejects(() => githubService.connectGithub("valid"));
  } finally {
    if (previousToken === undefined) {
      Deno.env.delete("GITHUB_TOKEN");
    } else {
      Deno.env.set("GITHUB_TOKEN", previousToken);
    }
  }
});

Deno.test("should_floor_milestone_progress_with_clean_cycle_evidence", async () => {
  const { reconcileCompletedMilestones } = await import(
    "../src/services/cdp_retv_agent_service.ts"
  );
  const base = { allowAutoAdvance: true, totalMilestones: 4 };

  // Weak planner under-reports (says 2) while the cycle succeeded: evidence wins.
  assertEquals(
    reconcileCompletedMilestones({ ...base, plannerReported: 2, prior: 2, cycleSucceeded: true }),
    3,
  );
  // Planner ahead of the floor is trusted.
  assertEquals(
    reconcileCompletedMilestones({ ...base, plannerReported: 4, prior: 1, cycleSucceeded: true }),
    4,
  );
  // Failed cycle: no advance, and a low planner claim cannot regress progress.
  assertEquals(
    reconcileCompletedMilestones({ ...base, plannerReported: 1, prior: 3, cycleSucceeded: false }),
    3,
  );
  // Planner silent + clean cycle: auto-advance, capped at total.
  assertEquals(
    reconcileCompletedMilestones({
      ...base,
      plannerReported: undefined,
      prior: 4,
      cycleSucceeded: true,
    }),
    4,
  );
  // Unreachable planner disables auto-advance.
  assertEquals(
    reconcileCompletedMilestones({
      plannerReported: undefined,
      prior: 1,
      cycleSucceeded: true,
      allowAutoAdvance: false,
      totalMilestones: 4,
    }),
    1,
  );
});

Deno.test("should_treat_loopback_equivalent_hosts_as_one_origin_for_drift", async () => {
  const { canonicalOrigin, isDrift } = await import("../src/services/cdp_retv_agent_service.ts");

  // The loopback auto-rewrite moves the browser between these mid-run;
  // none of them is drift relative to the others.
  assertEquals(canonicalOrigin("http://host.docker.internal:7858/x"), "http://localhost:7858");
  assertEquals(canonicalOrigin("http://127.0.0.1:7858/"), "http://localhost:7858");

  const allowed = new Set([canonicalOrigin("http://localhost:7858")]);
  assertEquals(isDrift("http://host.docker.internal:7858/app", allowed), false);
  assertEquals(isDrift("http://127.0.0.1:7858/", allowed), false);
  assertEquals(isDrift("https://evil.example/", allowed), true);
  // Different port on the same host is still drift.
  assertEquals(isDrift("http://localhost:9999/", allowed), true);
});

Deno.test("should_let_env_bridge_url_supersede_persisted_stdio_base_url", () => {
  const previous = Deno.env.get("CLAUDE_CODE_URL");
  try {
    Deno.env.set("CLAUDE_CODE_URL", "ws://host.docker.internal:7898");
    // Simulates runtime config rehydrated from the durable store before the
    // ws bridge existed: the stale stdio default must not win over the env.
    const provider = buildProviderFromKind("claude_code", { baseUrl: "stdio://claude-code" });
    assertEquals(provider.baseUrl, "ws://host.docker.internal:7898");

    // An explicit non-default value still wins over the env override.
    const explicit = buildProviderFromKind("claude_code", { baseUrl: "ws://10.0.0.5:7898" });
    assertEquals(explicit.baseUrl, "ws://10.0.0.5:7898");
  } finally {
    if (previous === undefined) {
      Deno.env.delete("CLAUDE_CODE_URL");
    } else {
      Deno.env.set("CLAUDE_CODE_URL", previous);
    }
  }

  // Without the env override, the stdio default holds.
  const vanilla = buildProviderFromKind("claude_code", { baseUrl: "stdio://claude-code" });
  assertEquals(vanilla.baseUrl, "stdio://claude-code");
});

Deno.test("should_paginate_past_100_visible_repositories", async () => {
  const buildRepoDto = (id: number) => ({
    id,
    owner: { login: "acme-org" },
    name: `repo-${id}`,
    full_name: `acme-org/repo-${id}`,
    default_branch: "main",
    private: true,
    html_url: `https://github.com/acme-org/repo-${id}`,
    language: "TypeScript",
    open_issues_count: 0,
  });
  const paginatingFetch = ((input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    if (url.endsWith("/user")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 1,
            login: "acme-user",
            name: "Acme User",
            avatar_url: "https://example.com/a.png",
          }),
          { status: 200 },
        ),
      );
    }
    if (url.includes("/user/repos")) {
      const page = Number(new URL(url).searchParams.get("page") || "1");
      const batch = page === 1
        ? Array.from({ length: 100 }, (_, i) => buildRepoDto(i + 1))
        : page === 2
        ? [buildRepoDto(101), buildRepoDto(102)]
        : [];
      return Promise.resolve(new Response(JSON.stringify(batch), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;

  const repository = new CelerReviewRepository();
  const githubService = new GitHubOakService(repository, paginatingFetch);
  await githubService.connectGithub("valid", "ghp_test_token");

  const repositories = await githubService.listRepositories();
  assertEquals(repositories.length, 102);
  assertEquals(repositories.some((repo) => repo.name === "repo-102"), true);
});

Deno.test("should_list_repositories_when_identity_is_connected", async () => {
  const { githubService } = buildFixture();
  await githubService.connectGithub("valid", "ghp_test_token");
  const repositories = await githubService.listRepositories();
  assertEquals(repositories.length, 1);
});

Deno.test("should_reject_repository_list_when_identity_is_missing", async () => {
  const { githubService } = buildFixture();
  await assertRejects(() => githubService.listRepositories());
});

Deno.test("should_list_pull_requests_when_repository_access_is_valid", async () => {
  const { githubService } = buildFixture();
  await githubService.connectGithub("valid", "ghp_test_token");
  const pullRequests = await githubService.listPullRequests("1207713294");
  assertEquals(pullRequests.length, 1);
});

Deno.test("should_reject_pull_request_list_when_repository_id_is_invalid", async () => {
  const { githubService } = buildFixture();
  await githubService.connectGithub("valid", "ghp_test_token");
  await assertRejects(() => githubService.listPullRequests("../bad"));
});

Deno.test("should_build_diff_dag_when_pull_request_diff_is_available", async () => {
  const { githubService, diffDagService } = buildFixture();
  await githubService.connectGithub("valid", "ghp_test_token");
  await githubService.listRepositories();
  await githubService.listPullRequests("1207713294");
  await githubService.getPullRequestDiff("1207713294", "8");
  const dag = await diffDagService.buildDiffDag("8");
  assertEquals(dag.nodeCount > 0, true);
  assertEquals(dag.edgeCount > 0, true);
});

Deno.test("should_build_diff_dag_with_explicit_repository_when_pr_numbers_collide", async () => {
  const { repository, githubService, diffDagService } = buildFixture();
  await githubService.connectGithub("valid", "ghp_test_token");
  await githubService.listRepositories();
  await githubService.listPullRequests("1207713294");
  await githubService.getPullRequestDiff("1207713294", "8");

  // Simulate another repository containing the same pull request number without a saved diff.
  await repository.upsertPullRequest({
    id: "8",
    repositoryId: "999999",
    number: 8,
    title: "colliding pr number",
    author: "tester",
    sourceBranch: "feature",
    targetBranch: "main",
    state: "open",
    htmlUrl: "https://example.com/repo/pull/8",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    changedFileCount: 1,
    additions: 1,
    deletions: 0,
    riskHint: "low",
  });

  const dag = await diffDagService.buildDiffDag("8", "1207713294");
  assertEquals(dag.repositoryId, "1207713294");
  assertEquals(dag.nodeCount > 0, true);
});

Deno.test("should_expand_dependency_wetting_when_neighbors_exist", async () => {
  const { githubService, diffDagService } = buildFixture();
  await githubService.connectGithub("valid", "ghp_test_token");
  await githubService.listRepositories();
  await githubService.listPullRequests("1207713294");
  await githubService.getPullRequestDiff("1207713294", "8");
  const dag = await diffDagService.buildDiffDag("8");
  const wetted = await diffDagService.expandDependencyWetting(dag.id);
  assertEquals(wetted.saturation > 0, true);
});

Deno.test("should_compute_program_shape_when_diff_state_and_interop_exist", async () => {
  const { githubService, diffDagService } = buildFixture();
  await githubService.connectGithub("valid", "ghp_test_token");
  await githubService.listRepositories();
  await githubService.listPullRequests("1207713294");
  await githubService.getPullRequestDiff("1207713294", "8");
  const dag = await diffDagService.buildDiffDag("8");
  await diffDagService.expandDependencyWetting(dag.id);
  const samples = await diffDagService.computeProgramShape(dag.id);
  assertEquals(samples.length > 0, true);
});

Deno.test("should_run_modified_tcsrct_when_review_packet_is_valid", async () => {
  const { githubService, reviewService } = buildFixture();
  await githubService.connectGithub("valid", "ghp_test_token");
  await githubService.listRepositories();
  await githubService.listPullRequests("1207713294");
  const run = await reviewService.beginReview("8", "1207713294");
  assertEquals(run.status, "completed");
  assertEquals(run.findingCount > 0, true);
});

Deno.test("should_persist_review_agent_record_with_report_when_review_completes", async () => {
  const { repository, githubService, reviewService } = buildFixture();
  await githubService.connectGithub("valid", "ghp_test_token");
  await githubService.listRepositories();
  await githubService.listPullRequests("1207713294");

  const run = await reviewService.beginReview("8", "1207713294");
  const record = await reviewService.getReviewAgentRun(run.id);

  assert(record !== null);
  assertEquals(record.runId, run.id);
  assert(record.report.includes("# Code Review Report"));
  assert(["approve", "request_changes", "comment"].includes(record.verdict));
  assertEquals(record.findingCount, run.findingCount);

  // History exposes the run; untraced runs are not exportable.
  const history = await reviewService.listReviewAgentRuns();
  assertEquals(history.some((item) => item.runId === run.id), true);
  assertEquals(record.traceEnabled, false);
  assertEquals(await reviewService.buildReviewExport(run.id), null);
});

Deno.test("should_export_markdown_review_when_run_is_complete", async () => {
  const { githubService, reviewService, artifactService } = buildFixture();
  await githubService.connectGithub("valid", "ghp_test_token");
  await githubService.listRepositories();
  await githubService.listPullRequests("1207713294");
  const run = await reviewService.beginReview("8", "1207713294");
  const markdown = await artifactService.exportMarkdownReview(run.id);
  assertEquals(markdown.includes("# Capillary Review"), true);
  assertEquals(markdown.includes("## LLM Stage"), true);
  assertEquals(markdown.includes("## Findings (TCSRTC Gates)"), true);
  // Findings surface under TCSRTC gates, never internal analysis lenses.
  assertEquals(/### (Target|Constrain|Sanitize|Review|Test|Confirm) Gate/.test(markdown), true);
  assertEquals(/### (Trace|Contracts|State|Runtime|CodeShape|Tests) Pass/.test(markdown), false);
  assertEquals(/\([^\):]+:\d+\)/.test(markdown), true);
});

Deno.test("should_include_line_numbers_on_tcsrct_findings_when_patch_data_exists", async () => {
  const { repository, githubService, reviewService } = buildFixture();
  await githubService.connectGithub("valid", "ghp_test_token");
  await githubService.listRepositories();
  await githubService.listPullRequests("1207713294");

  const run = await reviewService.beginReview("8", "1207713294");
  const findings = await repository.getFindings(run.id);

  assertEquals(findings.length > 0, true);
  assertEquals(
    findings.some((finding) => typeof finding.line === "number" && finding.line > 0),
    true,
  );
});

Deno.test("should_fail_make_dev_when_deno_is_missing", () => {
  const { buildService } = buildFixture();
  assertThrows(() => buildService.makeDev(false, true));
});

Deno.test("should_auto_detect_chrome_before_using_chrome_path", async () => {
  const executable = await resolveChromeExecutablePath(
    (candidate) => Promise.resolve(candidate === "chromium"),
    "/custom/chrome",
  );

  assertEquals(executable, "chromium");
});

Deno.test("should_use_chrome_path_when_auto_detection_fails", async () => {
  const executable = await resolveChromeExecutablePath(
    (candidate) => Promise.resolve(candidate === "/custom/chrome"),
    "/custom/chrome",
  );

  assertEquals(executable, "/custom/chrome");
});

Deno.test("should_resolve_provider_ops_for_all_ihhi_provider_kinds", async () => {
  const kinds = listProviderKinds();
  assertEquals(kinds.length, 7);

  for (const kind of kinds) {
    const ops = resolveProviderOps(kind);
    const response = await ops.send(
      {
        kind,
        apiKey: "test-key",
        baseUrl: "https://example.invalid",
        model: "test-model",
      },
      {
        messages: [{ role: "user", content: "review this graph" }],
      },
    );

    if (response.ok) {
      assertEquals(response.value?.providerKind, kind);
      assertEquals(response.value?.content.includes("test-model"), true);
      continue;
    }

    assertEquals(["network", "auth", "invalid_request"].includes(response.error?.kind || ""), true);
  }
});

Deno.test("should_build_retv_tcsrct_prompt_with_graph_first_tdd_guards", () => {
  const prompt = buildRetvTcsrctSystemPrompt({
    runId: "run_test",
    pullRequestId: "8",
    graph: {
      nodeCount: 161,
      edgeCount: 437,
      changedNodeCount: 28,
      flowCompleteness: 0.89,
      torusVariance: 0.06,
      saturation: 1,
      completenessNotes: ["flow coverage is consistent across changed and neighbor nodes"],
    },
    passes: ["Trace", "Contracts", "State", "Runtime", "CodeShape", "Tests"],
  });

  assertEquals(prompt.includes("RetV = ReAct + Toolforming + Voyager"), true);
  assertEquals(prompt.includes("Reason -> Toolform -> Act -> Observe -> Update -> Decide"), true);
  assertEquals(prompt.includes("No production change without a failing test first"), true);
  assertEquals(prompt.includes("graph-first"), true);
});

Deno.test("should_generate_retv_evidence_when_reviewing_packet_with_model", async () => {
  const { repository, githubService, reviewService } = buildFixture();
  await githubService.connectGithub("valid", "ghp_test_token");
  await githubService.listRepositories();
  await githubService.listPullRequests("1207713294");
  const run = await reviewService.beginReview("8", "1207713294");
  const packetId = (await repository.getReviewRun(run.id)).packetId || "";

  const llm = new LlmProviderService(repository, {
    kind: "github_copilot",
    model: "gpt-5.3-codex",
  });
  const findings = await llm.reviewPacketWithModel(packetId);

  assertEquals(findings.length > 0, true);
  assertEquals(
    findings[0].evidence.some((line) =>
      line.includes("retv.loop=reason->toolform->act->observe->update->decide")
    ),
    true,
  );
  assertEquals(findings[0].evidence.some((line) => line.includes("tdd_gate=enabled")), true);
});

Deno.test("should_prefer_runtime_llm_config_when_reviewing_packet", async () => {
  const { repository, githubService, reviewService } = buildFixture();
  await githubService.connectGithub("valid", "ghp_test_token");
  await githubService.listRepositories();
  await githubService.listPullRequests("1207713294");
  const run = await reviewService.beginReview("8", "1207713294");
  const packetId = (await repository.getReviewRun(run.id)).packetId || "";

  await repository.setRuntimeLlmConfig({
    providerKind: "gemini",
    model: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "",
  });

  const llm = new LlmProviderService(repository, {
    kind: "github_copilot",
    model: "gpt-5.3-codex",
  });
  const findings = await llm.reviewPacketWithModel(packetId);

  assertEquals(findings.length > 0, true);
  assertEquals(findings[0].evidence.some((line) => line.includes("provider.kind=gemini")), true);
});

// Spawns a real `codex-app-server` subprocess over stdio; on hosts without the
// binary on PATH (e.g. CI runners) the spawn hangs and trips the subprocess
// leak sanitizer, so the test only runs where the binary exists.
const hasCodexAppServer = await (async () => {
  try {
    const probe = await new Deno.Command("which", { args: ["codex-app-server"] }).output();
    return probe.success;
  } catch {
    return false;
  }
})();

Deno.test({
  name: "should_route_codex_alias_runtime_config_through_review_flow",
  ignore: !hasCodexAppServer,
  fn: async () => {
    const { repository, githubService, reviewService } = buildFixture();
    await githubService.connectGithub("valid", "ghp_test_token");
    await githubService.listRepositories();
    await githubService.listPullRequests("1207713294");
    const run = await reviewService.beginReview("8", "1207713294");
    const packetId = (await repository.getReviewRun(run.id)).packetId || "";

    // A misspelled/alias provider kind must still resolve to the Codex
    // app-server provider in the review flow (and stale codex model ids are
    // normalized to the recommended default).
    await repository.setRuntimeLlmConfig({
      providerKind: "codefx",
      model: "gpt-5.3-codex",
      baseUrl: "stdio://codex-app-server",
      apiKey: "",
    });

    const llm = new LlmProviderService(repository, {
      kind: "github_copilot",
      model: "openai/gpt-4.1",
    });
    const findings = await llm.reviewPacketWithModel(packetId);

    assertEquals(findings.length > 0, true);
    assertEquals(
      findings[0].evidence.some((line) => line.includes("provider.kind=codex_app_server")),
      true,
    );
  },
});

Deno.test("should_build_retv_loop_from_top_risk_surfaces", async () => {
  const { repository, githubService, reviewService } = buildFixture();
  await githubService.connectGithub("valid", "ghp_test_token");
  await githubService.listRepositories();
  await githubService.listPullRequests("1207713294");
  const run = await reviewService.beginReview("8", "1207713294");
  const packetId = (await repository.getReviewRun(run.id)).packetId || "";
  const packet = await repository.getReviewPacket(packetId);

  const loop = buildRetvLoop(packet);
  assertEquals(loop.length > 0, true);
  assertEquals(loop[0].iterationId.startsWith("retv_"), true);
  assertEquals(["continue", "stop", "backtrack"].includes(loop[0].decision), true);
});

Deno.test("should_emit_well_formed_retv_phases_and_stop_reason", async () => {
  const { repository, githubService, reviewService } = buildFixture();
  await githubService.connectGithub("valid", "ghp_test_token");
  await githubService.listRepositories();
  await githubService.listPullRequests("1207713294");
  const run = await reviewService.beginReview("8", "1207713294");
  const packetId = (await repository.getReviewRun(run.id)).packetId || "";
  const packet = await repository.getReviewPacket(packetId);

  const result = runRetvLoop(packet, { maxIterations: 3 });
  assertEquals(result.iterations.length > 0, true);
  assertEquals(result.traces.length >= result.iterations.length * 6, true);
  assertEquals(
    result.stopReason.startsWith("stop_at_retv_") ||
      result.stopReason === "iteration_budget_exhausted",
    true,
  );
  assertEquals(
    ["risk_threshold_met", "iteration_budget_exhausted", "no_surfaces"].includes(
      result.stopCondition.kind,
    ),
    true,
  );
  assertEquals(
    result.iterations[0].phases.map((phase) => phase.phase).join(","),
    "reason,toolform,act,observe,update,decide",
  );
  assertEquals(result.iterations[0].toolPlan.length > 0, true);
  assertEquals(result.iterations[0].toolPlan[0].toolName.length > 0, true);
});

Deno.test("should_normalize_invalid_retv_policy_values", async () => {
  const { repository, githubService, reviewService } = buildFixture();
  await githubService.connectGithub("valid", "ghp_test_token");
  await githubService.listRepositories();
  await githubService.listPullRequests("1207713294");
  const run = await reviewService.beginReview("8", "1207713294");
  const packetId = (await repository.getReviewRun(run.id)).packetId || "";
  const packet = await repository.getReviewPacket(packetId);

  const result = runRetvLoop(packet, {
    maxIterations: 0,
    minEvidencePerIteration: 0,
    stopRiskThreshold: 9,
    requireGraphCompleteness: -4,
  });

  assertEquals(result.iterations.length > 0, true);
  assertEquals(result.iterations.every((iteration) => iteration.phases.length === 6), true);
});

Deno.test("should_emit_no_surfaces_stop_condition_when_packet_has_no_risk_surfaces", async () => {
  const { repository, githubService, reviewService } = buildFixture();
  await githubService.connectGithub("valid", "ghp_test_token");
  await githubService.listRepositories();
  await githubService.listPullRequests("1207713294");
  const run = await reviewService.beginReview("8", "1207713294");
  const packetId = (await repository.getReviewRun(run.id)).packetId || "";
  const packet = await repository.getReviewPacket(packetId);

  const result = runRetvLoop({
    ...packet,
    riskSurfaces: [],
  });

  assertEquals(result.iterations.length, 0);
  assertEquals(result.stopCondition.kind, "no_surfaces");
  assertEquals(result.stopReason, "no_surfaces");
});

Deno.test("should_shape_and_parse_openrouter_transport", async () => {
  let capturedBody = "";
  const ops = createOpenRouterProviderOps((_url, init) => {
    capturedBody = String(init?.body || "");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "openrouter ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
        { status: 200 },
      ),
    );
  });

  const result = await ops.send(
    {
      kind: "openrouter",
      apiKey: "or-test",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-sonnet-4",
    },
    {
      systemPrompt: "graph-first",
      messages: [{ role: "user", content: "review" }],
    },
  );

  assertEquals(result.ok, true);
  assertEquals(capturedBody.includes('"model"'), true);
  assertEquals(result.value?.content, "openrouter ok");
});

Deno.test("should_stream_openrouter_transport_with_buffered_events", async () => {
  const events: string[] = [];
  const chunks: string[] = [];

  const ops = createOpenRouterProviderOps(() => {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "openrouter stream" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
        { status: 200 },
      ),
    );
  });

  const result = await ops.sendStream(
    {
      kind: "openrouter",
      apiKey: "or-test",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-sonnet-4",
    },
    {
      messages: [{ role: "user", content: "review" }],
    },
    (event) => {
      events.push(event.kind);
      if (event.kind === "chunk") {
        chunks.push(event.text || "");
      }
    },
  );

  assertEquals(result.ok, true);
  assertEquals(events, ["chunk", "completed"]);
  assertEquals(chunks.join(""), "openrouter stream");
});

Deno.test("should_reject_openrouter_transport_when_base_url_protocol_is_invalid", async () => {
  let fetchCalls = 0;

  const ops = createOpenRouterProviderOps(() => {
    fetchCalls += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  const result = await ops.send(
    {
      kind: "openrouter",
      apiKey: "or-test",
      baseUrl: "ftp://openrouter.ai/api/v1",
      model: "anthropic/claude-sonnet-4",
    },
    {
      messages: [{ role: "user", content: "review" }],
    },
  );

  assertEquals(result.ok, false);
  assertEquals(result.error?.kind, "invalid_request");
  assertEquals(result.error?.message, "invalid_provider_base_url");
  assertEquals(fetchCalls, 0);
});

Deno.test("should_shape_and_parse_gemini_transport", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  const ops = createGeminiProviderOps((url, init) => {
    capturedUrl = String(url);
    capturedBody = String(init?.body || "");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                text:
                  '{"findings":[{"severity":"low","passName":"Runtime","filePath":"src/main.ts","title":"Test","finding":"Test finding","evidence":["e1"],"confidence":0.7}]}',
              }],
            },
            finishReason: "STOP",
          }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 11 },
        }),
        { status: 200 },
      ),
    );
  });

  const result = await ops.send(
    {
      kind: "gemini",
      apiKey: "gem-test",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-pro",
    },
    {
      systemPrompt: "Return JSON",
      messages: [{ role: "user", content: "review" }],
    },
  );

  assertEquals(result.ok, true);
  assertEquals(capturedUrl.includes("/models/gemini-2.5-pro:generateContent"), true);
  assertEquals(capturedUrl.includes("key=gem-test"), true);
  assertEquals(capturedBody.includes('"contents"'), true);
  assertEquals(capturedBody.includes('"systemInstruction"'), true);
  assertEquals(result.value?.content.includes('"findings"'), true);
});

Deno.test("should_shape_and_parse_bedrock_transport", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  let capturedAuth = "";

  const ops = createBedrockProviderOps((url, init) => {
    capturedUrl = String(url);
    capturedBody = String(init?.body || "");
    capturedAuth = String(
      (init?.headers as Record<string, string> | undefined)?.authorization || "",
    );

    return Promise.resolve(
      new Response(
        JSON.stringify({
          output: {
            message: {
              content: [{ text: "bedrock ok" }],
            },
          },
          stopReason: "end_turn",
          usage: { inputTokens: 17, outputTokens: 8 },
        }),
        { status: 200 },
      ),
    );
  });

  const result = await ops.send(
    {
      kind: "ihhi_bedrock",
      apiKey: "br-test",
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    },
    {
      systemPrompt: "graph-first",
      messages: [{ role: "user", content: "review" }],
    },
  );

  assertEquals(result.ok, true);
  assertEquals(
    capturedUrl.includes("/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse"),
    true,
  );
  assertEquals(capturedBody.includes('"messages"'), true);
  assertEquals(capturedAuth, "Bearer br-test");
  assertEquals(result.value?.content, "bedrock ok");
});

Deno.test("should_shape_and_parse_codex_transport_with_http_endpoint", async () => {
  let capturedUrl = "";
  let capturedBody = "";

  const ops = createCodexAppServerProviderOps((url, init) => {
    capturedUrl = String(url);
    capturedBody = String(init?.body || "");

    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "codex http ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 15, completion_tokens: 6 },
        }),
        { status: 200 },
      ),
    );
  });

  const result = await ops.send(
    {
      kind: "codex_app_server",
      apiKey: "cx-test",
      baseUrl: "http://localhost:1234/v1",
      model: "gpt-5.3-codex",
    },
    {
      messages: [{ role: "user", content: "review" }],
    },
  );

  assertEquals(result.ok, true);
  assertEquals(capturedUrl, "http://localhost:1234/v1/chat/completions");
  assertEquals(capturedBody.includes('"model":"gpt-5.3-codex"'), true);
  assertEquals(result.value?.content, "codex http ok");
});

Deno.test("should_reject_codex_http_transport_when_base_url_protocol_is_invalid", async () => {
  let fetchCalls = 0;

  const ops = createCodexAppServerProviderOps(() => {
    fetchCalls += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  const result = await ops.send(
    {
      kind: "codex_app_server",
      apiKey: "cx-test",
      baseUrl: "ftp://localhost:1234/v1",
      model: "gpt-5.3-codex",
    },
    {
      messages: [{ role: "user", content: "review" }],
    },
  );

  assertEquals(result.ok, false);
  assertEquals(result.error?.kind, "invalid_request");
  assertEquals(result.error?.message, "invalid_provider_base_url");
  assertEquals(fetchCalls, 0);
});

function createFakeCodexChannel(
  options: { failTurn?: boolean; turnError?: Record<string, unknown> } = {},
): CodexRpcChannel {
  let messageHandler: (message: unknown) => void = () => {};
  return {
    send(message: unknown) {
      const m = message as { id?: number; method?: string };
      queueMicrotask(() => {
        if (m.method === "initialize") {
          messageHandler({ id: m.id, result: {} });
        } else if (m.method === "thread/start") {
          messageHandler({ id: m.id, result: { thread: { id: "thread-1" } } });
        } else if (m.method === "turn/start") {
          messageHandler({ id: m.id, result: {} });
          if (options.failTurn) {
            messageHandler({
              method: "turn/completed",
              params: { turn: { status: "failed", error: options.turnError } },
            });
          } else {
            messageHandler({
              method: "item/agentMessage/delta",
              params: { delta: "codex " },
            });
            messageHandler({
              method: "item/completed",
              params: { item: { type: "agentMessage", text: "codex app-server ok" } },
            });
            messageHandler({
              method: "turn/completed",
              params: { turn: { status: "completed" } },
            });
          }
        }
      });
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    onClose() {},
    close() {},
  };
}

Deno.test("should_drive_codex_app_server_turn_over_stdio_channel", async () => {
  let capturedBaseUrl = "";

  const ops = createCodexAppServerProviderOps(undefined, (baseUrl) => {
    capturedBaseUrl = baseUrl;
    return Promise.resolve(createFakeCodexChannel());
  });

  const result = await ops.send(
    {
      kind: "codex_app_server",
      apiKey: "",
      baseUrl: "stdio://codex-app-server",
      model: "gpt-5.3-codex",
    },
    {
      messages: [{ role: "user", content: "review" }],
    },
  );

  assertEquals(result.ok, true);
  assertEquals(capturedBaseUrl, "stdio://codex-app-server");
  assertEquals(result.value?.content, "codex app-server ok");
  assertEquals(result.value?.finishReason, "completed");
});

function makeClaudeProcess(
  ndjsonLines: string[],
  opts: { success?: boolean; code?: number; stderr?: string } = {},
): ClaudeCliProcess {
  const encoder = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of ndjsonLines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
  return {
    stdout,
    status: Promise.resolve({ success: opts.success ?? true, code: opts.code ?? 0 }),
    stderr: () => Promise.resolve(opts.stderr ?? ""),
  };
}

Deno.test("should_stream_claude_code_text_deltas_and_parse_result", async () => {
  let captured: ClaudeCliInvocation | null = null;
  const ops = createClaudeCodeProviderOps((invocation) => {
    captured = invocation;
    return makeClaudeProcess([
      JSON.stringify({ type: "system", subtype: "init", apiKeySource: "none" }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: ", world" },
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Hello, world",
        usage: { input_tokens: 11, output_tokens: 3 },
      }),
    ]);
  });

  const chunks: string[] = [];
  let completed = false;
  const result = await ops.sendStream(
    { kind: "claude_code", apiKey: "", baseUrl: "stdio://claude-code", model: "sonnet" },
    { messages: [{ role: "user", content: "say hi" }], systemPrompt: "Be terse." },
    (event) => {
      if (event.kind === "chunk" && event.text) {
        chunks.push(event.text);
      }
      if (event.kind === "completed") {
        completed = true;
      }
    },
  );

  assertEquals(result.ok, true);
  assertEquals(result.value?.providerKind, "claude_code");
  assertEquals(result.value?.content, "Hello, world");
  assertEquals(result.value?.finishReason, "completed");
  assertEquals(result.value?.inputTokens, 11);
  assertEquals(result.value?.outputTokens, 3);
  assertEquals(chunks.join(""), "Hello, world");
  assertEquals(completed, true);

  // Drives the local CLI in print mode as a PURE TEXT MODEL: prompt via stdin,
  // the agent system prompt fully REPLACED (append leaked the Claude Code
  // identity + empty-scratch-cwd framing into review reports), all built-in
  // tools disabled, and OAuth-only auth (the API key env is stripped, never
  // sent).
  const invocation = captured as ClaudeCliInvocation | null;
  assertEquals(invocation?.args.includes("-p"), true);
  assertEquals(invocation?.args.includes("--output-format"), true);
  assertEquals(invocation?.args.includes("stream-json"), true);
  assertEquals(invocation?.args.includes("--system-prompt"), true);
  assertEquals(invocation?.args.includes("--append-system-prompt"), false);
  const toolsIndex = invocation?.args.indexOf("--tools") ?? -1;
  assertEquals(toolsIndex >= 0, true);
  assertEquals(invocation?.args[toolsIndex + 1], "");
  assertEquals(invocation?.args.includes("--model"), true);
  assertEquals(invocation?.stdin, "say hi");
  assertEquals(
    Object.prototype.hasOwnProperty.call(invocation?.env ?? {}, "ANTHROPIC_API_KEY"),
    false,
  );
});

Deno.test("should_map_claude_code_result_error_to_provider_error", async () => {
  const ops = createClaudeCodeProviderOps(() =>
    makeClaudeProcess([
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "out of credits / overage rejected",
      }),
    ])
  );

  const result = await ops.send(
    { kind: "claude_code", apiKey: "", baseUrl: "stdio://claude-code", model: "sonnet" },
    { messages: [{ role: "user", content: "go" }] },
  );

  assertEquals(result.ok, false);
  assertEquals(result.error?.kind, "rate_limit");
});

Deno.test("should_reject_non_cli_base_url_for_claude_code_without_spawning", async () => {
  let spawned = false;
  const ops = createClaudeCodeProviderOps(() => {
    spawned = true;
    return makeClaudeProcess([]);
  });

  const result = await ops.send(
    { kind: "claude_code", apiKey: "", baseUrl: "https://api.anthropic.com/v1", model: "sonnet" },
    { messages: [{ role: "user", content: "go" }] },
  );

  assertEquals(result.ok, false);
  assertEquals(result.error?.kind, "invalid_request");
  assertEquals(spawned, false);
});

Deno.test("should_request_low_reasoning_for_agent_context_and_full_reasoning_for_review", async () => {
  const capturedThreadStarts: Array<Record<string, unknown>> = [];

  const makeChannel = (): CodexRpcChannel => {
    let messageHandler: (message: unknown) => void = () => {};
    return {
      send(message: unknown) {
        const m = message as { id?: number; method?: string; params?: Record<string, unknown> };
        queueMicrotask(() => {
          if (m.method === "initialize") {
            messageHandler({ id: m.id, result: {} });
          } else if (m.method === "thread/start") {
            capturedThreadStarts.push(m.params || {});
            messageHandler({
              id: m.id,
              result: { thread: { id: `thread-${capturedThreadStarts.length}` } },
            });
          } else if (m.method === "turn/start") {
            messageHandler({ id: m.id, result: {} });
            messageHandler({ method: "item/agentMessage/delta", params: { delta: "ok" } });
            messageHandler({ method: "turn/completed", params: { turn: { status: "completed" } } });
          }
        });
      },
      onMessage(handler) {
        messageHandler = handler;
      },
      onClose() {},
      close() {},
    };
  };

  const ops = createCodexAppServerProviderOps(undefined, () => Promise.resolve(makeChannel()));
  const provider = {
    kind: "codex_app_server" as const,
    apiKey: "",
    baseUrl: "stdio://codex-app-server",
    model: "gpt-5.4-mini",
  };

  const agent = await ops.send(provider, {
    runContextId: "retv_cdp_abcd1234",
    messages: [{ role: "user", content: "plan" }],
  });
  const review = await ops.send(provider, {
    runContextId: "review:42:packet-1",
    messages: [{ role: "user", content: "review" }],
  });

  assertEquals(agent.ok, true);
  assertEquals(review.ok, true);
  assertEquals(capturedThreadStarts.length, 2);

  const agentConfig = capturedThreadStarts[0].config as
    | { model_reasoning_effort?: string }
    | undefined;
  assertEquals(agentConfig?.model_reasoning_effort, "low");

  // Review threads must keep full (server-default) reasoning: no override sent.
  assertEquals(capturedThreadStarts[1].config, undefined);
});

Deno.test("should_stream_codex_app_server_turn_deltas_over_send_stream", async () => {
  let messageHandler: (message: unknown) => void = () => {};

  const channel: CodexRpcChannel = {
    send(message: unknown) {
      const m = message as { id?: number; method?: string };
      queueMicrotask(() => {
        if (m.method === "initialize") {
          messageHandler({ id: m.id, result: {} });
        } else if (m.method === "thread/start") {
          messageHandler({ id: m.id, result: { thread: { id: "thread-stream" } } });
        } else if (m.method === "turn/start") {
          messageHandler({ id: m.id, result: {} });
          messageHandler({ method: "item/agentMessage/delta", params: { delta: "hello " } });
          messageHandler({ method: "item/agentMessage/delta", params: { delta: "world" } });
          messageHandler({ method: "turn/completed", params: { turn: { status: "completed" } } });
        }
      });
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    onClose() {},
    close() {},
  };

  const ops = createCodexAppServerProviderOps(undefined, () => Promise.resolve(channel));
  const streamed: string[] = [];
  let completedCount = 0;

  const result = await ops.sendStream(
    {
      kind: "codex_app_server",
      apiKey: "",
      baseUrl: "stdio://codex-app-server",
      model: "gpt-5.4-mini",
    },
    {
      runContextId: "retv_stream_run",
      messages: [{ role: "user", content: "stream this" }],
    },
    (event) => {
      if (event.kind === "chunk" && event.text) {
        streamed.push(event.text);
      }
      if (event.kind === "completed") {
        completedCount += 1;
      }
    },
  );

  assertEquals(result.ok, true);
  assertEquals(result.value?.content, "hello world");
  assertEquals(streamed.join(""), "hello world");
  assertEquals(completedCount, 1);
});

Deno.test("should_map_codex_app_server_failed_turn_to_error", async () => {
  const ops = createCodexAppServerProviderOps(
    undefined,
    () =>
      Promise.resolve(createFakeCodexChannel({
        failTurn: true,
        turnError: { message: "Unauthorized", codexErrorInfo: { httpStatusCode: 401 } },
      })),
  );

  const result = await ops.send(
    {
      kind: "codex_app_server",
      apiKey: "",
      baseUrl: "ws://127.0.0.1:1455",
      model: "gpt-5.3-codex",
    },
    {
      messages: [{ role: "user", content: "review" }],
    },
  );

  assertEquals(result.ok, false);
  assertEquals(result.error?.kind, "auth");
  assertEquals(result.error?.statusCode, 401);
});

Deno.test("should_reuse_codex_app_server_channel_across_multiple_turns", async () => {
  let messageHandler: (message: unknown) => void = () => {};
  let channelFactoryCalls = 0;
  let initializeCalls = 0;
  let threadStartCalls = 0;
  let turnStartCalls = 0;

  const sharedChannel: CodexRpcChannel = {
    send(message: unknown) {
      const m = message as { id?: number; method?: string };
      queueMicrotask(() => {
        if (m.method === "initialize") {
          initializeCalls += 1;
          messageHandler({ id: m.id, result: {} });
        } else if (m.method === "thread/start") {
          threadStartCalls += 1;
          messageHandler({ id: m.id, result: { thread: { id: `thread-${threadStartCalls}` } } });
        } else if (m.method === "turn/start") {
          turnStartCalls += 1;
          messageHandler({ id: m.id, result: {} });
          messageHandler({
            method: "item/agentMessage/delta",
            params: { delta: `turn-${turnStartCalls}` },
          });
          messageHandler({
            method: "turn/completed",
            params: { turn: { status: "completed" } },
          });
        }
      });
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    onClose() {},
    close() {},
  };

  const ops = createCodexAppServerProviderOps(undefined, () => {
    channelFactoryCalls += 1;
    return Promise.resolve(sharedChannel);
  });

  const provider = {
    kind: "codex_app_server" as const,
    apiKey: "",
    baseUrl: "stdio://codex-app-server",
    model: "gpt-5.4-mini",
  };

  const first = await ops.send(provider, {
    messages: [{ role: "user", content: "first" }],
  });
  const second = await ops.send(provider, {
    messages: [{ role: "user", content: "second" }],
  });

  assertEquals(first.ok, true);
  assertEquals(second.ok, true);
  assertEquals(channelFactoryCalls, 1);
  assertEquals(initializeCalls, 1);
  assertEquals(threadStartCalls, 1);
  assertEquals(turnStartCalls, 2);
});

Deno.test("should_create_distinct_codex_threads_for_distinct_run_contexts", async () => {
  let messageHandler: (message: unknown) => void = () => {};
  let threadStartCalls = 0;

  const sharedChannel: CodexRpcChannel = {
    send(message: unknown) {
      const m = message as { id?: number; method?: string };
      queueMicrotask(() => {
        if (m.method === "initialize") {
          messageHandler({ id: m.id, result: {} });
        } else if (m.method === "thread/start") {
          threadStartCalls += 1;
          messageHandler({
            id: m.id,
            result: { thread: { id: `ctx-thread-${threadStartCalls}` } },
          });
        } else if (m.method === "turn/start") {
          messageHandler({ id: m.id, result: {} });
          messageHandler({
            method: "item/agentMessage/delta",
            params: { delta: "ok" },
          });
          messageHandler({
            method: "turn/completed",
            params: { turn: { status: "completed" } },
          });
        }
      });
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    onClose() {},
    close() {},
  };

  const ops = createCodexAppServerProviderOps(undefined, () => Promise.resolve(sharedChannel));
  const provider = {
    kind: "codex_app_server" as const,
    apiKey: "",
    baseUrl: "stdio://codex-app-server",
    model: "gpt-5.4-mini",
  };

  const first = await ops.send(provider, {
    runContextId: "retv_run_a",
    messages: [{ role: "user", content: "first" }],
  });
  const second = await ops.send(provider, {
    runContextId: "retv_run_b",
    messages: [{ role: "user", content: "second" }],
  });

  assertEquals(first.ok, true);
  assertEquals(second.ok, true);
  assertEquals(threadStartCalls, 2);
});

Deno.test("should_shape_and_parse_copilot_transport", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  let capturedVersion = "";
  const ops = createCopilotProviderOps((url, init) => {
    capturedUrl = String(url);
    capturedBody = String(init?.body || "");
    capturedVersion = String(
      (init?.headers as Record<string, string> | undefined)?.["x-github-api-version"] || "",
    );
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "copilot ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 13, completion_tokens: 5 },
        }),
        { status: 200 },
      ),
    );
  });

  const result = await ops.send(
    {
      kind: "github_copilot",
      apiKey: "gh-test",
      baseUrl: "https://models.github.ai",
      model: "openai/gpt-4.1",
    },
    {
      messages: [{ role: "user", content: "review" }],
    },
  );

  assertEquals(result.ok, true);
  assertEquals(capturedUrl, "https://models.github.ai/inference/chat/completions");
  assertEquals(capturedVersion, "2026-03-10");
  assertEquals(capturedBody.includes('"model":"openai/gpt-4.1"'), true);
  assertEquals(capturedBody.includes('"max_tokens"'), false);
  assertEquals(result.value?.content, "copilot ok");
});

Deno.test("should_use_max_completion_tokens_for_gpt_5_models_on_copilot_transport", async () => {
  let capturedBody = "";
  const ops = createCopilotProviderOps((_url, init) => {
    capturedBody = String(init?.body || "");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "copilot ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
        { status: 200 },
      ),
    );
  });

  const result = await ops.send(
    {
      kind: "github_copilot",
      apiKey: "gh-test",
      baseUrl: "https://models.github.ai",
      model: "openai/gpt-5",
    },
    {
      messages: [{ role: "user", content: "review" }],
      maxOutputTokens: 42,
    },
  );

  assertEquals(result.ok, true);
  assertEquals(capturedBody.includes('"max_completion_tokens":42'), true);
  assertEquals(capturedBody.includes('"max_tokens":42'), false);
});

Deno.test("should_retry_copilot_transport_with_token_exchange_on_auth_error", async () => {
  let chatAttempts = 0;
  let exchangeAttempts = 0;

  const ops = createCopilotProviderOps((url, init) => {
    const target = String(url);
    if (target.includes("/copilot_internal/v2/token")) {
      exchangeAttempts += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ token: "copilot-exchanged-token" }), { status: 200 }),
      );
    }

    if (target.includes("/inference/chat/completions")) {
      chatAttempts += 1;
      const auth = String(
        (init?.headers as Record<string, string> | undefined)?.authorization || "",
      );
      if (auth === "Bearer gho_source_token") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              message: "Unauthorized",
            }),
            { status: 401 },
          ),
        );
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "copilot exchanged ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 9, completion_tokens: 4 },
          }),
          { status: 200 },
        ),
      );
    }

    return Promise.resolve(new Response(JSON.stringify({ message: "not_found" }), { status: 404 }));
  });

  const result = await ops.send(
    {
      kind: "github_copilot",
      apiKey: "gho_source_token",
      baseUrl: "https://models.github.ai",
      model: "openai/gpt-4.1",
    },
    {
      messages: [{ role: "user", content: "review graph" }],
    },
  );

  assertEquals(result.ok, true);
  assertEquals(result.value?.content, "copilot exchanged ok");
  assertEquals(exchangeAttempts, 1);
  assertEquals(chatAttempts, 2);
});

Deno.test("should_fallback_to_copilot_api_when_github_models_is_rate_limited", async () => {
  let exchangeAttempts = 0;
  let githubModelsAttempts = 0;
  let copilotApiAttempts = 0;

  const ops = createCopilotProviderOps((url, _init) => {
    const target = String(url);

    if (target.includes("/copilot_internal/v2/token")) {
      exchangeAttempts += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ token: "copilot-exchanged-token" }), { status: 200 }),
      );
    }

    if (target.includes("models.github.ai/inference/chat/completions")) {
      githubModelsAttempts += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            message: "GitHub Models budget exceeded",
          }),
          { status: 403 },
        ),
      );
    }

    if (target.includes("api.githubcopilot.com/chat/completions")) {
      copilotApiAttempts += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "copilot api fallback ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
          }),
          { status: 200 },
        ),
      );
    }

    return Promise.resolve(new Response(JSON.stringify({ message: "not_found" }), { status: 404 }));
  });

  const result = await ops.send(
    {
      kind: "github_copilot",
      apiKey: "gho_rate_limit_token",
      baseUrl: "https://models.github.ai",
      model: "openai/gpt-4.1",
    },
    {
      messages: [{ role: "user", content: "review graph" }],
    },
  );

  assertEquals(result.ok, true);
  assertEquals(result.value?.content, "copilot api fallback ok");
  assertEquals(githubModelsAttempts, 1);
  assertEquals(exchangeAttempts, 1);
  assertEquals(copilotApiAttempts, 1);
});

Deno.test("should_shape_and_parse_anthropic_transport", async () => {
  const ops = createAnthropicProviderOps(() => {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "anthropic ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 19, output_tokens: 9 },
        }),
        { status: 200 },
      ),
    );
  });

  const result = await ops.send(
    {
      kind: "anthropic",
      apiKey: "sk-ant-test",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-20250514",
    },
    {
      systemPrompt: "graph-first",
      messages: [{ role: "user", content: "review" }],
    },
  );

  assertEquals(result.ok, true);
  assertEquals(result.value?.content, "anthropic ok");
});

Deno.test("should_count_cached_prompt_tokens_in_claude_code_input_usage", async () => {
  // The claude CLI reports input_tokens as the UNCACHED slice only; the bulk
  // of capillary's repeated prompt lands in the cache fields. The transport
  // must sum all three — and must never fabricate input from the output text.
  const ops = createClaudeCodeProviderOps(() =>
    makeClaudeProcess([
      JSON.stringify({ type: "system", subtype: "init", apiKeySource: "none" }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ok",
        usage: {
          input_tokens: 42,
          cache_read_input_tokens: 18_000,
          cache_creation_input_tokens: 2_500,
          output_tokens: 350,
        },
      }),
    ])
  );

  const result = await ops.sendStream(
    { kind: "claude_code", apiKey: "", baseUrl: "stdio://claude-code", model: "sonnet" },
    { messages: [{ role: "user", content: "review" }], systemPrompt: "s" },
    () => {},
  );

  assertEquals(result.ok, true);
  assertEquals(result.value?.inputTokens, 42 + 18_000 + 2_500);
  assertEquals(result.value?.outputTokens, 350);
});

Deno.test("should_report_zero_input_not_output_estimate_when_claude_usage_is_absent", async () => {
  const ops = createClaudeCodeProviderOps(() =>
    makeClaudeProcess([
      JSON.stringify({ type: "system", subtype: "init", apiKeySource: "none" }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result:
          "a fairly long response body that would previously have been fed into estimateTokens and reported as INPUT, which is fiction",
      }),
    ])
  );

  const result = await ops.sendStream(
    { kind: "claude_code", apiKey: "", baseUrl: "stdio://claude-code", model: "sonnet" },
    { messages: [{ role: "user", content: "review" }], systemPrompt: "s" },
    () => {},
  );

  assertEquals(result.ok, true);
  // Honest zero: input is unknown, not derivable from the response text.
  assertEquals(result.value?.inputTokens, 0);
  // Output MAY be estimated from the response — that is the right direction.
  assertEquals((result.value?.outputTokens ?? 0) > 0, true);
});

// --- repository catalog performance contract --------------------------------
// 1000+ repo org accounts: the catalog is walked once (parallel waves), then
// answers list and by-id lookups without touching GitHub again; refresh=true
// is the only path that re-walks.

function createCountingGitHubFetch(): { fetcher: typeof fetch; repoPageCalls: () => number } {
  let repoPages = 0;
  const buildRepoDto = (id: number) => ({
    id,
    owner: { login: "acme" },
    name: `repo-${id}`,
    full_name: `acme/repo-${id}`,
    default_branch: "main",
    private: true,
    html_url: `https://github.com/acme/repo-${id}`,
    language: "TypeScript",
    open_issues_count: 0,
  });
  const fetcher = ((input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    if (url.endsWith("/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: 1, login: "acme", name: "Acme" }), { status: 200 }),
      );
    }
    if (url.includes("/user/repos")) {
      repoPages += 1;
      const page = Number(new URL(url).searchParams.get("page") || "1");
      const batch = page === 1
        ? Array.from({ length: 100 }, (_, i) => buildRepoDto(i + 1))
        : page === 2
        ? [buildRepoDto(101)]
        : [];
      return Promise.resolve(new Response(JSON.stringify(batch), { status: 200 }));
    }
    if (url.includes("/repos/acme/repo-5/pulls")) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;
  return { fetcher, repoPageCalls: () => repoPages };
}

Deno.test("should_serve_cached_catalog_without_rewalking_github", async () => {
  const { fetcher, repoPageCalls } = createCountingGitHubFetch();
  const repository = new CelerReviewRepository();
  const githubService = new GitHubOakService(repository, fetcher);
  await githubService.connectGithub("valid", "ghp_test_token");

  const first = await githubService.listRepositories();
  assertEquals(first.length, 101);
  const walkCost = repoPageCalls();
  assertEquals(walkCost >= 2, true);

  // Second list: catalog hit, zero GitHub page calls.
  const second = await githubService.listRepositories();
  assertEquals(second.length, 101);
  assertEquals(repoPageCalls(), walkCost);

  // refresh=true is the only re-walk path.
  await githubService.listRepositories(true);
  assertEquals(repoPageCalls() > walkCost, true);
});

Deno.test("should_resolve_repository_by_id_from_catalog_without_github", async () => {
  const { fetcher, repoPageCalls } = createCountingGitHubFetch();
  const repository = new CelerReviewRepository();
  const githubService = new GitHubOakService(repository, fetcher);
  await githubService.connectGithub("valid", "ghp_test_token");
  await githubService.listRepositories();
  const walkCost = repoPageCalls();

  // Selecting a repo (PR list) must not re-walk the repo pages — that made
  // every click cost as much as loading the entire catalog.
  const pulls = await githubService.listPullRequests(String(5));
  assertEquals(pulls.length, 0);
  assertEquals(repoPageCalls(), walkCost);
});

Deno.test("should_lookup_exact_repository_by_owner_name_and_upsert_catalog", async () => {
  let directHits = 0;
  const fetcher = ((input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    if (url.endsWith("/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: 1, login: "acme", name: "Acme" }), { status: 200 }),
      );
    }
    if (url.includes("/repos/big-org/exact-repo") && !url.includes("/pulls")) {
      directHits += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 6001,
            owner: { login: "big-org" },
            name: "exact-repo",
            full_name: "big-org/exact-repo",
            default_branch: "main",
            private: true,
            html_url: "https://github.com/big-org/exact-repo",
            language: "TypeScript",
            open_issues_count: 3,
          }),
          { status: 200 },
        ),
      );
    }
    if (url.includes("/repos/big-org/exact-repo/pulls")) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    if (url.includes("/user/repos")) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;

  const repository = new CelerReviewRepository();
  const githubService = new GitHubOakService(repository, fetcher);
  await githubService.connectGithub("valid", "ghp_test_token");

  const found = await githubService.lookupRepositories("big-org/exact-repo");
  assertEquals(found.length, 1);
  assertEquals(found[0].fullName, "big-org/exact-repo");
  assertEquals(directHits, 1);

  // The lookup upserted the catalog: id-based resolution works with no
  // further direct fetches and zero page walks.
  const pulls = await githubService.listPullRequests("6001");
  assertEquals(pulls.length, 0);
  assertEquals(directHits, 1);

  // Malformed segments never reach the URL path.
  assertEquals(await githubService.lookupRepositories("weird owner/na me"), []);
  assertEquals(await githubService.lookupRepositories("   "), []);
});

Deno.test("should_lookup_bare_name_via_search_api", async () => {
  const fetcher = ((input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    if (url.endsWith("/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: 1, login: "acme", name: "Acme" }), { status: 200 }),
      );
    }
    if (url.includes("/search/repositories")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [{
              id: 6002,
              owner: { login: "big-org" },
              name: "needle",
              full_name: "big-org/needle",
              default_branch: "main",
              private: false,
              html_url: "https://github.com/big-org/needle",
              language: "Go",
              open_issues_count: 0,
            }],
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;

  const repository = new CelerReviewRepository();
  const githubService = new GitHubOakService(repository, fetcher);
  await githubService.connectGithub("valid", "ghp_test_token");

  const found = await githubService.lookupRepositories("needle");
  assertEquals(found.length, 1);
  assertEquals(found[0].fullName, "big-org/needle");
});

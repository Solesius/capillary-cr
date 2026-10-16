// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
// Route-level tests for the code-host status routes (/api/sources,
// /api/gitlab/identity): a small Express app over the real route table, with a
// faked GitLab. Nothing touches the network.

import type { AddressInfo } from "node:net";
import express from "express";
import { assertEquals, test } from "./support/harness.ts";
import { AppError } from "../src/domain/errors.ts";
import type { GitHubIdentity } from "../src/domain/entities.ts";
import { createApp } from "../src/http/app.ts";
import { deps } from "../src/http/deps.ts";
import { errorMiddleware, sourceRoutes } from "../src/http/router.ts";
import { mount } from "../src/http/routing.ts";

async function serve(app: express.Express, fn: (base: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const GITLAB_USER: GitHubIdentity = { id: "9", login: "gl-khalil", connected: true };

function sourcesApp(opts: { github: GitHubIdentity | null; gitlabToken: boolean; gitlabOk: boolean }) {
  const app = express();
  app.use(mount(sourceRoutes({
    githubIdentity: () => Promise.resolve(opts.github),
    gitlab: {
      configured: () => opts.gitlabToken,
      getIdentity: () =>
        opts.gitlabToken && opts.gitlabOk
          ? Promise.resolve(GITLAB_USER)
          : Promise.reject(new AppError("gitlab_auth_failed", 401, "gitlab_auth_failed")),
    },
  })));
  app.use(errorMiddleware());
  return app;
}

test("should_report_both_hosts_when_github_and_gitlab_are_connected", async () => {
  const github = { id: "1", login: "Solesius", connected: true };
  await serve(sourcesApp({ github, gitlabToken: true, gitlabOk: true }), async (base) => {
    const res = await fetch(`${base}/api/sources`);
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      sources: [
        { source: "github", connected: true, login: "Solesius" },
        { source: "gitlab", configured: true, connected: true, login: "gl-khalil" },
      ],
    });
  });
});

test("should_report_gitlab_configured_but_disconnected_when_its_token_is_rejected", async () => {
  await serve(sourcesApp({ github: null, gitlabToken: true, gitlabOk: false }), async (base) => {
    const body = await (await fetch(`${base}/api/sources`)).json() as { sources: unknown[] };
    assertEquals(body.sources, [
      { source: "github", connected: false, login: null },
      { source: "gitlab", configured: true, connected: false, login: null },
    ]);
  });
});

test("should_surface_gitlab_identity_or_its_auth_error", async () => {
  await serve(sourcesApp({ github: null, gitlabToken: true, gitlabOk: true }), async (base) => {
    assertEquals(await (await fetch(`${base}/api/gitlab/identity`)).json(), GITLAB_USER);
  });
  await serve(sourcesApp({ github: null, gitlabToken: true, gitlabOk: false }), async (base) => {
    const res = await fetch(`${base}/api/gitlab/identity`);
    assertEquals(res.status, 401);
    assertEquals(((await res.json()) as { error: string }).error, "gitlab_auth_failed");
  });
});

test("should_reject_non_get_methods_on_source_routes", async () => {
  await serve(sourcesApp({ github: null, gitlabToken: false, gitlabOk: false }), async (base) => {
    const res = await fetch(`${base}/api/sources`, { method: "POST" });
    assertEquals(res.status, 405);
    await res.body?.cancel();
  });
});

test("should_verify_the_merge_request_webhook_token_at_the_route", async () => {
  const previous = process.env["GITLAB_WEBHOOK_SECRET"];
  process.env["GITLAB_WEBHOOK_SECRET"] = "hook-s3cret";
  const hook = (token: string | null, body: string) =>
    fetch(`${base}/api/gitlab/webhook`, {
      method: "POST",
      headers: { "x-gitlab-event": "Merge Request Hook", ...(token ? { "x-gitlab-token": token } : {}) },
      body,
    });
  let base = "";
  try {
    await serve(createApp({ allowedOrigins: [], requireGithubLogin: false, webDistRoot: null }), async (url) => {
      base = url;
      const missing = await hook(null, "{}");
      assertEquals(missing.status, 401);
      assertEquals(await missing.json(), { error: "invalid_webhook_token" });

      const wrong = await hook("nope", "{}");
      assertEquals(wrong.status, 401);
      await wrong.body?.cancel();

      // Valid token: acknowledged even for a payload it cannot use (GitLab
      // retries non-2xx), and nothing is queued for a malformed body.
      const malformed = await hook("hook-s3cret", "not json");
      assertEquals(malformed.status, 202);
      assertEquals(await malformed.json(), { received: true });
    });
  } finally {
    if (previous === undefined) delete process.env["GITLAB_WEBHOOK_SECRET"];
    else process.env["GITLAB_WEBHOOK_SECRET"] = previous;
  }
});

test("should_queue_a_review_only_for_an_opened_merge_request_with_a_valid_token", async () => {
  const previousSecret = process.env["GITLAB_WEBHOOK_SECRET"];
  const previousAuto = process.env["CAPILLARY_AUTO_REVIEW_ON_OPEN"];
  process.env["GITLAB_WEBHOOK_SECRET"] = "hook-s3cret";
  process.env["CAPILLARY_AUTO_REVIEW_ON_OPEN"] = "1";
  const started: unknown[] = [];
  const realStart = deps.reviewSessionHub.start;
  deps.reviewSessionHub.start = (async (request: unknown) => {
    started.push(request);
    return {} as never;
  }) as typeof realStart;
  const opened = JSON.stringify({
    object_kind: "merge_request",
    project: { id: 42 },
    object_attributes: { iid: 7, action: "open" },
  });
  const deliver = (event: string, body: string) =>
    fetch(`${base}/api/gitlab/webhook`, {
      method: "POST",
      headers: { "x-gitlab-event": event, "x-gitlab-token": "hook-s3cret" },
      body,
    });
  let base = "";
  try {
    await serve(createApp({ allowedOrigins: [], requireGithubLogin: false, webDistRoot: null }), async (url) => {
      base = url;
      const valid = await deliver("Merge Request Hook", opened);
      assertEquals(valid.status, 202);
      await valid.body?.cancel();
      assertEquals(started, [{ repositoryId: "gitlab-42", pullRequestId: "7" }]);

      const malformed = await deliver("Merge Request Hook", "not json");
      assertEquals(malformed.status, 202);
      await malformed.body?.cancel();

      const draft = await deliver(
        "Merge Request Hook",
        JSON.stringify({
          object_kind: "merge_request",
          project: { id: 42 },
          object_attributes: { iid: 8, action: "open", draft: true },
        }),
      );
      assertEquals(draft.status, 202);
      await draft.body?.cancel();

      const wrongEvent = await deliver("Push Hook", opened);
      assertEquals(wrongEvent.status, 202);
      await wrongEvent.body?.cancel();

      assertEquals(started.length, 1, "only the valid opened merge request queues a review");
    });
  } finally {
    deps.reviewSessionHub.start = realStart;
    if (previousSecret === undefined) delete process.env["GITLAB_WEBHOOK_SECRET"];
    else process.env["GITLAB_WEBHOOK_SECRET"] = previousSecret;
    if (previousAuto === undefined) delete process.env["CAPILLARY_AUTO_REVIEW_ON_OPEN"];
    else process.env["CAPILLARY_AUTO_REVIEW_ON_OPEN"] = previousAuto;
  }
});

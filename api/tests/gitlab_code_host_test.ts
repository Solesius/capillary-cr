// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
// GitLab as a full code host: routing by repository id, catalog persistence,
// posting (notes, diff discussions, suggestions, issues), compare, commit
// statuses, the MR webhook — and a complete review of a merge request through
// the real pipeline. Every GitLab call goes to an injected fake.

import { assert, assertEquals, assertRejects, test } from "./support/harness.ts";
import { AppError } from "../src/domain/errors.ts";
import type { GitHubRepository } from "../src/domain/entities.ts";
import { CelerReviewRepository } from "../src/repositories/review_repository.ts";
import { AgenticReviewService } from "../src/services/agentic_review_orchestrator_service.ts";
import { ArtifactService } from "../src/services/artifact_service.ts";
import { ClickClackCoordinationService } from "../src/services/click_clack_coordination_service.ts";
import { type CodeHost, CodeHostRouter, sourceOf } from "../src/services/code_host.ts";
import { DiffDagService } from "../src/services/diff_dag_service.ts";
import { GitHubOakService } from "../src/services/github_service.ts";
import { diffLinePosition, GitLabService, suggestionBody } from "../src/services/gitlab_service.ts";
import { GraphMathService } from "../src/services/graph_math_service.ts";
import { TcsrctReviewService } from "../src/services/tcsrct_review_service.ts";
import {
  buildCommitStatus,
  CommitStatusPublisher,
  mergeRequestToReview,
  verifyGitlabWebhookToken,
} from "../src/services/team/gitlab.ts";
import type { ReviewFinishedEvent } from "../src/services/team/event_bus.ts";
import { TeamEventBus } from "../src/services/team/event_bus.ts";

// --- fake GitLab ---------------------------------------------------------------

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
}

type Handler = (call: Call) => Response | undefined;

function fakeGitLab(...handlers: Handler[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname.replace(/^\/api\/v4/, ""),
      search: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    for (const handle of handlers) {
      const response = handle(call);
      if (response) return Promise.resolve(response);
    }
    return Promise.resolve(new Response("", { status: 404 }));
  };
  return { fetch: fetcher as typeof fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PATCH = [
  "@@ -1,4 +1,5 @@",
  " import { retry } from './retry';",
  "-export const limit = 3;",
  "+export const limit = 5;",
  "+export const budget = limit * 2;",
  " export function run() {",
  "   return retry(limit);",
].join("\n");

const MR = {
  iid: 7,
  project_id: 42,
  title: "Raise the retry limit",
  state: "opened",
  draft: false,
  author: { username: "khalil" },
  source_branch: "feat/retry",
  target_branch: "main",
  sha: "bbbb2222",
  diff_refs: { base_sha: "aaaa1111", start_sha: "aaaa1111", head_sha: "bbbb2222" },
  web_url: "https://gitlab.example.com/group/app/-/merge_requests/7",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
  changes_count: "1",
};

const DIFFS = [{
  old_path: "src/config.ts",
  new_path: "src/config.ts",
  new_file: false,
  renamed_file: false,
  deleted_file: false,
  diff: PATCH,
}];

/** A GitLab project with one open MR, its diff, and file contents. */
const projectFixture: Handler = (call) => {
  if (call.method !== "GET") return undefined;
  if (call.path === "/projects/42/merge_requests/7") return json(MR);
  if (call.path === "/projects/42/merge_requests/7/diffs") return json(DIFFS);
  if (call.path === "/projects/42/merge_requests") return json([MR]);
  if (call.path.startsWith("/projects/42/repository/files/")) {
    return new Response("export const limit = 5;\nexport const budget = limit * 2;\n");
  }
  if (call.path === "/user") return json({ id: 9, username: "gl-khalil" });
  return undefined;
};

const gitlab = (fake: { fetch: typeof fetch }, catalog: CelerReviewRepository | null = null) =>
  new GitLabService({ token: "glpat-test", baseUrl: "https://gitlab.example.com" }, catalog, fake.fetch);

// --- routing ---------------------------------------------------------------------

function stubHost(label: string, repositories: GitHubRepository[] | Error): CodeHost {
  const calls: string[] = [];
  const host = new Proxy({} as Record<PropertyKey, unknown>, {
    // Own properties (e.g. a `configured` override) win over the recording stub.
    get: (target, name) => name in target ? target[name] : (...args: unknown[]) => {
      calls.push(`${label}.${String(name)}:${args[0]}`);
      if (name === "listRepositories" || name === "lookupRepositories") {
        return repositories instanceof Error ? Promise.reject(repositories) : Promise.resolve(repositories);
      }
      return Promise.resolve(label);
    },
  }) as unknown as CodeHost & { calls?: string[] };
  return Object.assign(host, { calls });
}

const repo = (id: string): GitHubRepository => ({
  id,
  owner: "o",
  name: id,
  fullName: `o/${id}`,
  defaultBranch: "main",
  privateRepo: false,
  htmlUrl: "",
  openPullRequestCount: 0,
});

test("should_route_each_call_to_the_host_its_repository_id_names", async () => {
  const github = stubHost("github", []);
  const gl = Object.assign(stubHost("gitlab", []), { configured: () => true });
  const router = new CodeHostRouter(github, gl);

  assertEquals(await router.getPullRequestDiff("1207713294", "8"), "github");
  assertEquals(await router.getPullRequestDiff("gitlab-42", "7"), "gitlab");
  assertEquals(await router.postPullRequestComment("gitlab-42", "7", "hi"), "gitlab");
  assertEquals(await router.compareCommits("1207713294", "a".repeat(7), "b".repeat(7)), "github");
  assertEquals(sourceOf("gitlab-42"), "gitlab");
  assertEquals(sourceOf("1207713294"), "github");
});

test("should_merge_catalogs_and_keep_one_host_when_the_other_fails", async () => {
  const both = new CodeHostRouter(
    stubHost("github", [repo("1")]),
    Object.assign(stubHost("gitlab", [repo("gitlab-2")]), { configured: () => true }),
  );
  assertEquals((await both.listRepositories()).map((r) => r.id), ["1", "gitlab-2"]);

  const gitlabOnly = new CodeHostRouter(
    stubHost("github", new AppError("unauthorized", 401, "github_login_required")),
    Object.assign(stubHost("gitlab", [repo("gitlab-2")]), { configured: () => true }),
  );
  assertEquals((await gitlabOnly.listRepositories()).map((r) => r.id), ["gitlab-2"]);

  const neither = new CodeHostRouter(
    stubHost("github", new AppError("unauthorized", 401, "github_login_required")),
    Object.assign(stubHost("gitlab", []), { configured: () => false }),
  );
  const error = await assertRejects(() => neither.listRepositories(), AppError);
  assertEquals(error.code, "github_login_required");
});

test("should_refuse_gitlab_ids_when_gitlab_is_not_configured", async () => {
  const router = new CodeHostRouter(stubHost("github", []), Object.assign(stubHost("gitlab", []), { configured: () => false }));
  // A rejection, never a synchronous throw: .catch() alone must handle it.
  const caught = await router.getPullRequest("gitlab-42", "7").catch((error: AppError) => error.code);
  assertEquals(caught, "gitlab_not_configured");
  const error = await assertRejects(() => router.getPullRequest("gitlab-42", "7"), AppError);
  assertEquals(error.code, "gitlab_not_configured");
  assertEquals(error.status, 409);
});

// --- catalog persistence -----------------------------------------------------------

test("should_store_merge_requests_and_diffs_where_the_pipeline_reads_them", async () => {
  const catalog = new CelerReviewRepository();
  const service = gitlab(fakeGitLab(projectFixture), catalog);

  const pulls = await service.listPullRequests("gitlab-42");
  assertEquals(pulls.map((p) => [p.id, p.repositoryId]), [["7", "gitlab-42"]]);

  await service.getPullRequestDiff("gitlab-42", "7");
  const stored = await catalog.getPullRequest("gitlab-42", "7");
  assertEquals([stored.additions, stored.deletions, stored.changedFileCount], [2, 1, 1]);
  assertEquals(stored.riskHint, "low");
  assertEquals((await catalog.getPullRequestDiff("gitlab-42", "7"))[0].path, "src/config.ts");
  assertEquals(await catalog.findPullRequestRepositoryId("7"), "gitlab-42");
});

test("should_resolve_project_paths_and_search_for_lookups", async () => {
  const project = { id: 42, name: "app", path_with_namespace: "group/sub/app", web_url: "https://g/app" };
  const fake = fakeGitLab((call) =>
    call.path === `/projects/${encodeURIComponent("group/sub/app")}`
      ? json(project)
      : call.path === "/projects" && call.search.get("search") === "app"
      ? json([project])
      : undefined
  );
  const service = gitlab(fake);
  assertEquals((await service.lookupRepositories("group/sub/app")).map((r) => r.id), ["gitlab-42"]);
  assertEquals((await service.lookupRepositories("app")).map((r) => r.fullName), ["group/sub/app"]);
  assertEquals(await service.lookupRepositories("missing/project"), []);
});

test("should_surface_auth_and_validation_errors_from_lookups", async () => {
  const denied = gitlab(fakeGitLab(() => new Response("", { status: 401 })));
  const auth = await assertRejects(() => denied.lookupRepositories("group/app"), AppError);
  assertEquals(auth.code, "gitlab_auth_failed");
  const searchAuth = await assertRejects(() => denied.lookupRepositories("app"), AppError);
  assertEquals(searchAuth.code, "gitlab_auth_failed");
  await assertRejects(() => gitlab(fakeGitLab()).lookupRepositories("group/../app"), AppError);
});

// --- posting -------------------------------------------------------------------------

test("should_post_a_summary_note_and_link_to_it", async () => {
  const fake = fakeGitLab(
    (call) => call.method === "POST" && call.path === "/projects/42/merge_requests/7/notes" ? json({ id: 555 }, 201) : undefined,
    projectFixture,
  );
  const result = await gitlab(fake).postPullRequestComment("gitlab-42", "7", "## Capillary review");
  assertEquals(result.htmlUrl, `${MR.web_url}#note_555`);
  assertEquals(fake.calls.find((c) => c.method === "POST")?.body, { body: "## Capillary review" });
});

test("should_anchor_inline_findings_with_the_full_diff_position", async () => {
  const fake = fakeGitLab(
    (call) =>
      call.method === "POST" && call.path === "/projects/42/merge_requests/7/discussions"
        ? json({ notes: [{ id: 901 }] }, 201)
        : undefined,
    projectFixture,
  );
  const service = gitlab(fake);

  // Line 3 is an added line: new_line only.
  const added = await service.postPullRequestInlineComment("gitlab-42", "7", {
    path: "src/config.ts",
    line: 3,
    body: "Budget doubles the limit — intended?",
  });
  assertEquals(added.htmlUrl, `${MR.web_url}#note_901`);
  const first = fake.calls.filter((c) => c.method === "POST")[0].body as {
    body: string;
    position: Record<string, unknown>;
  };
  assertEquals(first.position, {
    position_type: "text",
    base_sha: "aaaa1111",
    start_sha: "aaaa1111",
    head_sha: "bbbb2222",
    old_path: "src/config.ts",
    new_path: "src/config.ts",
    new_line: 3,
  });
  assert(first.body.startsWith("Budget doubles the limit — intended?"));

  // Line 4 is unchanged context: GitLab needs old_line too.
  await service.postPullRequestInlineComment("gitlab-42", "7", { path: "src/config.ts", line: 4, body: "ctx" });
  const second = fake.calls.filter((c) => c.method === "POST")[1].body as { position: Record<string, unknown> };
  assertEquals([second.position.old_line, second.position.new_line], [3, 4]);
});

test("should_position_from_the_catalog_diff_without_rewalking_gitlab", async () => {
  const catalog = new CelerReviewRepository();
  const fake = fakeGitLab(
    (call) => call.method === "POST" && call.path.endsWith("/discussions") ? json({ notes: [{ id: 903 }] }, 201) : undefined,
    projectFixture,
  );
  const service = gitlab(fake, catalog);
  await service.getPullRequestDiff("gitlab-42", "7");
  const walksBefore = fake.calls.filter((c) => c.path.endsWith("/diffs")).length;

  for (const line of [2, 3, 4]) {
    await service.postPullRequestInlineComment("gitlab-42", "7", { path: "src/config.ts", line, body: `finding ${line}` });
  }

  assertEquals(fake.calls.filter((c) => c.path.endsWith("/diffs")).length, walksBefore);
  const positions = fake.calls.filter((c) => c.method === "POST").map((c) => (c.body as { position: Record<string, unknown> }).position);
  assertEquals(positions.map((p) => [p.old_line, p.new_line]), [[undefined, 2], [undefined, 3], [3, 4]]);
});

test("should_post_committable_suggestions_in_gitlab_syntax", async () => {
  const fake = fakeGitLab(
    (call) => call.method === "POST" && call.path.endsWith("/discussions") ? json({ notes: [{ id: 902 }] }, 201) : undefined,
    projectFixture,
  );
  await gitlab(fake).postPullRequestSuggestion("gitlab-42", "7", {
    path: "src/config.ts",
    startLine: 2,
    endLine: 3,
    code: "export const limit = 4;\nexport const budget = limit;\n",
    note: "Keep the budget equal to the limit.",
  });
  const posted = fake.calls.find((c) => c.method === "POST")?.body as { body: string; position: { new_line: number } };
  assertEquals(posted.position.new_line, 3);
  assert(posted.body.includes("```suggestion:-1+0\nexport const limit = 4;\nexport const budget = limit;\n```"));
  assertEquals(suggestionBody({ startLine: 5, endLine: 5, code: "x", note: "n" }).includes("```suggestion:-0+0\nx\n```"), true);
});

test("should_reject_non_finite_lines_before_calling_gitlab", async () => {
  const fake = fakeGitLab(projectFixture);
  const service = gitlab(fake);
  const comment = await assertRejects(
    () => service.postPullRequestInlineComment("gitlab-42", "7", { path: "src/config.ts", line: Number.NaN, body: "x" }),
    AppError,
  );
  assertEquals([comment.code, comment.status], ["invalid_line", 400]);
  const suggestion = await assertRejects(
    () =>
      service.postPullRequestSuggestion("gitlab-42", "7", {
        path: "src/config.ts",
        startLine: 1,
        endLine: Number.POSITIVE_INFINITY,
        code: "x",
        note: "n",
      }),
    AppError,
  );
  assertEquals(suggestion.code, "invalid_line");
  assertEquals(fake.calls.filter((c) => c.method === "POST").length, 0);
});

test("should_map_line_positions_through_hunks", () => {
  assertEquals(diffLinePosition(PATCH, 1), { old_line: 1, new_line: 1 });
  assertEquals(diffLinePosition(PATCH, 2), { new_line: 2 });
  assertEquals(diffLinePosition(PATCH, 5), { old_line: 4, new_line: 5 });
  assertEquals(diffLinePosition(PATCH, 99), { new_line: 99 });
  assertEquals(diffLinePosition(undefined, 3), { new_line: 3 });
  // A trailing newline must not invent a context line just past the hunk.
  // (The hunk's last new line is 5; line 6 used to match the trailing "".)
  assertEquals(diffLinePosition(`${PATCH}\n`, 6), { new_line: 6 });
  assertEquals(diffLinePosition(`${PATCH}\n`, 5), { old_line: 4, new_line: 5 });
});

test("should_create_issues_with_labels_and_best_effort_assignment", async () => {
  const fake = fakeGitLab((call) => {
    if (call.method === "POST" && call.path === "/projects/42/issues") {
      return json({ iid: 12, web_url: "https://gitlab.example.com/group/app/-/issues/12" }, 201);
    }
    if (call.path === "/users" && call.search.get("username") === "dev-bot") return json([{ id: 77 }]);
    if (call.method === "PUT" && call.path === "/projects/42/issues/12") return json({ iid: 12 });
    return undefined;
  });
  const issue = await gitlab(fake).createRepositoryIssue("gitlab-42", {
    title: "[capillary] Retry budget overflow",
    body: "Found by review.",
    labels: ["capillary", "bug"],
    assignees: ["dev-bot"],
  });
  assertEquals(issue, { htmlUrl: "https://gitlab.example.com/group/app/-/issues/12", number: 12, assigned: true });
  assertEquals(fake.calls[0].body, {
    title: "[capillary] Retry budget overflow",
    description: "Found by review.",
    labels: "capillary,bug",
  });
  assertEquals(fake.calls.at(-1)?.body, { assignee_ids: [77] });
});

test("should_keep_operation_codes_on_write_failures", async () => {
  const fake = fakeGitLab(
    (call) => call.method === "POST" ? new Response("{}", { status: 422 }) : undefined,
    projectFixture,
  );
  const error = await assertRejects(() => gitlab(fake).postPullRequestComment("gitlab-42", "7", "hi"), AppError);
  assertEquals([error.code, error.status], ["gitlab_comment_failed", 422]);
});

// --- compare + statuses ----------------------------------------------------------------

test("should_compare_commits_in_the_follow_up_review_vocabulary", async () => {
  const fake = fakeGitLab((call) =>
    call.path === "/projects/42/repository/compare"
      ? json({
        diffs: [
          { ...DIFFS[0] },
          { old_path: "b.ts", new_path: "b.ts", new_file: true, renamed_file: false, deleted_file: false, diff: "+x" },
          { old_path: "c.ts", new_path: "c.ts", new_file: false, renamed_file: false, deleted_file: true, diff: "-y" },
        ],
      })
      : undefined
  );
  const files = await gitlab(fake).compareCommits("gitlab-42", "aaaa1111", "bbbb2222");
  assertEquals(files.map((f) => [f.path, f.status]), [["src/config.ts", "modified"], ["b.ts", "added"], ["c.ts", "removed"]]);
  assertEquals([fake.calls[0].search.get("from"), fake.calls[0].search.get("to")], ["aaaa1111", "bbbb2222"]);
  const bad = await assertRejects(() => gitlab(fake).compareCommits("gitlab-42", "main", "bbbb2222"), AppError);
  assertEquals(bad.code, "invalid_commit_sha");
});

const finished = (over: Partial<ReviewFinishedEvent> = {}): ReviewFinishedEvent => ({
  type: "review.completed",
  at: "2026-10-16T00:00:00Z",
  runId: "run_1",
  pullRequestId: "7",
  repositoryId: "gitlab-42",
  title: "Raise the retry limit",
  verdict: "request_changes",
  goalAchieved: true,
  stopReason: "complete",
  findingCount: 2,
  blockerCount: 1,
  highCount: 0,
  cycleCount: 3,
  durationMs: 1000,
  topFindings: [],
  ...over,
});

test("should_map_verdicts_to_gitlab_commit_states", () => {
  assertEquals(buildCommitStatus(finished(), "https://cap/run_1"), {
    state: "failed",
    name: "Capillary review",
    description: "request changes — 2 findings (1 blocker, 0 high)",
    target_url: "https://cap/run_1",
  });
  assertEquals(buildCommitStatus(finished({ verdict: "comment" }), null).state, "success");
  assertEquals(buildCommitStatus(finished({ verdict: "approve" }), null).state, "success");
  assertEquals(buildCommitStatus(finished({ type: "review.cancelled" }), null).state, "canceled");
});

test("should_publish_statuses_for_gitlab_reviews_only", async () => {
  const posted: { repositoryId: string; sha: string; state: string }[] = [];
  const bus = new TeamEventBus();
  new CommitStatusPublisher({
    gitlab: {
      configured: () => true,
      setCommitStatus: (repositoryId, sha, status) => {
        posted.push({ repositoryId, sha, state: status.state });
        return Promise.resolve();
      },
    },
    headSha: () => Promise.resolve("bbbb2222"),
    deepLink: () => null,
  }).start(bus);

  bus.emit(finished());
  bus.emit(finished({ repositoryId: "1207713294" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(posted, [{ repositoryId: "gitlab-42", sha: "bbbb2222", state: "failed" }]);
});

test("should_post_commit_status_to_the_head_sha", async () => {
  const fake = fakeGitLab((call) => call.method === "POST" ? json({ id: 1 }, 201) : undefined);
  await gitlab(fake).setCommitStatus("gitlab-42", "bbbb2222", { state: "success", name: "Capillary review", description: "ok" });
  assertEquals(fake.calls[0].path, "/projects/42/statuses/bbbb2222");
  assertEquals(fake.calls[0].body, { state: "success", name: "Capillary review", description: "ok" });
});

// --- webhook -------------------------------------------------------------------------------

test("should_verify_the_gitlab_webhook_token_in_constant_time", () => {
  assertEquals(verifyGitlabWebhookToken("s3cret", "s3cret"), true);
  assertEquals(verifyGitlabWebhookToken("s3cret", "s3cre"), false);
  assertEquals(verifyGitlabWebhookToken("s3cret", null), false);
  assertEquals(verifyGitlabWebhookToken(undefined, "anything"), false);
});

test("should_queue_reviews_for_opened_and_ready_merge_requests_only", () => {
  const hook = (attributes: Record<string, unknown>, changes: Record<string, unknown> = {}) =>
    JSON.stringify({ object_kind: "merge_request", project: { id: 42 }, object_attributes: { iid: 7, ...attributes }, changes });

  assertEquals(mergeRequestToReview(hook({ action: "open" })), { repositoryId: "gitlab-42", pullRequestId: "7" });
  assertEquals(mergeRequestToReview(hook({ action: "reopen" }))?.pullRequestId, "7");
  assertEquals(
    mergeRequestToReview(hook({ action: "update" }, { draft: { previous: true, current: false } }))?.repositoryId,
    "gitlab-42",
  );
  assertEquals(mergeRequestToReview(hook({ action: "open", draft: true })), null);
  assertEquals(mergeRequestToReview(hook({ action: "update" })), null);
  assertEquals(mergeRequestToReview(hook({ action: "merge" })), null);
  assertEquals(mergeRequestToReview("not json"), null);
});

// --- the whole pipeline ----------------------------------------------------------------------

test("should_review_a_gitlab_merge_request_end_to_end", async () => {
  const repository = new CelerReviewRepository();
  const fake = fakeGitLab(projectFixture);
  const gitlabService = gitlab(fake, repository);
  // GitHub is never consulted for a gitlab- id; a fetch that throws proves it.
  const github = new GitHubOakService(repository, (() => Promise.reject(new Error("github must not be called"))) as typeof fetch);
  const reviewService = new AgenticReviewService(
    repository,
    new ClickClackCoordinationService(repository),
    new DiffDagService(repository, new GraphMathService(), null),
    new CodeHostRouter(github, gitlabService),
    new TcsrctReviewService(repository),
    new ArtifactService(repository),
  );

  const run = await reviewService.beginReview("7", "gitlab-42");

  assertEquals(run.status, "completed");
  const record = await reviewService.getReviewAgentRun(run.id);
  assert(record !== null);
  assertEquals(record.repositoryId, "gitlab-42");
  assert(record.report.includes("# Code Review Report"));
  assert(fake.calls.some((c) => c.path === "/projects/42/merge_requests/7/diffs"));
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
// Hermetic GitLab source tests: every request goes to an injected fake fetch.

import { assert, assertEquals, assertRejects, test } from "./support/harness.ts";
import { AppError } from "../src/domain/errors.ts";
import {
  countDiffLines,
  GitLabService,
  mergeRequestState,
  normalizeGitlabBaseUrl,
  toDiffFile,
} from "../src/services/gitlab_service.ts";

interface Recorded {
  url: URL;
  token: string | null;
  method: string;
  body: unknown;
}

/** Fake GitLab: `handle` answers each request; every call is recorded. */
function fakeGitLab(
  handle: (url: URL) => Response,
): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetcher = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      token: headers.get("PRIVATE-TOKEN"),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Promise.resolve(handle(url));
  };
  return { fetch: fetcher as typeof fetch, calls };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const MR_OPEN = {
  iid: 7,
  project_id: 42,
  title: "Add retry budget",
  state: "opened",
  draft: false,
  author: { username: "khalil" },
  source_branch: "feat/retry",
  target_branch: "main",
  sha: "aaa111",
  diff_refs: { head_sha: "bbb222" },
  web_url: "https://gitlab.example.com/group/app/-/merge_requests/7",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
  changes_count: "3",
};

test("should_map_identity_from_user_endpoint_with_private_token_header", async () => {
  const fake = fakeGitLab(() =>
    jsonResponse({ id: 9001, username: "khalil", name: "Khalil Warren", avatar_url: "https://img/a.png" })
  );
  const service = new GitLabService({ token: "glpat-test" }, null, fake.fetch);

  const identity = await service.getIdentity();

  assertEquals(identity, {
    id: "9001",
    login: "khalil",
    displayName: "Khalil Warren",
    avatarUrl: "https://img/a.png",
    connected: true,
  });
  assertEquals(fake.calls[0].url.toString(), "https://gitlab.com/api/v4/user");
  assertEquals(fake.calls[0].token, "glpat-test");
});

test("should_walk_every_project_page_until_next_page_header_is_empty", async () => {
  const project = (id: number) => ({
    id,
    name: `app-${id}`,
    path_with_namespace: `group/app-${id}`,
    namespace: { full_path: "group" },
    default_branch: "main",
    visibility: id === 2 ? "public" : "private",
    web_url: `https://gitlab.com/group/app-${id}`,
  });
  const fake = fakeGitLab((url) => {
    const page = url.searchParams.get("page");
    return page === "1"
      ? jsonResponse([project(1)], { "x-next-page": "2" })
      : jsonResponse([project(2)], { "x-next-page": "" });
  });
  const service = new GitLabService({ token: "glpat-test" }, null, fake.fetch);

  const repositories = await service.listRepositories();

  assertEquals(repositories.map((repo) => repo.id), ["gitlab-1", "gitlab-2"]);
  assertEquals(repositories[0].source, "gitlab");
  assertEquals(repositories[0].privateRepo, true);
  assertEquals(repositories[1].privateRepo, false);
  assertEquals(repositories[0].owner, "group");
  assertEquals(repositories[0].fullName, "group/app-1");
  assertEquals(repositories[0].openPullRequestCount, 0);
  assertEquals(fake.calls.length, 2);
  assertEquals(fake.calls[0].url.searchParams.get("membership"), "true");
  assertEquals(fake.calls[1].url.searchParams.get("page"), "2");
});

test("should_list_open_merge_requests_mapped_to_pull_request_shape", async () => {
  const merged = { ...MR_OPEN, iid: 8, state: "merged", draft: false, changes_count: "1000+" };
  const draft = { ...MR_OPEN, iid: 9, draft: true, changes_count: null, diff_refs: null, sha: null };
  const fake = fakeGitLab(() => jsonResponse([MR_OPEN, merged, draft]));
  const service = new GitLabService({ token: "glpat-test" }, null, fake.fetch);

  const pulls = await service.listPullRequests("gitlab-42", "open");

  assertEquals(fake.calls[0].url.pathname, "/api/v4/projects/42/merge_requests");
  assertEquals(fake.calls[0].url.searchParams.get("state"), "opened");
  assertEquals(pulls.map((pull) => pull.state), ["open", "merged", "draft"]);
  assertEquals(pulls[0], {
    id: "7",
    repositoryId: "gitlab-42",
    number: 7,
    title: "Add retry budget",
    author: "khalil",
    sourceBranch: "feat/retry",
    headSha: "bbb222",
    targetBranch: "main",
    state: "open",
    htmlUrl: "https://gitlab.example.com/group/app/-/merge_requests/7",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    changedFileCount: 3,
    additions: 0,
    deletions: 0,
    riskHint: "unknown",
  });
  assertEquals(pulls[1].changedFileCount, 1000);
  assertEquals(pulls[2].headSha, undefined);
});

test("should_request_closed_merge_requests_when_closed_filter_is_given", async () => {
  const fake = fakeGitLab(() => jsonResponse([]));
  const service = new GitLabService({ token: "glpat-test" }, null, fake.fetch);

  assertEquals(await service.listPullRequests("gitlab-42", "closed"), []);
  assertEquals(fake.calls[0].url.searchParams.get("state"), "closed");
});

test("should_map_merge_request_diff_files_with_status_and_line_counts", () => {
  assertEquals(countDiffLines("@@ -1,2 +1,2 @@\n context\n-old\n+new\n+more\n"), {
    additions: 2,
    deletions: 1,
  });

  const added = toDiffFile({
    old_path: "src/new.ts",
    new_path: "src/new.ts",
    new_file: true,
    renamed_file: false,
    deleted_file: false,
    diff: "@@ -0,0 +1 @@\n+export const x = 1;\n",
  });
  assertEquals(added.status, "added");
  assertEquals(added.additions, 1);
  assertEquals(added.previousPath, undefined);

  const renamed = toDiffFile({
    old_path: "lib/a.ts",
    new_path: "lib/b.ts",
    new_file: false,
    renamed_file: true,
    deleted_file: false,
    diff: "",
  });
  assertEquals(renamed.status, "renamed");
  assertEquals(renamed.previousPath, "lib/a.ts");
  assertEquals(renamed.patch, undefined);

  const removed = toDiffFile({
    old_path: "tests/old_test.ts",
    new_path: "tests/old_test.ts",
    new_file: false,
    renamed_file: false,
    deleted_file: true,
    generated_file: true,
    diff: "@@ -1 +0,0 @@\n-gone\n",
  });
  assertEquals(removed.status, "deleted");
  assertEquals(removed.deletions, 1);
  assertEquals(removed.isTest, true);
  assertEquals(removed.isGenerated, true);
});

test("should_walk_merge_request_diff_pages_into_diff_files", async () => {
  const file = (name: string) => ({
    old_path: name,
    new_path: name,
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    diff: "@@ -1 +1 @@\n-a\n+b\n",
  });
  const fake = fakeGitLab((url) =>
    url.searchParams.get("page") === "1"
      ? jsonResponse([file("src/a.ts")], { "x-next-page": "2" })
      : jsonResponse([file("src/b.ts")], { "x-next-page": "" })
  );
  const service = new GitLabService({ token: "glpat-test" }, null, fake.fetch);

  const files = await service.getPullRequestDiff("gitlab-42", "7");

  assertEquals(files.map((f) => f.path), ["src/a.ts", "src/b.ts"]);
  assertEquals(
    fake.calls[0].url.pathname,
    "/api/v4/projects/42/merge_requests/7/diffs",
  );
});

test("should_fall_back_to_merge_request_changes_on_gitlab_before_15_7", async () => {
  const change = { old_path: "src/a.ts", new_path: "src/a.ts", new_file: false, renamed_file: false, deleted_file: false, diff: "@@ -1 +1 @@\n-a\n+b\n" };
  // An older self-managed instance: no /diffs endpoint, /changes carries the files.
  const fake = fakeGitLab((url) =>
    url.pathname.endsWith("/diffs")
      ? jsonResponse({ error: "404 Not Found" }, {}, 404)
      : jsonResponse({ ...MR_OPEN, changes: [change] })
  );
  const service = new GitLabService({ token: "glpat-test" }, null, fake.fetch);

  const files = await service.getPullRequestDiff("gitlab-42", "7");

  assertEquals(files.map((f) => f.path), ["src/a.ts"]);
  assertEquals(fake.calls.map((c) => c.url.pathname), [
    "/api/v4/projects/42/merge_requests/7/diffs",
    "/api/v4/projects/42/merge_requests/7/changes",
  ]);
});

test("should_still_report_a_missing_merge_request_as_not_found", async () => {
  const fake = fakeGitLab(() => jsonResponse({ message: "404 Not found" }, {}, 404));
  const service = new GitLabService({ token: "glpat-test" }, null, fake.fetch);

  const error = await assertRejects(() => service.getPullRequestDiff("gitlab-42", "999"), AppError);

  assertEquals(error.code, "gitlab_not_found");
  assertEquals(error.message, "gitlab_not_found (GET /projects/42/merge_requests/999/changes returned 404)");
});

test("should_return_merge_request_detail_with_head_sha_from_diff_refs", async () => {
  const fake = fakeGitLab(() => jsonResponse(MR_OPEN));
  const service = new GitLabService({ token: "glpat-test" }, null, fake.fetch);

  const pull = await service.getPullRequest("gitlab-42", "7");

  assertEquals(pull.headSha, "bbb222");
  assertEquals(fake.calls[0].url.pathname, "/api/v4/projects/42/merge_requests/7");
});

test("should_read_raw_file_at_ref_and_return_null_when_missing", async () => {
  const fake = fakeGitLab((url) =>
    url.pathname.includes("missing.ts")
      ? new Response("{}", { status: 404 })
      : new Response("export const ok = true;\n", { status: 200 })
  );
  const service = new GitLabService({ token: "glpat-test" }, null, fake.fetch);

  assertEquals(await service.getRepoFileContent("gitlab-42", "main", "src/ok.ts"), "export const ok = true;\n");
  assertEquals(
    fake.calls[0].url.pathname,
    "/api/v4/projects/42/repository/files/src%2Fok.ts/raw",
  );
  assertEquals(fake.calls[0].url.searchParams.get("ref"), "main");
  assertEquals(await service.getRepoFileContent("gitlab-42", "main", "src/missing.ts"), null);
  assertEquals(await service.getRepoFileContent("gitlab-42", "main", "../etc/passwd"), null);
});

test("should_send_requests_to_self_hosted_base_url_with_path_prefix", async () => {
  const fake = fakeGitLab(() => jsonResponse({ id: 1, username: "ops" }));
  const service = new GitLabService(
    { baseUrl: "https://git.corp.example/gitlab/", token: "glpat-test" },
    null,
    fake.fetch,
  );

  await service.getIdentity();

  assertEquals(fake.calls[0].url.toString(), "https://git.corp.example/gitlab/api/v4/user");
});

test("should_normalize_base_url_and_reject_remote_plain_http", () => {
  assertEquals(normalizeGitlabBaseUrl(undefined), "https://gitlab.com");
  assertEquals(normalizeGitlabBaseUrl("  "), "https://gitlab.com");
  assertEquals(normalizeGitlabBaseUrl("https://git.example.com///"), "https://git.example.com");
  assertEquals(normalizeGitlabBaseUrl("http://localhost:8929"), "http://localhost:8929");
  assertEquals(normalizeGitlabBaseUrl("http://git.example.com"), null);
  assertEquals(normalizeGitlabBaseUrl("not a url"), null);
  // The API root is a common way to name the instance; requests add /api/v4 themselves.
  assertEquals(normalizeGitlabBaseUrl("https://gitlab.com/api/v4"), "https://gitlab.com");
  assertEquals(normalizeGitlabBaseUrl("https://git.corp.example/gitlab/api/v4/"), "https://git.corp.example/gitlab");
});

test("should_map_unauthorized_response_to_stable_auth_error_code", async () => {
  const fake = fakeGitLab(() => jsonResponse({ message: "401 Unauthorized" }, {}, 401));
  const service = new GitLabService({ token: "glpat-bad" }, null, fake.fetch);

  const error = await assertRejects(() => service.getIdentity(), AppError);

  assertEquals(error.status, 401);
  assertEquals(error.code, "gitlab_auth_failed");
});

test("should_map_server_and_network_failures_to_gateway_codes", async () => {
  const serverDown = new GitLabService(
    { token: "glpat-test" },
    null,
    fakeGitLab(() => new Response("", { status: 503 })).fetch,
  );
  const serverError = await assertRejects(() => serverDown.getIdentity(), AppError);
  assertEquals(serverError.status, 502);
  assertEquals(serverError.code, "gitlab_request_failed");

  const unreachable = new GitLabService(
    { token: "glpat-test" },
    null,
    (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch,
  );
  const networkError = await assertRejects(() => unreachable.listRepositories(), AppError);
  assertEquals(networkError.code, "gitlab_unreachable");
});

test("should_refuse_gitlab_calls_when_token_is_missing_and_never_call_out", async () => {
  const fake = fakeGitLab(() => jsonResponse({ id: 1, username: "x" }));
  const service = new GitLabService({ token: "   " }, null, fake.fetch);

  const error = await assertRejects(() => service.getIdentity(), AppError);

  assertEquals(error.code, "gitlab_token_required");
  assertEquals(fake.calls.length, 0);
});

test("should_reject_non_numeric_merge_request_ids_before_any_request", async () => {
  const fake = fakeGitLab(() => jsonResponse(MR_OPEN));
  const service = new GitLabService({ token: "glpat-test" }, null, fake.fetch);

  const error = await assertRejects(() => service.getPullRequest("gitlab-42", "7/../../x"), AppError);

  assertEquals(error.code, "invalid_merge_request_id");
  assert(fake.calls.length === 0, "no request should be made");
});

test("should_reject_base_url_that_fails_validation_at_call_time_without_requests", async () => {
  const fake = fakeGitLab(() => jsonResponse({ id: 1, username: "x" }));
  const service = new GitLabService({ baseUrl: "http://git.example.com", token: "glpat-test" }, null, fake.fetch);

  const error = await assertRejects(() => service.getIdentity(), AppError);

  assertEquals(error.status, 503);
  assertEquals(error.code, "gitlab_base_url_invalid");
  assertEquals(fake.calls.length, 0);
});

test("should_map_forbidden_and_not_found_responses_to_their_codes", async () => {
  const forbidden = new GitLabService(
    { token: "glpat-test" },
    null,
    fakeGitLab(() => new Response("", { status: 403 })).fetch,
  );
  const denied = await assertRejects(() => forbidden.getIdentity(), AppError);
  assertEquals(denied.status, 403);
  assertEquals(denied.code, "gitlab_forbidden");

  const missing = new GitLabService(
    { token: "glpat-test" },
    null,
    fakeGitLab(() => new Response("", { status: 404 })).fetch,
  );
  const gone = await assertRejects(() => missing.getPullRequest("gitlab-42", "7"), AppError);
  assertEquals(gone.status, 404);
  assertEquals(gone.code, "gitlab_not_found");
});

test("should_name_the_failed_request_and_keep_gitlabs_reason_as_the_cause", async () => {
  const service = new GitLabService(
    { token: "glpat-test" },
    null,
    fakeGitLab(() => jsonResponse({ error: "insufficient_scope", error_description: "The request requires higher privileges." }, {}, 403)).fetch,
  );
  const error = await assertRejects(() => service.getIdentity(), AppError);
  assertEquals(error.code, "gitlab_forbidden");
  // Clients see the request; GitLab's reason is kept for operator logs.
  assertEquals(error.message, "gitlab_forbidden (GET /user returned 403)");
  assertEquals(error.cause, "The request requires higher privileges.");
});

test("should_fall_back_through_gitlabs_error_fields_and_bound_the_reason", async () => {
  const failing = (response: () => Response) =>
    new GitLabService({ token: "glpat-test" }, null, fakeGitLab(response).fetch);

  // A proxy's HTML error page has no reason to report; the request still names the failure.
  const proxy = await assertRejects(
    () => failing(() => new Response("<html>Bad Gateway</html>", { status: 502 })).getIdentity(),
    AppError,
  );
  assertEquals(proxy.status, 502);
  assertEquals(proxy.message, "gitlab_request_failed (GET /user returned 502)");
  assertEquals(proxy.cause, undefined);

  // Validation errors are objects; a null field is no reason at all.
  const invalid = await assertRejects(
    () => failing(() => jsonResponse({ message: { title: ["is too long"] } }, {}, 400)).getIdentity(),
    AppError,
  );
  assertEquals(invalid.cause, '{"title":["is too long"]}');
  const empty = await assertRejects(
    () => failing(() => jsonResponse({ error: null }, {}, 404)).getIdentity(),
    AppError,
  );
  assertEquals(empty.message, "gitlab_not_found (GET /user returned 404)");
  assertEquals(empty.cause, undefined);

  const long = await assertRejects(
    () => failing(() => jsonResponse({ message: "x".repeat(1000) }, {}, 403)).getIdentity(),
    AppError,
  );
  assertEquals(long.cause, "x".repeat(300));

  // A body past the read limit is not parsed at all.
  const huge = await assertRejects(
    () => failing(() => jsonResponse({ message: "y".repeat(10_000) }, {}, 403)).getIdentity(),
    AppError,
  );
  assertEquals(huge.cause, undefined);
});

test("should_omit_the_query_string_from_the_failed_request", async () => {
  const service = new GitLabService(
    { token: "glpat-test" },
    null,
    fakeGitLab(() => jsonResponse({ message: "403 Forbidden" }, {}, 403)).fetch,
  );
  const error = await assertRejects(() => service.listRepositories(true), AppError);
  assertEquals(error.message, "gitlab_forbidden (GET /projects returned 403)");
});

test("should_pass_rate_limit_status_through_as_request_failed", async () => {
  const limited = new GitLabService(
    { token: "glpat-test" },
    null,
    fakeGitLab(() => new Response("", { status: 429 })).fetch,
  );

  const error = await assertRejects(() => limited.listRepositories(), AppError);

  assertEquals(error.status, 429);
  assertEquals(error.code, "gitlab_request_failed");
});

test("should_treat_html_success_page_as_bad_response_not_json_error", async () => {
  const sso = new GitLabService(
    { token: "glpat-test" },
    null,
    fakeGitLab(() => new Response("<html>sign in</html>", { status: 200 })).fetch,
  );
  const identityError = await assertRejects(() => sso.getIdentity(), AppError);
  assertEquals(identityError.status, 502);
  assertEquals(identityError.code, "gitlab_bad_response");

  const listError = await assertRejects(() => sso.listPullRequests("gitlab-42"), AppError);
  assertEquals(listError.code, "gitlab_bad_response");
});

test("should_fail_loudly_instead_of_truncating_when_pages_outlast_the_guard", async () => {
  // Every page claims a next page, so the walk must stop with an error, not a short list.
  const endless = fakeGitLab((url) => {
    const page = Number(url.searchParams.get("page"));
    return jsonResponse([{ ...MR_OPEN, iid: page }], { "x-next-page": String(page + 1) });
  });
  const service = new GitLabService({ token: "glpat-test" }, null, endless.fetch);

  const error = await assertRejects(() => service.getPullRequestDiff("gitlab-42", "7"), AppError);

  assertEquals(error.status, 502);
  assertEquals(error.code, "gitlab_result_truncated");
  assertEquals(endless.calls.length, 100);
});

test("should_allow_dotted_file_names_but_reject_parent_segments", async () => {
  const fake = fakeGitLab(() => new Response("v1 to v2\n", { status: 200 }));
  const service = new GitLabService({ token: "glpat-test" }, null, fake.fetch);

  assertEquals(await service.getRepoFileContent("gitlab-42", "main", "docs/v1..v2.md"), "v1 to v2\n");
  assertEquals(await service.getRepoFileContent("gitlab-42", "main", "docs/../secrets.md"), null);
  assertEquals(fake.calls.length, 1);
});

test("should_prefer_draft_flags_and_treat_locked_as_closed", () => {
  const base = { ...MR_OPEN };
  assertEquals(mergeRequestState({ ...base, state: "opened", draft: true }), "draft");
  assertEquals(mergeRequestState({ ...base, state: "opened", draft: undefined, work_in_progress: true }), "draft");
  assertEquals(mergeRequestState({ ...base, state: "opened", draft: false, work_in_progress: true }), "open");
  assertEquals(mergeRequestState({ ...base, state: "opened", draft: undefined, work_in_progress: undefined }), "open");
  assertEquals(mergeRequestState({ ...base, state: "locked" }), "closed");
  assertEquals(mergeRequestState({ ...base, state: "closed" }), "closed");
  assertEquals(mergeRequestState({ ...base, state: "merged", draft: true }), "merged");
});

test("should_attribute_gitlab_posts_to_the_member_only_when_asked", async () => {
  const fake = fakeGitLab((url) => url.pathname.endsWith("/notes") ? jsonResponse({ id: 5 }) : jsonResponse(MR_OPEN));
  const service = new GitLabService({ token: "glpat-test" }, null, fake.fetch);

  await service.postPullRequestComment("gitlab-42", "7", "Looks good.", {
    onBehalfOf: "gl-khalil",
    asToken: "ghp_member_token",
  });
  await service.postPullRequestComment("gitlab-42", "7", "Looks good.");

  const notes = fake.calls.filter((call) => call.method === "POST");
  assertEquals(notes.length, 2);
  assertEquals(notes[0].body, {
    body: "Looks good.\n\n<sub>Posted on behalf of @gl-khalil via Capillary.</sub>",
  });
  assertEquals(notes[1].body, { body: "Looks good." });
  // GitLab always posts with the server token; the member's GitHub token is never sent.
  assertEquals(notes[0].token, "glpat-test");
});

test("should_abort_a_hung_gitlab_request_as_unreachable", async () => {
  const hung = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason));
    })) as typeof fetch;
  const service = new GitLabService({ token: "glpat-test", timeoutMs: 50 }, null, hung);
  const started = Date.now();

  const error = await assertRejects(() => service.getIdentity(), AppError);

  assertEquals(error.code, "gitlab_unreachable");
  assert(Date.now() - started < 5000, "the request should give up at the configured timeout");
});

test("should_keep_the_network_cause_in_the_unreachable_message_without_the_token", async () => {
  const refused = (() => Promise.reject(new TypeError("self-signed certificate"))) as typeof fetch;
  const service = new GitLabService({ token: "glpat-secret-value" }, null, refused);

  const error = await assertRejects(() => service.getIdentity(), AppError);

  assertEquals(error.code, "gitlab_unreachable");
  assert(error.message.includes("self-signed certificate"), error.message);
  assert(!error.message.includes("glpat-secret-value"), "the token must never appear in an error");
});

test("should_report_a_stalled_response_body_as_unreachable_not_bad_response", async () => {
  // Headers arrive, then the body never finishes; the request timeout fires mid-read.
  const stalled = ((_input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("[{"));
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )) as typeof fetch;
  const service = new GitLabService({ token: "glpat-test", timeoutMs: 50 }, null, stalled);
  const error = await assertRejects(() => service.listRepositories(), AppError);
  assertEquals(error.code, "gitlab_unreachable");
});

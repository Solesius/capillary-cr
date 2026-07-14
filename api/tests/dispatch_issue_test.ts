// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Dispatch-to-coding-agent survives assignment refusal. GitHub only silently
// drops unknown usernames; a real-but-unassignable bot (copilot-swe-agent
// behind a token shape without Copilot assignment rights) 422s, and that must
// degrade to `assigned: false` — never sink the issue itself.
import { assert, assertEquals } from "jsr:@std/assert";
import { CelerReviewRepository } from "../src/repositories/review_repository.ts";
import { GitHubOakService } from "../src/services/github_service.ts";

const REPO_ID = "1207713294";

type AssignResponder = (token: string) => Response;

function createDispatchFetch(options: {
  assign: AssignResponder;
  calls: { createBodies: string[]; assignTokens: string[] };
}): typeof fetch {
  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    if (url.includes(`/repositories/${REPO_ID}`)) {
      return new Response(
        JSON.stringify({
          id: Number(REPO_ID),
          owner: { login: "Solesius" },
          name: "demo",
          full_name: "Solesius/demo",
          default_branch: "main",
          private: false,
          html_url: "https://github.com/Solesius/demo",
          language: "TypeScript",
          open_issues_count: 0,
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/repos/Solesius/demo/issues") && init?.method === "POST") {
      options.calls.createBodies.push(String(init.body));
      return new Response(
        JSON.stringify({ html_url: "https://github.com/Solesius/demo/issues/7", number: 7 }),
        { status: 201 },
      );
    }
    if (url.endsWith("/issues/7/assignees") && init?.method === "POST") {
      const auth = String(
        (init.headers as Record<string, string>)?.["authorization"] ?? "",
      ).replace("Bearer ", "");
      options.calls.assignTokens.push(auth);
      return options.assign(auth);
    }
    return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
  };
}

async function buildService(assign: AssignResponder) {
  const calls = { createBodies: [] as string[], assignTokens: [] as string[] };
  const repository = new CelerReviewRepository();
  await repository.setGithubToken("instance-token");
  const service = new GitHubOakService(repository, createDispatchFetch({ assign, calls }));
  return { service, calls };
}

const draft = {
  title: "[capillary] finding",
  body: "@copilot please fix",
  labels: ["capillary"],
  assignees: ["Copilot"],
};

Deno.test("should_create_issue_without_assignees_in_the_create_call", async () => {
  const { service, calls } = await buildService(() =>
    new Response(JSON.stringify({ assignees: [{ login: "Copilot" }] }), { status: 201 })
  );
  const issue = await service.createRepositoryIssue(REPO_ID, draft);
  assertEquals(calls.createBodies.length, 1);
  assert(!calls.createBodies[0].includes("assignees"));
  assertEquals(issue.number, 7);
  assertEquals(issue.assigned, true);
});

Deno.test("should_keep_the_issue_and_report_unassigned_when_github_refuses_the_bot", async () => {
  const { service } = await buildService(() =>
    new Response(
      JSON.stringify({ message: "Validation Failed" }),
      { status: 422 },
    )
  );
  const issue = await service.createRepositoryIssue(REPO_ID, draft);
  assertEquals(issue.htmlUrl, "https://github.com/Solesius/demo/issues/7");
  assertEquals(issue.assigned, false);
});

Deno.test("should_report_unassigned_when_github_silently_drops_the_assignee", async () => {
  const { service } = await buildService(() =>
    new Response(JSON.stringify({ assignees: [] }), { status: 201 })
  );
  const issue = await service.createRepositoryIssue(REPO_ID, draft);
  assertEquals(issue.assigned, false);
});

Deno.test("should_not_count_a_different_returned_login_as_assigned", async () => {
  // The 2026-07-14 live failure: REST silently drops "copilot-swe-agent"
  // (the GraphQL actor login) — only "Copilot" is the REST-assignable Bot.
  // A response whose assignees don't include the requested login is a miss.
  const { service } = await buildService(() =>
    new Response(JSON.stringify({ assignees: [{ login: "Solesius" }] }), { status: 201 })
  );
  const issue = await service.createRepositoryIssue(REPO_ID, {
    ...draft,
    assignees: ["copilot-swe-agent"],
  });
  assertEquals(issue.assigned, false);
});

Deno.test("should_retry_assignment_with_the_instance_token_when_the_member_token_is_refused", async () => {
  const { service, calls } = await buildService((token) =>
    token === "member-token"
      ? new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 })
      : new Response(JSON.stringify({ assignees: [{ login: "Copilot" }] }), {
        status: 201,
      })
  );
  const issue = await service.createRepositoryIssue(REPO_ID, draft, { asToken: "member-token" });
  assertEquals(calls.assignTokens, ["member-token", "instance-token"]);
  assertEquals(issue.assigned, true);
});

Deno.test("should_skip_assignment_entirely_when_no_assignees_are_requested", async () => {
  const { service, calls } = await buildService(() =>
    new Response(JSON.stringify({ assignees: [] }), { status: 201 })
  );
  const issue = await service.createRepositoryIssue(REPO_ID, { ...draft, assignees: [] });
  assertEquals(calls.assignTokens.length, 0);
  assertEquals(issue.assigned, false);
});

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
import { buildCopilotDispatchComment } from "../src/services/review_agent_service.ts";
import type { ReviewAgentRunRecord, ReviewFinding } from "../src/domain/entities.ts";

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
  assignees: ["copilot-swe-agent"],
};

Deno.test("should_create_issue_without_assignees_in_the_create_call", async () => {
  const { service, calls } = await buildService(() =>
    new Response(JSON.stringify({ assignees: [{ login: "copilot-swe-agent" }] }), { status: 201 })
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

Deno.test("should_retry_assignment_with_the_instance_token_when_the_member_token_is_refused", async () => {
  const { service, calls } = await buildService((token) =>
    token === "member-token"
      ? new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 })
      : new Response(JSON.stringify({ assignees: [{ login: "copilot-swe-agent" }] }), {
        status: 201,
      })
  );
  const issue = await service.createRepositoryIssue(REPO_ID, draft, { asToken: "member-token" });
  assertEquals(calls.assignTokens, ["member-token", "instance-token"]);
  assertEquals(issue.assigned, true);
});

Deno.test("should_open_the_dispatch_comment_with_a_copilot_mention_and_carry_the_evidence", () => {
  const finding = {
    id: "f1",
    runId: "run_1",
    severity: "high",
    passName: "Review",
    filePath: "api/src/services/check_changes.ts",
    line: 247,
    title: "carryStillPresentFindings drops posted-artifact state",
    finding: "Prior artifacts are not carried forward.",
    evidence: ["check_changes.ts:235 doc comment", "review_agent_service.ts:621-625"],
    suggestedFix: "Thread priorArtifacts through the follow-up record.",
    confidence: 0.85,
  } as ReviewFinding;
  const record = { runId: "run_1" } as ReviewAgentRunRecord;
  const body = buildCopilotDispatchComment(record, finding, "http://localhost:7858/?run=run_1");
  assert(body.startsWith("@copilot "));
  assert(body.includes("[HIGH] carryStillPresentFindings drops posted-artifact state"));
  assert(body.includes("api/src/services/check_changes.ts:247"));
  assert(body.includes("- check_changes.ts:235 doc comment"));
  assert(body.includes("Suggested fix: Thread priorArtifacts"));
  assert(body.includes("Full run: http://localhost:7858/?run=run_1"));
  assert(body.includes("run `run_1`"));
});

Deno.test("should_omit_run_link_and_optionals_from_the_dispatch_comment_when_absent", () => {
  const finding = {
    id: "f2",
    runId: "run_2",
    severity: "medium",
    passName: "Sanitize",
    filePath: "api/src/services/github_service.ts",
    title: "compareCommits ignores file-list truncation",
    finding: "GitHub caps the files array around ~300 entries.",
    evidence: [],
    confidence: 0.75,
  } as ReviewFinding;
  const record = { runId: "run_2" } as ReviewAgentRunRecord;
  const body = buildCopilotDispatchComment(record, finding, null);
  assert(body.startsWith("@copilot "));
  assert(body.includes("File: `api/src/services/github_service.ts`"));
  assert(!body.includes("Evidence:"));
  assert(!body.includes("Suggested fix:"));
  assert(!body.includes("Full run:"));
});

Deno.test("should_skip_assignment_entirely_when_no_assignees_are_requested", async () => {
  const { service, calls } = await buildService(() =>
    new Response(JSON.stringify({ assignees: [] }), { status: 201 })
  );
  const issue = await service.createRepositoryIssue(REPO_ID, { ...draft, assignees: [] });
  assertEquals(calls.assignTokens.length, 0);
  assertEquals(issue.assigned, false);
});

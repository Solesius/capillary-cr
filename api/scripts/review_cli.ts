// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Agent-grade review CLI: run a full Capillary review from a terminal, CI
// job, or another agent. No server required — the pipeline runs in-process.
//
//   GITHUB_TOKEN=ghp_... npm run review -- --repo owner/name --pr 123
//   CAPILLARY_GITLAB_TOKEN=glpat-... npm run review -- --source gitlab --repo group/project --mr 42
//
// Flags:
//   --source <host>       github (default) or gitlab
//   --repo <owner/name>   repository (required); GitLab: group/subgroup/project
//   --pr <number>         pull request number (required); --mr is an alias
//   --max-cycles <n>      cap agent cycles (default: scales with PR size)
//   --json                emit the full run record as JSON on stdout
//   --quiet               suppress live narration on stderr
//
// Output contract (stable for agents):
//   stdout — the review report (markdown), or the run record with --json
//   stderr — live gate narration (unless --quiet)
//   exit 0 — approve | comment;  exit 1 — request_changes;  exit 2 — error
//
// Auth: GITHUB_TOKEN (or CAPILLARY_GITHUB_TOKEN) for GitHub; CAPILLARY_GITLAB_TOKEN
// (and GITLAB_BASE_URL for self-hosted) for GitLab. The model provider
// resolves exactly as the server does: Codex/Claude CLI logins, ws bridges
// via CODEX_APP_SERVER_URL / CLAUDE_CODE_URL, or provider API keys.

import { parseArgs } from "node:util";
import { deps } from "../src/http/deps.ts";
import { type ReviewRunEvent } from "../src/domain/review_phase.ts";

function fail(message: string): never {
  console.error(`capillary-review: ${message}`);
  process.exit(2);
}

const args = parseArgs({
  args: process.argv.slice(2),
  strict: false,
  options: {
    repo: { type: "string" },
    pr: { type: "string" },
    mr: { type: "string" },
    source: { type: "string" },
    "max-cycles": { type: "string" },
    json: { type: "boolean" },
    quiet: { type: "boolean" },
    help: { type: "boolean" },
  },
}).values;

if (args.help) {
  console.error(
    "usage: GITHUB_TOKEN=... npm run review -- --repo owner/name --pr 123 [--max-cycles n] [--json] [--quiet]\n" +
      "       CAPILLARY_GITLAB_TOKEN=... npm run review -- --source gitlab --repo group/project --mr 42 [...]",
  );
  process.exit(0);
}

const source = String(args.source || "github").trim().toLowerCase();
if (source !== "github" && source !== "gitlab") {
  fail(`--source must be github or gitlab, not ${source}`);
}
const repoFullName = String(args.repo || "").trim();
const prNumber = String(args.pr || args.mr || "").trim();
if (!repoFullName.includes("/") || !prNumber) {
  fail("required: --repo owner/name and --pr <number> (see --help)");
}

const token = process.env["GITHUB_TOKEN"]?.trim() ||
  process.env["CAPILLARY_GITHUB_TOKEN"]?.trim();
if (source === "github" && !token) {
  fail("GITHUB_TOKEN env var is required");
}
if (source === "gitlab" && !deps.gitlabService.configured()) {
  fail("CAPILLARY_GITLAB_TOKEN env var is required for --source gitlab");
}

const narrate = (line: string) => {
  if (!args.quiet) {
    console.error(line);
  }
};

try {
  // GitLab resolves the exact project path in one call; GitHub walks the catalog.
  if (source === "github") {
    await deps.githubService.connectGithub("valid", token);
  }
  const repositories = source === "gitlab"
    ? await deps.gitlabService.lookupRepositories(repoFullName)
    : await deps.githubService.listRepositories();
  const repository = repositories.find(
    (candidate) => candidate.fullName.toLowerCase() === repoFullName.toLowerCase(),
  );
  if (!repository) {
    fail(`repository ${repoFullName} not visible to this token`);
  }

  const pulls = await deps.codeHost.listPullRequests(repository.id, "open");
  const pull = pulls.find((candidate) => String(candidate.number) === prNumber) ??
    (await deps.codeHost.listPullRequests(repository.id, "closed"))
      .find((candidate) => String(candidate.number) === prNumber);
  if (!pull) {
    fail(`PR #${prNumber} not found in ${repoFullName}`);
  }

  narrate(`review: ${repoFullName}#${prNumber} — ${pull.title}`);

  const maxCyclesRaw = Number(args["max-cycles"]);
  const onEvent = (event: ReviewRunEvent) => {
    switch (event.type) {
      case "phase":
        narrate(`◦ phase ${event.phase}`);
        break;
      case "graph":
        narrate(`◦ graph ${event.nodeCount} nodes / ${event.edgeCount} edges`);
        break;
      case "thinking":
        narrate(`▸ [${event.gate}] ${event.text.split("\n")[0]}`);
        break;
      case "finding":
        narrate(`! ${event.finding.severity} ${event.finding.filePath} — ${event.finding.title}`);
        break;
      case "cycle":
        narrate(`◦ cycle ${event.cycle} gates ${event.gatesCovered}/${event.gatesTotal}`);
        break;
    }
  };

  const result = await deps.reviewService.runReviewStream(
    {
      pullRequestId: pull.id,
      repositoryId: repository.id,
      maxCycles: Number.isFinite(maxCyclesRaw) && maxCyclesRaw > 0 ? maxCyclesRaw : undefined,
    },
    onEvent,
  );

  // The stream result is the compact summary; the full artifact (report,
  // verdict, findings) is the persisted run record.
  const record = await deps.repository.getReviewAgentRun(result.runId);
  if (!record) {
    fail(`run ${result.runId} completed but no record was persisted`);
  }

  if (args.json) {
    console.log(JSON.stringify(record, null, 2));
  } else {
    console.log(record.report);
  }
  narrate(`verdict: ${record.verdict} (${record.findingCount} findings)`);
  process.exit(record.verdict === "request_changes" ? 1 : 0);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

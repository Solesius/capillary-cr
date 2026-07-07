// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assert, assertEquals } from "jsr:@std/assert";
import { InMemoryReviewRepository } from "../src/repositories/review_repository.ts";
import { GitHubOakService } from "../src/services/github_service.ts";
import { TcsrctReviewService } from "../src/services/tcsrct_review_service.ts";
import { ReviewAgentService } from "../src/services/review_agent_service.ts";
import { ReviewAgentRunRecord } from "../src/domain/entities.ts";

function makeRecord(
  runId: string,
  traceEnabled: boolean,
  finishedAt: string,
): ReviewAgentRunRecord {
  return {
    runId,
    pullRequestId: "pr-1",
    repositoryId: "repo-1",
    title: `review ${runId}`,
    verdict: "comment",
    goalAchieved: true,
    stopReason: "deterministic_review",
    startedAt: "2024-01-01T00:00:00.000Z",
    finishedAt,
    durationMs: 1000,
    cycleCount: traceEnabled ? 2 : 0,
    findingCount: 0,
    blockerCount: 0,
    highCount: 0,
    changedFileCount: 1,
    nodeCount: 3,
    edgeCount: 2,
    torusVariance: 0.1,
    findings: [],
    summary: "ok",
    report: "# Code Review Report\n\n## Verdict\ncomment",
    traceEnabled,
    trace: traceEnabled
      ? {
        cycles: [{
          cycle: 1,
          startedAt: "2024-01-01T00:00:00.000Z",
          phase: "review",
          toolCalls: [],
          steps: [],
          findings: [],
        }],
        captureManifest: JSON.stringify({ runId, changedFiles: [] }),
      }
      : undefined,
  };
}

function makeService(repository: InMemoryReviewRepository): ReviewAgentService {
  const github = new GitHubOakService(repository);
  const tcsrct = new TcsrctReviewService(repository);
  return new ReviewAgentService(repository, github, tcsrct);
}

Deno.test("should_list_review_agent_runs_most_recent_first_and_omit_trace", () => {
  const repo = new InMemoryReviewRepository();
  repo.saveReviewAgentRun(makeRecord("older", true, "2024-01-01T00:00:00.000Z"));
  repo.saveReviewAgentRun(makeRecord("newer", false, "2024-02-01T00:00:00.000Z"));

  const list = repo.listReviewAgentRuns();
  assertEquals(list.map((item) => item.runId), ["newer", "older"]);
  assertEquals(list[0].traceEnabled, false);
  assertEquals(list[1].traceEnabled, true);
  assert(!("trace" in list[0]));

  const full = repo.getReviewAgentRun("older");
  assert(full !== null);
  assertEquals(full.trace?.cycles.length, 1);
  assertEquals(repo.getReviewAgentRun("missing"), null);
});

Deno.test("should_not_export_untraced_or_missing_review_runs", () => {
  const repo = new InMemoryReviewRepository();
  repo.saveReviewAgentRun(makeRecord("plain", false, "2024-01-01T00:00:00.000Z"));
  const service = makeService(repo);

  assertEquals(service.buildReviewExport("plain"), null);
  assertEquals(service.buildReviewExport("missing"), null);
});

Deno.test("should_export_traced_review_run_as_valid_zip_bundle", () => {
  const repo = new InMemoryReviewRepository();
  repo.saveReviewAgentRun(makeRecord("traced", true, "2024-01-01T00:00:00.000Z"));
  const service = makeService(repo);

  const bytes = service.buildReviewExport("traced");
  assert(bytes !== null);

  // Local file header signature 'PK\x03\x04' at the start.
  assertEquals([bytes[0], bytes[1], bytes[2], bytes[3]], [0x50, 0x4b, 0x03, 0x04]);
  // End-of-central-directory signature 'PK\x05\x06' at the tail.
  const eocd = bytes.subarray(bytes.length - 22);
  assertEquals([eocd[0], eocd[1], eocd[2], eocd[3]], [0x50, 0x4b, 0x05, 0x06]);

  const text = new TextDecoder().decode(bytes);
  assert(text.includes("report.md"));
  assert(text.includes("run.json"));
  assert(text.includes("findings.json"));
  assert(text.includes("trace.json"));
  assert(text.includes("capture/manifest.json"));
});

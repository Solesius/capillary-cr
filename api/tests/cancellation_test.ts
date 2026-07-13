// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Coverage for the cooperative-cancellation mechanism (flagged by capillary
// reviewing its own Stop feature: "zero test coverage" on exactly the kind of
// boundary logic that regresses silently). Pins the raceCancellation
// primitive's semantics and the orchestrator's cancel state transition.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { CANCELLED, raceCancellation } from "../src/services/review_agent_service.ts";
import { AgenticReviewService } from "../src/services/agentic_review_orchestrator_service.ts";
import { CelerReviewRepository } from "../src/repositories/review_repository.ts";
import { ClickClackCoordinationService } from "../src/services/click_clack_coordination_service.ts";
import { DiffDagService } from "../src/services/diff_dag_service.ts";
import { GitHubOakService } from "../src/services/github_service.ts";
import { GraphMathService } from "../src/services/graph_math_service.ts";
import { TcsrctReviewService } from "../src/services/tcsrct_review_service.ts";
import { ArtifactService } from "../src/services/artifact_service.ts";
import { ReviewRun } from "../src/domain/entities.ts";

// --- raceCancellation: the primitive that makes Stop land mid-model-turn ----

Deno.test("raceCancellation returns the work's value when never cancelled", async () => {
  const result = await raceCancellation(Promise.resolve(42), () => false);
  assertEquals(result, 42);
});

Deno.test("raceCancellation without a signal is a plain passthrough", async () => {
  assertEquals(await raceCancellation(Promise.resolve("ok")), "ok");
});

Deno.test("raceCancellation propagates the work's rejection when not cancelled", async () => {
  await assertRejects(
    () => raceCancellation(Promise.reject(new Error("provider_down")), () => false),
    Error,
    "provider_down",
  );
});

Deno.test("raceCancellation yields CANCELLED promptly while the work hangs", async () => {
  // A never-resolving "model call": the stop must win the race on poll cadence
  // (~250ms), not wait out the turn. Generous ceiling for slow CI.
  let cancelled = false;
  const hanging = new Promise<never>(() => {});
  const started = Date.now();
  setTimeout(() => {
    cancelled = true;
  }, 50);
  const result = await raceCancellation(hanging, () => cancelled);
  const elapsed = Date.now() - started;
  assertEquals(result, CANCELLED);
  assert(elapsed < 2_000, `stop took ${elapsed}ms; must land on poll cadence`);
});

Deno.test("raceCancellation swallows a late rejection from the abandoned work", async () => {
  // When cancel wins, the orphaned call may still fail later — that must not
  // surface as an unhandled rejection (Deno's test sanitizer would flag it).
  let reject!: (e: Error) => void;
  const work = new Promise<never>((_, rej) => {
    reject = rej;
  });
  const result = await raceCancellation(work, () => true);
  assertEquals(result, CANCELLED);
  reject(new Error("late provider failure"));
  // Give the microtask queue a beat to deliver the (handled) rejection.
  await new Promise((resolve) => setTimeout(resolve, 10));
});

// --- orchestrator: cancelReview state transition -----------------------------

function makeRun(id: string): ReviewRun {
  return {
    id,
    pullRequestId: "pr-1",
    status: "reviewing",
    startedAt: new Date().toISOString(),
    currentPhase: "tcsrct",
    findingCount: 0,
    blockerCount: 0,
    highCount: 0,
  };
}

function buildOrchestrator(repository: CelerReviewRepository): AgenticReviewService {
  const graphMath = new GraphMathService();
  return new AgenticReviewService(
    repository,
    new ClickClackCoordinationService(repository),
    new DiffDagService(repository, graphMath, null),
    new GitHubOakService(repository),
    new TcsrctReviewService(repository),
    new ArtifactService(repository),
  );
}

Deno.test("cancelReview records intent as 'cancelling' — terminal stamp belongs to the loop", async () => {
  const repository = new CelerReviewRepository();
  const service = buildOrchestrator(repository);
  await repository.createReviewRun(makeRun("run-stop"));

  const acknowledged = await service.cancelReview("run-stop");
  assertEquals(acknowledged, true);

  const run = await repository.getReviewRun("run-stop");
  assertEquals(run.status, "cancelling");
  assertEquals(run.currentPhase, "cancelling");
  // finishedAt is the loop's to stamp (#finishCancelled / boot sweep).
  assertEquals(run.finishedAt, undefined);
});

Deno.test("cancelReview on an unknown run rejects instead of inventing state", async () => {
  const repository = new CelerReviewRepository();
  const service = buildOrchestrator(repository);
  await assertRejects(() => service.cancelReview("run-ghost"));
});

Deno.test("cancelRetvRun refuses ghosts — false when no such run is live", async () => {
  const { CdpRetvAgentService } = await import("../src/services/cdp_retv_agent_service.ts");
  const { CdpDriverService } = await import("../src/services/cdp_driver_service.ts");
  const repository = new CelerReviewRepository();
  const service = new CdpRetvAgentService(repository, new CdpDriverService());
  assertEquals(service.cancelRetvRun("retv_cdp_ghost123"), false);
});

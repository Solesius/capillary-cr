// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assert, assertEquals } from "jsr:@std/assert";
import { CelerStore } from "../src/services/storage/celer_mem.ts";
import { DurableReviewStore } from "../src/services/storage/celer_review_store.ts";
import { CelerReviewRepository } from "../src/repositories/review_repository.ts";
import { RetvCdpRunRecord, ReviewFinding, ReviewRun } from "../src/domain/entities.ts";

// Exercises the durable review store against the real native library. Self-skips
// when celer-mem is unavailable so `deno test --allow-env` stays green. Run with:
//   deno test --allow-env --allow-ffi --allow-read --allow-write
const NATIVE_AVAILABLE = CelerStore.canLoad();

function makeRun(id: string): ReviewRun {
  return {
    id,
    pullRequestId: "pr-1",
    status: "reviewing",
    startedAt: "2024-01-01T00:00:00.000Z",
    currentPhase: "observe",
    findingCount: 0,
    blockerCount: 0,
    highCount: 0,
  };
}

function makeFinding(id: string, runId: string): ReviewFinding {
  return {
    id,
    runId,
    severity: "high",
    passName: "State",
    filePath: "src/main.ts",
    title: "Unflushed write",
    finding: "State mutation is not persisted before return.",
    evidence: ["tcsrtc.gate=Test"],
    confidence: 0.91,
  };
}

function makeRetvRun(runId: string, traceEnabled: boolean): RetvCdpRunRecord {
  return {
    runId,
    sessionId: "sess-1",
    goal: "validate login flow",
    allowedOrigin: "http://localhost:4200",
    stopReason: "goal_achieved",
    functionalTestSucceeded: true,
    goalAchieved: true,
    startedAt: "2024-01-01T00:00:00.000Z",
    finishedAt: "2024-01-01T00:01:00.000Z",
    durationMs: 60000,
    cycleCount: 2,
    milestonesCompleted: 2,
    milestonesTotal: 2,
    percent: 100,
    findings: ["login succeeded"],
    summary: "Login flow verified.",
    report: "# Functional Test Report\n\n## Verdict\n**PASS**",
    traceEnabled,
    trace: traceEnabled
      ? {
        cycles: [{
          cycle: 1,
          startedAt: "2024-01-01T00:00:10.000Z",
          url: "http://localhost:4200/login",
          title: "Login",
          headings: ["Sign in"],
          interactiveLabels: ["Email", "Password", "Submit"],
          plannerRaw: "{}",
          toolCalls: [{ tool: "click", args: { selector: "#submit" }, reason: "submit" }],
          steps: [{ index: 0, action: "click", ok: true, durationMs: 12 }],
          workUnitName: "retv_goal_cycle_1",
          workUnitSuccess: true,
          failedSteps: 0,
          findings: [],
        }],
        screenshots: [],
      }
      : undefined,
  };
}

Deno.test({
  name: "should_persist_and_rehydrate_review_artifacts_through_celer_store",
  ignore: !NATIVE_AVAILABLE,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "celer_review_test_" });
    try {
      // First lifecycle: write through the durable store (celer is the source
      // of truth; every write awaits its persistence).
      const repoA = new CelerReviewRepository();
      const storeA = await DurableReviewStore.tryOpen({ path: dir });
      assert(storeA !== null, "durable store should open when native is available");
      repoA.attachDurableStore(storeA);

      await repoA.createReviewRun(makeRun("run-1"));
      await repoA.appendReviewEvent("run-1", "phase:observe");
      await repoA.appendReviewEvent("run-1", "phase:plan");
      await repoA.updateReviewRun(
        "run-1",
        (run) => ({ ...run, status: "completed", findingCount: 1, highCount: 1 }),
      );
      await repoA.saveFindings("run-1", [makeFinding("finding-1", "run-1")]);
      await repoA.saveRetvRun(makeRetvRun("retv-traced", true));
      await repoA.saveRetvRun(makeRetvRun("retv-light", false));
      await storeA.close();

      // Second lifecycle: a fresh repository reads back from disk on demand
      // (no boot-time replay — cache misses fault through to celer).
      const repoB = new CelerReviewRepository();
      const storeB = await DurableReviewStore.tryOpen({ path: dir });
      assert(storeB !== null);
      repoB.attachDurableStore(storeB);

      const run = await repoB.getReviewRun("run-1");
      assertEquals(run.status, "completed");
      assertEquals(run.findingCount, 1);
      assertEquals(await repoB.listReviewEvents("run-1"), ["phase:observe", "phase:plan"]);

      const findings = await repoB.getFindings("run-1");
      assertEquals(findings.length, 1);
      assertEquals(findings[0].id, "finding-1");
      assertEquals(findings[0].evidence, ["tcsrtc.gate=Test"]);

      const retvRuns = await repoB.listRetvRuns();
      assertEquals(retvRuns.length, 2);
      const traced = await repoB.getRetvRun("retv-traced");
      assert(traced !== null);
      assertEquals(traced.traceEnabled, true);
      assertEquals(traced.trace?.cycles.length, 1);
      assertEquals(traced.report.includes("Functional Test Report"), true);
      const light = await repoB.getRetvRun("retv-light");
      assert(light !== null);
      assertEquals(light.traceEnabled, false);
      assertEquals(light.trace, undefined);

      await storeB.close();
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "should_run_in_memory_when_durable_store_is_unavailable",
  async fn() {
    // Pointing at a non-existent library forces tryOpen to fall back to null.
    // No directory is created because the store never opens, so this test needs
    // no extra permissions and runs in the default `--allow-env` suite.
    const store = await DurableReviewStore.tryOpen({
      path: "/tmp/celer_review_fallback_unused",
      libPath: "/nonexistent/libceler_ffi.so",
    });
    assertEquals(store, null);

    // The repository still works purely in memory.
    const repo = new CelerReviewRepository();
    await repo.createReviewRun(makeRun("run-x"));
    await repo.appendReviewEvent("run-x", "phase:observe");
    assertEquals((await repo.getReviewRun("run-x")).id, "run-x");
    assertEquals(await repo.listReviewEvents("run-x"), ["phase:observe"]);
  },
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assertEquals } from "jsr:@std/assert";
import { ReviewSessionHub } from "../src/services/review_session_hub.ts";
import { ReviewRunEvent } from "../src/domain/review_phase.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const doneEvent = (runId: string): ReviewRunEvent => ({
  type: "done",
  result: {
    runId,
    pullRequestId: "p1",
    phase: "completed",
    stopReason: "verdict_reached",
    goalAchieved: true,
    findingCount: 0,
    blockerCount: 0,
    highCount: 0,
    progress: {
      percent: 100,
      coveredPasses: 6,
      totalPasses: 6,
      findingCount: 0,
      nextPass: null,
      goalAchieved: true,
    },
    cycles: [],
  },
});

Deno.test("should_replay_history_then_tail_live_events_for_late_attachers", async () => {
  const gate = deferred();
  let emit!: (event: ReviewRunEvent) => void;

  const hub = new ReviewSessionHub((_request, onEvent) => {
    emit = onEvent;
    onEvent({ type: "run_start", runId: "r1", pullRequestId: "p1", phase: "queued" });
    onEvent({ type: "phase", phase: "diff_dag" });
    return gate.promise;
  });

  const session = await hub.start({ pullRequestId: "p1" });
  assertEquals(session.runId, "r1");
  assertEquals(hub.isActive("r1"), true);

  // Late attacher: full replay first, then live tail.
  const seen: string[] = [];
  const detach = hub.attach("r1", (event) => seen.push(event.type));
  assertEquals(seen, ["run_start", "phase"]);

  emit({ type: "phase", phase: "tcsrct" });
  assertEquals(seen, ["run_start", "phase", "phase"]);

  // Detached consumers stop receiving; the run continues unaffected.
  detach?.();
  emit({ type: "log", level: "info", message: "still running" });
  assertEquals(seen.length, 3);

  emit(doneEvent("r1"));
  gate.resolve();
  await gate.promise;
  assertEquals(hub.isActive("r1"), false);

  // Attaching to a finished session replays everything including done.
  const replay: string[] = [];
  hub.attach("r1", (event) => replay.push(event.type));
  assertEquals(replay, ["run_start", "phase", "phase", "log", "done"]);
});

Deno.test("should_run_multiple_concurrent_sessions_independently", async () => {
  const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const emitters = new Map<string, (event: ReviewRunEvent) => void>();
  let counter = 0;

  const hub = new ReviewSessionHub((_request, onEvent) => {
    counter += 1;
    const runId = `r${counter}`;
    const gate = deferred();
    gates.set(runId, gate);
    emitters.set(runId, onEvent);
    onEvent({ type: "run_start", runId, pullRequestId: `p${counter}`, phase: "queued" });
    return gate.promise;
  });

  const first = await hub.start({ pullRequestId: "p1" });
  const second = await hub.start({ pullRequestId: "p2" });
  assertEquals(hub.list().length, 2);
  assertEquals(hub.list().every((session) => session.active), true);

  const firstSeen: string[] = [];
  const secondSeen: string[] = [];
  hub.attach(first.runId, (event) => firstSeen.push(event.type));
  hub.attach(second.runId, (event) => secondSeen.push(event.type));

  emitters.get(first.runId)!({ type: "phase", phase: "tcsrct" });
  assertEquals(firstSeen, ["run_start", "phase"]);
  assertEquals(secondSeen, ["run_start"]);

  emitters.get(first.runId)!(doneEvent(first.runId));
  gates.get(first.runId)!.resolve();
  await gates.get(first.runId)!.promise;
  assertEquals(hub.isActive(first.runId), false);
  assertEquals(hub.isActive(second.runId), true);

  emitters.get(second.runId)!(doneEvent(second.runId));
  gates.get(second.runId)!.resolve();
  await gates.get(second.runId)!.promise;
});

Deno.test("should_return_null_when_attaching_to_unknown_session", () => {
  const hub = new ReviewSessionHub(() => Promise.resolve());
  assertEquals(hub.attach("nope", () => {}), null);
  assertEquals(hub.has("nope"), false);
});

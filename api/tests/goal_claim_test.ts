// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Pins the functional agent's completion contract: goalAchieved is a verdict
// that requires quoted evidence and complete milestones — the gate that turns
// "ambiguous goal completion" into explicit, teachable rejections.
import { assert, assertEquals } from "jsr:@std/assert";
import { evaluateGoalClaim } from "../src/services/cdp_retv_agent_service.ts";

Deno.test("no claim is a quiet non-event — no rejection noise", () => {
  const gate = evaluateGoalClaim(false, undefined, false);
  assertEquals(gate.accepted, false);
  assertEquals(gate.rejection, undefined);
});

Deno.test("a claim without evidence is rejected with the evidence lesson", () => {
  const gate = evaluateGoalClaim(true, "", true);
  assertEquals(gate.accepted, false);
  assert(gate.rejection?.includes("no_evidence"));
});

Deno.test("trivial evidence does not count as proof", () => {
  const gate = evaluateGoalClaim(true, "done", true);
  assertEquals(gate.accepted, false);
  assert(gate.rejection?.includes("no_evidence"));
});

Deno.test("a claim with evidence but incomplete milestones is rejected", () => {
  const gate = evaluateGoalClaim(true, "URL is /dashboard and heading reads 'Welcome back'", false);
  assertEquals(gate.accepted, false);
  assert(gate.rejection?.includes("milestones_incomplete"));
});

Deno.test("evidence plus complete milestones is an accepted verdict", () => {
  const gate = evaluateGoalClaim(true, "URL is /dashboard and heading reads 'Welcome back'", true);
  assertEquals(gate.accepted, true);
  assertEquals(gate.rejection, undefined);
});

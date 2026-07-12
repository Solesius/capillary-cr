// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Pins the run-skeleton codegen: tool→Playwright mapping, source-safe
// escaping, failed-step quarantine, and the runsheet's action table.
import { assert, assertEquals } from "jsr:@std/assert";
import { buildAgentRunsheet, buildPlaywrightSpec } from "../src/services/driver_export.ts";
import { RetvCdpRunRecord } from "../src/domain/entities.ts";

function makeRecord(): RetvCdpRunRecord {
  return {
    runId: "retv_cdp_test1234",
    sessionId: "s1",
    goal: 'Verify login works with "quotes" in it',
    allowedOrigin: "http://localhost:4200",
    stopReason: "goal_achieved",
    functionalTestSucceeded: true,
    goalAchieved: true,
    startedAt: "2026-07-12T00:00:00.000Z",
    finishedAt: "2026-07-12T00:01:00.000Z",
    durationMs: 60_000,
    cycleCount: 2,
    milestonesCompleted: 2,
    milestonesTotal: 2,
    percent: 100,
    findings: ["interpretation: smoke-check the login flow"],
    summary: "ok",
    report: "# r",
    traceEnabled: true,
    trace: {
      screenshots: [],
      cycles: [
        {
          cycle: 1,
          startedAt: "2026-07-12T00:00:01.000Z",
          url: "http://localhost:4200/",
          title: "App",
          headings: [],
          interactiveLabels: [],
          toolCalls: [
            {
              tool: "navigate",
              args: { url: "http://localhost:4200/login" },
              reason: "open login",
            },
            {
              tool: "type",
              args: { selector: 'input[name="email"]', text: "a@b.dev" },
              reason: "fill email",
            },
          ],
          steps: [
            { index: 0, action: "navigate", ok: true, durationMs: 5 },
            { index: 1, action: "type", ok: true, durationMs: 5 },
          ],
          workUnitName: "w1",
          workUnitSuccess: true,
          failedSteps: 0,
          findings: [],
        },
        {
          cycle: 2,
          startedAt: "2026-07-12T00:00:20.000Z",
          url: "http://localhost:4200/login",
          title: "App",
          headings: [],
          interactiveLabels: [],
          toolCalls: [
            {
              tool: "assertText",
              args: { selector: "body", includes: "Welcome back" },
              reason: "verify landing",
            },
            { tool: "mystery", args: { x: 1 }, reason: "unknown tool" },
          ],
          steps: [
            { index: 0, action: "assertText", ok: false, durationMs: 5 },
            { index: 1, action: "mystery", ok: true, durationMs: 1 },
          ],
          workUnitName: "w2",
          workUnitSuccess: false,
          failedSteps: 1,
          findings: [],
        },
      ],
    },
  };
}

Deno.test("playwright spec maps tools and escapes selectors safely", () => {
  const spec = buildPlaywrightSpec(makeRecord());
  assert(spec.includes('await page.goto("http://localhost:4200/login");'));
  assert(spec.includes('await page.locator("input[name=\\"email\\"]").first().fill("a@b.dev");'));
  assert(spec.includes('import { expect, test } from "@playwright/test";'));
});

Deno.test("playwright spec quarantines steps that failed in the recorded run", () => {
  const spec = buildPlaywrightSpec(makeRecord());
  assert(spec.includes("FAILED in the recorded run"));
  // The failed assert is present but commented — never silently replayed.
  assert(spec.includes('// await expect(page.locator("body")'));
  assert(!spec.includes('\n  await expect(page.locator("body")'));
});

Deno.test("playwright spec comments unknown tools instead of guessing", () => {
  const spec = buildPlaywrightSpec(makeRecord());
  assert(spec.includes("// unsupported tool mystery"));
});

Deno.test("runsheet carries goal, ordered actions with intent, and outcomes", () => {
  const sheet = buildAgentRunsheet(makeRecord());
  assert(sheet.includes("## Goal"));
  assert(sheet.includes("| 1 | 1 | navigate |"));
  assert(sheet.includes("fill email"));
  assert(sheet.includes("| FAILED |"));
  assert(sheet.includes("interpretation: smoke-check the login flow"));
  assert(sheet.includes("whitespace-normalized"));
});

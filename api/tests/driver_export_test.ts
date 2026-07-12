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

Deno.test("unexecuted tail tool calls are quarantined, not laundered into passes", () => {
  const record = makeRecord();
  // Cycle 1 planned two calls but only executed the first (crashed mid-batch).
  record.trace!.cycles[0].steps = [record.trace!.cycles[0].steps[0]];
  const spec = buildPlaywrightSpec(record);
  assert(spec.includes('await page.goto("http://localhost:4200/login");'));
  assert(!spec.includes('\n  await page.locator("input[name=\\"email\\"]")'));
  assert(spec.includes("FAILED in the recorded run"));
});

Deno.test("assertText equals exports as exact toHaveText, not containment", () => {
  const record = makeRecord();
  record.trace!.cycles[1].toolCalls[0] = {
    tool: "assertText",
    args: { selector: "h1", equals: "Welcome back" },
    reason: "exact heading",
  };
  record.trace!.cycles[1].steps[0].ok = true;
  const spec = buildPlaywrightSpec(record);
  assert(spec.includes('toHaveText("Welcome back")'));
  assert(!spec.includes('toContainText("Welcome back")'));
});

Deno.test("typed credentials are redacted to env placeholders in both artifacts", () => {
  const record = makeRecord();
  record.trace!.cycles[0].toolCalls[1] = {
    tool: "type",
    args: { selector: 'input[type="password"]', text: "hunter2-super-secret" },
    reason: "fill password",
  };
  const spec = buildPlaywrightSpec(record);
  assert(!spec.includes("hunter2-super-secret"), "spec must not embed the secret");
  assert(spec.includes("process.env.CAP_SKELETON_SECRET_1"));
  assert(spec.includes("Provide via env: CAP_SKELETON_SECRET_1"));
  const sheet = buildAgentRunsheet(record);
  assert(!sheet.includes("hunter2-super-secret"), "runsheet must not embed the secret");
  assert(sheet.includes("redacted-secret"));
});

Deno.test("runsheet neutralizes backticks so args cannot break the table", () => {
  const record = makeRecord();
  record.trace!.cycles[0].toolCalls[1] = {
    tool: "type",
    args: { selector: "input", text: "payload with ` backtick" },
    reason: "backtick payload",
  };
  const sheet = buildAgentRunsheet(record);
  const row = sheet.split("\n").find((line) => line.includes("payload with"));
  assert(row !== undefined);
  assert(!row.includes("`payload"), "raw backtick must not survive inside the code span");
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assertEquals } from "./support/harness.ts";
import { test } from "./support/harness.ts";
import { markdownProse } from "../src/lib/markdown.ts";
import { buildPrSummaryComment } from "../src/services/review_agent_service.ts";
import type { ReviewAgentRunRecord } from "../src/domain/entities.ts";

test("markdown: tag-shaped tokens in prose become inline code", () => {
  // The text that swallowed a GitLab note: <title> is a raw-text element there.
  assertEquals(
    markdownProse("The <title> was changed from 'Knowledge Graph' to 'Knowledge Graprh'."),
    "The `<title>` was changed from 'Knowledge Graph' to 'Knowledge Graprh'.",
  );
  assertEquals(markdownProse("Close </textarea> and <div class=\"x\">"), "Close `</textarea>` and `<div class=\"x\">`");
});

test("markdown: existing code spans, fences and plain comparisons are untouched", () => {
  assertEquals(markdownProse("Already `<title>` quoted"), "Already `<title>` quoted");
  assertEquals(markdownProse("Use ``a `<b>` c`` here"), "Use ``a `<b>` c`` here");
  assertEquals(markdownProse("if a < b and c > d"), "if a < b and c > d");
  const fenced = "Before <p>\n```html\n<title>Knowledge Graph</title>\n```\nAfter <br>";
  assertEquals(markdownProse(fenced), "Before `<p>`\n```html\n<title>Knowledge Graph</title>\n```\nAfter `<br>`");
});

test("markdown: the review summary comment quotes tags in the model summary", () => {
  const record = {
    verdict: "request_changes",
    summary: "Changes the <title> element.",
    findingCount: 1,
    blockerCount: 0,
    highCount: 0,
    changedFileCount: 1,
    cycleCount: 2,
    model: "claude_code/sonnet",
    runId: "run_1",
  } as unknown as ReviewAgentRunRecord;
  const comment = buildPrSummaryComment(record);
  assertEquals(comment.includes("Changes the `<title>` element."), true);
  assertEquals(comment.includes("<sub>Posted by"), true);
});

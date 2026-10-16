// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assertEquals, test } from "./support/harness.ts";
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

test("markdown: autolinks keep rendering as links", () => {
  assertEquals(markdownProse("See <https://example.com/a?b=1> or <ops@example.com>"), "See <https://example.com/a?b=1> or <ops@example.com>");
  assertEquals(markdownProse("Self-closing <br/> and generic Promise<T>"), "Self-closing `<br/>` and generic Promise`<T>`");
});

test("markdown: a stray backtick does not leave later tags unprotected", () => {
  assertEquals(markdownProse("it's a ` typo, then <title> breaks"), "it's a ` typo, then `<title>` breaks");
});

test("markdown: tilde fences and longer fences close only on a long enough run", () => {
  assertEquals(markdownProse("~~~\n<title>x</title>\n~~~\n<p>"), "~~~\n<title>x</title>\n~~~\n`<p>`");
  // A ```` fence is not closed by ```: the inner line stays code.
  assertEquals(
    markdownProse("````\n```\n<title>x</title>\n````\nafter <p>"),
    "````\n```\n<title>x</title>\n````\nafter `<p>`",
  );
});

test("markdown: a code span closes only on a backtick run of the same length", () => {
  // The single backtick is unmatched (the `` run is longer), so <p> is prose.
  assertEquals(markdownProse("a `x`` <p>"), "a `x`` `<p>`");
  assertEquals(markdownProse("``a `<b>` c`` then <p>"), "``a `<b>` c`` then `<p>`");
});

test("markdown: a fence closes only on a bare run; four-space indent is not a fence", () => {
  // ```html inside a ``` block does not close it; the next bare ``` does.
  assertEquals(
    markdownProse("```\n```html\n<title>x</title>\n```\nafter <p>"),
    "```\n```html\n<title>x</title>\n```\nafter `<p>`",
  );
  assertEquals(markdownProse("    ```\n<p>"), "    ```\n`<p>`");
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
  assertEquals(comment.includes("Changes the <title>"), false);
});

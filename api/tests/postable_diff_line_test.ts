// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Regression coverage for the finding→diff-line resolver. Every finding must
// anchor to a line GitHub accepts as an inline comment (added/context on the
// new side); these pin the line-counting rules that make that reliable — in
// particular the `+++counter;` header-misread off-by-one.
import { assertEquals } from "jsr:@std/assert";
import { postableDiffLine } from "../src/services/review_agent_service.ts";

// New-side numbering: 10 ` ctx`, 11 `+added`, 12 ` tail`.
const SIMPLE = [
  "@@ -10,2 +10,3 @@",
  " ctx",
  "+added line with needleword",
  " tail",
].join("\n");

Deno.test("keeps the preferred line when it is genuinely commentable", () => {
  assertEquals(postableDiffLine(SIMPLE, 11, "unrelated"), 11);
  assertEquals(postableDiffLine(SIMPLE, 12, "unrelated"), 12);
});

Deno.test("rejects a preferred line outside the diff and falls back to the anchor match", () => {
  // 999 is not in the hunk; the anchor text matches the added line at 11.
  assertEquals(postableDiffLine(SIMPLE, 999, "the needleword issue"), 11);
});

Deno.test("falls back to the first commentable line when nothing anchors", () => {
  assertEquals(postableDiffLine(SIMPLE, 999, "zzz qqq"), 10);
});

Deno.test("no patch returns the model's line unchanged", () => {
  assertEquals(postableDiffLine("", 7, "whatever"), 7);
  assertEquals(postableDiffLine("", undefined, "whatever"), undefined);
});

Deno.test("deletion lines never advance the new-side counter", () => {
  // New side: 5 ` keep`, (deletion), 6 `+replacement`, 7 ` after`.
  const patch = [
    "@@ -5,3 +5,3 @@",
    " keep",
    "-removed",
    "+replacement",
    " after",
  ].join("\n");
  assertEquals(postableDiffLine(patch, 6, ""), 6);
  assertEquals(postableDiffLine(patch, 7, ""), 7);
  // The deleted line's old number is not a valid new-side target; 999 forces
  // fallback and the first commentable line is 5.
  assertEquals(postableDiffLine(patch, 999, ""), 5);
});

Deno.test("an added `++counter;` line is content, not a header — no off-by-one", () => {
  // New side: 3 ` ctx`, 4 `+++counter;` (added content `++counter;`), 5 ` tail`,
  // 6 `+final marker line`.
  const patch = [
    "@@ -3,2 +3,4 @@",
    " ctx",
    "+++counter;",
    " tail",
    "+final marker line",
  ].join("\n");
  // The regression: treating `+++counter;` as a file header skipped it without
  // advancing the counter, so every later line resolved one off (5 -> 4, 6 -> 5).
  assertEquals(postableDiffLine(patch, 4, ""), 4); // the ++counter; line itself
  assertEquals(postableDiffLine(patch, 5, ""), 5); // tail keeps its true number
  assertEquals(postableDiffLine(patch, 6, ""), 6); // later added line too
  // And anchoring by content lands on the true line, not the shifted one.
  assertEquals(postableDiffLine(patch, undefined, "final marker line"), 6);
});

Deno.test("a deleted `--x;` line (rendered ---x;) is skipped without desync", () => {
  // New side: 8 ` a`, (deletion `--x;`), 9 ` b`.
  const patch = [
    "@@ -8,3 +8,2 @@",
    " a",
    "---x;",
    " b",
  ].join("\n");
  assertEquals(postableDiffLine(patch, 9, ""), 9);
});

Deno.test("multiple hunks each reset the new-side counter from their header", () => {
  const patch = [
    "@@ -1,2 +1,2 @@",
    " one",
    "+two",
    "@@ -40,2 +50,2 @@",
    " fifty",
    "+fifty-one has anchorable text",
  ].join("\n");
  assertEquals(postableDiffLine(patch, 2, ""), 2);
  assertEquals(postableDiffLine(patch, 51, ""), 51);
  assertEquals(postableDiffLine(patch, 999, "anchorable text here"), 51);
});

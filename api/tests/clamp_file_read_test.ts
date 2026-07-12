// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Pins the line-aware read truncation: cuts on a line boundary and hands the
// model a precise readFileSlice continuation instead of a dead-end char count.
import { assert, assertEquals } from "jsr:@std/assert";
import { clampFileRead } from "../src/services/review_agent_service.ts";

Deno.test("clampFileRead passes short content through untouched", () => {
  const content = "line one\nline two";
  assertEquals(clampFileRead(content, 100, "a.ts"), content);
});

Deno.test("clampFileRead cuts on a line boundary, never mid-line", () => {
  // 5 lines of 10 chars (incl. newline); limit 25 lands mid-line-3.
  const content = ["aaaaaaaaa", "bbbbbbbbb", "ccccccccc", "ddddddddd", "eeeeeeeee"].join("\n");
  const out = clampFileRead(content, 25, "src/x.ts");
  assert(out.startsWith("aaaaaaaaa\nbbbbbbbbb\n…["));
  assert(!out.includes("ccc"), "partial line must not leak through");
});

Deno.test("clampFileRead names the shown range and the exact continuation call", () => {
  const content = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join("\n");
  const out = clampFileRead(content, 80, "src/deep/file.ts");
  assert(out.includes("of 50"), "must state the file's total line count");
  assert(
    out.includes('readFileSlice {path: "src/deep/file.ts", startLine:'),
    "must hand the model a ready-to-use continuation call",
  );
  // The advertised startLine continues exactly where the cut ended.
  const shown = out.slice(0, out.indexOf("\n…[")).split("\n").length;
  assert(out.includes(`startLine: ${shown + 1}`));
});

Deno.test("clampFileRead survives content with no newline before the limit", () => {
  const content = "x".repeat(300);
  const out = clampFileRead(content, 100, "blob.bin");
  assert(out.includes("…[truncated"));
  assert(out.length < content.length + 200);
});

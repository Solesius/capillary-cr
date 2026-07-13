// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Pins the spatial page digest the planner reasons over: compact ranked ref
// lines with role|region tags — the low-token contract adapted from emet's
// torus mapper (roles + bbox regions, no manifold).
import { assert, assertEquals } from "jsr:@std/assert";
import { formatPageDigest } from "../src/services/cdp_retv_agent_service.ts";

const FIXTURE = {
  url: "https://github.com/Solesius/capillary-cr",
  title: "Solesius/capillary-cr",
  interactiveCount: 143,
  scrollY: 0,
  pageHeight: 4200,
  headings: ["capillary-cr", "About"],
  nodes: [
    { ref: "e1", role: "nav", region: "right", label: "Releases 16", tag: "a" },
    { ref: "e2", role: "action", region: "main", label: "Code", tag: "button" },
    { ref: "e3", role: "input", region: "header", label: "Search", tag: "input" },
  ],
};

Deno.test("digest header carries page identity, density and scroll position", () => {
  const digest = formatPageDigest(FIXTURE);
  const head = digest.split("\n")[0];
  assert(head.includes('"Solesius/capillary-cr"'));
  assert(head.includes("143 interactive (top 3)"));
  assert(head.includes("scrollY 0/4200"));
});

Deno.test("digest lines are the compact ref grammar the prompt teaches", () => {
  const digest = formatPageDigest(FIXTURE);
  assert(digest.includes('e1 [nav|right] "Releases 16" <a>'));
  assert(digest.includes('e2 [action|main] "Code" <button>'));
  assert(digest.includes('e3 [input|header] "Search" <input>'));
});

Deno.test("digest stays lean — roughly ten tokens per element line", () => {
  const digest = formatPageDigest(FIXTURE);
  // 3 nodes + header + headings ≈ well under a kilobyte; the old path dumped
  // multi-KB JSON or 2KB of raw HTML for the same information.
  assert(digest.length < 500, `digest unexpectedly fat: ${digest.length} chars`);
});

Deno.test("digest tolerates missing optional fields", () => {
  const digest = formatPageDigest({ nodes: [], headings: [] });
  assertEquals(digest.split("\n").length, 1);
});

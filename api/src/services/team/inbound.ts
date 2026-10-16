// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// inbound.ts — Slack slash-command support (issue #46, 1.2). One endpoint,
// signed-secret verified (Slack signing secret v0 scheme), two commands:
//
//   /capillary review owner/repo#123   -> start a review session
//   /capillary review gitlab:g/p#7     -> same, on a named code host
//   /capillary status                  -> live session summary
//
// No socket mode, no hosted bot: Slack POSTs the form here directly.

import { sourceOf } from "../code_host.ts";

export type RepositorySource = "github" | "gitlab";

/** Parse the slash-command text into a typed command. */
export type InboundCommand =
  | { kind: "review"; ownerRepo: string; prNumber: string; source?: RepositorySource }
  | { kind: "status" }
  | { kind: "unknown"; text: string };

export function parseInboundCommand(text: string): InboundCommand {
  const trimmed = text.trim();
  if (/^status$/i.test(trimmed)) {
    return { kind: "status" };
  }
  const review = trimmed.match(
    /^review\s+(?:(github|gitlab):)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*#(\d+)$/i,
  );
  if (review) {
    const source = review[1]?.toLowerCase() as RepositorySource | undefined;
    return {
      kind: "review",
      ownerRepo: review[2],
      prNumber: review[3],
      ...(source ? { source } : {}),
    };
  }
  return { kind: "unknown", text: trimmed };
}

export type RepositoryPick<T> =
  | { kind: "found"; repo: T }
  | { kind: "none" }
  | { kind: "ambiguous"; matches: T[] };

/**
 * Choose the repository a Slack command names. An exact full-name match is
 * required. A `github:` or `gitlab:` prefix narrows the match to that host.
 * Several matches after narrowing are ambiguous, and the caller asks for a prefix.
 */
export function pickRepository<T extends { id: string; fullName: string }>(
  repos: readonly T[],
  ownerRepo: string,
  source?: RepositorySource,
): RepositoryPick<T> {
  const wanted = ownerRepo.toLowerCase();
  const matches = repos.filter((repo) =>
    repo.fullName.toLowerCase() === wanted && (!source || sourceOf(repo.id) === source)
  );
  if (matches.length === 0) {
    return { kind: "none" };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", matches };
  }
  return { kind: "found", repo: matches[0] };
}

/**
 * Slack request verification (v0): HMAC-SHA256 over `v0:{timestamp}:{body}`
 * with the app's signing secret; reject stale timestamps (>5 min) to stop
 * replay. https://api.slack.com/authentication/verifying-requests-from-slack
 */
export async function verifySlackSignature(
  signingSecret: string,
  body: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  nowSeconds?: number,
): Promise<boolean> {
  if (!timestampHeader || !signatureHeader?.startsWith("v0=")) {
    return false;
  }
  const timestamp = Number(timestampHeader);
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 300) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`v0:${timestampHeader}:${body}`),
    ),
  );
  const expected = `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  if (expected.length !== signatureHeader.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}

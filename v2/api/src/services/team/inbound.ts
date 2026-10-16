// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// inbound.ts — Slack slash-command support (issue #46, 1.2). One endpoint,
// signed-secret verified (Slack signing secret v0 scheme), two commands:
//
//   /capillary review owner/repo#123   -> start a review session
//   /capillary status                  -> live session summary
//
// No socket mode, no hosted bot: Slack POSTs the form here directly.

/** Parse the slash-command text into a typed command. */
export type InboundCommand =
  | { kind: "review"; ownerRepo: string; prNumber: string }
  | { kind: "status" }
  | { kind: "unknown"; text: string };

export function parseInboundCommand(text: string): InboundCommand {
  const trimmed = text.trim();
  if (/^status$/i.test(trimmed)) {
    return { kind: "status" };
  }
  const review = trimmed.match(
    /^review\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*#(\d+)$/i,
  );
  if (review) {
    return { kind: "review", ownerRepo: review[1], prNumber: review[2] };
  }
  return { kind: "unknown", text: trimmed };
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

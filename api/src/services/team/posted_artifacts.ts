// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// posted_artifacts.ts — shared posted-state for review runs. When a human
// publishes a finding/suggestion/summary to GitHub, the artifact URL lands on
// the persisted run record so every attached client (and every teammate) sees
// the same "posted ✓" truth — instead of the client-local state that let a
// second browser re-post a duplicate.

import { PostedArtifact, ReviewAgentRunRecord } from "../../domain/entities.ts";

/**
 * Return the artifact list with `artifact` recorded, replacing any prior
 * entry for the same target — a re-post refreshes the URL, never duplicates
 * the row. Pure; the caller persists the updated record.
 */
export function withPostedArtifact(
  existing: PostedArtifact[] | undefined,
  artifact: PostedArtifact,
): PostedArtifact[] {
  const rest = (existing ?? []).filter(
    (item) => !(item.kind === artifact.kind && item.findingId === artifact.findingId),
  );
  return [...rest, artifact];
}

/** Stamp one published artifact onto a run record (mutates the record copy passed in). */
export function recordPostedArtifact(
  record: ReviewAgentRunRecord,
  input: { kind: PostedArtifact["kind"]; findingId?: string; url: string },
): PostedArtifact {
  const artifact: PostedArtifact = { ...input, postedAt: new Date().toISOString() };
  record.postedArtifacts = withPostedArtifact(record.postedArtifacts, artifact);
  return artifact;
}

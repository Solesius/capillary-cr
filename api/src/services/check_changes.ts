// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// check_changes.ts — delta re-review ("Check changes"). Born from live
// dogfooding: a full review found findings, fixes were pushed, and the only
// verification path was re-paying the entire review to confirm two fixes.
// The follow-up question is much smaller than the original; this prices it
// that way — only the compare delta enters the model's context.
//
// Honesty rules (standing law):
//   * a "fixed" classification must cite evidence from the delta — never the
//     commit message; when the delta can't prove it, the status is
//     "unverifiable" and says so.
//   * new findings obey the same structured contract as full reviews.
//   * an approve verdict cannot coexist with still-present or new findings —
//     the deterministic guard overrides to request_changes.
//
// Pure functions here (prompt build, reply parsing, report build, verdict
// guard) — the network/orchestration lives on ReviewAgentService.

import { PostedArtifact, ReviewFinding } from "../domain/entities.ts";

export interface DeltaFile {
  path: string;
  status: string;
  patch?: string;
}

export type ResolutionStatus = "fixed" | "still_present" | "unverifiable";

export interface FindingResolution {
  findingId: string;
  title: string;
  status: ResolutionStatus;
  evidence: string;
}

export interface CheckChangesReply {
  resolutions: FindingResolution[];
  newFindings: {
    severity: string;
    filePath: string;
    line?: number;
    title: string;
    finding: string;
    evidence: string[];
  }[];
  verdict: string;
  summary: string;
}

const MAX_PATCH_CHARS = 4_000;
const MAX_TOTAL_PATCH_CHARS = 60_000;

export const CHECK_CHANGES_SYSTEM_PROMPT =
  `You are Capillary's follow-up reviewer. A prior review recorded findings; new commits ` +
  `have landed since. You receive ONLY the prior findings and the compare delta.\n` +
  `Tasks:\n` +
  `1. For EACH prior finding, classify: "fixed" (the delta demonstrably addresses it — cite ` +
  `the hunk), "still_present" (the delta touches the area but the defect remains, or clearly ` +
  `does not address it), or "unverifiable" (the delta gives no evidence either way — say so; ` +
  `NEVER infer a fix from commit messages or intent).\n` +
  `2. Review the delta hunks themselves for NEW defects introduced by these commits.\n` +
  `3. Verdict for the follow-up: "approve" only when nothing is still present and nothing new ` +
  `was found.\n` +
  `Reply with STRICT JSON only:\n` +
  `{"resolutions":[{"findingId","status","evidence"}],` +
  `"newFindings":[{"severity","filePath","line","title","finding","evidence":[]}],` +
  `"verdict","summary"}`;

/** Build the single-call user message: prior findings + clamped delta. */
export function buildCheckChangesPrompt(
  priorFindings: readonly ReviewFinding[],
  delta: readonly DeltaFile[],
): string {
  const findings = priorFindings.map((finding) => ({
    findingId: finding.id,
    severity: finding.severity,
    filePath: finding.filePath,
    line: finding.line,
    title: finding.title,
    finding: finding.finding,
  }));
  const parts: string[] = [
    `PRIOR FINDINGS (classify every one):`,
    JSON.stringify(findings, null, 1),
    ``,
    `DELTA since the reviewed commit (${delta.length} file${delta.length === 1 ? "" : "s"}):`,
  ];
  let total = 0;
  for (const file of delta) {
    const patch = (file.patch ?? "(no patch — binary or too large)").slice(0, MAX_PATCH_CHARS);
    if (total + patch.length > MAX_TOTAL_PATCH_CHARS) {
      parts.push(`… delta truncated at ${MAX_TOTAL_PATCH_CHARS} chars — remaining files omitted.`);
      break;
    }
    total += patch.length;
    parts.push(``, `--- ${file.path} (${file.status}) ---`, patch);
  }
  return parts.join("\n");
}

/**
 * Coerce the planner's JSON into a typed reply. Unknown finding ids and
 * malformed rows drop; prior findings the model skipped come back as
 * "unverifiable" — silence is never laundered into resolution.
 */
export function parseCheckChangesReply(
  payload: Record<string, unknown>,
  priorFindings: readonly ReviewFinding[],
): CheckChangesReply {
  const known = new Map(priorFindings.map((finding) => [finding.id, finding]));
  const resolutions: FindingResolution[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(payload.resolutions) ? payload.resolutions : []) {
    const row = raw as Record<string, unknown>;
    const findingId = String(row.findingId ?? "");
    const prior = known.get(findingId);
    if (!prior || seen.has(findingId)) {
      continue;
    }
    const status = row.status === "fixed" || row.status === "still_present"
      ? row.status
      : "unverifiable";
    seen.add(findingId);
    resolutions.push({
      findingId,
      title: prior.title,
      status,
      evidence: String(row.evidence ?? "").slice(0, 500),
    });
  }
  for (const prior of priorFindings) {
    if (!seen.has(prior.id)) {
      resolutions.push({
        findingId: prior.id,
        title: prior.title,
        status: "unverifiable",
        evidence: "not classified by the follow-up model",
      });
    }
  }

  const newFindings: CheckChangesReply["newFindings"] = [];
  for (const raw of Array.isArray(payload.newFindings) ? payload.newFindings : []) {
    const row = raw as Record<string, unknown>;
    const title = String(row.title ?? "").trim();
    const finding = String(row.finding ?? "").trim();
    const filePath = String(row.filePath ?? row.path ?? "").trim();
    if (!title || !finding || !filePath) {
      continue;
    }
    const line = Number(row.line);
    newFindings.push({
      severity: String(row.severity ?? "medium"),
      filePath,
      line: Number.isFinite(line) && line > 0 ? line : undefined,
      title,
      finding,
      evidence: Array.isArray(row.evidence) ? row.evidence.map((e) => String(e)) : [],
    });
  }

  // Verdicts are a closed set; anything else the model invents degrades to
  // "comment" rather than flowing downstream as an unknown state.
  const rawVerdict = String(payload.verdict ?? "comment");
  const verdict = rawVerdict === "approve" || rawVerdict === "request_changes"
    ? rawVerdict
    : "comment";
  return {
    resolutions,
    newFindings,
    verdict,
    summary: String(payload.summary ?? "").slice(0, 2000),
  };
}

/** Approve cannot coexist with unresolved or new defects — deterministic. */
export function guardFollowUpVerdict(reply: CheckChangesReply): string {
  const unresolved = reply.resolutions.filter((r) => r.status !== "fixed").length;
  if (reply.verdict === "approve" && (unresolved > 0 || reply.newFindings.length > 0)) {
    return "request_changes";
  }
  return reply.verdict;
}

const STATUS_BADGE: Record<ResolutionStatus, string> = {
  fixed: "✅ fixed",
  still_present: "🛑 still present",
  unverifiable: "❓ unverifiable from delta",
};

/** Deterministic follow-up report. */
export function buildCheckChangesReport(input: {
  priorRunId: string;
  baseSha: string;
  headSha: string;
  reply: CheckChangesReply;
  verdict: string;
  deltaFileCount: number;
}): string {
  const fixed = input.reply.resolutions.filter((r) => r.status === "fixed").length;
  const lines: string[] = [
    `# Follow-up Review (Check changes)`,
    ``,
    `## Verdict`,
    `**${input.verdict}** — ${fixed}/${input.reply.resolutions.length} prior finding${
      input.reply.resolutions.length === 1 ? "" : "s"
    } fixed · ${input.reply.newFindings.length} new.`,
    ``,
    `Prior run \`${input.priorRunId}\` · delta \`${input.baseSha.slice(0, 7)}…${
      input.headSha.slice(0, 7)
    }\` (${input.deltaFileCount} files).`,
    ``,
    `## Prior findings`,
    ``,
    `| Finding | Status | Evidence |`,
    `|---|---|---|`,
    ...input.reply.resolutions.map((r) =>
      `| ${r.title.replaceAll("|", "\\|")} | ${STATUS_BADGE[r.status]} | ${
        (r.evidence || "—").replaceAll("|", "\\|").replaceAll("\n", " ")
      } |`
    ),
  ];
  if (input.reply.newFindings.length > 0) {
    lines.push(``, `## New findings in the delta`);
    for (const finding of input.reply.newFindings) {
      lines.push(
        `- **[${finding.severity.toUpperCase()}] ${finding.title}** — ${finding.filePath}${
          finding.line ? `:${finding.line}` : ""
        }: ${finding.finding}`,
      );
    }
  }
  if (input.reply.summary) {
    lines.push(``, `## Summary`, input.reply.summary);
  }
  return lines.join("\n");
}

/**
 * Carry still-present prior findings into the follow-up run — WITH their
 * posted-artifact state, so a finding already posted/dispatched from the
 * prior run renders "posted ✓" in the follow-up instead of a re-postable
 * button (flagged HIGH by capillary's live review of this feature: the
 * carriedArtifacts half of this contract was previously dead).
 */
export function carryStillPresentFindings(
  priorFindings: readonly ReviewFinding[],
  resolutions: readonly FindingResolution[],
  newRunId: string,
  priorArtifacts: readonly PostedArtifact[] = [],
): { findings: ReviewFinding[]; carriedArtifacts: PostedArtifact[] } {
  const still = new Set(
    resolutions.filter((r) => r.status !== "fixed").map((r) => r.findingId),
  );
  const findings = priorFindings
    .filter((finding) => still.has(finding.id))
    .map((finding) => ({ ...finding, runId: newRunId }));
  const carriedArtifacts = priorArtifacts.filter(
    (artifact) => artifact.findingId !== undefined && still.has(artifact.findingId),
  );
  return { findings, carriedArtifacts };
}

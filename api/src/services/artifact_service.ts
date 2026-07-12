// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { AppError } from "../domain/errors.ts";
import { ReviewFinding } from "../domain/entities.ts";
import { lensToGate, TCSRTC_GATES } from "../domain/review_phase.ts";
import { enforceDefensiveInput } from "../lib/validation.ts";
import { ReviewRepository } from "../repositories/review_repository.ts";

export class ArtifactService {
  constructor(private readonly repository: ReviewRepository) {}

  async exportMarkdownReview(runId: string): Promise<string> {
    enforceDefensiveInput(runId, "run_id");
    const run = await this.repository.getReviewRun(runId);
    if (run.status !== "completed") {
      throw new AppError("review_not_complete", 409, "review_not_complete");
    }

    const findings = await this.repository.getFindings(runId);
    const checklist = await this.repository.getChecklist(runId);
    const events = await this.repository.listReviewEvents(runId);
    const graph = await this.repository.findGraphByPullRequest(run.pullRequestId);

    const findingsByGate = groupFindingsByGate(findings);
    const findingLines = findings.length === 0
      ? ["- No findings"]
      : TCSRTC_GATES.flatMap((gate) => {
        const gateFindings = findingsByGate.get(gate) || [];
        if (gateFindings.length === 0) {
          return [];
        }
        const lines = [`### ${gate} Gate`, `- Findings: ${gateFindings.length}`];
        for (const finding of gateFindings) {
          lines.push(
            `- [${finding.severity}] ${finding.title} (${finding.filePath}:${
              finding.line ?? "n/a"
            }) [gate=${gate}; confidence=${finding.confidence.toFixed(2)}]`,
          );
        }
        lines.push("");
        return lines;
      });
    const checklistLines = checklist.length === 0
      ? ["- No checklist items"]
      : checklist.flatMap((item) => {
        const lines = [`- [ ] ${item.description}`];
        if (item.command) {
          lines.push(`  - command: ${item.command}`);
        }
        return lines;
      });

    const graphHealthLines = !graph ? ["- Graph unavailable"] : [
      `- Flow completeness: ${graph.dag.flowCompleteness.toFixed(3)}`,
      `- Torus variance: ${graph.dag.torusVariance.toFixed(3)}`,
      `- Saturation: ${graph.dag.saturation.toFixed(3)}`,
      ...graph.dag.completenessNotes.map((note) => `- ${note}`),
    ];

    const llmStageLines = buildLlmStageLines(events, findings);

    return [
      `# Capillary Review ${run.id}`,
      "",
      `Status: ${run.status}`,
      `Pull Request: ${run.pullRequestId}`,
      "",
      "## Graph Health",
      ...graphHealthLines,
      "",
      "## LLM Stage",
      ...llmStageLines,
      "",
      "## Findings (TCSRTC Gates)",
      ...findingLines,
      "",
      "## Checklist",
      ...checklistLines,
    ].join("\n");
  }

  async exportGraphJson(runId: string): Promise<string> {
    enforceDefensiveInput(runId, "run_id");
    const run = await this.repository.getReviewRun(runId);
    const graph = await this.repository.findGraphByPullRequest(run.pullRequestId);
    if (!graph) {
      throw new AppError("diff_dag_not_found", 404, "diff_dag_not_found");
    }

    return JSON.stringify(graph, null, 2);
  }
}

function groupFindingsByGate(findings: ReviewFinding[]): Map<string, ReviewFinding[]> {
  const map = new Map<string, ReviewFinding[]>();

  for (const gate of TCSRTC_GATES) {
    map.set(gate, []);
  }

  for (const finding of findings) {
    // passName may hold a gate (current runs) or a legacy lens (old stored
    // runs) — lensToGate handles both, defaulting unknowns to Review.
    const gate = (TCSRTC_GATES as readonly string[]).includes(finding.passName)
      ? finding.passName
      : lensToGate(finding.passName);
    const existing = map.get(gate) || [];
    existing.push(finding);
    map.set(gate, existing);
  }

  return map;
}

function buildLlmStageLines(events: string[], findings: ReviewFinding[]): string[] {
  const requestDispatched = events.some((event) => event.startsWith("llm:request_dispatched"));
  const responseEvent = events.find((event) => event.startsWith("llm:response_received"));
  const mergeEvent = events.find((event) => event.startsWith("llm:merge_strategy="));

  const responseCountMatch = /findings=(\d+)/.exec(responseEvent || "");
  const responseCount = responseCountMatch ? Number(responseCountMatch[1]) : null;

  let mergeStrategy = "none";
  let actionableCount = "0";
  let passCount = "0";
  if (mergeEvent) {
    const strategyMatch = /llm:merge_strategy=([^:]+)/.exec(mergeEvent);
    const actionableMatch = /actionable=(\d+)/.exec(mergeEvent);
    const passMatch = /passes=(\d+)/.exec(mergeEvent);
    mergeStrategy = strategyMatch?.[1] || "unknown";
    actionableCount = actionableMatch?.[1] || "0";
    passCount = passMatch?.[1] || "0";
  }

  const providerEvidenceCount =
    findings.filter((finding) => finding.evidence.some((line) => line.startsWith("provider.kind=")))
      .length;

  return [
    `- Invoked: ${requestDispatched ? "yes" : "no"}`,
    `- Response findings: ${responseCount === null ? "unknown" : responseCount}`,
    `- Merge strategy: ${mergeStrategy}`,
    `- Actionable LLM findings: ${actionableCount}`,
    `- Pass coverage from LLM findings: ${passCount}`,
    `- Final findings carrying provider evidence: ${providerEvidenceCount}`,
  ];
}

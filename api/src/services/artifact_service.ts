// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { AppError } from "../domain/errors.ts";
import { ReviewFinding } from "../domain/entities.ts";
import { enforceDefensiveInput } from "../lib/validation.ts";
import { ReviewRepository } from "../repositories/review_repository.ts";

const TCSRCT_PASS_ORDER = ["Trace", "Contracts", "State", "Runtime", "CodeShape", "Tests"] as const;

export class ArtifactService {
  constructor(private readonly repository: ReviewRepository) {}

  exportMarkdownReview(runId: string): string {
    enforceDefensiveInput(runId, "run_id");
    const run = this.repository.getReviewRun(runId);
    if (run.status !== "completed") {
      throw new AppError("review_not_complete", 409, "review_not_complete");
    }

    const findings = this.repository.getFindings(runId);
    const checklist = this.repository.getChecklist(runId);
    const events = this.repository.listReviewEvents(runId);
    const graph = this.repository.findGraphByPullRequest(run.pullRequestId);

    const findingsByPass = groupFindingsByPass(findings);
    const findingLines = findings.length === 0
      ? ["- No findings"]
      : TCSRCT_PASS_ORDER.flatMap((passName) => {
        const passFindings = findingsByPass.get(passName) || [];
        const lines = [`### ${passName} Pass`, `- Findings: ${passFindings.length}`];
        if (passFindings.length === 0) {
          lines.push("- No findings for this pass");
          lines.push("");
          return lines;
        }

        for (const finding of passFindings) {
          lines.push(
            `- [${finding.severity}] ${finding.title} (${finding.filePath}:${finding.line ?? "n/a"}) [pass=${finding.passName}; confidence=${finding.confidence.toFixed(2)}]`,
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

    const graphHealthLines = !graph
      ? ["- Graph unavailable"]
      : [
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
      "## Findings (TCSRCT Structured)",
      ...findingLines,
      "",
      "## Checklist",
      ...checklistLines,
    ].join("\n");
  }

  exportGraphJson(runId: string): string {
    enforceDefensiveInput(runId, "run_id");
    const run = this.repository.getReviewRun(runId);
    const graph = this.repository.findGraphByPullRequest(run.pullRequestId);
    if (!graph) {
      throw new AppError("diff_dag_not_found", 404, "diff_dag_not_found");
    }

    return JSON.stringify(graph, null, 2);
  }
}

function groupFindingsByPass(findings: ReviewFinding[]): Map<string, ReviewFinding[]> {
  const map = new Map<string, ReviewFinding[]>();

  for (const pass of TCSRCT_PASS_ORDER) {
    map.set(pass, []);
  }

  for (const finding of findings) {
    const passName = TCSRCT_PASS_ORDER.includes(finding.passName as (typeof TCSRCT_PASS_ORDER)[number])
      ? finding.passName
      : "CodeShape";
    const existing = map.get(passName) || [];
    existing.push(finding);
    map.set(passName, existing);
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

  const providerEvidenceCount = findings.filter((finding) =>
    finding.evidence.some((line) => line.startsWith("provider.kind="))
  ).length;

  return [
    `- Invoked: ${requestDispatched ? "yes" : "no"}`,
    `- Response findings: ${responseCount === null ? "unknown" : responseCount}`,
    `- Merge strategy: ${mergeStrategy}`,
    `- Actionable LLM findings: ${actionableCount}`,
    `- Pass coverage from LLM findings: ${passCount}`,
    `- Final findings carrying provider evidence: ${providerEvidenceCount}`,
  ];
}

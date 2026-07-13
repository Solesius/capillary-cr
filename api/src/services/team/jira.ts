// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// jira.ts — finding → Jira ticket (issue #46 Pillar D). Human-initiated per
// the standing law: a button per finding, never automatic. Configured
// entirely from server env (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN,
// JIRA_PROJECT_KEY); the API token never travels to a client.

import { ReviewFinding } from "../../domain/entities.ts";

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
}

export function jiraConfigFromEnv(
  env: Record<string, string | undefined>,
): JiraConfig | null {
  const baseUrl = env.JIRA_BASE_URL?.trim().replace(/\/+$/, "");
  const email = env.JIRA_EMAIL?.trim();
  const apiToken = env.JIRA_API_TOKEN?.trim();
  const projectKey = env.JIRA_PROJECT_KEY?.trim();
  if (!baseUrl || !email || !apiToken || !projectKey) {
    return null;
  }
  return { baseUrl, email, apiToken, projectKey };
}

/** Pure: one finding → the Jira create-issue body (ADF description). */
export function buildJiraIssuePayload(
  projectKey: string,
  finding: ReviewFinding,
  context: { prTitle: string; runLink: string | null },
): Record<string, unknown> {
  const paragraphs: Record<string, unknown>[] = [
    adfParagraph(finding.finding),
    adfParagraph(`File: ${finding.filePath}${finding.line ? `:${finding.line}` : ""}`),
  ];
  for (const evidence of finding.evidence.slice(0, 5)) {
    paragraphs.push(adfParagraph(`Evidence: ${evidence}`));
  }
  if (finding.suggestedFix) {
    paragraphs.push(adfParagraph(`Suggested fix: ${finding.suggestedFix}`));
  }
  paragraphs.push(
    adfParagraph(
      `From Capillary review of "${context.prTitle}"${
        context.runLink ? ` — ${context.runLink}` : ""
      }`,
    ),
  );
  return {
    fields: {
      project: { key: projectKey },
      issuetype: { name: "Bug" },
      summary: `[${finding.severity.toUpperCase()}] ${finding.title}`.slice(0, 250),
      description: { type: "doc", version: 1, content: paragraphs },
      labels: ["capillary", `severity-${finding.severity}`],
    },
  };
}

function adfParagraph(text: string): Record<string, unknown> {
  return { type: "paragraph", content: [{ type: "text", text: text.slice(0, 2000) }] };
}

export class JiraService {
  #config: JiraConfig | null;
  #fetch: typeof fetch;

  constructor(config: JiraConfig | null, options: { fetchFn?: typeof fetch } = {}) {
    this.#config = config;
    this.#fetch = options.fetchFn ?? fetch;
  }

  configured(): boolean {
    return this.#config !== null;
  }

  async createIssue(
    finding: ReviewFinding,
    context: { prTitle: string; runLink: string | null },
  ): Promise<{ key: string; url: string }> {
    if (!this.#config) {
      throw new Error("jira_not_configured");
    }
    const response = await this.#fetch(`${this.#config.baseUrl}/rest/api/3/issue`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${this.#config.email}:${this.#config.apiToken}`)}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(buildJiraIssuePayload(this.#config.projectKey, finding, context)),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `jira_create_failed_${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }
    const dto = await response.json() as { key?: string };
    const key = String(dto.key ?? "");
    return { key, url: `${this.#config.baseUrl}/browse/${key}` };
  }
}

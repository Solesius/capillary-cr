// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// checks.ts — publish review verdicts as GitHub check runs (merge-box ✓/✗),
// the honest `capillary[bot]` surface a GitHub App unlocks. Subscribes to the
// team bus; runs only when an app is configured. Publishing failures log and
// stop there — a checks hiccup can never affect the review that emitted.

import { ReviewFinishedEvent, TeamEvent, TeamEventBus } from "./event_bus.ts";

/** The slice of GithubAppService the publisher needs (test-fakeable). */
export interface AppTokenSource {
  configured(): boolean;
  installationToken(): Promise<string>;
}

export interface CheckRunPayload {
  name: string;
  head_sha: string;
  status: "completed";
  conclusion: "success" | "neutral" | "action_required" | "cancelled";
  details_url?: string;
  output: { title: string; summary: string };
}

/** Pure builder: one review event → the check-run body GitHub receives. */
export function buildCheckRun(
  event: ReviewFinishedEvent,
  headSha: string,
  deepLink: string | null,
): CheckRunPayload {
  const cancelled = event.type === "review.cancelled";
  const conclusion = cancelled
    ? "cancelled"
    : event.verdict === "approve"
    ? "success"
    : event.verdict === "request_changes"
    ? "action_required"
    : "neutral";
  const title = cancelled
    ? `Stopped after ${event.cycleCount} cycles`
    : `${event.verdict.replace("_", " ")} — ${event.findingCount} finding${
      event.findingCount === 1 ? "" : "s"
    } (${event.blockerCount} blocker, ${event.highCount} high)`;
  const tokens = (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
  const lines = [
    `**${event.title}**`,
    "",
    `- Cycles: ${event.cycleCount} · ${Math.round(event.durationMs / 1000)}s`,
    ...(event.model ? [`- Model: ${event.model}`] : []),
    ...(tokens > 0
      ? [
        `- Tokens: in ${(event.inputTokens ?? 0).toLocaleString()} · out ${
          (event.outputTokens ?? 0).toLocaleString()
        }`,
      ]
      : []),
    ...(event.topFindings.length > 0 ? ["", "**Top findings**"] : []),
    ...event.topFindings.map((f) =>
      `- [${f.severity.toUpperCase()}] ${f.title} — \`${f.filePath}${f.line ? `:${f.line}` : ""}\``
    ),
    "",
    `<sub>Published by [Capillary](https://github.com/Solesius/capillary-cr)</sub>`,
  ];
  return {
    name: "Capillary review",
    head_sha: headSha,
    status: "completed",
    conclusion,
    ...(deepLink ? { details_url: deepLink } : {}),
    output: { title, summary: lines.join("\n") },
  };
}

export interface CheckPublisherDeps {
  app: AppTokenSource;
  /** Resolve repo full name + PR head sha for the event. */
  resolveTarget: (
    repositoryId: string,
    pullRequestId: string,
  ) => Promise<{ fullName: string; headSha: string } | null>;
  deepLink: (runId: string) => string | null;
  fetchFn?: typeof fetch;
  /** CAPILLARY_CHECKS=0 disables; default on when the app is configured. */
  enabled?: boolean;
}

export class CheckPublisher {
  #deps: CheckPublisherDeps;
  #fetch: typeof fetch;

  constructor(deps: CheckPublisherDeps) {
    this.#deps = deps;
    this.#fetch = deps.fetchFn ?? fetch;
  }

  start(bus: TeamEventBus): () => void {
    return bus.subscribe((event) => this.#onEvent(event));
  }

  async #onEvent(event: TeamEvent): Promise<void> {
    if (event.type !== "review.completed" && event.type !== "review.cancelled") {
      return;
    }
    if (this.#deps.enabled === false || !this.#deps.app.configured()) {
      return;
    }
    try {
      const target = await this.#deps.resolveTarget(event.repositoryId, event.pullRequestId);
      if (!target?.headSha) {
        return;
      }
      const payload = buildCheckRun(event, target.headSha, this.#deps.deepLink(event.runId));
      const token = await this.#deps.app.installationToken();
      const response = await this.#fetch(
        `https://api.github.com/repos/${target.fullName}/check-runs`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
          },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok) {
        console.warn(`check-run publish failed: HTTP ${response.status}`);
      }
      await response.text().catch(() => {});
    } catch (error) {
      console.warn("check-run publish failed:", error instanceof Error ? error.message : error);
    }
  }
}

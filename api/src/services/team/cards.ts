// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// cards.ts — pure renderers from one TeamEvent to each platform's message
// payload. Slack gets Block Kit; Teams gets an Adaptive Card in the standard
// message envelope (the format Teams "Workflows" incoming webhooks accept).
// Every card carries a deep link back to the capillary instance when
// CAPILLARY_PUBLIC_URL is configured — the channel ping leads people into the
// shared session, it does not replace it.
//
// detail="summary" keeps finding titles out of the payload: only verdict,
// counts, token totals and the link leave the instance unless the operator
// opted the connection into "findings".

import { NotifyDetail } from "./connections.ts";
import {
  FindingPostedEvent,
  RetvFinishedEvent,
  ReviewFinishedEvent,
  TeamEvent,
} from "./event_bus.ts";

export interface CardContext {
  /** Externally reachable base URL of this instance; deep links omit when unset. */
  publicUrl?: string;
  detail: NotifyDetail;
}

/** Deep link into the UI for a run, or null when no public URL is configured. */
export function runDeepLink(
  publicUrl: string | undefined,
  kind: "review" | "retv",
  runId: string,
): string | null {
  const base = (publicUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) {
    return null;
  }
  const param = kind === "review" ? "run" : "retvRun";
  return `${base}/?${param}=${encodeURIComponent(runId)}`;
}

interface CardModel {
  headline: string;
  facts: { label: string; value: string }[];
  /** Finding titles; empty unless detail="findings". */
  lines: string[];
  linkUrl: string | null;
  linkText: string;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatTokens(input?: number, output?: number): string | null {
  const total = (input ?? 0) + (output ?? 0);
  if (total <= 0) {
    return null;
  }
  return `in ${(input ?? 0).toLocaleString()} · out ${
    (output ?? 0).toLocaleString()
  } · total ${total.toLocaleString()}`;
}

function verdictBadge(verdict: string): string {
  switch (verdict) {
    case "approve":
      return "✅ approve";
    case "request_changes":
      return "🛑 request changes";
    default:
      return `💬 ${verdict || "comment"}`;
  }
}

function reviewModel(event: ReviewFinishedEvent, ctx: CardContext): CardModel {
  const cancelled = event.type === "review.cancelled";
  const facts: CardModel["facts"] = [
    { label: "Pull request", value: `#${event.pullRequestId} — ${event.title}` },
    { label: "Verdict", value: cancelled ? "⏹ stopped" : verdictBadge(event.verdict) },
    {
      label: "Findings",
      value:
        `${event.findingCount} total · ${event.blockerCount} blocker · ${event.highCount} high`,
    },
    { label: "Run", value: `${event.cycleCount} cycles · ${formatDuration(event.durationMs)}` },
  ];
  if (event.model) {
    facts.push({ label: "Model", value: event.model });
  }
  const tokens = formatTokens(event.inputTokens, event.outputTokens);
  if (tokens) {
    facts.push({ label: "Tokens", value: tokens });
  }
  const lines = ctx.detail === "findings"
    ? event.topFindings.map((f) =>
      `[${f.severity.toUpperCase()}] ${f.title} — ${f.filePath}${f.line ? `:${f.line}` : ""}`
    )
    : [];
  return {
    headline: cancelled ? "Capillary review stopped" : "Capillary review complete",
    facts,
    lines,
    linkUrl: runDeepLink(ctx.publicUrl, "review", event.runId),
    linkText: "Open in Capillary",
  };
}

function retvModel(event: RetvFinishedEvent, ctx: CardContext): CardModel {
  const outcome = event.functionalTestSucceeded && event.goalAchieved
    ? "✅ passed"
    : event.stopReason.toLowerCase().includes("cancel")
    ? "⏹ stopped"
    : "❌ failed";
  const facts: CardModel["facts"] = [
    { label: "Goal", value: event.goal.length > 180 ? `${event.goal.slice(0, 177)}…` : event.goal },
    { label: "Outcome", value: `${outcome} (${event.stopReason})` },
    {
      label: "Milestones",
      value: `${event.milestonesCompleted}/${event.milestonesTotal} · ${event.percent}%`,
    },
    { label: "Run", value: `${event.cycleCount} cycles · ${formatDuration(event.durationMs)}` },
  ];
  const tokens = formatTokens(event.inputTokens, event.outputTokens);
  if (tokens) {
    facts.push({ label: "Tokens", value: tokens });
  }
  const lines = ctx.detail === "findings" ? event.findings.slice(0, 5) : [];
  return {
    headline: "Capillary functional test finished",
    facts,
    lines,
    linkUrl: runDeepLink(ctx.publicUrl, "retv", event.runId),
    linkText: "Open in Capillary",
  };
}

function findingPostedModel(event: FindingPostedEvent, ctx: CardContext): CardModel {
  const kind = event.kind === "summary"
    ? "review summary"
    : event.kind === "suggestion"
    ? "code suggestion"
    : "inline comment";
  return {
    headline: `Capillary ${kind} posted to PR #${event.pullRequestId}`,
    facts: [
      {
        label: "Finding",
        value: ctx.detail === "findings"
          ? `${event.severity ? `[${event.severity.toUpperCase()}] ` : ""}${event.title}`
          : kind,
      },
    ],
    lines: [],
    linkUrl: event.url,
    linkText: "View on GitHub",
  };
}

function toModel(event: TeamEvent, ctx: CardContext): CardModel {
  switch (event.type) {
    case "review.completed":
    case "review.cancelled":
      return reviewModel(event, ctx);
    case "retv.completed":
      return retvModel(event, ctx);
    case "finding.posted":
      return findingPostedModel(event, ctx);
  }
}

/** Slack incoming-webhook payload (Block Kit). */
export function buildSlackPayload(event: TeamEvent, ctx: CardContext): Record<string, unknown> {
  const model = toModel(event, ctx);
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: model.headline, emoji: true } },
    {
      type: "section",
      fields: model.facts.map((fact) => ({
        type: "mrkdwn",
        text: `*${fact.label}*\n${fact.value}`,
      })),
    },
  ];
  if (model.lines.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: model.lines.map((line) => `• ${line}`).join("\n") },
    });
  }
  if (model.linkUrl) {
    blocks.push({
      type: "actions",
      elements: [{
        type: "button",
        text: { type: "plain_text", text: model.linkText, emoji: true },
        url: model.linkUrl,
      }],
    });
  }
  // `text` is the notification-tray fallback for clients that don't render blocks.
  return { text: model.headline, blocks };
}

/** Teams incoming-webhook payload: Adaptive Card in the message envelope. */
export function buildTeamsPayload(event: TeamEvent, ctx: CardContext): Record<string, unknown> {
  const model = toModel(event, ctx);
  const body: Record<string, unknown>[] = [
    { type: "TextBlock", size: "Large", weight: "Bolder", text: model.headline, wrap: true },
    {
      type: "FactSet",
      facts: model.facts.map((fact) => ({ title: fact.label, value: fact.value })),
    },
  ];
  for (const line of model.lines) {
    body.push({ type: "TextBlock", text: `• ${line}`, wrap: true, spacing: "Small" });
  }
  const card: Record<string, unknown> = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body,
  };
  if (model.linkUrl) {
    card.actions = [{ type: "Action.OpenUrl", title: model.linkText, url: model.linkUrl }];
  }
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: card,
    }],
  };
}

/** Small fixed card for the connection "Test" button. */
export function buildTestPayload(app: "slack" | "teams", label: string): Record<string, unknown> {
  const text = `Capillary connection test — "${label}" is wired up. 🎉`;
  if (app === "slack") {
    return { text };
  }
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        body: [{ type: "TextBlock", text, wrap: true }],
      },
    }],
  };
}

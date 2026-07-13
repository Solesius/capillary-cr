// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { Context, Router } from "jsr:@oak/oak";
import { AppError } from "../domain/errors.ts";
import { buildPrSummaryComment } from "../services/review_agent_service.ts";
import { deps } from "./deps.ts";

const router = new Router();

router.post("/api/github/connect", async (ctx) => {
  const body = await ctx.request.body.json();
  const identity = await deps.githubService.connectGithub(body.oauthState || "valid", body.token);
  ctx.response.status = 200;
  ctx.response.body = identity;
});

router.get("/api/github/oauth/start", async (ctx) => {
  const webOrigin = ctx.request.url.searchParams.get("webOrigin") || undefined;
  ctx.response.body = await deps.githubService.beginGithubOAuth(ctx.request.url.origin, webOrigin);
});

router.get("/api/github/oauth/poll/:sessionId", async (ctx) => {
  const sessionId = ctx.params.sessionId || "";
  ctx.response.body = await deps.githubService.pollGithubOAuthSession(sessionId);
});

router.get("/api/github/oauth/callback", async (ctx) => {
  const code = ctx.request.url.searchParams.get("code") || "";
  const state = ctx.request.url.searchParams.get("state") || "";
  const callbackOrigin = state ? deps.githubService.peekGithubOAuthWebOrigin(state) : null;

  try {
    const completed = await deps.githubService.completeGithubOAuth(code, state);
    ctx.response.headers.set("content-type", "text/html; charset=utf-8");
    ctx.response.body = githubOAuthCallbackHtml({
      ok: true,
      webOrigin: completed.webOrigin,
      message: "GitHub connected. You can close this window.",
    });
  } catch (error) {
    const message = error instanceof AppError ? error.code : "github_oauth_callback_failed";
    ctx.response.status = error instanceof AppError ? error.status : 500;
    ctx.response.headers.set("content-type", "text/html; charset=utf-8");
    ctx.response.body = githubOAuthCallbackHtml({
      ok: false,
      webOrigin: callbackOrigin || undefined,
      message,
    });
  }
});

router.get("/api/github/repositories", async (ctx) => {
  const refresh = ctx.request.url.searchParams.get("refresh") === "1";
  ctx.response.body = await deps.githubService.listRepositories(refresh);
});

router.get("/api/github/repositories/:repositoryId/pull-requests", async (ctx) => {
  const repositoryId = ctx.params.repositoryId || "";
  const stateParam = ctx.request.url.searchParams.get("state") || "open";
  const stateFilter = stateParam === "closed" ? "closed" : "open";
  ctx.response.body = await deps.githubService.listPullRequests(repositoryId, stateFilter);
});

router.get("/api/github/repositories/:repositoryId/pull-requests/:pullRequestId", async (ctx) => {
  const repositoryId = ctx.params.repositoryId || "";
  const pullRequestId = ctx.params.pullRequestId || "";
  ctx.response.body = await deps.githubService.getPullRequest(repositoryId, pullRequestId);
});

// Read-only single-file content at the PR's head, for the file explorer. The
// explorer loads the tree map from the (already cached) diff and fetches file
// bodies one at a time on click — never in bulk — so a large PR cannot fan out
// into a GitHub rate-limit burst.
router.get(
  "/api/github/repositories/:repositoryId/pull-requests/:pullRequestId/file",
  async (ctx) => {
    const repositoryId = ctx.params.repositoryId || "";
    const pullRequestId = ctx.params.pullRequestId || "";
    const path = ctx.request.url.searchParams.get("path") || "";
    // side=head (default) reads at the PR head; side=base reads the target
    // branch — the "original" pane of the explorer's diff view.
    const side = ctx.request.url.searchParams.get("side") === "base" ? "base" : "head";
    const pull = await deps.repository.getPullRequest(repositoryId, pullRequestId);
    const ref = side === "base" ? pull.targetBranch : (pull.headSha || pull.sourceBranch);
    const content = await deps.githubService.getRepoFileContent(repositoryId, ref, path);
    if (content === null) {
      ctx.response.status = 404;
      ctx.response.body = { error: "file_content_unavailable", path, side };
      return;
    }
    ctx.response.body = { path, side, content };
  },
);

router.get(
  "/api/github/repositories/:repositoryId/pull-requests/:pullRequestId/diff",
  async (ctx) => {
    const repositoryId = ctx.params.repositoryId || "";
    const pullRequestId = ctx.params.pullRequestId || "";
    ctx.response.body = await deps.githubService.getPullRequestDiff(repositoryId, pullRequestId);
  },
);

router.post("/api/review/runs", async (ctx) => {
  const body = await ctx.request.body.json();
  const run = await deps.reviewService.beginReview(body.pullRequestId || "", body.repositoryId);
  ctx.response.status = 201;
  ctx.response.body = run;
});

router.post("/api/review/runs/async", async (ctx) => {
  const body = await ctx.request.body.json();
  const run = await deps.reviewService.beginReviewAsync(
    body.pullRequestId || "",
    body.repositoryId,
  );
  ctx.response.status = 202;
  ctx.response.body = run;
});

// --- durable review sessions -------------------------------------------------
// Runs execute detached from any connection; clients attach for replay + tail.

router.post("/api/review/sessions", async (ctx) => {
  const body = await ctx.request.body.json();
  const maxCycles = Number(body.maxCycles);
  const session = await deps.reviewSessionHub.start({
    pullRequestId: String(body.pullRequestId || ""),
    repositoryId: body.repositoryId ? String(body.repositoryId) : undefined,
    maxCycles: Number.isFinite(maxCycles) && maxCycles > 0 ? maxCycles : undefined,
    trace: body.trace === true,
    suggest: body.suggest === true,
  });
  ctx.response.status = 201;
  ctx.response.body = session;
});

router.get("/api/review/sessions", (ctx) => {
  ctx.response.body = { sessions: deps.reviewSessionHub.list() };
});

router.get("/api/review/sessions/:runId/stream", async (ctx) => {
  const runId = ctx.params.runId || "";
  if (!deps.reviewSessionHub.has(runId)) {
    ctx.response.status = 404;
    ctx.response.body = { error: "session_not_found" };
    return;
  }

  const target = await ctx.sendEvents();
  let detach: (() => void) | null = null;
  const close = () => {
    detach?.();
    target.close().catch(() => {});
  };

  detach = deps.reviewSessionHub.attach(runId, (event) => {
    try {
      target.dispatchMessage(JSON.stringify(event));
      if (event.type === "done") {
        close();
      }
    } catch {
      close();
    }
  });
  if (!deps.reviewSessionHub.isActive(runId)) {
    // Finished session: full replay delivered above; close after flush.
    close();
  }
});

router.get("/api/review/runs/stream", async (ctx) => {
  const params = ctx.request.url.searchParams;
  const pullRequestId = params.get("pullRequestId") || "";
  const repositoryId = params.get("repositoryId") || undefined;
  const maxCyclesRaw = params.get("maxCycles");
  const maxCycles = maxCyclesRaw ? Number(maxCyclesRaw) : undefined;
  const trace = params.get("trace") === "1" || params.get("trace") === "true";

  const target = await ctx.sendEvents();
  const send = (event: unknown) => {
    try {
      target.dispatchMessage(JSON.stringify(event));
    } catch {
      // Client disconnected; the run continues but events are dropped.
    }
  };

  try {
    await deps.reviewService.runReviewStream(
      { pullRequestId, repositoryId, maxCycles, trace },
      send,
    );
  } catch (error) {
    const message = error instanceof AppError ? error.message : "review_stream_failed";
    send({ type: "log", level: "error", message });
  } finally {
    await target.close();
  }
});

router.get("/api/review/runs/:runId", async (ctx) => {
  const runId = ctx.params.runId || "";
  ctx.response.body = await deps.reviewService.getReviewRun(runId);
});

router.get("/api/review/runs/:runId/events", async (ctx) => {
  const runId = ctx.params.runId || "";
  ctx.response.body = {
    events: await deps.reviewService.streamReviewEvents(runId),
  };
});

router.get("/api/review/runs/:runId/findings", async (ctx) => {
  const runId = ctx.params.runId || "";
  ctx.response.body = {
    findings: await deps.repository.getFindings(runId),
  };
});

router.get("/api/review/runs/:runId/checklist", async (ctx) => {
  const runId = ctx.params.runId || "";
  ctx.response.body = {
    checklist: await deps.repository.getChecklist(runId),
  };
});

router.post("/api/review/runs/:runId/pr-comment", async (ctx) => {
  const runId = ctx.params.runId || "";
  const record = await deps.reviewService.getReviewAgentRun(runId);
  if (!record) {
    ctx.response.status = 404;
    ctx.response.body = { message: "review_run_not_found" };
    return;
  }
  const result = await deps.githubService.postPullRequestComment(
    record.repositoryId,
    record.pullRequestId,
    buildPrSummaryComment(record),
  );
  ctx.response.status = 201;
  ctx.response.body = { posted: true, url: result.htmlUrl };
});

// Human-initiated: post one finding's committable suggestion to the PR as a
// GitHub ```suggestion block. Never batched, never automatic.
router.post("/api/review/runs/:runId/findings/:findingId/suggestion", async (ctx) => {
  const runId = ctx.params.runId || "";
  const findingId = ctx.params.findingId || "";
  const record = await deps.reviewService.getReviewAgentRun(runId);
  if (!record) {
    ctx.response.status = 404;
    ctx.response.body = { message: "review_run_not_found" };
    return;
  }
  const finding = record.findings.find((item) => item.id === findingId);
  if (!finding || !finding.suggestion) {
    ctx.response.status = 404;
    ctx.response.body = { message: "suggestion_not_found" };
    return;
  }
  const result = await deps.githubService.postPullRequestSuggestion(
    record.repositoryId,
    record.pullRequestId,
    {
      path: finding.filePath,
      startLine: finding.suggestion.startLine,
      endLine: finding.suggestion.endLine,
      code: finding.suggestion.code,
      note: `**${finding.title}** — ${finding.finding}`,
    },
  );
  ctx.response.status = 201;
  ctx.response.body = { posted: true, url: result.htmlUrl };
});

// Human-initiated: post one finding as a plain inline review comment at its
// file:line. Works for any finding (no code suggestion required).
router.post("/api/review/runs/:runId/findings/:findingId/comment", async (ctx) => {
  const runId = ctx.params.runId || "";
  const findingId = ctx.params.findingId || "";
  const record = await deps.reviewService.getReviewAgentRun(runId);
  if (!record) {
    ctx.response.status = 404;
    ctx.response.body = { message: "review_run_not_found" };
    return;
  }
  const finding = record.findings.find((item) => item.id === findingId);
  if (!finding || !finding.line) {
    ctx.response.status = 404;
    ctx.response.body = { message: "finding_not_commentable" };
    return;
  }
  const severity = finding.severity.toUpperCase();
  const fix = finding.suggestedFix ? `\n\n**Suggested fix:** ${finding.suggestedFix}` : "";
  const result = await deps.githubService.postPullRequestInlineComment(
    record.repositoryId,
    record.pullRequestId,
    {
      path: finding.filePath,
      line: finding.line,
      body: `**[${severity}] ${finding.title}**\n\n${finding.finding}${fix}`,
    },
  );
  ctx.response.status = 201;
  ctx.response.body = { posted: true, url: result.htmlUrl };
});

router.post("/api/review/runs/:runId/cancel", async (ctx) => {
  const runId = ctx.params.runId || "";
  ctx.response.body = {
    cancelled: await deps.reviewService.cancelReview(runId),
  };
});

router.get("/api/review/agent/runs", async (ctx) => {
  ctx.response.body = { runs: await deps.reviewService.listReviewAgentRuns() };
});

router.get("/api/review/agent/runs/:runId", async (ctx) => {
  const record = await deps.reviewService.getReviewAgentRun(ctx.params.runId || "");
  if (!record) {
    ctx.response.status = 404;
    ctx.response.body = { error: "review_agent_run_not_found" };
    return;
  }
  ctx.response.body = record;
});

router.get("/api/review/agent/runs/:runId/report", async (ctx) => {
  const record = await deps.reviewService.getReviewAgentRun(ctx.params.runId || "");
  if (!record) {
    ctx.response.status = 404;
    ctx.response.body = { error: "review_agent_run_not_found" };
    return;
  }
  ctx.response.headers.set("content-type", "text/markdown; charset=utf-8");
  ctx.response.headers.set("content-disposition", `inline; filename="${record.runId}.md"`);
  ctx.response.body = record.report;
});

router.get("/api/review/agent/runs/:runId/export", async (ctx) => {
  const runId = ctx.params.runId || "";
  const bundle = await deps.reviewService.buildReviewExport(runId);
  if (!bundle) {
    const record = await deps.reviewService.getReviewAgentRun(runId);
    ctx.response.status = record ? 409 : 404;
    ctx.response.body = {
      error: record ? "review_agent_run_not_traced" : "review_agent_run_not_found",
    };
    return;
  }
  ctx.response.headers.set("content-type", "application/zip");
  ctx.response.headers.set("content-disposition", `attachment; filename="review-${runId}.zip"`);
  ctx.response.body = bundle;
});

router.get("/api/artifacts/:runId/markdown", async (ctx) => {
  const runId = ctx.params.runId || "";
  ctx.response.headers.set("content-type", "text/markdown; charset=utf-8");
  ctx.response.body = await deps.artifactService.exportMarkdownReview(runId);
});

router.get("/api/artifacts/:runId/graph", async (ctx) => {
  const runId = ctx.params.runId || "";
  ctx.response.headers.set("content-type", "application/json; charset=utf-8");
  ctx.response.body = await deps.artifactService.exportGraphJson(runId);
});

// Idempotent co-engineer browser: focuses the existing headed session,
// relaunches if the user closed the window, opens one otherwise.
router.post("/api/cdp/browser/open", async (ctx) => {
  const body = await ctx.request.body.json().catch(() => ({}));
  ctx.response.status = 201;
  ctx.response.body = await deps.cdpDriverService.openHeadedBrowser(
    body.startUrl || "about:blank",
  );
});

router.post("/api/cdp/sessions", async (ctx) => {
  const body = await ctx.request.body.json().catch(() => ({}));
  const session = await deps.cdpDriverService.createSession(
    body.startUrl || "about:blank",
    body.headed === true,
  );
  ctx.response.status = 201;
  ctx.response.body = session;
});

router.get("/api/cdp/sessions", (ctx) => {
  ctx.response.body = deps.cdpDriverService.listSessions();
});

router.post("/api/cdp/sessions/:sessionId/work-units", async (ctx) => {
  const sessionId = ctx.params.sessionId || "";
  const body = await ctx.request.body.json();
  ctx.response.body = await deps.cdpDriverService.executeWorkUnit(sessionId, body);
});

router.post("/api/cdp/retv/run", async (ctx) => {
  const body = await ctx.request.body.json();
  ctx.response.body = await deps.cdpRetvAgentService.runGoalRound({
    goal: body.goal || "",
    sessionId: body.sessionId,
    startUrl: body.startUrl,
    maxCycles: body.maxCycles,
    maxDurationMs: body.maxDurationMs,
    trace: body.trace === true,
    allowedOrigins: Array.isArray(body.allowedOrigins)
      ? body.allowedOrigins
      : parseAllowedDomains(body.allowedDomains),
  });
});

router.get("/api/cdp/retv/run/stream", async (ctx) => {
  const params = ctx.request.url.searchParams;
  const goal = params.get("goal") || "";
  const sessionId = params.get("sessionId") || undefined;
  const startUrl = params.get("startUrl") || undefined;
  const maxCyclesRaw = params.get("maxCycles");
  const maxCycles = maxCyclesRaw ? Number(maxCyclesRaw) : undefined;
  const maxDurationMsRaw = params.get("maxDurationMs");
  const maxDurationMs = maxDurationMsRaw ? Number(maxDurationMsRaw) : undefined;
  const traceRaw = params.get("trace");
  const trace = traceRaw === "1" || traceRaw === "true";
  const allowedOrigins = parseAllowedDomains(params.get("allowedDomains"));

  const target = await ctx.sendEvents();
  const send = (event: unknown) => {
    try {
      target.dispatchMessage(JSON.stringify(event));
    } catch {
      // Client disconnected; the run continues but events are dropped.
    }
  };

  try {
    await deps.cdpRetvAgentService.runGoalRound(
      { goal, sessionId, startUrl, maxCycles, maxDurationMs, trace, allowedOrigins },
      send,
    );
  } catch (error) {
    const message = error instanceof AppError ? error.message : "retv_stream_failed";
    send({ type: "log", level: "error", message });
  } finally {
    await target.close();
  }
});

// Live stop for an in-flight functional run. Closing the SSE stream alone
// never stopped the server-side round; this lands the stop at the loop's next
// boundary (racing any in-flight planner turn).
router.post("/api/cdp/retv/runs/:runId/cancel", (ctx) => {
  const runId = ctx.params.runId || "";
  ctx.response.body = { cancelled: deps.cdpRetvAgentService.cancelRetvRun(runId) };
});

router.get("/api/cdp/retv/runs", async (ctx) => {
  ctx.response.body = { runs: await deps.cdpRetvAgentService.listRuns() };
});

router.get("/api/cdp/retv/runs/:runId", async (ctx) => {
  const record = await deps.cdpRetvAgentService.getRun(ctx.params.runId || "");
  if (!record) {
    ctx.response.status = 404;
    ctx.response.body = { error: "retv_run_not_found" };
    return;
  }
  ctx.response.body = record;
});

router.get("/api/cdp/retv/runs/:runId/report", async (ctx) => {
  const record = await deps.cdpRetvAgentService.getRun(ctx.params.runId || "");
  if (!record) {
    ctx.response.status = 404;
    ctx.response.body = { error: "retv_run_not_found" };
    return;
  }
  ctx.response.headers.set("content-type", "text/markdown; charset=utf-8");
  ctx.response.headers.set("content-disposition", `inline; filename="${record.runId}.md"`);
  ctx.response.body = record.report;
});

// Run skeleton: export a traced run as a deterministic Playwright spec or a
// model-agnostic agent runsheet (?format=playwright|runsheet).
router.get("/api/cdp/retv/runs/:runId/driver", async (ctx) => {
  const runId = ctx.params.runId || "";
  const format = ctx.request.url.searchParams.get("format") === "runsheet"
    ? "runsheet" as const
    : "playwright" as const;
  const driver = await deps.cdpRetvAgentService.buildDriverExport(runId, format);
  if (!driver) {
    const record = await deps.cdpRetvAgentService.getRun(runId);
    ctx.response.status = record ? 409 : 404;
    ctx.response.body = { error: record ? "retv_run_not_traced" : "retv_run_not_found" };
    return;
  }
  ctx.response.headers.set(
    "content-type",
    format === "playwright" ? "text/typescript; charset=utf-8" : "text/markdown; charset=utf-8",
  );
  ctx.response.headers.set("content-disposition", `attachment; filename="${driver.filename}"`);
  ctx.response.body = driver.text;
});

router.get("/api/cdp/retv/runs/:runId/export", async (ctx) => {
  const bundle = await deps.cdpRetvAgentService.buildRunExport(ctx.params.runId || "");
  if (!bundle) {
    const record = await deps.cdpRetvAgentService.getRun(ctx.params.runId || "");
    ctx.response.status = record ? 409 : 404;
    ctx.response.body = { error: record ? "retv_run_not_traced" : "retv_run_not_found" };
    return;
  }
  ctx.response.headers.set("content-type", "application/zip");
  ctx.response.headers.set("content-disposition", `attachment; filename="${bundle.filename}"`);
  ctx.response.body = bundle.bytes;
});

router.get("/api/cdp/retv/config", (ctx) => {
  ctx.response.body = deps.cdpRetvAgentService.getPlannerConfig();
});

router.post("/api/cdp/retv/config", async (ctx) => {
  const body = await ctx.request.body.json().catch(() => ({}));
  ctx.response.body = deps.cdpRetvAgentService.setPlannerConfig({
    providerKind: body.providerKind,
    model: body.model,
    baseUrl: body.baseUrl,
  });
});

router.delete("/api/cdp/sessions/:sessionId", async (ctx) => {
  const sessionId = ctx.params.sessionId || "";
  ctx.response.body = {
    closed: await deps.cdpDriverService.closeSession(sessionId),
  };
});

/** Parse a comma/space/newline separated list of allowed domains into tokens. */
function parseAllowedDomains(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function routes() {
  return router;
}

export function errorMiddleware() {
  return async (ctx: Context, next: () => Promise<unknown>) => {
    try {
      await next();
    } catch (error) {
      if (error instanceof AppError) {
        ctx.response.status = error.status;
        ctx.response.body = {
          error: error.code,
          message: error.message,
        };
        return;
      }

      ctx.response.status = 500;
      ctx.response.body = {
        error: "internal_server_error",
      };
    }
  };
}

function githubOAuthCallbackHtml(
  input: { ok: boolean; webOrigin?: string; message: string },
): string {
  const payload = {
    source: "capillary-github-oauth",
    ok: input.ok,
    message: input.message,
  };
  const payloadJson = JSON.stringify(payload);
  const targetOriginJson = JSON.stringify(input.webOrigin || null);
  const safeMessage = escapeHtml(input.message);

  return [
    "<!doctype html>",
    "<html>",
    '<head><meta charset="utf-8"><title>GitHub OAuth</title></head>',
    '<body style="font-family:sans-serif;padding:24px;">',
    `<h2>${input.ok ? "Connected" : "Connection failed"}</h2>`,
    `<p>${safeMessage}</p>`,
    "<p>You can close this window.</p>",
    "<script>",
    `  const payload = ${payloadJson};`,
    `  const targetOrigin = ${targetOriginJson};`,
    "  if (window.opener && targetOrigin) {",
    "    try { window.opener.postMessage(payload, targetOrigin); } catch (_) {}",
    "  }",
    "  setTimeout(() => { window.close(); }, 100);",
    "</script>",
    "</body>",
    "</html>",
  ].join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

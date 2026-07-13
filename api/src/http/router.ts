// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { Context, Router } from "jsr:@oak/oak";
import { AppError } from "../domain/errors.ts";
import { ReviewAgentRunRecord } from "../domain/entities.ts";
import { buildPrSummaryComment } from "../services/review_agent_service.ts";
import { teamBus } from "../services/team/event_bus.ts";
import { buildAppManifest, isPubliclyReachableUrl } from "../services/team/github_app.ts";
import { parseInboundCommand, verifySlackSignature } from "../services/team/inbound.ts";
import { MEMBER_COOKIE } from "../services/team/members.ts";
import { PostedArtifact } from "../domain/entities.ts";
import { recordPostedArtifact } from "../services/team/posted_artifacts.ts";
import { deps } from "./deps.ts";

/**
 * Persist shared posted-state on the run record and announce the publication
 * on the team bus. Best-effort: the GitHub post already succeeded, so a
 * persistence hiccup must not fail the request that reports it.
 */
async function publishPostedArtifact(
  record: ReviewAgentRunRecord,
  input: { kind: PostedArtifact["kind"]; findingId?: string; url: string; postedBy?: string },
  meta: { title: string; severity?: string },
): Promise<void> {
  try {
    const artifact = recordPostedArtifact(record, input);
    await deps.repository.saveReviewAgentRun(record);
    teamBus.emit({
      type: "finding.posted",
      at: artifact.postedAt,
      runId: record.runId,
      pullRequestId: record.pullRequestId,
      repositoryId: record.repositoryId,
      repositoryFullName: record.repositoryFullName,
      kind: artifact.kind,
      findingId: artifact.findingId,
      title: meta.title,
      severity: meta.severity,
      url: artifact.url,
      actor: artifact.postedBy,
    });
  } catch (error) {
    console.warn("posted-artifact bookkeeping failed:", error);
  }
}

const router = new Router();

/**
 * Resolve (or mint) the member session for this request. The cookie is a
 * random bearer id — HttpOnly, SameSite=Lax; identity attaches separately.
 */
async function memberSession(ctx: Context): Promise<string> {
  const current = await ctx.cookies.get(MEMBER_COOKIE);
  const { sessionId, isNew } = deps.teamMembers.ensure(current);
  if (isNew) {
    await ctx.cookies.set(MEMBER_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      // Secure whenever the request itself arrived over TLS; localhost HTTP
      // dev keeps working (flagged by capillary's review of this branch).
      secure: ctx.request.secure,
    });
  }
  return sessionId;
}

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

// Exact-name escape hatch for huge accounts: owner/name (direct) or bare
// name (search) — one query, no catalog walk. Registered before the
// parameterized repository routes.
router.get("/api/github/repositories/lookup", async (ctx) => {
  const name = ctx.request.url.searchParams.get("name") || "";
  ctx.response.body = await deps.githubService.lookupRepositories(name);
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
  const sessionId = await memberSession(ctx);
  const memberToken = deps.teamMembers.tokenFor(sessionId);
  const result = await deps.githubService.postPullRequestComment(
    record.repositoryId,
    record.pullRequestId,
    buildPrSummaryComment(record),
    { asToken: memberToken ?? undefined },
  );
  await publishPostedArtifact(record, {
    kind: "summary",
    url: result.htmlUrl,
    postedBy: deps.teamMembers.loginFor(sessionId) ?? undefined,
  }, {
    title: record.title,
  });
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
  const sessionId = await memberSession(ctx);
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
    { asToken: deps.teamMembers.tokenFor(sessionId) ?? undefined },
  );
  await publishPostedArtifact(record, {
    kind: "suggestion",
    findingId: finding.id,
    url: result.htmlUrl,
    postedBy: deps.teamMembers.loginFor(sessionId) ?? undefined,
  }, { title: finding.title, severity: finding.severity });
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
  const sessionId = await memberSession(ctx);
  const result = await deps.githubService.postPullRequestInlineComment(
    record.repositoryId,
    record.pullRequestId,
    {
      path: finding.filePath,
      line: finding.line,
      body: `**[${severity}] ${finding.title}**\n\n${finding.finding}${fix}`,
    },
    { asToken: deps.teamMembers.tokenFor(sessionId) ?? undefined },
  );
  await publishPostedArtifact(record, {
    kind: "inline",
    findingId: finding.id,
    url: result.htmlUrl,
    postedBy: deps.teamMembers.loginFor(sessionId) ?? undefined,
  }, { title: finding.title, severity: finding.severity });
  ctx.response.status = 201;
  ctx.response.body = { posted: true, url: result.htmlUrl };
});

// "Check changes": delta re-review after new commits — verifies prior
// findings and reviews only the compare delta. Synchronous single planner
// call; 409s carry the reason (no_new_commits / run_not_checkable / llm).
router.post("/api/review/runs/:runId/check-changes", async (ctx) => {
  const record = await deps.reviewService.runCheckChanges(ctx.params.runId || "");
  ctx.response.status = 201;
  ctx.response.body = record;
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

// --- team member identity ------------------------------------------------------
// Per-browser sessions; a member attaches their own GitHub identity so posts
// go out as them. Tokens are memory-only — a restart forgets them.

router.get("/api/team/me", async (ctx) => {
  const sessionId = await memberSession(ctx);
  ctx.response.body = deps.teamMembers.view(sessionId);
});

router.post("/api/team/me/github", async (ctx) => {
  const sessionId = await memberSession(ctx);
  const body = await ctx.request.body.json();
  const token = String(body.token ?? "").trim();
  if (!token) {
    ctx.response.status = 400;
    ctx.response.body = { error: "token_required" };
    return;
  }
  const identity = await deps.githubService.getUserForToken(token);
  deps.teamMembers.attachIdentity(sessionId, identity, token);
  ctx.response.body = deps.teamMembers.view(sessionId);
});

router.delete("/api/team/me/github", async (ctx) => {
  const sessionId = await memberSession(ctx);
  deps.teamMembers.detachIdentity(sessionId);
  ctx.response.body = deps.teamMembers.view(sessionId);
});

// --- integrations status ---------------------------------------------------------

router.get("/api/team/integrations", (ctx) => {
  ctx.response.body = {
    githubApp: deps.githubApp.status(),
    jira: deps.jiraService.configured(),
    checksEnabled: Deno.env.get("CAPILLARY_CHECKS") !== "0",
    autoReviewOnOpen: Deno.env.get("CAPILLARY_AUTO_REVIEW_ON_OPEN") === "1",
    publicUrlConfigured: Boolean(Deno.env.get("CAPILLARY_PUBLIC_URL")?.trim()),
    // localhost/private URLs mint the app without webhooks (GitHub rejects
    // unreachable hook URLs at manifest time); checks still work.
    webhookCapable: isPubliclyReachableUrl(Deno.env.get("CAPILLARY_PUBLIC_URL") ?? ""),
  };
});

// --- per-instance GitHub App (manifest flow) --------------------------------------
// GET /setup-url returns the GitHub page + manifest the admin submits; GitHub
// redirects back to /callback with a one-time code we convert to credentials.

router.get("/api/github/app/manifest", (ctx) => {
  const publicUrl = Deno.env.get("CAPILLARY_PUBLIC_URL")?.trim();
  if (!publicUrl) {
    ctx.response.status = 409;
    ctx.response.body = {
      error: "public_url_required",
      message: "Set CAPILLARY_PUBLIC_URL so GitHub can redirect the manifest callback here.",
    };
    return;
  }
  const organization = ctx.request.url.searchParams.get("org")?.trim();
  ctx.response.body = {
    manifest: buildAppManifest(publicUrl),
    createUrl: organization
      ? `https://github.com/organizations/${organization}/settings/apps/new`
      : "https://github.com/settings/apps/new",
  };
});

router.get("/api/github/app/callback", async (ctx) => {
  const code = ctx.request.url.searchParams.get("code") ?? "";
  if (!code) {
    ctx.response.status = 400;
    ctx.response.body = { error: "code_required" };
    return;
  }
  try {
    const created = await deps.githubApp.completeManifest(code);
    ctx.response.headers.set("content-type", "text/html; charset=utf-8");
    ctx.response.body = `<!doctype html><body style="font-family:sans-serif;padding:24px;">` +
      `<h2>GitHub App created${created.slug ? `: ${escapeHtml(created.slug)}` : ""}</h2>` +
      `<p>Install it on your repositories${
        created.htmlUrl
          ? ` at <a href="${escapeHtml(created.htmlUrl)}/installations/new">${
            escapeHtml(created.htmlUrl)
          }</a>`
          : ""
      }, then return to Capillary.</p></body>`;
  } catch (error) {
    ctx.response.status = 502;
    ctx.response.body = {
      error: "app_manifest_conversion_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
});

// Inbound GitHub webhook (the App's): PR opened -> auto-queue a review when
// the operator opted in. Signature verified against the app webhook secret.
router.post("/api/github/webhook", async (ctx) => {
  const raw = new Uint8Array(await ctx.request.body.arrayBuffer());
  const valid = await deps.githubApp.verifyWebhookSignature(
    raw,
    ctx.request.headers.get("x-hub-signature-256"),
  );
  if (!valid) {
    ctx.response.status = 401;
    ctx.response.body = { error: "invalid_signature" };
    return;
  }
  ctx.response.status = 202;
  ctx.response.body = { received: true };
  if (ctx.request.headers.get("x-github-event") !== "pull_request") {
    return;
  }
  if (Deno.env.get("CAPILLARY_AUTO_REVIEW_ON_OPEN") !== "1") {
    return;
  }
  try {
    const payload = JSON.parse(new TextDecoder().decode(raw)) as {
      action?: string;
      repository?: { id?: number };
      pull_request?: { number?: number; draft?: boolean };
    };
    const action = payload.action ?? "";
    if ((action !== "opened" && action !== "ready_for_review") || payload.pull_request?.draft) {
      return;
    }
    const repositoryId = String(payload.repository?.id ?? "");
    const pullRequestId = String(payload.pull_request?.number ?? "");
    if (!repositoryId || !pullRequestId) {
      return;
    }
    // Detached: webhook responses must be fast; the session hub owns the run.
    void deps.reviewSessionHub.start({ pullRequestId, repositoryId }).catch((error) => {
      console.warn("auto-review on PR open failed to start:", error);
    });
  } catch {
    // Malformed payloads are ignored; GitHub retries transient failures.
  }
});

// --- finding dispatch + Jira -------------------------------------------------------
// Human-initiated per the standing law: a button per finding, never automatic.

router.post("/api/review/runs/:runId/findings/:findingId/dispatch", async (ctx) => {
  const runId = ctx.params.runId || "";
  const findingId = ctx.params.findingId || "";
  const record = await deps.reviewService.getReviewAgentRun(runId);
  const finding = record?.findings.find((item) => item.id === findingId);
  if (!record || !finding) {
    ctx.response.status = 404;
    ctx.response.body = { message: "finding_not_found" };
    return;
  }
  const sessionId = await memberSession(ctx);
  const runLink = Deno.env.get("CAPILLARY_PUBLIC_URL")?.trim()
    ? `${Deno.env.get("CAPILLARY_PUBLIC_URL")!.trim().replace(/\/+$/, "")}/?run=${record.runId}`
    : null;
  const body = [
    `@copilot please fix the following finding from a Capillary review of PR #${record.pullRequestId} ("${record.title}").`,
    "",
    `**[${finding.severity.toUpperCase()}] ${finding.title}**`,
    "",
    finding.finding,
    "",
    "File: `" + finding.filePath + (finding.line ? `:${finding.line}` : "") + "`",
    ...(finding.evidence.length
      ? ["", "Evidence:", ...finding.evidence.slice(0, 5).map((e) => `- ${e}`)]
      : []),
    ...(finding.suggestedFix ? ["", `Suggested fix: ${finding.suggestedFix}`] : []),
    ...(runLink ? ["", `Full run: ${runLink}`] : []),
    "",
    `<sub>Dispatched from [Capillary](https://github.com/Solesius/capillary-cr)</sub>`,
  ].join("\n");
  const issue = await deps.githubService.createRepositoryIssue(record.repositoryId, {
    title: `[capillary] ${finding.title}`,
    body,
    labels: ["capillary"],
    // Best-effort: repos with the Copilot coding agent get a real assignment;
    // GitHub silently drops unknown assignees, leaving the @mention to carry.
    assignees: ["copilot-swe-agent"],
  }, { asToken: deps.teamMembers.tokenFor(sessionId) ?? undefined });
  await publishPostedArtifact(record, {
    kind: "dispatch",
    findingId: finding.id,
    url: issue.htmlUrl,
    postedBy: deps.teamMembers.loginFor(sessionId) ?? undefined,
  }, { title: finding.title, severity: finding.severity });
  ctx.response.status = 201;
  ctx.response.body = { dispatched: true, url: issue.htmlUrl };
});

router.post("/api/review/runs/:runId/findings/:findingId/jira", async (ctx) => {
  if (!deps.jiraService.configured()) {
    ctx.response.status = 409;
    ctx.response.body = { error: "jira_not_configured" };
    return;
  }
  const runId = ctx.params.runId || "";
  const findingId = ctx.params.findingId || "";
  const record = await deps.reviewService.getReviewAgentRun(runId);
  const finding = record?.findings.find((item) => item.id === findingId);
  if (!record || !finding) {
    ctx.response.status = 404;
    ctx.response.body = { message: "finding_not_found" };
    return;
  }
  const sessionId = await memberSession(ctx);
  const runLink = Deno.env.get("CAPILLARY_PUBLIC_URL")?.trim()
    ? `${Deno.env.get("CAPILLARY_PUBLIC_URL")!.trim().replace(/\/+$/, "")}/?run=${record.runId}`
    : null;
  const issue = await deps.jiraService.createIssue(finding, {
    prTitle: record.title,
    runLink,
  });
  await publishPostedArtifact(record, {
    kind: "jira",
    findingId: finding.id,
    url: issue.url,
    postedBy: deps.teamMembers.loginFor(sessionId) ?? undefined,
  }, { title: finding.title, severity: finding.severity });
  ctx.response.status = 201;
  ctx.response.body = { created: true, key: issue.key, url: issue.url };
});

// --- inbound Slack slash command ---------------------------------------------------

router.post("/api/integrations/slack/command", async (ctx) => {
  const signingSecret = Deno.env.get("CAPILLARY_SLACK_SIGNING_SECRET")?.trim();
  if (!signingSecret) {
    ctx.response.status = 409;
    ctx.response.body = { error: "slack_signing_secret_not_configured" };
    return;
  }
  const raw = new TextDecoder().decode(new Uint8Array(await ctx.request.body.arrayBuffer()));
  const valid = await verifySlackSignature(
    signingSecret,
    raw,
    ctx.request.headers.get("x-slack-request-timestamp"),
    ctx.request.headers.get("x-slack-signature"),
  );
  if (!valid) {
    ctx.response.status = 401;
    ctx.response.body = { error: "invalid_signature" };
    return;
  }
  const params = new URLSearchParams(raw);
  const command = parseInboundCommand(params.get("text") ?? "");
  if (command.kind === "status") {
    const sessions = deps.reviewSessionHub.list();
    const active = sessions.filter((session) => session.active);
    ctx.response.body = {
      response_type: "ephemeral",
      text: active.length === 0
        ? `No reviews running. ${sessions.length} recent session(s).`
        : active.map((s) => `PR #${s.pullRequestId} — running (${s.eventCount} events)`).join("\n"),
    };
    return;
  }
  if (command.kind === "review") {
    try {
      const repos = await deps.githubService.lookupRepositories(command.ownerRepo);
      const repo = repos.find((item) =>
        item.fullName.toLowerCase() === command.ownerRepo.toLowerCase()
      );
      if (!repo) {
        ctx.response.body = {
          response_type: "ephemeral",
          text: `Repository ${command.ownerRepo} not found or not accessible.`,
        };
        return;
      }
      const session = await deps.reviewSessionHub.start({
        pullRequestId: command.prNumber,
        repositoryId: repo.id,
      });
      ctx.response.body = {
        response_type: "in_channel",
        text: `Capillary review started for ${command.ownerRepo}#${command.prNumber} ` +
          `(run ${session.runId}). The card lands here when it finishes.`,
      };
    } catch (error) {
      ctx.response.body = {
        response_type: "ephemeral",
        text: `Could not start review: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
    return;
  }
  ctx.response.body = {
    response_type: "ephemeral",
    text: "Usage: /capillary review owner/repo#123 · /capillary status",
  };
});

// --- team channel connections -------------------------------------------------
// A connection is a channel (incoming webhooks are minted per channel in both
// Slack and Teams). Webhook URLs never leave the server unmasked.

router.get("/api/team/connections", (ctx) => {
  ctx.response.body = {
    connections: deps.teamConnections.list(),
    publicUrlConfigured: Boolean(Deno.env.get("CAPILLARY_PUBLIC_URL")?.trim()),
  };
});

router.post("/api/team/connections", async (ctx) => {
  const body = await ctx.request.body.json();
  try {
    const connection = await deps.teamConnections.create({
      app: body.app,
      label: body.label,
      webhookUrl: body.webhookUrl,
      events: body.events,
      detail: body.detail,
    });
    ctx.response.status = 201;
    ctx.response.body = connection;
  } catch {
    ctx.response.status = 400;
    ctx.response.body = {
      error: "webhook_host_not_allowed",
      message: "Webhook URL must be https on an allowed webhook host " +
        "(hooks.slack.com; *.webhook.office.com / *.logic.azure.com for Teams). " +
        "Extend with CAPILLARY_WEBHOOK_HOST_ALLOWLIST for self-hosted relays.",
    };
  }
});

router.patch("/api/team/connections/:id", async (ctx) => {
  const body = await ctx.request.body.json();
  const connection = await deps.teamConnections.update(ctx.params.id || "", {
    label: body.label,
    events: body.events,
    detail: body.detail,
    repoFilter: body.repoFilter,
    enabled: body.enabled,
  });
  if (!connection) {
    ctx.response.status = 404;
    ctx.response.body = { error: "connection_not_found" };
    return;
  }
  ctx.response.body = connection;
});

router.delete("/api/team/connections/:id", async (ctx) => {
  ctx.response.body = { deleted: await deps.teamConnections.delete(ctx.params.id || "") };
});

// Fire the fixed test card so a channel can be verified right after wiring.
router.post("/api/team/connections/:id/test", async (ctx) => {
  const result = await deps.channelPublisher.sendTest(ctx.params.id || "");
  ctx.response.status = result.ok ? 200 : result.error === "connection_not_found" ? 404 : 502;
  ctx.response.body = result;
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

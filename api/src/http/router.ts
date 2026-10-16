// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
// router.ts — the API route table.
//
// Every route is a pure function from request to Reply (see reply.ts and
// routing.ts). Handlers read `req` and call services; they never write to the
// response. Errors are thrown as AppError and rendered by errorMiddleware.

import { STATUS_CODES } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "../domain/errors.ts";
import type { GitHubIdentity, PostedArtifact, ReviewAgentRunRecord } from "../domain/entities.ts";
import { buildPrSummaryComment } from "../services/review_agent_service.ts";
import { teamBus } from "../services/team/event_bus.ts";
import type { GitLabService } from "../services/gitlab_service.ts";
import { buildAppManifest, isPubliclyReachableUrl } from "../services/team/github_app.ts";
import { mergeRequestToReview, verifyGitlabWebhookToken } from "../services/team/gitlab.ts";
import { parseInboundCommand, verifySlackSignature } from "../services/team/inbound.ts";
import { MEMBER_COOKIE } from "../services/team/members.ts";
import { recordPostedArtifact } from "../services/team/posted_artifacts.ts";
import { deps } from "./deps.ts";
import {
  bytes,
  type Cookie,
  disposition,
  type Emit,
  events,
  failure,
  html,
  json,
  markdown,
  text,
  withCookie,
} from "./reply.ts";
import { del, get, origin, param, patch, post, query, type Route } from "./routing.ts";

// --- shared helpers ----------------------------------------------------------

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

interface MemberSession {
  sessionId: string;
  /** Set when the session was just minted and the browser must store it. */
  cookie: Cookie | null;
}

/**
 * Resolve (or mint) the member session for this request. The cookie is a
 * random bearer id — HttpOnly, SameSite=Lax; identity attaches separately.
 */
function memberSession(req: Request): MemberSession {
  const current: string | undefined = req.cookies?.[MEMBER_COOKIE];
  const { sessionId, isNew } = deps.teamMembers.ensure(current);
  return {
    sessionId,
    cookie: isNew
      ? {
        name: MEMBER_COOKIE,
        value: sessionId,
        // Secure whenever the request itself arrived over TLS; localhost HTTP
        // dev keeps working (flagged by capillary's review of this branch).
        options: { httpOnly: true, sameSite: "lax", path: "/", secure: req.secure },
      }
      : null,
  };
}

const memberToken = (sessionId: string) => deps.teamMembers.tokenFor(sessionId) ?? undefined;
const memberLogin = (sessionId: string) => deps.teamMembers.loginFor(sessionId) ?? undefined;

const publicUrl = () => process.env["CAPILLARY_PUBLIC_URL"]?.trim() || "";

const runLinkFor = (runId: string) =>
  publicUrl() ? `${publicUrl().replace(/\/+$/, "")}/?run=${runId}` : null;

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

const isTrue = (raw: string | null) => raw === "1" || raw === "true";
const optionalNumber = (raw: string | null) => (raw ? Number(raw) : undefined);

/** Forward events to an SSE stream; a gone client just drops them. */
async function streamRun(
  emit: Emit,
  run: (send: (event: unknown) => void) => Promise<unknown>,
  fallbackError: string,
): Promise<void> {
  const send = (event: unknown) => void emit(event);
  try {
    await run(send);
  } catch (error) {
    const message = error instanceof AppError ? error.message : fallbackError;
    send({ type: "log", level: "error", message });
  }
}

// --- GitHub connection & OAuth -----------------------------------------------

const github: Route[] = [
  post("/api/github/connect", async (req) =>
    json(await deps.githubService.connectGithub(req.body.oauthState || "valid", req.body.token))),

  get("/api/github/oauth/start", async (req) =>
    json(
      await deps.githubService.beginGithubOAuth(
        origin(req),
        query(req).get("webOrigin") || undefined,
      ),
    )),

  get("/api/github/oauth/poll/:sessionId", async (req) =>
    json(await deps.githubService.pollGithubOAuthSession(param(req, "sessionId")))),

  get("/api/github/oauth/callback", async (req) => {
    const code = query(req).get("code") || "";
    const state = query(req).get("state") || "";
    const callbackOrigin = state ? deps.githubService.peekGithubOAuthWebOrigin(state) : null;
    try {
      const completed = await deps.githubService.completeGithubOAuth(code, state);
      return html(githubOAuthCallbackHtml({
        ok: true,
        webOrigin: completed.webOrigin,
        message: "GitHub connected. You can close this window.",
      }));
    } catch (error) {
      return html(
        githubOAuthCallbackHtml({
          ok: false,
          webOrigin: callbackOrigin || undefined,
          message: error instanceof AppError ? error.code : "github_oauth_callback_failed",
        }),
        error instanceof AppError ? error.status : 500,
      );
    }
  }),

  // Exact-name escape hatch for huge accounts: owner/name (direct) or bare
  // name (search) — one query, no catalog walk. Registered before the
  // parameterized repository routes.
  get("/api/github/repositories/lookup", async (req) =>
    json(await deps.codeHost.lookupRepositories(query(req).get("name") || ""))),

  get("/api/github/repositories", async (req) =>
    json(await deps.codeHost.listRepositories(query(req).get("refresh") === "1"))),

  get("/api/github/repositories/:repositoryId/pull-requests", async (req) =>
    json(
      await deps.codeHost.listPullRequests(
        param(req, "repositoryId"),
        query(req).get("state") === "closed" ? "closed" : "open",
      ),
    )),

  get("/api/github/repositories/:repositoryId/pull-requests/:pullRequestId", async (req) =>
    json(
      await deps.codeHost.getPullRequest(param(req, "repositoryId"), param(req, "pullRequestId")),
    )),

  // Read-only single-file content at the PR's head, for the file explorer. The
  // explorer loads the tree map from the (already cached) diff and fetches file
  // bodies one at a time on click — never in bulk — so a large PR cannot fan out
  // into a GitHub rate-limit burst.
  get("/api/github/repositories/:repositoryId/pull-requests/:pullRequestId/file", async (req) => {
    const repositoryId = param(req, "repositoryId");
    const path = query(req).get("path") || "";
    // side=head (default) reads at the PR head; side=base reads the target
    // branch — the "original" pane of the explorer's diff view.
    const side = query(req).get("side") === "base" ? "base" : "head";
    const pull = await deps.repository.getPullRequest(repositoryId, param(req, "pullRequestId"));
    const ref = side === "base" ? pull.targetBranch : (pull.headSha || pull.sourceBranch);
    const content = await deps.codeHost.getRepoFileContent(repositoryId, ref, path);
    return content === null
      ? failure(404, "file_content_unavailable", { path, side })
      : json({ path, side, content });
  }),

  get("/api/github/repositories/:repositoryId/pull-requests/:pullRequestId/diff", async (req) =>
    json(
      await deps.codeHost.getPullRequestDiff(
        param(req, "repositoryId"),
        param(req, "pullRequestId"),
      ),
    )),
];

// --- code hosts ---------------------------------------------------------------
// GitLab repositories are served by the /api/github/repositories routes above
// (ids `gitlab-<project id>`); these report which hosts are connected. Tokens
// come from server env only — no route accepts a GitLab token over the API.

export interface SourceStatusDeps {
  githubIdentity: () => Promise<GitHubIdentity | null>;
  gitlab: Pick<GitLabService, "configured" | "getIdentity">;
}

// Built from its dependencies so tests can inject a fake GitLab.
export const sourceRoutes = (sources: SourceStatusDeps): Route[] => [
  get("/api/sources", async () => {
    // One guarded GitLab call: trouble there degrades only GitLab's entry.
    const github = await sources.githubIdentity();
    const gitlab = sources.gitlab.configured() ? await sources.gitlab.getIdentity().catch(() => null) : null;
    const gitlabConnected = gitlab !== null;
    return json({
      sources: [
        { source: "github", connected: Boolean(github?.connected), login: github?.login ?? null },
        {
          source: "gitlab",
          configured: sources.gitlab.configured(),
          connected: gitlabConnected,
          login: gitlab?.login ?? null,
        },
      ],
    });
  }),

  get("/api/gitlab/identity", async () => json(await sources.gitlab.getIdentity())),
];

// --- review runs & durable sessions ------------------------------------------

const reviews: Route[] = [
  post("/api/review/runs", async (req) =>
    json(await deps.reviewService.beginReview(req.body.pullRequestId || "", req.body.repositoryId), 201)),

  post("/api/review/runs/async", async (req) =>
    json(
      await deps.reviewService.beginReviewAsync(req.body.pullRequestId || "", req.body.repositoryId),
      202,
    )),

  // Runs execute detached from any connection; clients attach for replay + tail.
  post("/api/review/sessions", async (req) => {
    const body = req.body;
    const maxCycles = Number(body.maxCycles);
    return json(
      await deps.reviewSessionHub.start({
        pullRequestId: String(body.pullRequestId || ""),
        repositoryId: body.repositoryId ? String(body.repositoryId) : undefined,
        maxCycles: Number.isFinite(maxCycles) && maxCycles > 0 ? maxCycles : undefined,
        trace: body.trace === true,
        suggest: body.suggest === true,
      }),
      201,
    );
  }),

  get("/api/review/sessions", () => json({ sessions: deps.reviewSessionHub.list() })),

  get("/api/review/sessions/:runId/stream", (req) => {
    const runId = param(req, "runId");
    if (!deps.reviewSessionHub.has(runId)) {
      return failure(404, "session_not_found");
    }
    // Replay everything recorded so far, then tail until "done" (or the
    // client leaves). A finished session ends right after the replay.
    return events((emit, signal) =>
      new Promise<void>((resolve) => {
        let finished = false;
        let detach = () => {};
        const finish = () => {
          if (finished) return;
          finished = true;
          detach();
          resolve();
        };
        detach = deps.reviewSessionHub.attach(runId, (event) => {
          if (!emit(event) || event.type === "done") finish();
        }) ?? (() => {});
        if (finished) detach();
        if (!deps.reviewSessionHub.isActive(runId)) finish();
        signal.addEventListener("abort", finish, { once: true });
      })
    );
  }),

  get("/api/review/runs/stream", (req) => {
    const params = query(req);
    const input = {
      pullRequestId: params.get("pullRequestId") || "",
      repositoryId: params.get("repositoryId") || undefined,
      maxCycles: optionalNumber(params.get("maxCycles")),
      trace: isTrue(params.get("trace")),
    };
    return events((emit) =>
      streamRun(emit, (send) => deps.reviewService.runReviewStream(input, send), "review_stream_failed")
    );
  }),

  get("/api/review/runs/:runId", async (req) =>
    json(await deps.reviewService.getReviewRun(param(req, "runId")))),

  get("/api/review/runs/:runId/events", async (req) =>
    json({ events: await deps.reviewService.streamReviewEvents(param(req, "runId")) })),

  get("/api/review/runs/:runId/findings", async (req) =>
    json({ findings: await deps.repository.getFindings(param(req, "runId")) })),

  get("/api/review/runs/:runId/checklist", async (req) =>
    json({ checklist: await deps.repository.getChecklist(param(req, "runId")) })),

  // "Check changes": delta re-review after new commits — verifies prior
  // findings and reviews only the compare delta. Synchronous single planner
  // call; 409s carry the reason (no_new_commits / run_not_checkable / llm).
  post("/api/review/runs/:runId/check-changes", async (req) =>
    json(await deps.reviewService.runCheckChanges(param(req, "runId")), 201), { body: "none" }),

  post("/api/review/runs/:runId/cancel", async (req) =>
    json({ cancelled: await deps.reviewService.cancelReview(param(req, "runId")) }), { body: "none" }),

  get("/api/review/agent/runs", async () =>
    json({ runs: await deps.reviewService.listReviewAgentRuns() })),

  get("/api/review/agent/runs/:runId", async (req) => {
    const record = await deps.reviewService.getReviewAgentRun(param(req, "runId"));
    return record ? json(record) : failure(404, "review_agent_run_not_found");
  }),

  get("/api/review/agent/runs/:runId/report", async (req) => {
    const record = await deps.reviewService.getReviewAgentRun(param(req, "runId"));
    return record
      ? markdown(record.report, disposition.inline(`${record.runId}.md`))
      : failure(404, "review_agent_run_not_found");
  }),

  get("/api/review/agent/runs/:runId/export", async (req) => {
    const runId = param(req, "runId");
    const bundle = await deps.reviewService.buildReviewExport(runId);
    if (bundle) {
      return bytes(bundle, "application/zip", {
        disposition: disposition.attachment(`review-${runId}.zip`),
      });
    }
    return await deps.reviewService.getReviewAgentRun(runId)
      ? failure(409, "review_agent_run_not_traced")
      : failure(404, "review_agent_run_not_found");
  }),

  get("/api/artifacts/:runId/markdown", async (req) =>
    markdown(await deps.artifactService.exportMarkdownReview(param(req, "runId")))),

  get("/api/artifacts/:runId/graph", async (req) =>
    text(
      await deps.artifactService.exportGraphJson(param(req, "runId")),
      "application/json; charset=utf-8",
    )),
];

// --- posting findings to GitHub / Jira (human-initiated, one per click) -------

const findingNotFound = (message: string) => json({ message }, 404);

const posting: Route[] = [
  post("/api/review/runs/:runId/pr-comment", async (req) => {
    const record = await deps.reviewService.getReviewAgentRun(param(req, "runId"));
    if (!record) return findingNotFound("review_run_not_found");
    const member = memberSession(req);
    const result = await deps.codeHost.postPullRequestComment(
      record.repositoryId,
      record.pullRequestId,
      buildPrSummaryComment(record),
      { asToken: memberToken(member.sessionId) },
    );
    await publishPostedArtifact(record, {
      kind: "summary",
      url: result.htmlUrl,
      postedBy: memberLogin(member.sessionId),
    }, { title: record.title });
    return withCookie(json({ posted: true, url: result.htmlUrl }, 201), member.cookie);
  }, { body: "none" }),

  // Post one finding's committable suggestion to the PR as a GitHub
  // ```suggestion block. Never batched, never automatic.
  post("/api/review/runs/:runId/findings/:findingId/suggestion", async (req) => {
    const record = await deps.reviewService.getReviewAgentRun(param(req, "runId"));
    if (!record) return findingNotFound("review_run_not_found");
    const finding = record.findings.find((item) => item.id === param(req, "findingId"));
    if (!finding || !finding.suggestion) return findingNotFound("suggestion_not_found");
    const member = memberSession(req);
    const result = await deps.codeHost.postPullRequestSuggestion(
      record.repositoryId,
      record.pullRequestId,
      {
        path: finding.filePath,
        startLine: finding.suggestion.startLine,
        endLine: finding.suggestion.endLine,
        code: finding.suggestion.code,
        note: `**${finding.title}** — ${finding.finding}`,
      },
      { asToken: memberToken(member.sessionId) },
    );
    await publishPostedArtifact(record, {
      kind: "suggestion",
      findingId: finding.id,
      url: result.htmlUrl,
      postedBy: memberLogin(member.sessionId),
    }, { title: finding.title, severity: finding.severity });
    return withCookie(json({ posted: true, url: result.htmlUrl }, 201), member.cookie);
  }, { body: "none" }),

  // Post one finding as a plain inline review comment at its file:line.
  // Works for any finding (no code suggestion required).
  post("/api/review/runs/:runId/findings/:findingId/comment", async (req) => {
    const record = await deps.reviewService.getReviewAgentRun(param(req, "runId"));
    if (!record) return findingNotFound("review_run_not_found");
    const finding = record.findings.find((item) => item.id === param(req, "findingId"));
    if (!finding || !finding.line) return findingNotFound("finding_not_commentable");
    const severity = finding.severity.toUpperCase();
    const fix = finding.suggestedFix ? `\n\n**Suggested fix:** ${finding.suggestedFix}` : "";
    const member = memberSession(req);
    const result = await deps.codeHost.postPullRequestInlineComment(
      record.repositoryId,
      record.pullRequestId,
      {
        path: finding.filePath,
        line: finding.line,
        body: `**[${severity}] ${finding.title}**\n\n${finding.finding}${fix}`,
      },
      { asToken: memberToken(member.sessionId) },
    );
    await publishPostedArtifact(record, {
      kind: "inline",
      findingId: finding.id,
      url: result.htmlUrl,
      postedBy: memberLogin(member.sessionId),
    }, { title: finding.title, severity: finding.severity });
    return withCookie(json({ posted: true, url: result.htmlUrl }, 201), member.cookie);
  }, { body: "none" }),

  post("/api/review/runs/:runId/findings/:findingId/dispatch", async (req) => {
    const record = await deps.reviewService.getReviewAgentRun(param(req, "runId"));
    const finding = record?.findings.find((item) => item.id === param(req, "findingId"));
    if (!record || !finding) return findingNotFound("finding_not_found");
    const member = memberSession(req);
    const runLink = runLinkFor(record.runId);
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
    const issue = await deps.codeHost.createRepositoryIssue(record.repositoryId, {
      title: `[capillary] ${finding.title}`,
      body,
      labels: ["capillary"],
      // Assignment is best-effort and never sinks the issue; `assigned: false`
      // in the response means the coding agent must be assigned by hand.
      // REST knows the coding agent as "Copilot" (Bot) — "copilot-swe-agent"
      // is its GraphQL actor login and REST silently drops it as unknown.
      assignees: ["Copilot"],
    }, { asToken: memberToken(member.sessionId) });
    await publishPostedArtifact(record, {
      kind: "dispatch",
      findingId: finding.id,
      url: issue.htmlUrl,
      postedBy: memberLogin(member.sessionId),
    }, { title: finding.title, severity: finding.severity });
    return withCookie(
      json({ dispatched: true, url: issue.htmlUrl, assigned: issue.assigned }, 201),
      member.cookie,
    );
  }, { body: "none" }),

  post("/api/review/runs/:runId/findings/:findingId/jira", async (req) => {
    if (!deps.jiraService.configured()) return failure(409, "jira_not_configured");
    const record = await deps.reviewService.getReviewAgentRun(param(req, "runId"));
    const finding = record?.findings.find((item) => item.id === param(req, "findingId"));
    if (!record || !finding) return findingNotFound("finding_not_found");
    const member = memberSession(req);
    const issue = await deps.jiraService.createIssue(finding, {
      prTitle: record.title,
      runLink: runLinkFor(record.runId),
    });
    await publishPostedArtifact(record, {
      kind: "jira",
      findingId: finding.id,
      url: issue.url,
      postedBy: memberLogin(member.sessionId),
    }, { title: finding.title, severity: finding.severity });
    return withCookie(json({ created: true, key: issue.key, url: issue.url }, 201), member.cookie);
  }, { body: "none" }),
];

// --- browser automation (CDP) and RetV functional runs -----------------------

const notTraced = (traced: unknown, notFound: string, untraced: string) =>
  traced ? failure(409, untraced) : failure(404, notFound);

const cdp: Route[] = [
  // Idempotent co-engineer browser: focuses the existing headed session,
  // relaunches if the user closed the window, opens one otherwise.
  post(
    "/api/cdp/browser/open",
    async (req) => json(await deps.cdpDriverService.openHeadedBrowser(req.body.startUrl || "about:blank"), 201),
    { body: "lenient" },
  ),

  post(
    "/api/cdp/sessions",
    async (req) =>
      json(
        await deps.cdpDriverService.createSession(req.body.startUrl || "about:blank", req.body.headed === true),
        201,
      ),
    { body: "lenient" },
  ),

  get("/api/cdp/sessions", () => json(deps.cdpDriverService.listSessions())),

  del("/api/cdp/sessions/:sessionId", async (req) =>
    json({ closed: await deps.cdpDriverService.closeSession(param(req, "sessionId")) })),

  post("/api/cdp/sessions/:sessionId/work-units", async (req) =>
    json(await deps.cdpDriverService.executeWorkUnit(param(req, "sessionId"), req.body))),

  post("/api/cdp/retv/run", async (req) => {
    const body = req.body;
    return json(
      await deps.cdpRetvAgentService.runGoalRound({
        goal: body.goal || "",
        sessionId: body.sessionId,
        startUrl: body.startUrl,
        maxCycles: body.maxCycles,
        maxDurationMs: body.maxDurationMs,
        trace: body.trace === true,
        dialogPolicy: body.dialogPolicy === "accept" || body.dialogPolicy === "dismiss"
          ? body.dialogPolicy
          : undefined,
        allowedOrigins: Array.isArray(body.allowedOrigins)
          ? body.allowedOrigins
          : parseAllowedDomains(body.allowedDomains),
      }),
    );
  }),

  get("/api/cdp/retv/run/stream", (req) => {
    const params = query(req);
    const policy = params.get("dialogPolicy");
    const dialogPolicy = policy === "accept" || policy === "dismiss" ? policy as "accept" | "dismiss" : undefined;
    const input = {
      goal: params.get("goal") || "",
      sessionId: params.get("sessionId") || undefined,
      startUrl: params.get("startUrl") || undefined,
      maxCycles: optionalNumber(params.get("maxCycles")),
      maxDurationMs: optionalNumber(params.get("maxDurationMs")),
      trace: isTrue(params.get("trace")),
      dialogPolicy,
      allowedOrigins: parseAllowedDomains(params.get("allowedDomains")),
    };
    return events((emit) =>
      streamRun(emit, (send) => deps.cdpRetvAgentService.runGoalRound(input, send), "retv_stream_failed")
    );
  }),

  // Live stop for an in-flight functional run. Closing the SSE stream alone
  // never stopped the server-side round; this lands the stop at the loop's next
  // boundary (racing any in-flight planner turn).
  post("/api/cdp/retv/runs/:runId/cancel", (req) =>
    json({ cancelled: deps.cdpRetvAgentService.cancelRetvRun(param(req, "runId")) }), { body: "none" }),

  get("/api/cdp/retv/runs", async () => json({ runs: await deps.cdpRetvAgentService.listRuns() })),

  get("/api/cdp/retv/runs/:runId", async (req) => {
    const record = await deps.cdpRetvAgentService.getRun(param(req, "runId"));
    return record ? json(record) : failure(404, "retv_run_not_found");
  }),

  get("/api/cdp/retv/runs/:runId/report", async (req) => {
    const record = await deps.cdpRetvAgentService.getRun(param(req, "runId"));
    return record
      ? markdown(record.report, disposition.inline(`${record.runId}.md`))
      : failure(404, "retv_run_not_found");
  }),

  // Run skeleton: export a traced run as a deterministic Playwright spec or a
  // model-agnostic agent runsheet (?format=playwright|runsheet).
  get("/api/cdp/retv/runs/:runId/driver", async (req) => {
    const runId = param(req, "runId");
    const format = query(req).get("format") === "runsheet" ? "runsheet" as const : "playwright" as const;
    const driver = await deps.cdpRetvAgentService.buildDriverExport(runId, format);
    if (!driver) {
      return notTraced(await deps.cdpRetvAgentService.getRun(runId), "retv_run_not_found", "retv_run_not_traced");
    }
    return text(
      driver.text,
      format === "playwright" ? "text/typescript; charset=utf-8" : "text/markdown; charset=utf-8",
      { disposition: disposition.attachment(driver.filename) },
    );
  }),

  get("/api/cdp/retv/runs/:runId/export", async (req) => {
    const runId = param(req, "runId");
    const bundle = await deps.cdpRetvAgentService.buildRunExport(runId);
    if (!bundle) {
      return notTraced(await deps.cdpRetvAgentService.getRun(runId), "retv_run_not_found", "retv_run_not_traced");
    }
    return bytes(bundle.bytes, "application/zip", { disposition: disposition.attachment(bundle.filename) });
  }),

  get("/api/cdp/retv/config", () => json(deps.cdpRetvAgentService.getPlannerConfig())),

  post(
    "/api/cdp/retv/config",
    (req) =>
      json(deps.cdpRetvAgentService.setPlannerConfig({
        providerKind: req.body.providerKind,
        model: req.body.model,
        baseUrl: req.body.baseUrl,
      })),
    { body: "lenient" },
  ),
];

// --- team: members, integrations, GitHub App, inbound hooks, channels --------

const team: Route[] = [
  // Per-browser sessions; a member attaches their own GitHub identity so posts
  // go out as them. Tokens are memory-only — a restart forgets them.
  get("/api/team/me", (req) => {
    const member = memberSession(req);
    return withCookie(json(deps.teamMembers.view(member.sessionId)), member.cookie);
  }),

  post("/api/team/me/github", async (req) => {
    const member = memberSession(req);
    const token = String(req.body.token ?? "").trim();
    if (!token) return withCookie(failure(400, "token_required"), member.cookie);
    const identity = await deps.githubService.getUserForToken(token);
    deps.teamMembers.attachIdentity(member.sessionId, identity, token);
    return withCookie(json(deps.teamMembers.view(member.sessionId)), member.cookie);
  }),

  del("/api/team/me/github", (req) => {
    const member = memberSession(req);
    deps.teamMembers.detachIdentity(member.sessionId);
    return withCookie(json(deps.teamMembers.view(member.sessionId)), member.cookie);
  }),

  get("/api/team/integrations", () =>
    json({
      githubApp: deps.githubApp.status(),
      jira: deps.jiraService.configured(),
      checksEnabled: process.env["CAPILLARY_CHECKS"] !== "0",
      autoReviewOnOpen: process.env["CAPILLARY_AUTO_REVIEW_ON_OPEN"] === "1",
      publicUrlConfigured: Boolean(publicUrl()),
      // localhost/private URLs mint the app without webhooks (GitHub rejects
      // unreachable hook URLs at manifest time); checks still work.
      webhookCapable: isPubliclyReachableUrl(process.env["CAPILLARY_PUBLIC_URL"] ?? ""),
    })),

  // Per-instance GitHub App (manifest flow): /manifest returns the GitHub page
  // + manifest the admin submits; GitHub redirects back to /callback with a
  // one-time code we convert to credentials.
  get("/api/github/app/manifest", (req) => {
    const url = publicUrl();
    if (!url) {
      return failure(409, "public_url_required", {
        message: "Set CAPILLARY_PUBLIC_URL so GitHub can redirect the manifest callback here.",
      });
    }
    const organization = query(req).get("org")?.trim();
    if (organization && !/^[A-Za-z0-9-]{1,39}$/.test(organization)) {
      return failure(400, "invalid_organization");
    }
    return json({
      manifest: buildAppManifest(url),
      createUrl: organization
        ? `https://github.com/organizations/${organization}/settings/apps/new`
        : "https://github.com/settings/apps/new",
    });
  }),

  get("/api/github/app/callback", async (req) => {
    const code = query(req).get("code") ?? "";
    if (!code) return failure(400, "code_required");
    try {
      const created = await deps.githubApp.completeManifest(code);
      const install = created.htmlUrl
        ? ` at <a href="${escapeHtml(created.htmlUrl)}/installations/new">${escapeHtml(created.htmlUrl)}</a>`
        : "";
      return html(
        `<!doctype html><body style="font-family:sans-serif;padding:24px;">` +
          `<h2>GitHub App created${created.slug ? `: ${escapeHtml(created.slug)}` : ""}</h2>` +
          `<p>Install it on your repositories${install}, then return to Capillary.</p></body>`,
      );
    } catch (error) {
      return failure(502, "app_manifest_conversion_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }),

  // Inbound GitHub webhook (the App's): PR opened -> auto-queue a review when
  // the operator opted in. Signature verified against the app webhook secret.
  post("/api/github/webhook", async (req) => {
    const raw = new Uint8Array(req.body as Buffer);
    const valid = await deps.githubApp.verifyWebhookSignature(raw, req.get("x-hub-signature-256") ?? null);
    if (!valid) return failure(401, "invalid_signature");
    if (req.get("x-github-event") === "pull_request" && process.env["CAPILLARY_AUTO_REVIEW_ON_OPEN"] === "1") {
      autoReviewOnOpen(raw);
    }
    return json({ received: true }, 202);
  }, { body: "raw" }),

  // Inbound GitLab merge-request webhook: MR opened / reopened / marked ready ->
  // auto-queue a review when the operator opted in. Verified by the shared
  // secret GitLab sends as X-Gitlab-Token (GITLAB_WEBHOOK_SECRET).
  post("/api/gitlab/webhook", (req) => {
    if (!verifyGitlabWebhookToken(process.env["GITLAB_WEBHOOK_SECRET"]?.trim(), req.get("x-gitlab-token") ?? null)) {
      return failure(401, "invalid_webhook_token");
    }
    const target = req.get("x-gitlab-event") === "Merge Request Hook" &&
        process.env["CAPILLARY_AUTO_REVIEW_ON_OPEN"] === "1"
      ? mergeRequestToReview((req.body as Buffer).toString("utf8"))
      : null;
    if (target) {
      void deps.reviewSessionHub.start(target).catch((error) => {
        console.warn("auto-review on MR open failed to start:", error);
      });
    }
    return json({ received: true }, 202);
  }, { body: "raw" }),

  post("/api/integrations/slack/command", async (req) => {
    const signingSecret = process.env["CAPILLARY_SLACK_SIGNING_SECRET"]?.trim();
    if (!signingSecret) return failure(409, "slack_signing_secret_not_configured");
    const raw = (req.body as Buffer).toString("utf8");
    const valid = await verifySlackSignature(
      signingSecret,
      raw,
      req.get("x-slack-request-timestamp") ?? null,
      req.get("x-slack-signature") ?? null,
    );
    if (!valid) return failure(401, "invalid_signature");
    return json(await slackCommand(new URLSearchParams(raw).get("text") ?? ""));
  }, { body: "raw" }),

  // A connection is a channel (incoming webhooks are minted per channel in both
  // Slack and Teams). Webhook URLs never leave the server unmasked.
  get("/api/team/connections", () =>
    json({
      connections: deps.teamConnections.list(),
      publicUrlConfigured: Boolean(publicUrl()),
    })),

  post("/api/team/connections", async (req) => {
    const body = req.body;
    try {
      return json(
        await deps.teamConnections.create({
          app: body.app,
          label: body.label,
          webhookUrl: body.webhookUrl,
          events: body.events,
          detail: body.detail,
        }),
        201,
      );
    } catch (error) {
      // Only the allow-list refusal is a 400; anything else is a real failure
      // and reaches errorMiddleware (logged, 500) instead of being mislabelled.
      if (!(error instanceof Error && error.message === "webhook_host_not_allowed")) throw error;
      return failure(400, "webhook_host_not_allowed", {
        message: "Webhook URL must be https on an allowed webhook host " +
          "(hooks.slack.com; *.webhook.office.com / *.logic.azure.com for Teams). " +
          "Extend with CAPILLARY_WEBHOOK_HOST_ALLOWLIST for self-hosted relays.",
      });
    }
  }),

  patch("/api/team/connections/:id", async (req) => {
    const body = req.body;
    const connection = await deps.teamConnections.update(param(req, "id"), {
      label: body.label,
      events: body.events,
      detail: body.detail,
      repoFilter: body.repoFilter,
      enabled: body.enabled,
    });
    return connection ? json(connection) : failure(404, "connection_not_found");
  }),

  del("/api/team/connections/:id", async (req) =>
    json({ deleted: await deps.teamConnections.delete(param(req, "id")) })),

  // Fire the fixed test card so a channel can be verified right after wiring.
  post("/api/team/connections/:id/test", async (req) => {
    const result = await deps.channelPublisher.sendTest(param(req, "id"));
    return json(result, result.ok ? 200 : result.error === "connection_not_found" ? 404 : 502);
  }, { body: "none" }),
];

/** Detached: webhook responses must be fast; the session hub owns the run. */
function autoReviewOnOpen(raw: Uint8Array): void {
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
    void deps.reviewSessionHub.start({ pullRequestId, repositoryId }).catch((error) => {
      console.warn("auto-review on PR open failed to start:", error);
    });
  } catch {
    // Malformed payloads are ignored; GitHub retries transient failures.
  }
}

/** Slack slash command → the message body Slack renders. */
async function slackCommand(textArg: string): Promise<{ response_type: string; text: string }> {
  const command = parseInboundCommand(textArg);
  if (command.kind === "status") {
    const sessions = deps.reviewSessionHub.list();
    const active = sessions.filter((session) => session.active);
    return {
      response_type: "ephemeral",
      text: active.length === 0
        ? `No reviews running. ${sessions.length} recent session(s).`
        : active.map((s) => `PR #${s.pullRequestId} — running (${s.eventCount} events)`).join("\n"),
    };
  }
  if (command.kind === "review") {
    try {
      const repos = await deps.codeHost.lookupRepositories(command.ownerRepo);
      const repo = repos.find((item) => item.fullName.toLowerCase() === command.ownerRepo.toLowerCase());
      if (!repo) {
        return {
          response_type: "ephemeral",
          text: `Repository ${command.ownerRepo} not found or not accessible.`,
        };
      }
      const session = await deps.reviewSessionHub.start({
        pullRequestId: command.prNumber,
        repositoryId: repo.id,
      });
      return {
        response_type: "in_channel",
        text: `Capillary review started for ${command.ownerRepo}#${command.prNumber} ` +
          `(run ${session.runId}). The card lands here when it finishes.`,
      };
    } catch (error) {
      return {
        response_type: "ephemeral",
        text: `Could not start review: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  }
  return {
    response_type: "ephemeral",
    text: "Usage: /capillary review owner/repo#123 · /capillary status",
  };
}

/** The complete API route table, in registration order. */
export const apiRoutes: readonly Route[] = [...github, ...sourceRoutes({ githubIdentity: () => deps.repository.getIdentity(), gitlab: deps.gitlabService }), ...reviews, ...posting, ...cdp, ...team];

// --- errors ------------------------------------------------------------------

/**
 * Render thrown errors: AppError carries its own status and code; client
 * errors raised by Express middleware (body too large, unsatisfiable range…)
 * keep their 4xx status; anything else is a logged, opaque 500.
 */
export function errorMiddleware() {
  return (error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      // Mid-stream failure (SSE): the status line is gone; let Express close it.
      next(error);
      return;
    }
    if (error instanceof AppError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    const status = (error as { status?: unknown })?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const code = (STATUS_CODES[status] ?? "bad_request").toLowerCase().replace(/[^a-z]+/g, "_");
      res.status(status).json({ error: code });
      return;
    }
    console.error("unhandled request error:", error);
    res.status(500).json({ error: "internal_server_error" });
  };
}

// --- HTML ----------------------------------------------------------------------

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

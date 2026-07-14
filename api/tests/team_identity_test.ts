// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assert, assertEquals } from "jsr:@std/assert";
import { MemberSessionStore } from "../src/services/team/members.ts";
import {
  buildAppJwt,
  buildAppManifest,
  GithubAppService,
  importAppKey,
  pkcs1ToPkcs8,
} from "../src/services/team/github_app.ts";
import { buildCheckRun, CheckPublisher } from "../src/services/team/checks.ts";
import {
  buildJiraIssuePayload,
  jiraConfigFromEnv,
  JiraService,
} from "../src/services/team/jira.ts";
import { parseInboundCommand, verifySlackSignature } from "../src/services/team/inbound.ts";
import { repoFilterMatches } from "../src/services/team/connections.ts";
import { ReviewFinishedEvent, TeamEventBus } from "../src/services/team/event_bus.ts";
import { ReviewFinding } from "../src/domain/entities.ts";

// --- member sessions ---------------------------------------------------------

Deno.test("member sessions mint, attach identity, and never leak the token in views", () => {
  const store = new MemberSessionStore();
  const first = store.ensure(undefined);
  assert(first.isNew);
  const again = store.ensure(first.sessionId);
  assertEquals(again.isNew, false);
  assertEquals(store.view(first.sessionId).connected, false);

  store.attachIdentity(first.sessionId, { login: "kwarren" }, "ghp_secret");
  const view = store.view(first.sessionId);
  assertEquals(view, { connected: true, login: "kwarren", avatarUrl: undefined });
  assert(!JSON.stringify(view).includes("ghp_secret"));
  assertEquals(store.tokenFor(first.sessionId), "ghp_secret");
  assertEquals(store.loginFor(first.sessionId), "kwarren");

  store.detachIdentity(first.sessionId);
  assertEquals(store.view(first.sessionId).connected, false);
  assertEquals(store.tokenFor(first.sessionId), null);
  // Unknown/garbage cookie values just mint fresh sessions.
  assert(store.ensure("not-a-session").isNew);
});

// --- github app: manifest, key handling, jwt, webhook signature ----------------

Deno.test("app manifest points every callback at the public URL", () => {
  const manifest = buildAppManifest("https://cap.example.com/") as {
    redirect_url: string;
    hook_attributes: { url: string };
    default_permissions: Record<string, string>;
  };
  assertEquals(manifest.redirect_url, "https://cap.example.com/api/github/app/callback");
  assertEquals(manifest.hook_attributes.url, "https://cap.example.com/api/github/webhook");
  assertEquals(manifest.default_permissions.checks, "write");
  assertEquals(manifest.default_permissions.contents, "read");
});

Deno.test("pkcs1ToPkcs8 emits well-formed DER envelopes across length forms", () => {
  for (const size of [16, 200, 4096]) {
    const body = new Uint8Array(size).fill(0xab);
    const wrapped = pkcs1ToPkcs8(body);
    assertEquals(wrapped[0], 0x30); // outer SEQUENCE
    // version INTEGER 0 appears right after the outer header.
    const headerLen = wrapped[1] < 0x80 ? 2 : 2 + (wrapped[1] & 0x7f);
    assertEquals([...wrapped.slice(headerLen, headerLen + 3)], [0x02, 0x01, 0x00]);
    // the original body survives at the tail.
    assertEquals([...wrapped.slice(-4)], [0xab, 0xab, 0xab, 0xab]);
  }
});

Deno.test("app JWT signs RS256 with honest claims (verifiable, clock-skewed iat)", async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${
    btoa(String.fromCharCode(...pkcs8))
  }\n-----END PRIVATE KEY-----`;
  const key = await importAppKey(pem);
  const now = 1_800_000_000;
  const jwt = await buildAppJwt("12345", key, now);

  const [header, payload, signature] = jwt.split(".");
  const claims = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/")));
  assertEquals(claims.iss, "12345");
  assertEquals(claims.iat, now - 60);
  assertEquals(claims.exp, now + 540);
  const sigBytes = Uint8Array.from(
    atob(signature.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    pair.publicKey,
    sigBytes,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  assert(valid);
});

Deno.test("webhook signature verification accepts the real MAC and rejects forgeries", async () => {
  const app = new GithubAppService(null);
  await app.init({
    appId: "1",
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----",
    webhookSecret: "whsec",
  });
  const body = new TextEncoder().encode('{"action":"opened"}');

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("whsec"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body.buffer as ArrayBuffer));
  const good = `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

  assert(await app.verifyWebhookSignature(body, good));
  assertEquals(await app.verifyWebhookSignature(body, "sha256=" + "0".repeat(64)), false);
  assertEquals(await app.verifyWebhookSignature(body, null), false);
});

// --- checks -------------------------------------------------------------------

const REVIEW_EVENT: ReviewFinishedEvent = {
  type: "review.completed",
  at: "2026-07-13T00:05:00Z",
  runId: "run-1",
  pullRequestId: "47",
  repositoryId: "999",
  title: "teams alpha",
  verdict: "request_changes",
  goalAchieved: true,
  stopReason: "verdict_reached",
  findingCount: 3,
  blockerCount: 1,
  highCount: 1,
  cycleCount: 8,
  durationMs: 90_000,
  model: "claude_code/opus",
  inputTokens: 100,
  outputTokens: 10,
  topFindings: [{ severity: "blocker", title: "bad", filePath: "a.ts", line: 3 }],
};

Deno.test("buildCheckRun maps verdicts onto merge-box conclusions", () => {
  const check = buildCheckRun(REVIEW_EVENT, "abc123", "https://cap/x");
  assertEquals(check.conclusion, "action_required");
  assertEquals(check.head_sha, "abc123");
  assertEquals(check.details_url, "https://cap/x");
  assert(check.output.summary.includes("[BLOCKER] bad"));
  assertEquals(
    buildCheckRun({ ...REVIEW_EVENT, verdict: "approve" }, "s", null).conclusion,
    "success",
  );
  assertEquals(
    buildCheckRun({ ...REVIEW_EVENT, verdict: "comment" }, "s", null).conclusion,
    "neutral",
  );
  assertEquals(
    buildCheckRun({ ...REVIEW_EVENT, type: "review.cancelled" }, "s", null).conclusion,
    "cancelled",
  );
});

Deno.test("CheckPublisher posts once per finished review and stays silent unconfigured", async () => {
  const calls: string[] = [];
  const fetchFn = ((url: string, init?: RequestInit) => {
    calls.push(`${url}:${String(init?.body ?? "").includes("abc123")}`);
    return Promise.resolve(new Response("{}", { status: 201 }));
  }) as typeof fetch;

  const bus = new TeamEventBus();
  const publisher = new CheckPublisher({
    app: { configured: () => true, installationToken: () => Promise.resolve("tok") },
    resolveTarget: () => Promise.resolve({ fullName: "o/r", headSha: "abc123" }),
    deepLink: () => null,
    fetchFn,
  });
  publisher.start(bus);
  bus.emit(REVIEW_EVENT);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(calls.length, 1);
  assert(calls[0].startsWith("https://api.github.com/repos/o/r/check-runs"));

  const silentBus = new TeamEventBus();
  const silent = new CheckPublisher({
    app: { configured: () => false, installationToken: () => Promise.reject(new Error("no")) },
    resolveTarget: () => Promise.resolve(null),
    deepLink: () => null,
    fetchFn,
  });
  silent.start(silentBus);
  silentBus.emit(REVIEW_EVENT);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(calls.length, 1); // unconfigured app: no delivery attempted
});

// --- jira ----------------------------------------------------------------------

function finding(): ReviewFinding {
  return {
    id: "f1",
    runId: "r1",
    severity: "high",
    passName: "Trace",
    filePath: "src/x.ts",
    line: 9,
    title: "unchecked deref",
    finding: "detail text",
    evidence: ["e1"],
    suggestedFix: "add a guard",
    confidence: 0.9,
  };
}

Deno.test("jira config requires all four env values; payload carries the finding", async () => {
  assertEquals(jiraConfigFromEnv({ JIRA_BASE_URL: "https://x.atlassian.net" }), null);
  const config = jiraConfigFromEnv({
    JIRA_BASE_URL: "https://x.atlassian.net/",
    JIRA_EMAIL: "k@x.dev",
    JIRA_API_TOKEN: "tok",
    JIRA_PROJECT_KEY: "CAP",
  });
  assertEquals(config?.baseUrl, "https://x.atlassian.net");

  const payload = buildJiraIssuePayload("CAP", finding(), {
    prTitle: "PR",
    runLink: "https://cap/r",
  }) as {
    fields: { summary: string; labels: string[] };
  };
  assertEquals(payload.fields.summary, "[HIGH] unchecked deref");
  assert(payload.fields.labels.includes("severity-high"));

  const calls: { url: string; auth: string }[] = [];
  const fetchFn = ((url: string, init?: RequestInit) => {
    calls.push({ url, auth: String((init?.headers as Record<string, string>).authorization) });
    return Promise.resolve(new Response(JSON.stringify({ key: "CAP-7" }), { status: 201 }));
  }) as typeof fetch;
  const service = new JiraService(config, { fetchFn });
  const created = await service.createIssue(finding(), { prTitle: "PR", runLink: null });
  assertEquals(created, { key: "CAP-7", url: "https://x.atlassian.net/browse/CAP-7" });
  assert(calls[0].url.endsWith("/rest/api/3/issue"));
  assert(calls[0].auth.startsWith("Basic "));
});

// --- inbound slack ----------------------------------------------------------------

Deno.test("inbound command parser handles review/status/garbage", () => {
  assertEquals(parseInboundCommand("review Solesius/capillary-cr#47"), {
    kind: "review",
    ownerRepo: "Solesius/capillary-cr",
    prNumber: "47",
  });
  assertEquals(parseInboundCommand("  STATUS "), { kind: "status" });
  assertEquals(parseInboundCommand("do a flip").kind, "unknown");
  assertEquals(parseInboundCommand("review nonsense").kind, "unknown");
});

Deno.test("slack signature verifies v0 MAC and rejects stale or forged requests", async () => {
  const secret = "sekrit";
  const body = "command=%2Fcapillary&text=status";
  const timestamp = "1800000000";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)),
  );
  const good = `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

  assert(await verifySlackSignature(secret, body, timestamp, good, 1_800_000_100));
  assertEquals(
    await verifySlackSignature(secret, body, timestamp, good, 1_800_000_000 + 600),
    false,
  );
  assertEquals(
    await verifySlackSignature(secret, body, timestamp, "v0=" + "0".repeat(64), 1_800_000_100),
    false,
  );
  assertEquals(await verifySlackSignature(secret, body, null, good, 1_800_000_100), false);
});

// --- per-repo routing ---------------------------------------------------------------

Deno.test("repoFilterMatches: exact, prefix, unscoped, and repo-less events", () => {
  assert(repoFilterMatches(undefined, "owner/repo"));
  assert(repoFilterMatches("", "owner/repo"));
  assert(repoFilterMatches("Owner/Repo", "owner/repo"));
  assertEquals(repoFilterMatches("owner/other", "owner/repo"), false);
  assert(repoFilterMatches("owner/*", "owner/repo"));
  assertEquals(repoFilterMatches("owner/*", "elsewhere/repo"), false);
  // RetV events carry no repository: scoped channels never receive them.
  assertEquals(repoFilterMatches("owner/*", null), false);
  assert(repoFilterMatches(undefined, null));
});

// --- fixes from capillary's own review of this branch ---------------------------

Deno.test("connectionMatches scopes by repository FULL NAME, not the numeric id", async () => {
  // Regression for the self-review blocker: an "owner/name" filter compared
  // against the numeric repositoryId silently never matched.
  const { ConnectionStore } = await import("../src/services/team/connections.ts");
  const { connectionMatches } = await import("../src/services/team/connections.ts");
  const store = new ConnectionStore(null);
  const scoped = await store.create({
    app: "slack",
    label: "#cap-only",
    webhookUrl: "https://hooks.slack.com/services/X",
  });
  await store.update(scoped.id, { repoFilter: "Solesius/capillary-cr" });
  const connection = store.getRaw(scoped.id)!;

  const event = {
    ...REVIEW_EVENT,
    repositoryId: "999888777",
    repositoryFullName: "Solesius/capillary-cr",
  };
  assert(connectionMatches(connection, event));
  assertEquals(
    connectionMatches(connection, { ...event, repositoryFullName: "Solesius/other" }),
    false,
  );
  // Older records without a full name: the filter cannot match a numeric id —
  // scoped channels stay silent rather than misrouting.
  assertEquals(
    connectionMatches(connection, { ...event, repositoryFullName: undefined }),
    false,
  );
});

Deno.test("reviewCompletionRefusal blocks evidence-free request_changes only", async () => {
  const { reviewCompletionRefusal } = await import("../src/services/review_agent_service.ts");
  // The live bug: request_changes narrated in the report, zero recorded.
  const refusal = reviewCompletionRefusal("request_changes", 0);
  assert(refusal !== null && refusal.includes("recordFinding"));
  // Evidence present, or verdicts that assert nothing: completion proceeds.
  assertEquals(reviewCompletionRefusal("request_changes", 2), null);
  assertEquals(reviewCompletionRefusal("approve", 0), null);
  assertEquals(reviewCompletionRefusal("comment", 0), null);
});

Deno.test("manifest omits webhooks on unreachable hosts (GitHub rejects localhost hooks)", async () => {
  const { buildAppManifest, isPubliclyReachableUrl } = await import(
    "../src/services/team/github_app.ts"
  );
  assert(isPubliclyReachableUrl("https://cap.example.com"));
  assertEquals(isPubliclyReachableUrl("http://localhost:7858"), false);
  assertEquals(isPubliclyReachableUrl("http://127.0.0.1:7858"), false);
  assertEquals(isPubliclyReachableUrl("https://192.168.1.20"), false);
  assertEquals(isPubliclyReachableUrl("https://172.20.0.5"), false);
  assertEquals(isPubliclyReachableUrl("https://cap.corp.internal"), false);

  const local = buildAppManifest("http://localhost:7858") as Record<string, unknown>;
  assertEquals("hook_attributes" in local, false);
  assertEquals("default_events" in local, false);
  assertEquals(String(local.redirect_url), "http://localhost:7858/api/github/app/callback");

  const publicManifest = buildAppManifest("https://cap.example.com") as {
    hook_attributes: { url: string };
  };
  assertEquals(publicManifest.hook_attributes.url, "https://cap.example.com/api/github/webhook");
});

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import {
  ChannelConnection,
  connectionMatches,
  ConnectionPersistence,
  ConnectionStore,
  isAllowedWebhookUrl,
  maskWebhookUrl,
} from "../src/services/team/connections.ts";
import { retvRecordToEvent, TeamEvent } from "../src/services/team/event_bus.ts";

class FakePersistence implements ConnectionPersistence {
  saved = new Map<string, ChannelConnection>();
  saveConnection(connection: ChannelConnection): Promise<void> {
    this.saved.set(connection.id, structuredClone(connection));
    return Promise.resolve();
  }
  deleteConnection(id: string): Promise<void> {
    this.saved.delete(id);
    return Promise.resolve();
  }
  listConnections(): Promise<ChannelConnection[]> {
    return Promise.resolve([...this.saved.values()]);
  }
}

const SLACK_URL = "https://hooks.slack.com/services/T000/B000/secret1234";

Deno.test("ConnectionStore.create persists, defaults toggles, and masks the URL in views", async () => {
  const persistence = new FakePersistence();
  const store = new ConnectionStore(persistence);
  const view = await store.create({ app: "slack", label: "#code-reviews", webhookUrl: SLACK_URL });

  assertEquals(view.app, "slack");
  assertEquals(view.events.reviewCompleted, true);
  // Per-finding pings are opt-in, never a default channel experience.
  assertEquals(view.events.findingPosted, false);
  // The serialized view surface must never carry the full webhook path.
  assert(!JSON.stringify(store.list()).includes("/services/T000/B000/secret1234"));
  assert(view.webhookUrlMasked.endsWith("1234"));
  assert(!view.webhookUrlMasked.includes("/services/T000/B000/secret1234"));
  assertEquals(persistence.saved.size, 1);
});

Deno.test("ConnectionStore.create rejects non-https and non-allowlisted webhook URLs", async () => {
  const store = new ConnectionStore(null);
  await assertRejects(() =>
    store.create({ app: "slack", label: "x", webhookUrl: "http://plain.example/hook" })
  );
  await assertRejects(() => store.create({ app: "slack", label: "x", webhookUrl: "not a url" }));
  // SSRF surface flagged by self-review: arbitrary https hosts are refused —
  // internal endpoints must not be probeable through the publisher.
  await assertRejects(() =>
    store.create({ app: "slack", label: "x", webhookUrl: "https://169.254.169.254/latest/meta" })
  );
  await assertRejects(() =>
    store.create({ app: "slack", label: "x", webhookUrl: "https://internal.admin.corp/hook" })
  );
});

Deno.test("isAllowedWebhookUrl enforces per-app hosts and env extension", () => {
  assert(isAllowedWebhookUrl(SLACK_URL, "slack"));
  assert(!isAllowedWebhookUrl(SLACK_URL, "teams"));
  assert(
    isAllowedWebhookUrl("https://x.webhook.office.com/webhookb2/abc", "teams"),
  );
  assert(
    isAllowedWebhookUrl("https://prod-01.westus.logic.azure.com/workflows/a", "teams"),
  );
  // Suffix matching never falls for lookalike registrable domains.
  assert(!isAllowedWebhookUrl("https://hooks.slack.com.evil.example/x", "slack"));
  assert(!isAllowedWebhookUrl("https://evilhooks.slack.com.attacker.net/x", "slack"));
  // Operator-owned allow-list extension for self-hosted relays.
  assert(!isAllowedWebhookUrl("https://relay.corp.example/hook", "slack"));
  assert(isAllowedWebhookUrl("https://relay.corp.example/hook", "slack", ["relay.corp.example"]));
  assert(
    isAllowedWebhookUrl("https://a.relay.corp.example/hook", "slack", ["*.relay.corp.example"]),
  );
});

Deno.test("ConnectionStore honors the extra webhook host allow-list", async () => {
  const store = new ConnectionStore(null, { extraWebhookHosts: ["relay.corp.example"] });
  const created = await store.create({
    app: "slack",
    label: "#relay",
    webhookUrl: "https://relay.corp.example/hook",
  });
  assert(created.webhookUrlMasked.startsWith("https://relay.corp.example"));
});

Deno.test("ConnectionStore.init loads persisted rows and seeds env webhooks exactly once", async () => {
  const persistence = new FakePersistence();
  const first = new ConnectionStore(persistence);
  await first.init({ slackWebhookUrl: SLACK_URL });
  assertEquals(first.list().length, 1);

  // Second boot with the same env: no duplicate seed.
  const second = new ConnectionStore(persistence);
  await second.init({ slackWebhookUrl: SLACK_URL });
  assertEquals(second.list().length, 1);
  assertEquals(persistence.saved.size, 1);
});

Deno.test("ConnectionStore.update patches toggles and enabled; delete removes from persistence", async () => {
  const persistence = new FakePersistence();
  const store = new ConnectionStore(persistence);
  const created = await store.create({
    app: "teams",
    label: "#eng",
    webhookUrl: "https://prod-01.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke",
  });

  const updated = await store.update(created.id, {
    enabled: false,
    events: { findingPosted: true },
    detail: "findings",
  });
  assertEquals(updated?.enabled, false);
  assertEquals(updated?.events.findingPosted, true);
  assertEquals(updated?.events.reviewCompleted, true);
  assertEquals(updated?.detail, "findings");

  assertEquals(await store.delete(created.id), true);
  assertEquals(await store.delete(created.id), false);
  assertEquals(persistence.saved.size, 0);
});

Deno.test("connectionMatches routes by event toggle and respects enabled", () => {
  const base: ChannelConnection = {
    id: "c1",
    app: "slack",
    label: "#x",
    webhookUrl: SLACK_URL,
    events: {
      reviewCompleted: true,
      reviewCancelled: false,
      retvCompleted: false,
      findingPosted: false,
    },
    detail: "summary",
    enabled: true,
    createdAt: "2026-07-13T00:00:00Z",
  };
  const review: TeamEvent = {
    type: "review.completed",
    at: "",
    runId: "r",
    pullRequestId: "1",
    repositoryId: "o/r",
    title: "t",
    verdict: "comment",
    goalAchieved: true,
    stopReason: "verdict_reached",
    findingCount: 0,
    blockerCount: 0,
    highCount: 0,
    cycleCount: 1,
    durationMs: 1,
    topFindings: [],
  };
  assert(connectionMatches(base, review));
  assert(!connectionMatches({ ...base, enabled: false }, review));
  assert(!connectionMatches(base, { ...review, type: "review.cancelled" }));
  const retv = retvRecordToEvent({
    runId: "rv",
    sessionId: "s",
    goal: "g",
    allowedOrigin: "o",
    stopReason: "goal_achieved",
    functionalTestSucceeded: true,
    goalAchieved: true,
    startedAt: "",
    finishedAt: "",
    durationMs: 0,
    cycleCount: 0,
    milestonesCompleted: 0,
    milestonesTotal: 0,
    percent: 0,
    findings: [],
    summary: "",
    report: "",
    traceEnabled: false,
  });
  assert(!connectionMatches(base, retv));
  assert(connectionMatches({ ...base, events: { ...base.events, retvCompleted: true } }, retv));
});

Deno.test("recordDelivery stamps lastPostedAt on success and lastError on failure", async () => {
  const store = new ConnectionStore(null);
  const created = await store.create({ app: "slack", label: "#x", webhookUrl: SLACK_URL });

  await store.recordDelivery(created.id, false, "HTTP 404");
  assertEquals(store.list()[0].lastError, "HTTP 404");

  await store.recordDelivery(created.id, true);
  assertEquals(store.list()[0].lastError, undefined);
  assert(store.list()[0].lastPostedAt);
});

Deno.test("maskWebhookUrl keeps only origin and tail", () => {
  const masked = maskWebhookUrl(SLACK_URL);
  assertEquals(masked, "https://hooks.slack.com/…1234");
  assertEquals(maskWebhookUrl("garbage-value"), "…alue");
});

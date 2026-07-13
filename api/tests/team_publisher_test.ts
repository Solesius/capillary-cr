// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assert, assertEquals } from "jsr:@std/assert";
import { ChannelConnection, ConnectionStore } from "../src/services/team/connections.ts";
import { ReviewFinishedEvent, TeamEventBus } from "../src/services/team/event_bus.ts";
import { ChannelPublisher } from "../src/services/team/publisher.ts";
import { withPostedArtifact } from "../src/services/team/posted_artifacts.ts";

const EVENT: ReviewFinishedEvent = {
  type: "review.completed",
  at: "2026-07-13T00:05:00Z",
  runId: "run-abc",
  pullRequestId: "12",
  repositoryId: "owner/repo",
  title: "PR",
  verdict: "approve",
  goalAchieved: true,
  stopReason: "verdict_reached",
  findingCount: 0,
  blockerCount: 0,
  highCount: 0,
  cycleCount: 2,
  durationMs: 10_000,
  topFindings: [],
};

function capturingFetch(status = 200) {
  const calls: { url: string; body: string }[] = [];
  const fetchFn = (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    return Promise.resolve(new Response("ok", { status }));
  };
  return { calls, fetchFn };
}

Deno.test("publisher fans out only to enabled connections whose toggles match", async () => {
  const store = new ConnectionStore(null);
  const wants = await store.create({
    app: "slack",
    label: "#a",
    webhookUrl: "https://hooks.slack.com/services/AAA",
  });
  await store.create({
    app: "slack",
    label: "#b",
    webhookUrl: "https://hooks.slack.com/services/BBB",
    events: { reviewCompleted: false },
  });
  const disabled = await store.create({
    app: "teams",
    label: "#c",
    webhookUrl: "https://example.webhook.office.com/CCC",
  });
  await store.update(disabled.id, { enabled: false });

  const { calls, fetchFn } = capturingFetch();
  const publisher = new ChannelPublisher(store, { fetchFn });
  await publisher.deliver(EVENT);

  assertEquals(calls.length, 1);
  assert(calls[0].url.endsWith("AAA"));
  assert(store.list().find((c) => c.id === wants.id)?.lastPostedAt);
});

Deno.test("publisher renders per-app payloads from one event", async () => {
  const store = new ConnectionStore(null);
  await store.create({ app: "slack", label: "#a", webhookUrl: "https://hooks.slack.com/S" });
  await store.create({
    app: "teams",
    label: "#b",
    webhookUrl: "https://example.webhook.office.com/T",
  });

  const { calls, fetchFn } = capturingFetch();
  const publisher = new ChannelPublisher(store, { fetchFn, publicUrl: "https://cap.example.com" });
  await publisher.deliver(EVENT);

  assertEquals(calls.length, 2);
  const slackBody = calls.find((c) => c.url.includes("slack"))!.body;
  const teamsBody = calls.find((c) => c.url.includes("office"))!.body;
  assert(slackBody.includes('"blocks"'));
  assert(teamsBody.includes("AdaptiveCard"));
});

Deno.test("a failing webhook stamps lastError and never throws into the emitter", async () => {
  const store = new ConnectionStore(null);
  const created = await store.create({
    app: "slack",
    label: "#a",
    webhookUrl: "https://hooks.slack.com/S",
  });
  const { fetchFn } = capturingFetch(404);
  const publisher = new ChannelPublisher(store, { fetchFn });

  const bus = new TeamEventBus();
  publisher.start(bus);
  bus.emit(EVENT); // must not throw
  // deliver() directly to await the async path deterministically.
  await publisher.deliver(EVENT);
  assertEquals(store.list().find((c) => c.id === created.id)?.lastError, "HTTP 404");
});

Deno.test("sendTest hits the connection webhook and reports the outcome", async () => {
  const store = new ConnectionStore(null);
  const created = await store.create({
    app: "slack",
    label: "#a",
    webhookUrl: "https://hooks.slack.com/S",
  });
  const { calls, fetchFn } = capturingFetch();
  const publisher = new ChannelPublisher(store, { fetchFn });

  assertEquals(await publisher.sendTest("nope"), { ok: false, error: "connection_not_found" });
  const result = await publisher.sendTest(created.id);
  assertEquals(result.ok, true);
  assertEquals(calls.length, 1);
  assert(calls[0].body.includes("connection test"));
});

Deno.test("publisher refuses delivery to a stored URL outside the allow-list", async () => {
  // A connection persisted before the allow-list tightened: loaded from
  // storage, but never posted to.
  const store = new ConnectionStore(null);
  const legit = await store.create({
    app: "slack",
    label: "#ok",
    webhookUrl: "https://hooks.slack.com/services/OK",
  });
  const smuggled: ChannelConnection = {
    ...store.getRaw(legit.id)!,
    id: "smuggled",
    label: "#internal",
    webhookUrl: "https://internal.admin.corp/hook",
  };
  const persistence = new StubPersistence([smuggled]);
  const loaded = new ConnectionStore(persistence);
  await loaded.init();

  const { calls, fetchFn } = capturingFetch();
  const publisher = new ChannelPublisher(loaded, { fetchFn });
  await publisher.deliver(EVENT);

  assertEquals(calls.length, 0);
  assertEquals(loaded.list()[0].lastError, "webhook_host_not_allowed");
});

class StubPersistence {
  #rows: ChannelConnection[];
  constructor(rows: ChannelConnection[]) {
    this.#rows = rows;
  }
  saveConnection(connection: ChannelConnection): Promise<void> {
    this.#rows = this.#rows.filter((row) => row.id !== connection.id).concat(connection);
    return Promise.resolve();
  }
  deleteConnection(id: string): Promise<void> {
    this.#rows = this.#rows.filter((row) => row.id !== id);
    return Promise.resolve();
  }
  listConnections(): Promise<ChannelConnection[]> {
    return Promise.resolve([...this.#rows]);
  }
}

Deno.test("withPostedArtifact replaces the entry for the same target instead of duplicating", () => {
  const first = withPostedArtifact(undefined, {
    kind: "inline",
    findingId: "f1",
    url: "https://github.com/x/1",
    postedAt: "t1",
  });
  const reposted = withPostedArtifact(first, {
    kind: "inline",
    findingId: "f1",
    url: "https://github.com/x/2",
    postedAt: "t2",
  });
  assertEquals(reposted.length, 1);
  assertEquals(reposted[0].url, "https://github.com/x/2");

  const withSummary = withPostedArtifact(reposted, {
    kind: "summary",
    url: "https://github.com/x/3",
    postedAt: "t3",
  });
  assertEquals(withSummary.length, 2);
});

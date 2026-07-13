// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// publisher.ts — the bus subscriber that delivers team events to registered
// channel connections. Delivery is best-effort and isolated per connection: a
// dead webhook logs and stamps lastError on that connection, never affects
// other channels, and never touches the emitting run.

import { buildSlackPayload, buildTeamsPayload, buildTestPayload, CardContext } from "./cards.ts";
import { ChannelConnection, connectionMatches, ConnectionStore } from "./connections.ts";
import { TeamEvent, TeamEventBus } from "./event_bus.ts";

const DELIVERY_TIMEOUT_MS = 8_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class ChannelPublisher {
  #store: ConnectionStore;
  #publicUrl?: string;
  #fetch: FetchLike;

  constructor(
    store: ConnectionStore,
    options: { publicUrl?: string; fetchFn?: FetchLike } = {},
  ) {
    this.#store = store;
    this.#publicUrl = options.publicUrl?.trim() || undefined;
    this.#fetch = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  /** Subscribe to the bus; returns the detach function. */
  start(bus: TeamEventBus): () => void {
    return bus.subscribe((event) => this.deliver(event));
  }

  /** Fan one event out to every matching enabled connection. */
  async deliver(event: TeamEvent): Promise<void> {
    const targets = this.#store.listRaw().filter((connection) =>
      connectionMatches(connection, event)
    );
    await Promise.all(
      targets.map((connection) => this.#post(connection, this.#payloadFor(connection, event))),
    );
  }

  /** Fire the fixed test card at one connection (the UI "Test" button). */
  async sendTest(connectionId: string): Promise<{ ok: boolean; error?: string }> {
    const connection = this.#store.getRaw(connectionId);
    if (!connection) {
      return { ok: false, error: "connection_not_found" };
    }
    return await this.#post(connection, buildTestPayload(connection.app, connection.label));
  }

  #payloadFor(connection: ChannelConnection, event: TeamEvent): Record<string, unknown> {
    const ctx: CardContext = { publicUrl: this.#publicUrl, detail: connection.detail };
    return connection.app === "teams"
      ? buildTeamsPayload(event, ctx)
      : buildSlackPayload(event, ctx);
  }

  async #post(
    connection: ChannelConnection,
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await this.#fetch(connection.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      // Drain so the connection is released; webhook bodies are tiny.
      await response.text().catch(() => {});
      if (!response.ok) {
        const error = `HTTP ${response.status}`;
        await this.#store.recordDelivery(connection.id, false, error);
        console.warn(`channel delivery to "${connection.label}" failed: ${error}`);
        return { ok: false, error };
      }
      await this.#store.recordDelivery(connection.id, true);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#store.recordDelivery(connection.id, false, message);
      console.warn(`channel delivery to "${connection.label}" failed:`, message);
      return { ok: false, error: message };
    }
  }
}

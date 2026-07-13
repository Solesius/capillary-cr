// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// connections.ts — channel connections: "publish team events to this Slack or
// Teams channel". In both platforms an incoming webhook is minted per channel,
// so a connection IS a channel; registering several yields the channel picker.
//
// Persistence: connections survive restarts (publishing that vanishes on
// reboot is not usable), stored via the same durable store as review
// artifacts when available, in-memory otherwise. A webhook URL grants
// post-only access to one channel — a deliberately narrower secret class than
// the API tokens capillary refuses to persist — and it is never returned to
// the UI unmasked.

import { TeamEvent } from "./event_bus.ts";

export type ChannelApp = "slack" | "teams";
export type NotifyDetail = "summary" | "findings";

export interface ChannelEventToggles {
  /** Review finished with a verdict. */
  reviewCompleted: boolean;
  /** Review stopped/cancelled before a verdict. */
  reviewCancelled: boolean;
  /** RetV functional-test run finished. */
  retvCompleted: boolean;
  /** A finding/summary/suggestion was posted to the PR. */
  findingPosted: boolean;
}

export interface ChannelConnection {
  id: string;
  app: ChannelApp;
  /** Human label, conventionally the channel name ("#code-reviews"). */
  label: string;
  webhookUrl: string;
  events: ChannelEventToggles;
  /** summary = verdict/counts/link only; findings additionally carries titles. */
  detail: NotifyDetail;
  enabled: boolean;
  createdAt: string;
  lastPostedAt?: string;
  lastError?: string;
}

/** UI-safe projection: the webhook URL never leaves the server unmasked. */
export interface ChannelConnectionView {
  id: string;
  app: ChannelApp;
  label: string;
  webhookUrlMasked: string;
  events: ChannelEventToggles;
  detail: NotifyDetail;
  enabled: boolean;
  createdAt: string;
  lastPostedAt?: string;
  lastError?: string;
}

/**
 * Narrow persistence surface, implemented by DurableReviewStore (structural —
 * the review-artifact interface is not widened for team config).
 */
export interface ConnectionPersistence {
  saveConnection(connection: ChannelConnection): Promise<void>;
  deleteConnection(id: string): Promise<void>;
  listConnections(): Promise<ChannelConnection[]>;
}

export interface CreateConnectionInput {
  app: ChannelApp;
  label: string;
  webhookUrl: string;
  events?: Partial<ChannelEventToggles>;
  detail?: NotifyDetail;
}

export interface UpdateConnectionInput {
  label?: string;
  events?: Partial<ChannelEventToggles>;
  detail?: NotifyDetail;
  enabled?: boolean;
}

// findingPosted defaults off: per-finding pings are high-frequency and are an
// opt-in, not a default channel experience.
const DEFAULT_TOGGLES: ChannelEventToggles = {
  reviewCompleted: true,
  reviewCancelled: false,
  retvCompleted: true,
  findingPosted: false,
};

export function maskWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = url.slice(-4);
    return `${parsed.origin}/…${tail}`;
  } catch {
    return "…" + url.slice(-4);
  }
}

/** Does this connection want this event? Pure — unit-tested routing truth. */
export function connectionMatches(connection: ChannelConnection, event: TeamEvent): boolean {
  if (!connection.enabled) {
    return false;
  }
  switch (event.type) {
    case "review.completed":
      return connection.events.reviewCompleted;
    case "review.cancelled":
      return connection.events.reviewCancelled;
    case "retv.completed":
      return connection.events.retvCompleted;
    case "finding.posted":
      return connection.events.findingPosted;
  }
}

export class ConnectionStore {
  #connections = new Map<string, ChannelConnection>();
  #persistence: ConnectionPersistence | null;
  #defaultDetail: NotifyDetail;

  constructor(
    persistence: ConnectionPersistence | null,
    options: { defaultDetail?: NotifyDetail } = {},
  ) {
    this.#persistence = persistence;
    this.#defaultDetail = options.defaultDetail ?? "summary";
  }

  /**
   * Load persisted connections, then seed one per configured env webhook when
   * that URL is not registered yet — the env vars bootstrap a default channel
   * on first boot and the seeded row is editable/persisted like any other.
   */
  async init(env: { slackWebhookUrl?: string; teamsWebhookUrl?: string } = {}): Promise<void> {
    if (this.#persistence) {
      for (const connection of await this.#persistence.listConnections()) {
        this.#connections.set(connection.id, connection);
      }
    }
    const seeds: { app: ChannelApp; url?: string }[] = [
      { app: "slack", url: env.slackWebhookUrl?.trim() },
      { app: "teams", url: env.teamsWebhookUrl?.trim() },
    ];
    for (const seed of seeds) {
      if (!seed.url || !isAcceptableWebhookUrl(seed.url)) {
        continue;
      }
      const exists = [...this.#connections.values()].some((c) => c.webhookUrl === seed.url);
      if (!exists) {
        await this.create({
          app: seed.app,
          label: `${seed.app} (env default)`,
          webhookUrl: seed.url,
        });
      }
    }
  }

  list(): ChannelConnectionView[] {
    return [...this.#connections.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((connection) => toView(connection));
  }

  /** Full records for the publisher; never serialized to clients. */
  listRaw(): ChannelConnection[] {
    return [...this.#connections.values()];
  }

  getRaw(id: string): ChannelConnection | null {
    return this.#connections.get(id) ?? null;
  }

  async create(input: CreateConnectionInput): Promise<ChannelConnectionView> {
    const app = input.app === "teams" ? "teams" : "slack";
    const webhookUrl = String(input.webhookUrl ?? "").trim();
    if (!isAcceptableWebhookUrl(webhookUrl)) {
      throw new Error("webhook_url_must_be_https");
    }
    const connection: ChannelConnection = {
      id: crypto.randomUUID().slice(0, 8),
      app,
      label: String(input.label ?? "").trim() || `${app} channel`,
      webhookUrl,
      events: { ...DEFAULT_TOGGLES, ...input.events },
      detail: input.detail === "findings" ? "findings" : this.#defaultDetail,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.#connections.set(connection.id, connection);
    await this.#persist(connection);
    return toView(connection);
  }

  async update(id: string, input: UpdateConnectionInput): Promise<ChannelConnectionView | null> {
    const current = this.#connections.get(id);
    if (!current) {
      return null;
    }
    const next: ChannelConnection = {
      ...current,
      label: input.label !== undefined
        ? String(input.label).trim() || current.label
        : current.label,
      events: { ...current.events, ...input.events },
      detail: input.detail === "summary" || input.detail === "findings"
        ? input.detail
        : current.detail,
      enabled: input.enabled !== undefined ? input.enabled === true : current.enabled,
    };
    this.#connections.set(id, next);
    await this.#persist(next);
    return toView(next);
  }

  async delete(id: string): Promise<boolean> {
    const existed = this.#connections.delete(id);
    if (existed && this.#persistence) {
      try {
        await this.#persistence.deleteConnection(id);
      } catch (error) {
        console.warn("connection delete persistence failed:", error);
      }
    }
    return existed;
  }

  /** Stamp the outcome of the latest delivery attempt (shown in the UI). */
  async recordDelivery(id: string, ok: boolean, error?: string): Promise<void> {
    const current = this.#connections.get(id);
    if (!current) {
      return;
    }
    const next: ChannelConnection = ok
      ? { ...current, lastPostedAt: new Date().toISOString(), lastError: undefined }
      : { ...current, lastError: (error ?? "delivery failed").slice(0, 300) };
    this.#connections.set(id, next);
    await this.#persist(next);
  }

  async #persist(connection: ChannelConnection): Promise<void> {
    if (!this.#persistence) {
      return;
    }
    try {
      await this.#persistence.saveConnection(connection);
    } catch (error) {
      console.warn("connection persistence failed:", error);
    }
  }
}

function toView(connection: ChannelConnection): ChannelConnectionView {
  const { webhookUrl: _webhookUrl, ...rest } = connection;
  return { ...rest, webhookUrlMasked: maskWebhookUrl(connection.webhookUrl) };
}

function isAcceptableWebhookUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

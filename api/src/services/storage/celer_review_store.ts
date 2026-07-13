// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
// celer_review_store.ts — durable persistence for review work-product, backed
// by celer-mem via the CelerStore FFI binding.
//
// celer is the source of truth for review artifacts. The repository keeps only a
// bounded in-memory cache in front of this store, so resident memory stays flat
// no matter how many reviews accumulate — every read falls through to here on a
// cache miss and every write persists here immediately. When the native library
// is unavailable (not built, or no --allow-ffi), `tryOpen` returns null and the
// repository degrades to a pure in-memory store.
//
// Security: only review artifacts are persisted. Secrets (GitHub tokens, the
// runtime LLM api key, identity) are intentionally never written to disk.

import {
  DiffFile,
  GraphSnapshot,
  RetvCdpRunRecord,
  ReviewAgentRunRecord,
  ReviewChecklistItem,
  ReviewFinding,
  ReviewPacket,
  ReviewRun,
} from "../../domain/entities.ts";
import { ChannelConnection, ConnectionPersistence } from "../team/connections.ts";
import { CelerStore, CelerTableDescriptor } from "./celer_mem.ts";

const SCOPE = "review";

const TABLE = {
  runs: "runs",
  events: "events",
  findings: "findings",
  packets: "packets",
  graphs: "graphs",
  checklists: "checklists",
  retvRuns: "retv_runs",
  reviewAgentRuns: "review_agent_runs",
  diffs: "diffs",
  // Team channel connections (webhook publishing config). Not a review
  // artifact, but the single durable store is shared: one database, one
  // lifecycle. Webhook URLs are post-only channel secrets — a deliberately
  // narrower class than the API tokens that are never persisted.
  connections: "team_connections",
} as const;

const SCHEMA: CelerTableDescriptor[] = Object.values(TABLE).map((table) => ({
  scope: SCOPE,
  table,
}));

export interface DurableReviewStoreOptions {
  /** Directory where the celer-mem backend files live. */
  path: string;
  /** Override the shared-library location (mainly for tests). */
  libPath?: string | URL;
  /** Backend override; defaults to the platform default chosen by the native build. */
  backend?: "sqlite" | "rocksdb";
  /** Sink for non-fatal persistence errors; defaults to console.warn. */
  onError?: (op: string, error: unknown) => void;
}

/**
 * The durable-store surface the repository depends on. Kept as an interface so
 * the repository is decoupled from the FFI-backed implementation and can be
 * exercised in unit tests against a faithful in-memory fake — no native library
 * required. `DurableReviewStore` is the production implementation.
 */
export interface ReviewArtifactStore {
  saveRun(run: ReviewRun): Promise<void>;
  saveEvents(runId: string, events: string[]): Promise<void>;
  saveFindings(runId: string, findings: ReviewFinding[]): Promise<void>;
  savePacket(packet: ReviewPacket): Promise<void>;
  saveGraph(diffDagId: string, snapshot: GraphSnapshot): Promise<void>;
  saveChecklist(runId: string, items: ReviewChecklistItem[]): Promise<void>;
  saveRetvRun(record: RetvCdpRunRecord): Promise<void>;
  saveReviewAgentRun(record: ReviewAgentRunRecord): Promise<void>;
  saveDiff(key: string, diff: DiffFile[]): Promise<void>;

  getRun(runId: string): Promise<ReviewRun | null>;
  getEvents(runId: string): Promise<string[] | null>;
  getFindings(runId: string): Promise<ReviewFinding[] | null>;
  getPacket(packetId: string): Promise<ReviewPacket | null>;
  getGraph(diffDagId: string): Promise<GraphSnapshot | null>;
  getChecklist(runId: string): Promise<ReviewChecklistItem[] | null>;
  getRetvRun(runId: string): Promise<RetvCdpRunRecord | null>;
  getReviewAgentRun(runId: string): Promise<ReviewAgentRunRecord | null>;
  getDiff(key: string): Promise<DiffFile[] | null>;

  listRetvRuns(): Promise<RetvCdpRunRecord[]>;
  listReviewAgentRuns(): Promise<ReviewAgentRunRecord[]>;
  listGraphs(): Promise<GraphSnapshot[]>;
  /** Scan of all persisted review runs — powers the boot-time status sweep. */
  listRuns(): Promise<ReviewRun[]>;

  close(): Promise<void>;
}

/**
 * Durable, source-of-truth store for review artifacts. Writes persist before
 * resolving; reads return `null` on a miss. Persistence errors are reported
 * through `onError` and surface as `null`/no-op rather than throwing, so a
 * storage hiccup degrades gracefully instead of breaking the request path.
 */
export class DurableReviewStore implements ReviewArtifactStore, ConnectionPersistence {
  #store: CelerStore;
  #onError: (op: string, error: unknown) => void;

  private constructor(store: CelerStore, onError: (op: string, error: unknown) => void) {
    this.#store = store;
    this.#onError = onError;
  }

  /** Open the durable store, or return null when native storage is unavailable. */
  static async tryOpen(options: DurableReviewStoreOptions): Promise<DurableReviewStore | null> {
    const store = await CelerStore.tryOpen({
      path: options.path,
      backend: options.backend,
      schema: SCHEMA,
      libPath: options.libPath,
    });
    if (store === null) {
      return null;
    }
    const onError = options.onError ?? ((op, error) => {
      console.warn(`durable-review-store ${op} failed:`, error);
    });
    return new DurableReviewStore(store, onError);
  }

  async #write(op: string, table: string, key: string, value: unknown): Promise<void> {
    try {
      await this.#store.put(SCOPE, table, key, JSON.stringify(value));
    } catch (error) {
      this.#onError(op, error);
    }
  }

  async #read<T>(op: string, table: string, key: string): Promise<T | null> {
    try {
      const text = await this.#store.getText(SCOPE, table, key);
      return text === null ? null : (JSON.parse(text) as T);
    } catch (error) {
      this.#onError(op, error);
      return null;
    }
  }

  async #scan<T>(op: string, table: string): Promise<T[]> {
    const out: T[] = [];
    try {
      const decoder = new TextDecoder();
      for (const entry of await this.#store.list(SCOPE, table)) {
        out.push(JSON.parse(decoder.decode(entry.value)) as T);
      }
    } catch (error) {
      this.#onError(op, error);
    }
    return out;
  }

  // --- writes ---
  saveRun(run: ReviewRun): Promise<void> {
    return this.#write("saveRun", TABLE.runs, run.id, run);
  }
  saveEvents(runId: string, events: string[]): Promise<void> {
    return this.#write("saveEvents", TABLE.events, runId, events);
  }
  saveFindings(runId: string, findings: ReviewFinding[]): Promise<void> {
    return this.#write("saveFindings", TABLE.findings, runId, findings);
  }
  savePacket(packet: ReviewPacket): Promise<void> {
    return this.#write("savePacket", TABLE.packets, packet.id, packet);
  }
  saveGraph(diffDagId: string, snapshot: GraphSnapshot): Promise<void> {
    return this.#write("saveGraph", TABLE.graphs, diffDagId, snapshot);
  }
  saveChecklist(runId: string, items: ReviewChecklistItem[]): Promise<void> {
    return this.#write("saveChecklist", TABLE.checklists, runId, items);
  }
  saveRetvRun(record: RetvCdpRunRecord): Promise<void> {
    return this.#write("saveRetvRun", TABLE.retvRuns, record.runId, record);
  }
  saveReviewAgentRun(record: ReviewAgentRunRecord): Promise<void> {
    return this.#write("saveReviewAgentRun", TABLE.reviewAgentRuns, record.runId, record);
  }
  saveDiff(key: string, diff: DiffFile[]): Promise<void> {
    return this.#write("saveDiff", TABLE.diffs, key, diff);
  }

  // --- point reads (return null on miss) ---
  getRun(runId: string): Promise<ReviewRun | null> {
    return this.#read("getRun", TABLE.runs, runId);
  }
  getEvents(runId: string): Promise<string[] | null> {
    return this.#read("getEvents", TABLE.events, runId);
  }
  getFindings(runId: string): Promise<ReviewFinding[] | null> {
    return this.#read("getFindings", TABLE.findings, runId);
  }
  getPacket(packetId: string): Promise<ReviewPacket | null> {
    return this.#read("getPacket", TABLE.packets, packetId);
  }
  getGraph(diffDagId: string): Promise<GraphSnapshot | null> {
    return this.#read("getGraph", TABLE.graphs, diffDagId);
  }
  getChecklist(runId: string): Promise<ReviewChecklistItem[] | null> {
    return this.#read("getChecklist", TABLE.checklists, runId);
  }
  getRetvRun(runId: string): Promise<RetvCdpRunRecord | null> {
    return this.#read("getRetvRun", TABLE.retvRuns, runId);
  }
  getReviewAgentRun(runId: string): Promise<ReviewAgentRunRecord | null> {
    return this.#read("getReviewAgentRun", TABLE.reviewAgentRuns, runId);
  }
  getDiff(key: string): Promise<DiffFile[] | null> {
    return this.#read("getDiff", TABLE.diffs, key);
  }

  // --- scans (list/find paths that cannot be served from a partial cache) ---
  listRetvRuns(): Promise<RetvCdpRunRecord[]> {
    return this.#scan("listRetvRuns", TABLE.retvRuns);
  }
  listReviewAgentRuns(): Promise<ReviewAgentRunRecord[]> {
    return this.#scan("listReviewAgentRuns", TABLE.reviewAgentRuns);
  }
  listGraphs(): Promise<GraphSnapshot[]> {
    return this.#scan("listGraphs", TABLE.graphs);
  }
  listRuns(): Promise<ReviewRun[]> {
    return this.#scan("listRuns", TABLE.runs);
  }

  // --- team channel connections (ConnectionPersistence) ---
  saveConnection(connection: ChannelConnection): Promise<void> {
    return this.#write("saveConnection", TABLE.connections, connection.id, connection);
  }
  async deleteConnection(id: string): Promise<void> {
    try {
      await this.#store.delete(SCOPE, TABLE.connections, id);
    } catch (error) {
      this.#onError("deleteConnection", error);
    }
  }
  listConnections(): Promise<ChannelConnection[]> {
    return this.#scan("listConnections", TABLE.connections);
  }

  close(): Promise<void> {
    return this.#store.close();
  }
}

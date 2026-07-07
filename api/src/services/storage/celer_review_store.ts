// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
// celer_review_store.ts — durable persistence for review work-product, backed
// by celer-mem via the CelerStore FFI binding.
//
// This is an opt-in, write-through side store. The in-memory repository remains
// the synchronous source of truth; mutations are mirrored here asynchronously
// and the persisted snapshot is replayed back into memory on boot. When the
// native library is unavailable (not built, or no --allow-ffi), construction
// returns null and the system runs purely in-memory.
//
// Security: only review artifacts are persisted. Secrets (GitHub tokens, the
// runtime LLM api key, identity) are intentionally never written to disk.

import {
  GraphSnapshot,
  RetvCdpRunRecord,
  ReviewAgentRunRecord,
  ReviewChecklistItem,
  ReviewFinding,
  ReviewPacket,
  ReviewRun,
} from "../../domain/entities.ts";
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
} as const;

const SCHEMA: CelerTableDescriptor[] = Object.values(TABLE).map((table) => ({ scope: SCOPE, table }));

export interface ReviewStoreSnapshot {
  runs: ReviewRun[];
  events: Map<string, string[]>;
  findings: Map<string, ReviewFinding[]>;
  packets: ReviewPacket[];
  graphs: Map<string, GraphSnapshot>;
  checklists: Map<string, ReviewChecklistItem[]>;
  retvRuns: RetvCdpRunRecord[];
  reviewAgentRuns: ReviewAgentRunRecord[];
}

export interface DurableReviewStoreOptions {
  /** Directory where the celer-mem SQLite files live. */
  path: string;
  /** Override the shared-library location (mainly for tests). */
  libPath?: string | URL;
  /** Sink for non-fatal persistence errors; defaults to console.warn. */
  onError?: (op: string, error: unknown) => void;
}

/**
 * Durable, write-through store for review artifacts. All write methods resolve
 * without throwing — persistence failures are reported through `onError` so a
 * storage hiccup never breaks the in-memory request path.
 */
export class DurableReviewStore {
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

  /** Load the full persisted snapshot for rehydrating the in-memory repository. */
  async loadSnapshot(): Promise<ReviewStoreSnapshot> {
    const [runs, events, findings, packets, graphs, checklists, retvRuns, reviewAgentRuns] =
      await Promise.all([
        this.#readMap<ReviewRun>(TABLE.runs),
        this.#readMap<string[]>(TABLE.events),
        this.#readMap<ReviewFinding[]>(TABLE.findings),
        this.#readMap<ReviewPacket>(TABLE.packets),
        this.#readMap<GraphSnapshot>(TABLE.graphs),
        this.#readMap<ReviewChecklistItem[]>(TABLE.checklists),
        this.#readMap<RetvCdpRunRecord>(TABLE.retvRuns),
        this.#readMap<ReviewAgentRunRecord>(TABLE.reviewAgentRuns),
      ]);
    return {
      runs: [...runs.values()],
      events,
      findings,
      packets: [...packets.values()],
      graphs,
      checklists,
      retvRuns: [...retvRuns.values()],
      reviewAgentRuns: [...reviewAgentRuns.values()],
    };
  }

  async #readMap<T>(table: string): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    try {
      for (const entry of await this.#store.list(SCOPE, table)) {
        out.set(entry.key, JSON.parse(new TextDecoder().decode(entry.value)) as T);
      }
    } catch (error) {
      this.#onError(`loadSnapshot:${table}`, error);
    }
    return out;
  }

  close(): Promise<void> {
    return this.#store.close();
  }
}

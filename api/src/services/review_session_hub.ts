// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Durable review sessions. A session is a review run whose lifecycle is
// decoupled from any client connection: the pipeline executes detached on
// the server, every typed event is recorded, and any number of clients
// (browser tabs, the CLI, agents) can attach later — they get a full replay
// of the narrative so far, then the live tail. Closing a tab, bouncing
// between screens, or attaching twice never affects the run. Multiple
// sessions run concurrently; each is keyed by its runId.

import { ReviewRunEvent } from "../domain/review_phase.ts";

export interface ReviewSessionSummary {
  runId: string;
  pullRequestId: string;
  active: boolean;
  startedAt: string;
  eventCount: number;
}

interface SessionState {
  runId: string;
  pullRequestId: string;
  startedAt: string;
  active: boolean;
  events: ReviewRunEvent[];
  subscribers: Set<(event: ReviewRunEvent) => void>;
}

// Narrative cap per session: enough for a long 60-cycle review, bounded so a
// pathological run cannot grow memory without limit. Oldest events drop
// first; the `done` terminal event is always retained.
const MAX_EVENTS_PER_SESSION = 4000;
// Finished sessions kept for late re-attach (report stays viewable); oldest
// finished sessions are evicted beyond this count.
const MAX_FINISHED_SESSIONS = 12;

export type RunStarter = (
  request: { pullRequestId: string; repositoryId?: string; maxCycles?: number; trace?: boolean },
  onEvent: (event: ReviewRunEvent) => void,
) => Promise<unknown>;

export class ReviewSessionHub {
  #sessions = new Map<string, SessionState>();

  constructor(private readonly startRun: RunStarter) {}

  /**
   * Launch a review as a detached session. Resolves as soon as the run has
   * an id (the `run_start` event), never waits for the review itself.
   */
  start(
    request: { pullRequestId: string; repositoryId?: string; maxCycles?: number; trace?: boolean },
  ): Promise<ReviewSessionSummary> {
    return new Promise((resolve, reject) => {
      let session: SessionState | null = null;
      let settled = false;

      const record = (event: ReviewRunEvent) => {
        if (!session && event.type === "run_start") {
          session = {
            runId: event.runId,
            pullRequestId: event.pullRequestId,
            startedAt: new Date().toISOString(),
            active: true,
            events: [],
            subscribers: new Set(),
          };
          this.#sessions.set(event.runId, session);
          if (!settled) {
            settled = true;
            resolve(this.#toSummary(session));
          }
        }
        if (!session) {
          return;
        }
        session.events.push(event);
        if (session.events.length > MAX_EVENTS_PER_SESSION) {
          session.events.splice(0, session.events.length - MAX_EVENTS_PER_SESSION);
        }
        for (const subscriber of session.subscribers) {
          try {
            subscriber(event);
          } catch {
            // One slow/broken consumer must never affect the run or peers.
          }
        }
        if (event.type === "done") {
          session.active = false;
          this.#evictFinished();
        }
      };

      this.startRun(request, record)
        .catch((error) => {
          if (!settled) {
            settled = true;
            reject(error);
            return;
          }
          // Run failed after start: mark inactive so clients stop waiting.
          if (session) {
            session.active = false;
          }
        })
        .finally(() => {
          if (session && session.active) {
            // Defensive: a pipeline that resolved without a done event still
            // terminates the session.
            session.active = false;
          }
        });
    });
  }

  /**
   * Attach a consumer: replays the full recorded narrative synchronously,
   * then delivers live events until the returned detach fn is called.
   * Returns null for unknown sessions.
   */
  attach(runId: string, onEvent: (event: ReviewRunEvent) => void): (() => void) | null {
    const session = this.#sessions.get(runId);
    if (!session) {
      return null;
    }
    for (const event of session.events) {
      onEvent(event);
    }
    if (!session.active) {
      return () => {};
    }
    session.subscribers.add(onEvent);
    return () => session.subscribers.delete(onEvent);
  }

  has(runId: string): boolean {
    return this.#sessions.has(runId);
  }

  isActive(runId: string): boolean {
    return this.#sessions.get(runId)?.active ?? false;
  }

  list(): ReviewSessionSummary[] {
    return [...this.#sessions.values()]
      .map((session) => this.#toSummary(session))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  #toSummary(session: SessionState): ReviewSessionSummary {
    return {
      runId: session.runId,
      pullRequestId: session.pullRequestId,
      active: session.active,
      startedAt: session.startedAt,
      eventCount: session.events.length,
    };
  }

  #evictFinished(): void {
    const finished = [...this.#sessions.values()]
      .filter((session) => !session.active)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    while (finished.length > MAX_FINISHED_SESSIONS) {
      const oldest = finished.shift();
      if (oldest) {
        this.#sessions.delete(oldest.runId);
      }
    }
  }
}

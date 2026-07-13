// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// members.ts — per-browser member sessions for team mode. Each browser gets a
// random session id in an HttpOnly cookie; a member may attach their own
// GitHub identity (personal token) to it, after which write paths (posting
// findings/suggestions/summaries) go out AS THAT MEMBER — GitHub attribution
// reflects the actual human, not the instance's service identity.
//
// Security posture, per the standing invariant: member tokens are MEMORY-ONLY
// and never persisted — a restart forgets them and members reconnect. The
// session id is a 128-bit random bearer value (unguessable), HttpOnly and
// SameSite=Lax; no structured content, so no signing is required.

export interface MemberIdentity {
  login: string;
  avatarUrl?: string;
}

interface MemberSession {
  sessionId: string;
  createdAt: number;
  lastSeenAt: number;
  identity?: MemberIdentity;
  githubToken?: string;
}

/** UI-safe projection — the token never leaves the server. */
export interface MemberView {
  connected: boolean;
  login?: string;
  avatarUrl?: string;
}

export const MEMBER_COOKIE = "cap_member";

// Bounded: a public-ish instance must not grow sessions without limit. Idle
// sessions past the cap evict oldest-seen first; an evicted member simply
// reconnects their identity.
const MAX_SESSIONS = 512;

export class MemberSessionStore {
  #sessions = new Map<string, MemberSession>();

  /** Get-or-create the session for a cookie value; returns whether it is new. */
  ensure(sessionId: string | undefined | null): { sessionId: string; isNew: boolean } {
    const existing = sessionId ? this.#sessions.get(sessionId) : undefined;
    if (existing) {
      existing.lastSeenAt = Date.now();
      return { sessionId: existing.sessionId, isNew: false };
    }
    const fresh: MemberSession = {
      sessionId: crypto.randomUUID(),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.#sessions.set(fresh.sessionId, fresh);
    this.#evictIdle();
    return { sessionId: fresh.sessionId, isNew: true };
  }

  attachIdentity(sessionId: string, identity: MemberIdentity, githubToken: string): boolean {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.identity = identity;
    session.githubToken = githubToken;
    return true;
  }

  detachIdentity(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return false;
    }
    session.identity = undefined;
    session.githubToken = undefined;
    return true;
  }

  view(sessionId: string | undefined | null): MemberView {
    const session = sessionId ? this.#sessions.get(sessionId) : undefined;
    if (!session?.identity) {
      return { connected: false };
    }
    return {
      connected: true,
      login: session.identity.login,
      avatarUrl: session.identity.avatarUrl,
    };
  }

  /** The member's own token for write paths, or null to use the service identity. */
  tokenFor(sessionId: string | undefined | null): string | null {
    return (sessionId ? this.#sessions.get(sessionId)?.githubToken : null) ?? null;
  }

  /** The member's login for attribution, or null when not connected. */
  loginFor(sessionId: string | undefined | null): string | null {
    return (sessionId ? this.#sessions.get(sessionId)?.identity?.login : null) ?? null;
  }

  get size(): number {
    return this.#sessions.size;
  }

  #evictIdle(): void {
    if (this.#sessions.size <= MAX_SESSIONS) {
      return;
    }
    const oldest = [...this.#sessions.values()]
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt)
      .slice(0, this.#sessions.size - MAX_SESSIONS);
    for (const session of oldest) {
      this.#sessions.delete(session.sessionId);
    }
  }
}

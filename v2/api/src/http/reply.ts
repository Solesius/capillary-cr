// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
// reply.ts — what a route handler returns, and the one place it is written.
//
// Handlers are pure functions from an Express request to a `Reply` value. They
// never touch `res`; `send` interprets the value with plain Express calls.
// Keeping effects in a single interpreter means every response shape the API
// can produce is enumerated here, and handlers stay testable as functions.

import type { CookieOptions, Response } from "express";

export interface Cookie {
  name: string;
  value: string;
  options: CookieOptions;
}

/** Emit one SSE `data:` frame. False once the client has gone away. */
export type Emit = (event: unknown) => boolean;

interface Common {
  status: number;
  cookies?: readonly Cookie[];
}

export type Reply =
  | Common & { kind: "json"; body: unknown }
  | Common & { kind: "text"; body: string; type: string; disposition?: string }
  | Common & { kind: "bytes"; body: Uint8Array; type: string; disposition?: string }
  | { kind: "events"; cookies?: readonly Cookie[]; run: (emit: Emit, signal: AbortSignal) => Promise<void> };

// --- constructors ------------------------------------------------------------

export const json = (body: unknown, status = 200): Reply => ({ kind: "json", status, body });

export const text = (
  body: string,
  type: string,
  options: { status?: number; disposition?: string } = {},
): Reply => ({ kind: "text", body, type, status: options.status ?? 200, disposition: options.disposition });

export const html = (body: string, status = 200): Reply => text(body, "text/html; charset=utf-8", { status });

export const markdown = (body: string, disposition?: string): Reply =>
  text(body, "text/markdown; charset=utf-8", { disposition });

export const bytes = (
  body: Uint8Array,
  type: string,
  options: { status?: number; disposition?: string } = {},
): Reply => ({ kind: "bytes", body, type, status: options.status ?? 200, disposition: options.disposition });

/** A server-sent event stream; the response ends when `run` settles. */
export const events = (run: (emit: Emit, signal: AbortSignal) => Promise<void>): Reply => ({
  kind: "events",
  run,
});

/** `{ error }` (plus optional extras) with a status — the API's error shape. */
export const failure = (status: number, error: string, extra: Record<string, unknown> = {}): Reply =>
  json({ error, ...extra }, status);

export const withCookie = (reply: Reply, cookie: Cookie | null): Reply =>
  cookie ? { ...reply, cookies: [...(reply.cookies ?? []), cookie] } : reply;

// --- interpreter -------------------------------------------------------------

const inline = (filename: string) => `inline; filename="${filename}"`;
const attachment = (filename: string) => `attachment; filename="${filename}"`;
export const disposition = { inline, attachment };

async function stream(res: Response, run: (emit: Emit, signal: AbortSignal) => Promise<void>) {
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  res.status(200).set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    // Disable response buffering in nginx-style proxies so events flow live.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const emit: Emit = (event) => {
    if (abort.signal.aborted || res.writableEnded) return false;
    const data = typeof event === "string" ? event : JSON.stringify(event);
    res.write(`data: ${data.split("\n").join("\ndata: ")}\n\n`);
    return true;
  };

  try {
    await run(emit, abort.signal);
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/** Write a Reply. The only function in the HTTP layer that touches `res`. */
export async function send(res: Response, reply: Reply): Promise<void> {
  for (const { name, value, options } of reply.cookies ?? []) {
    res.cookie(name, value, options);
  }
  switch (reply.kind) {
    case "json":
      res.status(reply.status).json(reply.body);
      return;
    case "text":
    case "bytes":
      res.status(reply.status).type(reply.type);
      if (reply.disposition) res.set("Content-Disposition", reply.disposition);
      res.send(reply.kind === "bytes" ? Buffer.from(reply.body) : reply.body);
      return;
    case "events":
      await stream(res, reply.run);
      return;
  }
}

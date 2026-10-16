// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
// routing.ts — the route table as data, mounted onto an Express router.
//
// A route is { method, path, body, handle }. `handle` is a pure function of
// the request returning a Reply (see reply.ts). `mount` turns the table into
// an Express router: it picks the body parser each route declares, adapts the
// handler, and answers 405 for a known path under the wrong method.
//
// Body semantics are explicit per route rather than content-type sniffing:
//   json      parse as JSON whatever the content type; empty → {}; malformed → 400
//   lenient   as json, but malformed or empty → {} (best-effort UI endpoints)
//   raw       the exact bytes as a Buffer (signature-verified webhooks)

import express from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AppError } from "../domain/errors.ts";
import { type Reply, send } from "./reply.ts";

export type Method = "GET" | "POST" | "PATCH" | "DELETE";
export type BodyMode = "none" | "json" | "lenient" | "raw";
export type Handler = (req: Request) => Reply | Promise<Reply>;

export interface Route {
  readonly method: Method;
  readonly path: string;
  readonly body: BodyMode;
  readonly handle: Handler;
}

const route = (method: Method, defaultBody: BodyMode) =>
(path: string, handle: Handler, options: { body?: BodyMode } = {}): Route => ({
  method,
  path,
  body: options.body ?? defaultBody,
  handle,
});

export const get = route("GET", "none");
export const post = route("POST", "json");
export const patch = route("PATCH", "json");
export const del = route("DELETE", "none");

// --- request helpers ---------------------------------------------------------

/** Query string as URLSearchParams: `.get()` yields the first value or null. */
export const query = (req: Request): URLSearchParams =>
  new URL(req.originalUrl, "http://localhost").searchParams;

/** Route parameter, "" when absent. */
export const param = (req: Request, name: string): string => {
  const value = req.params[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
};

/** The origin this request was addressed to (scheme + Host). */
export const origin = (req: Request): string => `${req.protocol}://${req.get("host") ?? "localhost"}`;

// --- body parsing ------------------------------------------------------------

const JSON_LIMIT = "10mb";
const RAW_LIMIT = "25mb"; // GitHub caps webhook payloads at 25 MB

const readBytes = express.raw({ type: () => true, limit: JSON_LIMIT });
const readRaw = express.raw({ type: () => true, limit: RAW_LIMIT });

function parseJson(lenient: boolean): RequestHandler {
  return (req, _res, next) => {
    const raw: Buffer | undefined = Buffer.isBuffer(req.body) ? req.body : undefined;
    if (!raw || raw.length === 0) {
      req.body = {};
      next();
      return;
    }
    try {
      req.body = JSON.parse(raw.toString("utf8"));
      next();
    } catch {
      if (lenient) {
        req.body = {};
        next();
        return;
      }
      next(new AppError("request body is not valid JSON", 400, "invalid_json"));
    }
  };
}

const PARSERS: Record<BodyMode, RequestHandler[]> = {
  none: [],
  json: [readBytes, parseJson(false)],
  lenient: [readBytes, parseJson(true)],
  raw: [readRaw],
};

// --- mounting ----------------------------------------------------------------

function adapt(handle: Handler): RequestHandler {
  return async (req: Request, res: Response) => {
    await send(res, await handle(req));
  };
}

/** `/a/:b/c` → /^\/a\/[^/]+\/c\/?$/i, matching Express's default (non-strict, case-insensitive). */
function pathPattern(path: string): RegExp {
  const source = path
    .split("/")
    .map((segment) => segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("/");
  return new RegExp(`^${source}/?$`, "i");
}

function methodNotAllowed(routes: readonly Route[]): RequestHandler {
  const table = routes.map((r) => ({ method: r.method, pattern: pathPattern(r.path) }));
  return (req: Request, res: Response, next: NextFunction) => {
    const allowed = [...new Set(table.filter((r) => r.pattern.test(req.path)).map((r) => r.method))];
    if (allowed.length === 0) {
      next();
      return;
    }
    if (allowed.includes("GET")) allowed.push("HEAD" as Method);
    res.set("Allow", allowed.join(", "));
    res.status(405).json({ error: "method_not_allowed" });
  };
}

const VERBS = { GET: "get", POST: "post", PATCH: "patch", DELETE: "delete" } as const;

export function mount(routes: readonly Route[]): express.Router {
  const router = express.Router();
  for (const r of routes) {
    router[VERBS[r.method]](r.path, ...PARSERS[r.body], adapt(r.handle));
  }
  router.use(methodNotAllowed(routes));
  return router;
}

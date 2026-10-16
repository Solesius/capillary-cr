// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
// app.ts — the Express application: middleware order, API, SPA hosting.

import { join, resolve } from "node:path";
import cookieParser from "cookie-parser";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { unauthorized } from "../domain/errors.ts";
import { deps } from "./deps.ts";
import { apiRoutes, errorMiddleware } from "./router.ts";
import { mount } from "./routing.ts";

export interface AppConfig {
  /** Browser origins allowed to call the API (first is the CORS default). */
  allowedOrigins: string[];
  /** Require a connected GitHub identity for /api/* (minus the login flow). */
  requireGithubLogin: boolean;
  /** Directory of the built SPA to serve, or null to serve the API only. */
  webDistRoot: string | null;
}

const GITHUB_LOGIN_EXEMPT_API_PATHS = [
  "/api/github/connect",
  "/api/github/oauth/start",
  "/api/github/oauth/callback",
];
const GITHUB_LOGIN_EXEMPT_API_PREFIXES = ["/api/github/oauth/poll/"];

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isSameHostOrigin(origin: string, requestHost: string): boolean {
  try {
    return new URL(origin).host === requestHost;
  } catch {
    return false;
  }
}

function isGithubLoginExemptPath(pathname: string): boolean {
  return GITHUB_LOGIN_EXEMPT_API_PATHS.includes(pathname) ||
    GITHUB_LOGIN_EXEMPT_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** CORS for the configured web origins, plus a CSRF guard on mutating requests. */
function cors(allowedOrigins: string[]) {
  const primaryOrigin = allowedOrigins[0] || "http://localhost:4200";
  return (req: Request, res: Response, next: NextFunction) => {
    const requestOrigin = req.get("origin") ?? null;
    const originAllowed = requestOrigin !== null &&
      (allowedOrigins.includes(requestOrigin) || isSameHostOrigin(requestOrigin, req.get("host") ?? ""));

    res.set({
      "Access-Control-Allow-Origin": requestOrigin && originAllowed ? requestOrigin : primaryOrigin,
      "Vary": "Origin",
      "Access-Control-Allow-Headers": "content-type, authorization",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    });

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    // CSRF guard: a cross-origin browser can issue "simple" state-changing
    // requests without triggering a preflight, so CORS response headers alone do
    // not protect mutating endpoints (e.g. setting a provider API key). Reject
    // any mutating request whose Origin is present but neither allow-listed nor
    // same-host. An Origin matching the request's own Host header is same-origin
    // by definition (an attacker page cannot be served from the victim's own
    // host:port), so it is safe on any published container port without
    // operator configuration. Requests with no Origin (curl, server-to-server,
    // tests) are permitted.
    if (MUTATING_METHODS.has(req.method) && requestOrigin && !originAllowed) {
      res.status(403).json({ error: "origin_not_allowed" });
      return;
    }
    next();
  };
}

/**
 * Optional login gate over /api/*; the GitHub login flow itself is exempt. A
 * connected GitHub identity or an authenticated GitLab token both satisfy it,
 * so a GitLab-only deployment works with the gate on.
 */
function githubLoginGate(required: boolean) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (required && req.path.startsWith("/api/") && !isGithubLoginExemptPath(req.path)) {
      const identity = await deps.repository.getIdentity();
      if (!identity?.connected && !(await deps.gitlabService.isConnected())) {
        throw unauthorized("github_login_required");
      }
    }
    next();
  };
}

/** SPA hosting: real files from the build; GET deep links fall back to index.html. */
function spa(webDistRoot: string) {
  // sendFile needs an absolute path; operators may set CAPILLARY_WEB_DIST relative.
  const root = resolve(webDistRoot);
  const index = join(root, "index.html");
  const files = express.static(root, { index: "index.html", redirect: false });
  return [
    files,
    (req: Request, res: Response, next: NextFunction) => {
      if ((req.method !== "GET" && req.method !== "HEAD") || req.path.startsWith("/api/")) {
        next();
        return;
      }
      res.sendFile(index, (error) => {
        if (error && !res.headersSent) next();
      });
    },
  ];
}

export function createApp(config: AppConfig): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // Behind a proxy/ingress the secure flag and origin follow X-Forwarded-*
  // only when TRUST_PROXY is set; the default trusts the socket.
  if (process.env["TRUST_PROXY"]) app.set("trust proxy", process.env["TRUST_PROXY"]);

  app.use(cors(config.allowedOrigins));

  // Unauthenticated liveness/readiness probe for container orchestration and
  // the Docker HEALTHCHECK. Ahead of the login gate so an operator can confirm
  // the process is up before any identity is connected. Stays 200 even if
  // persistence degraded — the container must not restart-loop on a storage
  // hiccup; `storage.healthy: false` is the signal to alert on.
  app.get("/healthz", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ status: "ok", storage: deps.storageHealth.snapshot() });
  });

  app.use(cookieParser());
  app.use(githubLoginGate(config.requireGithubLogin));
  app.use(mount(apiRoutes));
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  if (config.webDistRoot) {
    app.use(...spa(config.webDistRoot));
  }
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  app.use(errorMiddleware());
  return app;
}

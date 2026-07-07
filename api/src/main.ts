// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { Application } from "jsr:@oak/oak";
import { send } from "jsr:@oak/oak/send";
import { unauthorized } from "./domain/errors.ts";
import { deps } from "./http/deps.ts";
import { errorMiddleware, routes } from "./http/router.ts";

const app = new Application();
const port = Number(Deno.env.get("PORT") || 8080);
const allowedOrigins = (Deno.env.get("CORS_ORIGIN") || "http://localhost:4200")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);
const primaryOrigin = allowedOrigins[0] || "http://localhost:4200";
const requireGithubLogin = readBooleanEnv("CAPILLARY_REQUIRE_GITHUB_LOGIN", false);
const serveWebApp = readBooleanEnv("CAPILLARY_SERVE_WEB", false);
const webDistRoot = Deno.env.get("CAPILLARY_WEB_DIST")?.trim() || decodeURIComponent(
	new URL("../../web/dist/capillary-web/browser", import.meta.url).pathname,
);

const GITHUB_LOGIN_EXEMPT_API_PATHS = [
	"/api/github/connect",
	"/api/github/oauth/start",
	"/api/github/oauth/callback",
];
const GITHUB_LOGIN_EXEMPT_API_PREFIXES = ["/api/github/oauth/poll/"];

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

app.use(async (ctx, next) => {
	const requestOrigin = ctx.request.headers.get("origin");
	const allowOrigin = requestOrigin && allowedOrigins.includes(requestOrigin)
		? requestOrigin
		: primaryOrigin;

	ctx.response.headers.set("Access-Control-Allow-Origin", allowOrigin);
	ctx.response.headers.set("Vary", "Origin");
	ctx.response.headers.set("Access-Control-Allow-Headers", "content-type, authorization");
	ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");

	if (ctx.request.method === "OPTIONS") {
		ctx.response.status = 204;
		return;
	}

	// CSRF guard: a cross-origin browser can issue "simple" state-changing
	// requests without triggering a preflight, so CORS response headers alone do
	// not protect mutating endpoints (e.g. setting a provider API key). Reject
	// any mutating request whose Origin is present but not allow-listed.
	// Requests with no Origin (curl, server-to-server, tests) are permitted.
	if (MUTATING_METHODS.has(ctx.request.method) && requestOrigin && !allowedOrigins.includes(requestOrigin)) {
		ctx.response.status = 403;
		ctx.response.body = { error: "origin_not_allowed" };
		return;
	}

	await next();
});

// Unauthenticated liveness/readiness probe for container orchestration and the
// Docker HEALTHCHECK. Intentionally sits ahead of the GitHub-login gate so an
// operator can confirm the process is up before any identity is connected.
app.use(async (ctx, next) => {
	if (ctx.request.url.pathname === "/healthz") {
		ctx.response.status = 200;
		ctx.response.headers.set("cache-control", "no-store");
		ctx.response.body = { status: "ok" };
		return;
	}

	await next();
});

app.use(async (ctx, next) => {
	if (
		requireGithubLogin &&
		ctx.request.url.pathname.startsWith("/api/") &&
		!isGithubLoginExemptPath(ctx.request.url.pathname)
	) {
		const identity = deps.repository.getIdentity();
		if (!identity?.connected) {
			throw unauthorized("github_login_required");
		}
	}

	await next();
});

app.use(errorMiddleware());
app.use(routes().routes());
app.use(routes().allowedMethods());

if (serveWebApp) {
	app.use(async (ctx, next) => {
		if (ctx.request.url.pathname.startsWith("/api/")) {
			await next();
			return;
		}

		const requestPath = ctx.request.url.pathname === "/"
			? "/index.html"
			: ctx.request.url.pathname;

		try {
			await send(ctx, requestPath, { root: webDistRoot, index: "index.html" });
		} catch {
			await send(ctx, "/index.html", { root: webDistRoot });
		}
	});
}

console.log(`Capillary API listening on :${port}`);
await app.listen({ port });

function isGithubLoginExemptPath(pathname: string): boolean {
	if (GITHUB_LOGIN_EXEMPT_API_PATHS.includes(pathname)) {
		return true;
	}

	return GITHUB_LOGIN_EXEMPT_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
	const raw = Deno.env.get(name);
	if (!raw) {
		return fallback;
	}

	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}

	return fallback;
}

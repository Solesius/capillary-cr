// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// HTTP layer: the Reply interpreter, the route-table mount (body modes, 405),
// and the app's middleware (CORS/CSRF, healthz, login gate, 404, SPA).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import express from "express";
import { assert, assertEquals, test } from "./support/harness.ts";
import { AppError } from "../src/domain/errors.ts";
import { createApp } from "../src/http/app.ts";
import { bytes, disposition, events, failure, json, markdown, withCookie } from "../src/http/reply.ts";
import { errorMiddleware } from "../src/http/router.ts";
import { del, get, mount, param, post, query, type Route } from "../src/http/routing.ts";

async function serve(app: express.Express, fn: (base: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function kitApp(routes: Route[]): express.Express {
  const app = express();
  app.use(mount(routes));
  app.use(errorMiddleware());
  return app;
}

const ROUTES: Route[] = [
  get("/items/:id", (req) => json({ id: param(req, "id"), q: query(req).get("q") })),
  post("/items", (req) => json({ received: req.body }, 201)),
  post("/lenient", (req) => json({ received: req.body }), { body: "lenient" }),
  post("/raw", (req) => json({ length: (req.body as Buffer).length, isBuffer: Buffer.isBuffer(req.body) }), {
    body: "raw",
  }),
  del("/items/:id", () => json({ deleted: true })),
  get("/report", () => markdown("# hi", disposition.inline("r.md"))),
  get("/zip", () => bytes(new Uint8Array([80, 75, 3, 4]), "application/zip", {
    disposition: disposition.attachment("x.zip"),
  })),
  get("/cookie", () =>
    withCookie(json({ ok: true }), { name: "sid", value: "abc", options: { httpOnly: true, path: "/" } })),
  get("/missing", () => failure(404, "thing_not_found", { id: "1" })),
  get("/throws", () => {
    throw new AppError("nope", 409, "conflict_here");
  }),
  get("/crash", () => {
    throw new Error("boom");
  }),
  get("/stream", () =>
    events(async (emit) => {
      emit({ n: 1 });
      emit("two\nlines");
    })),
];

test("reply: json with params and query", async () => {
  await serve(kitApp(ROUTES), async (base) => {
    const res = await fetch(`${base}/items/42?q=a&q=b`);
    assertEquals(res.status, 200);
    assert(res.headers.get("content-type")?.startsWith("application/json"));
    assertEquals(await res.json(), { id: "42", q: "a" });
  });
});

test("reply: text, bytes and content-disposition", async () => {
  await serve(kitApp(ROUTES), async (base) => {
    const md = await fetch(`${base}/report`);
    assertEquals(md.headers.get("content-type"), "text/markdown; charset=utf-8");
    assertEquals(md.headers.get("content-disposition"), 'inline; filename="r.md"');
    assertEquals(await md.text(), "# hi");

    const zip = await fetch(`${base}/zip`);
    assertEquals(zip.headers.get("content-type"), "application/zip");
    assertEquals(zip.headers.get("content-disposition"), 'attachment; filename="x.zip"');
    assertEquals([...new Uint8Array(await zip.arrayBuffer())], [80, 75, 3, 4]);
  });
});

test("reply: cookies and failure bodies", async () => {
  await serve(kitApp(ROUTES), async (base) => {
    const res = await fetch(`${base}/cookie`);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert(cookie.startsWith("sid=abc"));
    assert(cookie.includes("HttpOnly"));

    const missing = await fetch(`${base}/missing`);
    assertEquals(missing.status, 404);
    assertEquals(await missing.json(), { error: "thing_not_found", id: "1" });
  });
});

test("reply: server-sent events frame each message and end the response", async () => {
  await serve(kitApp(ROUTES), async (base) => {
    const res = await fetch(`${base}/stream`);
    assert(res.headers.get("content-type")?.startsWith("text/event-stream"));
    assertEquals(res.headers.get("cache-control"), "no-cache");
    assertEquals(await res.text(), 'data: {"n":1}\n\ndata: two\ndata: lines\n\n');
  });
});

test("routing: json body is parsed regardless of content type; empty is {}", async () => {
  await serve(kitApp(ROUTES), async (base) => {
    const typed = await fetch(`${base}/items`, { method: "POST", body: '{"a":1}' });
    assertEquals(typed.status, 201);
    assertEquals(await typed.json(), { received: { a: 1 } });

    const empty = await fetch(`${base}/items`, { method: "POST" });
    assertEquals(await empty.json(), { received: {} });
  });
});

test("routing: malformed json is 400 invalid_json, or {} on lenient routes", async () => {
  await serve(kitApp(ROUTES), async (base) => {
    const strict = await fetch(`${base}/items`, { method: "POST", body: "not json" });
    assertEquals(strict.status, 400);
    assertEquals(((await strict.json()) as { error: string }).error, "invalid_json");

    const lenient = await fetch(`${base}/lenient`, { method: "POST", body: "not json" });
    assertEquals(lenient.status, 200);
    assertEquals(await lenient.json(), { received: {} });
  });
});

test("routing: raw routes receive the exact bytes", async () => {
  await serve(kitApp(ROUTES), async (base) => {
    const res = await fetch(`${base}/raw`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "text=hello+world",
    });
    assertEquals(await res.json(), { length: 16, isBuffer: true });
  });
});

test("routing: wrong method on a known path is 405 with Allow", async () => {
  await serve(kitApp(ROUTES), async (base) => {
    const res = await fetch(`${base}/items/1`, { method: "PATCH" });
    assertEquals(res.status, 405);
    assertEquals(res.headers.get("allow"), "GET, DELETE, HEAD");
    assertEquals(await res.json(), { error: "method_not_allowed" });
  });
});

test("errors: AppError renders its status and code; others are an opaque 500", async () => {
  await serve(kitApp(ROUTES), async (base) => {
    const app = await fetch(`${base}/throws`);
    assertEquals(app.status, 409);
    assertEquals(await app.json(), { error: "conflict_here", message: "nope" });

    const originalError = console.error;
    console.error = () => {};
    try {
      const crash = await fetch(`${base}/crash`);
      assertEquals(crash.status, 500);
      assertEquals(await crash.json(), { error: "internal_server_error" });
    } finally {
      console.error = originalError;
    }
  });
});

// --- application middleware ---------------------------------------------------

const ORIGIN = "http://localhost:8080";

test("app: healthz, CORS preflight and CSRF guard", async () => {
  await serve(createApp({ allowedOrigins: [ORIGIN], requireGithubLogin: false, webDistRoot: null }), async (base) => {
    const health = await fetch(`${base}/healthz`);
    assertEquals(health.status, 200);
    assertEquals(health.headers.get("cache-control"), "no-store");
    assertEquals(((await health.json()) as { status: string }).status, "ok");

    const preflight = await fetch(`${base}/api/review/runs`, { method: "OPTIONS", headers: { Origin: ORIGIN } });
    assertEquals(preflight.status, 204);
    assertEquals(preflight.headers.get("access-control-allow-origin"), ORIGIN);

    const forged = await fetch(`${base}/api/review/runs`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
      body: "{}",
    });
    assertEquals(forged.status, 403);
    assertEquals(await forged.json(), { error: "origin_not_allowed" });
  });
});

test("app: unknown API paths are a JSON 404", async () => {
  await serve(createApp({ allowedOrigins: [ORIGIN], requireGithubLogin: false, webDistRoot: null }), async (base) => {
    const res = await fetch(`${base}/api/does-not-exist`);
    assertEquals(res.status, 404);
    assertEquals(await res.json(), { error: "not_found" });
  });
});

test("app: the login gate guards /api but not the login flow or healthz", async () => {
  await serve(createApp({ allowedOrigins: [ORIGIN], requireGithubLogin: true, webDistRoot: null }), async (base) => {
    const gated = await fetch(`${base}/api/review/agent/runs`);
    assertEquals(gated.status, 401);
    assertEquals(((await gated.json()) as { error: string }).error, "unauthorized");

    const health = await fetch(`${base}/healthz`);
    assertEquals(health.status, 200);
    await health.body?.cancel();
  });
});

test("app: SPA serves files and falls back to index.html for deep links", async () => {
  const root = await mkdtemp(join(tmpdir(), "capillary_spa_"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>spa</title>");
  await writeFile(join(root, "app.js"), "console.log(1)");
  try {
    await serve(createApp({ allowedOrigins: [ORIGIN], requireGithubLogin: false, webDistRoot: root }), async (base) => {
      const js = await fetch(`${base}/app.js`);
      assert(js.headers.get("content-type")?.includes("javascript"));
      assertEquals(await js.text(), "console.log(1)");

      const deep = await fetch(`${base}/review/123`);
      assertEquals(deep.status, 200);
      assert((await deep.text()).includes("<title>spa</title>"));

      const range = await fetch(`${base}/app.js`, { headers: { Range: "bytes=999999-" } });
      assertEquals(range.status, 416);
      assertEquals(await range.json(), { error: "range_not_satisfiable" });

      const api = await fetch(`${base}/api/nope`);
      assertEquals(api.status, 404);
      await api.body?.cancel();
    });
  } finally {
    await rm(root, { recursive: true });
  }
});

test("app: SPA fallback works when the web dist root is relative", async () => {
  const root = await mkdtemp(join(tmpdir(), "capillary_spa_rel_"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>rel</title>");
  try {
    const webDistRoot = relative(process.cwd(), root);
    await serve(createApp({ allowedOrigins: [ORIGIN], requireGithubLogin: false, webDistRoot }), async (base) => {
      const deep = await fetch(`${base}/review/123`);
      assertEquals(deep.status, 200);
      assert((await deep.text()).includes("<title>rel</title>"));
    });
  } finally {
    await rm(root, { recursive: true });
  }
});

test("app: the GitHub App manifest rejects an org that would reshape its URL", async () => {
  const previous = process.env["CAPILLARY_PUBLIC_URL"];
  process.env["CAPILLARY_PUBLIC_URL"] = "https://capillary.example.com";
  try {
    await serve(createApp({ allowedOrigins: [ORIGIN], requireGithubLogin: false, webDistRoot: null }), async (base) => {
      const ok = await fetch(`${base}/api/github/app/manifest?org=solesius-labs`);
      assertEquals(ok.status, 200);
      assertEquals(
        ((await ok.json()) as { createUrl: string }).createUrl,
        "https://github.com/organizations/solesius-labs/settings/apps/new",
      );

      const reshaped = await fetch(`${base}/api/github/app/manifest?org=${encodeURIComponent("evil/../x?y#z")}`);
      assertEquals(reshaped.status, 400);
      assertEquals(((await reshaped.json()) as { error: string }).error, "invalid_organization");
    });
  } finally {
    if (previous === undefined) delete process.env["CAPILLARY_PUBLIC_URL"];
    else process.env["CAPILLARY_PUBLIC_URL"] = previous;
  }
});

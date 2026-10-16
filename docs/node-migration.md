# Deno → Node migration

The Capillary API moved from Deno 2 + Oak to **Node 24 + Express 5** after
1.2.1. The product does not change: same routes and response shapes, same
on-disk data, and the same container contract. Upgrading an existing
deployment is `docker compose pull && docker compose up -d`.

## What changed

| Concern | Deno (≤ 1.2.1) | Node |
| --- | --- | --- |
| Runtime | Deno 2, TypeScript | Node 24, TypeScript run directly (type stripping) |
| HTTP | Oak 17 | Express 5: a route table of pure handlers (`api/src/http/`) |
| Native store | `Deno.dlopen` | koffi 3 (`.async` calls on worker threads) |
| FFI shim | `native/celer_ffi.cpp` | **unchanged**, same `build.sh`, same celer-mem ref |
| Processes | `Deno.Command` | `src/lib/proc.ts` (same shape, same sync not-found) |
| Bridges/test servers | `Deno.serve` + `upgradeWebSocket` | `src/lib/serve.ts` on `node:http` + `ws` |
| Embeddings | transformers 2.17.2 via CDN URL import | transformers 2.17.2 from npm (no runtime CDN) |
| Tests | `deno test` | `node --test` via `tests/support/harness.ts` |
| Tasks | `deno task …` | `npm run …` (same names) |
| Permissions | `--allow-*` sandbox | none (Node's `--permission` is a possible follow-up) |

### HTTP layer

```
api/src/http/
  app.ts      createApp(config): CORS/CSRF, healthz, login gate, API, SPA, errors
  router.ts   apiRoutes — the route table; every handler is (req) => Reply
  routing.ts  Route type, get/post/patch/del, per-route body modes, mount(), 405
  reply.ts    Reply (json | text | bytes | events) + send(), the only writer of res
  deps.ts     service wiring
```

Handlers never touch `res`. They read the request, call services and return a
`Reply` value; `send` interprets it with plain Express (`res.json`, `res.type`,
`res.cookie`, SSE writes). Cookies a handler needs to set ride on the reply
(`withCookie`). Errors are thrown `AppError`s rendered by `errorMiddleware`.
Static files are `express.static`, cookies `cookie-parser`, bodies `express.raw`
with explicit per-route semantics: `json` (any content type; empty → `{}`;
malformed → 400), `lenient` (malformed → `{}`), `raw` (signed webhooks).

## Container compatibility (1:1)

The image is a drop-in for the Deno-era `ghcr.io/solesius/capillary-cr`:

- same base distro (Debian 13) → same RocksDB 9.10 / SQLite ABI
- same port `8080`, env surface, `/var/lib/capillary` and
  `/app/api/.data/review_captures` volume paths
- same uid/gid **1993**, so volumes created by Deno images stay writable
- tini as PID 1 (also at `/tini`), reaping chromium from RetV runs
- `DENO_V8_FLAGS` still honored (the entrypoint passes the flags to node);
  `NODE_OPTIONS` works as well
- healthcheck semantics unchanged (`GET /healthz`)
- `docker-compose.yml` keeps the project name `capillary`, so it reuses the
  existing `capillary_capillary-data` / `capillary_capillary-captures` volumes

Rollback is safe: a 1.2.1 image reads data written by the Node image.

### Behavior changes (deliberate)

Status codes, JSON bodies, SSE events, cookies, CORS and storage match 1.2.1.
These edges were tightened, each checked by `compat/parity.py`:

| Case | Deno | Node |
| --- | --- | --- |
| Malformed JSON body | 500 `internal_server_error` | 400 `invalid_json` |
| Empty body on a JSON route | 500 | treated as `{}` (normal validation applies) |
| Unknown `/api/*` path | empty 404 | 404 `{"error":"not_found"}` |
| Wrong method on a route | empty 405 | 405 `{"error":"method_not_allowed"}` + `Allow` |
| Error after a handler set a content type | JSON body labelled e.g. `text/markdown` | always `application/json` |
| Unsatisfiable `Range` | 416 with the whole file | 416, `Content-Range: bytes */N`, no file |
| Non-GET to a SPA path | index.html | 404 JSON |
| Unexpected errors | silent 500 | 500, logged with the stack |

Cosmetic header differences (charset casing, ETag format, `public` in
Cache-Control, cookie attribute order, hop-by-hop headers) are not tracked.

## Verification

`compat/run.sh [deno-image] [node-image]` (or `make compat V1=… V2=…`) checks
both directions; it defaults to `ghcr.io/solesius/capillary-cr:1.2.1` against `:latest`.

- **Behavior parity**: 149 scripted requests (login gate on and off) covering
  all 59 routes, SSE, static assets, ranges, CORS/CSRF, 405/Allow, cookies,
  malformed/empty bodies and error responses. It fails on any difference not
  listed as intended above.
- **Storage**: a *copy* of a real data volume (35 review runs, 14 RetV runs)
  read by both images: byte-identical API snapshots; a Node write read back
  by the Deno image. The source volume is never written.

Unit tests: 255 pass (13 of them cover the HTTP layer), 2 opt-in skips
(`CAPILLARY_EMBEDDING_TESTS=1` runs the real MiniLM test; the codex test needs
a codex binary). The celer FFI tests run against the real library.

## Developing without Node 24 on the host

`api/dev.Dockerfile` is a Node 24 + native-toolchain image:

```bash
docker build -f api/dev.Dockerfile -t capillary-dev .
docker run --rm -it -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD/api:/work/api" -w /work/api capillary-dev \
  bash -c "npm ci && ./native/build.sh && npm test"
```

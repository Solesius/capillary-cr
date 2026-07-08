# Contributing to Capillary

Thanks for helping improve Capillary. This guide covers the local workflow and
the conventions the codebase expects.

## Prerequisites

- [Deno](https://deno.com/) 2.x (API)
- Node.js 22+ (web)
- `sqlite3` + a C++23 compiler (`g++`) if you build the native `celer-mem` FFI
  (`api/native/build.sh` auto-fetches the [celer-mem](https://github.com/Solesius/celer-mem)
  sources, or point `CELER_MEM_DIR` at a local checkout)
- Docker (optional, for the container deploy)

## Layout

- `api/` — Deno + Oak API. Tasks live in [api/deno.json](api/deno.json).
- `web/` — Angular 20 SPA (standalone components, signals, `OnPush`).
- `capillary-cr.sml` (repo root) — the SML manifest is the source of truth for
  the review domain. Keep service/entity declarations in sync when you change
  backend domain logic that it models. (The RetV CDP agent is intentionally not
  modeled there.)

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system flow.

## Everyday commands

```bash
make dev            # run API (:8080) + web (:4200) with hot reload
make test           # API tests + web unit tests + Playwright scaffold
make docker-up      # build & run the single-instance container locally
```

Focused loops:

```bash
cd api && deno task dev            # API only
cd api && deno check src/main.ts   # type-check
cd api && deno task test           # backend tests
cd web && npm run start            # web only
cd web && npm run -s build         # production web build
cd web && npm test                 # web unit tests
```

## Testing conventions

- Backend tests use `Deno.test` with `jsr:@std/assert` and `snake_case`
  `should_*` names. Run with `deno test --allow-env --allow-net`; native FFI
  tests additionally need `--allow-ffi --allow-read --allow-write`.
- Prefer dependency injection (e.g. inject a fake spawner / channel / fetch) over
  hitting real CLIs, networks, or browsers in tests.
- Add or update tests alongside behavior changes; keep the suite green before
  opening a PR. CI runs the API and web suites on every pull request.

## Code conventions

- TypeScript throughout; match the existing style (no drive-by reformatting).
- Keep changes scoped to the task — avoid unrelated refactors, and don't add
  docstrings/comments to code you didn't touch.
- **Security**: model credentials are environment-only. Never add a code path
  that accepts an API key over the API, persists a token/key, logs a secret, or
  sends the GitHub token to a non-Copilot/Codex endpoint. See the security
  section of [ARCHITECTURE.md](ARCHITECTURE.md).

## Submitting changes

1. Branch from `main`.
2. Make the change with tests; run `make test` (or the focused equivalents).
3. Open a PR describing the change and its rationale. Ensure CI is green.

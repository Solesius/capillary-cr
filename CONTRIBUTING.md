# Contributing to Capillary

Thanks for helping improve Capillary. This guide covers the local workflow and
the conventions the codebase expects.

## Prerequisites

- Node.js 24+ (API; runs the TypeScript directly)
- Node.js 22+ (web)
- `sqlite3` + a C++23 compiler (`g++`) if you build the native `celer-mem` FFI
  (`api/native/build.sh` auto-fetches the [celer-mem](https://github.com/Solesius/celer-mem)
  sources, or point `CELER_MEM_DIR` at a local checkout)
- Docker (optional, for the container deploy)

## Layout

- `api/` — Node + Express API. Scripts live in [api/package.json](api/package.json).
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
cd api && npm run dev              # API only
cd api && npm run check            # type-check
cd api && npm test                 # backend tests
cd web && npm run start            # web only
cd web && npm run -s build         # production web build
cd web && npm test                 # web unit tests
```

## Testing conventions

- Backend tests run on `node:test` through `api/tests/support/harness.ts`
  (`test`, `assert`, `assertEquals`, `assertThrows`, `assertRejects`) with
  `snake_case` `should_*` names. Run with `npm test`; native FFI tests use the
  real `libceler_ffi.so` when it has been built (`make native`).
- Prefer dependency injection (e.g. inject a fake spawner / channel / fetch) over
  hitting real CLIs, networks, or browsers in tests.
- Add or update tests alongside behavior changes; keep the suite green before
  opening a PR. CI runs the API and web suites on every pull request.

## Capillary reviews itself

Every PR is reviewed by Capillary before it is marked ready. Open it as a
**draft**, then run the agent CLI from your branch against it:

```bash
cd api
GITHUB_TOKEN=$(gh auth token) npm run review -- --repo Solesius/capillary-cr --pr <n>
```

Fix real findings (with a test), note false positives in the PR, re-run until
the verdict is clean, and only then mark the PR ready for review.

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

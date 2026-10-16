
# Capillary
<img width="2508" height="627" alt="pic" src="https://github.com/user-attachments/assets/aa0fb72f-3ada-429f-909f-75f4506bc371" />



**A PR is not a patch. It is a disturbance in a software graph.**

Capillary is a code review system built around that premise. It takes a pull request, builds a dependency graph from the diff, projects changed and affected nodes onto a torus, and runs an agentic review through six TCSRTC gates — Target → Constrain → Sanitize → Review → Test → Confirm — streaming its reasoning and findings in real time. A second agent drives a real browser over CDP to run natural-language functional tests against your running app.

<img width="1401" height="1074" alt="image" src="https://github.com/user-attachments/assets/c26fac88-2135-41bd-8fd2-8269d4c1799a" />


---

## Quick start — Docker

One command, everything included (UI, browser agent, durable storage):

```bash
docker run -d --name capillary -p 8080:8080 \
  -v capillary-data:/var/lib/capillary \
  -e CAPILLARY_GITHUB_TOKEN=github_pat_... \
  ghcr.io/solesius/capillary-cr:latest
```

Open **http://localhost:8080**, pick a PR, hit **Begin Review**. Compose users: clone the repo and `docker compose up -d`. Details in [Docker deploy](#docker-deploy-single-instance).

**GitHub access — use an environment token.** `CAPILLARY_GITHUB_TOKEN` connects an identity at boot, never travels through the browser, and reaches **org and private** repos (device-flow login against the built-in OAuth app only surfaces public repos for org accounts). Grant the minimum:

- **Fine-grained PAT** (recommended): resource owner = your org or account, selected repositories, permissions **Contents: read**, **Metadata: read**, **Pull requests: read and write** (write only enables posting review comments/suggestions — drop to read-only if you never post).
- **Classic PAT**: `repo` scope.

Pasting a PAT into the UI works for a quick trial (it stays in memory only), but the env token is the recommended path.

## Quick start — local

Requirements: Node.js 24+ (API), Node.js 22+ (web).

```bash
git clone https://github.com/Solesius/capillary-cr.git && cd capillary-cr
cp .env.example .env       # add GITHUB_OAUTH_CLIENT_ID (2-min setup below)
make dev                   # API :8080 + Angular dev server :4200
```

Open **http://localhost:4200**. The review agent needs a model: the Codex or Claude Code CLI logged in locally (no key), or a provider key in `.env`. OAuth app setup and provider details in [Local development](#local-development).

---

## Why a torus

Most review tools draw a flat list of files. Capillary draws a field.

When you change a file, risk propagates outward through the import graph the way fluid moves through capillary tissue — not uniformly, and not just through direct dependencies. The torus (`T²`) is the right shape for this because it has no boundary: you can follow a dependency ring continuously and come back to where you started. Changed files render in `#FFD400`. Wetted (transitively affected) files render in `#F2F2F2`. The shape of the disturbance is the review.

This is not decoration, and the geometry is real. A node's major-ring angle is a stable hash of its file path; its minor-ring angle is how disturbed it is — disturbed nodes migrate toward the inner rim, the saddle region of negative Gaussian curvature. Risk telemetry comes from the surface's actual differential geometry: Euler normal curvature and geodesic torsion along each node's flow direction. The graph is computed from the actual diff — the torus is the projection surface that makes the topology legible.

---

## Why TCSRTC

Static diff review asks one question: does this code look right? Capillary's agent instead walks six process gates — the TCSRTC formalism — and every finding is raised under the gate that produced it:

| Gate | Question it must answer |
|---|---|
| **Target** | What actually changed, and what is the true blast radius? |
| **Constrain** | What boundaries and contracts must this change respect — and does it? |
| **Sanitize** | Are inputs at system boundaries, auth, and persistence still safe? |
| **Review** | Line by line, hot path by hot path: is this correct? |
| **Test** | Where is regression coverage thin? What changed that isn't tested? |
| **Confirm** | Has every hot path been examined? Only then is a verdict legitimate. |

The gates have teeth. The agent's context tracks hot-path coverage every cycle, the cycle budget scales with the size of the change, and an approval that skipped hot paths is automatically downgraded with the unexamined files listed in the report. On a 100-file PR you don't get "LGTM" — you get a coverage-accounted verdict and an artifact you can action: what was checked, what was found, and exactly what still deserves a human read.

The review runs as an agentic loop, narrating its reasoning at each gate over SSE as it reads files, diffs, neighbors, and the graph — with a live token meter (input/output, cache-aware) and a run clock, and a Stop that actually stops the loop mid-model-turn.

Findings are first-class output, not just prose: every finding resolves to a real, commentable diff line, and you can post them to the PR as inline comments — **one by one or all at once** — plus committable ```suggestion blocks when the model proposes a concrete fix, and a summary comment for the run. All gated behind explicit buttons, never automatic. A file explorer (read-only Monaco, side-by-side diff view) lets you read the PR the way the agent read it, with findings rendered in place on their lines. Every report ends with a **Model usage** footer — the run's token cost travels with the artifact.

---

## Why CDP

Static review tells you what could go wrong. CDP tells you what does.

The RetV agent (`api/src/services/cdp_retv_agent_service.ts`) connects to a Chrome DevTools Protocol endpoint, takes a natural-language goal, and drives a real browser against your running application. It can navigate, click, type, assert text, take screenshots, and report structured findings. You give it a goal like:

```
"Open the Run page, switch to the Findings tab, and verify the severity badges are present"
```

It drives Chrome and tells you whether it worked, where it got stuck, and why. This runs against the actual app, not a mock. If your PR broke the review results page, the CDP agent finds it without you having to write a Playwright spec first.

Completion has teeth: `goalAchieved` is a verdict that requires quoted on-page evidence and every milestone complete — unproven claims are rejected and the rejection is fed back to the planner. And a traced run exports **run skeletons**: a deterministic Playwright spec (runs in any CI, no LLM, failed steps quarantined, credentials redacted to env placeholders) plus a model-agnostic runsheet any engineer or coding agent can use to reproduce or port the run. Explore agentically once, regress deterministically forever.

---

## Stack

- **API** — Node 24 + Express 5 (TypeScript, run directly). Single process on `:8080`. Moved from Deno after 1.2.1 — see [docs/node-migration.md](docs/node-migration.md).
- **Frontend** — Angular 20. Standalone components, signals and `computed`, `OnPush` throughout. No NGXS.
- **Graph** — Zdog. Canvas-2D torus, deliberately lightweight — no WebGL dependency.
- **Review engine** — TCSRTC-gated agentic loop with typed SSE events, hot-path coverage enforcement, and CPU semantic embeddings (MiniLM over wasm) relating files by meaning before any LLM call.
- **Sessions** — reviews run as durable server-side sessions: bounce between screens or reload, re-attach with a full narrative replay; run several concurrently (with a token-cost warning before each additional session).
- **LLM providers** — Claude Code CLI, Codex, Anthropic, Gemini, OpenRouter, AWS Bedrock, GitHub Copilot. Server-side only; keys never touch the client.
- **Durable storage** — [`celer-mem`](https://github.com/Solesius/celer-mem) over FFI, **RocksDB** backend (SQLite fallback on bare-metal macOS). celer is the **source of truth** for review artifacts; the process keeps only a bounded LRU cache in front of it, so resident memory stays flat under concurrent reviews and runs survive restarts. Persistence health is surfaced at `/healthz`. Optional: without `CAPILLARY_STORAGE_DIR` (or the native lib), the process runs fully in-memory.
- **Browser agent** — Chrome DevTools Protocol. Auto-detects a local Chrome binary or connects to an existing CDP endpoint.

---

## Local development

Requirements: Node.js 24+ (API), Node.js 22+ (web); `g++`, `librocksdb-dev`, `libsqlite3-dev` to build the optional native store (`make native`)

```bash
make dev          # starts API (port 8080) and Angular dev server (port 4200) concurrently
make test         # API tests, Angular unit tests, Playwright e2e scaffold
make check        # API type-check
```

GitHub access (recommended — environment token):

```bash
cp .env.example .env
# CAPILLARY_GITHUB_TOKEN=github_pat_...   (fine-grained: Contents+Metadata read,
#                                          Pull requests read/write; or classic: repo)
# add an LLM provider key for the review agent (ANTHROPIC_API_KEY, GEMINI_API_KEY, etc.)
make dev
```

Prefer this over browser login: it reaches org/private repos and never exposes the token to the client. OAuth device/web login is available as an alternative (set `GITHUB_OAUTH_CLIENT_ID` from your own OAuth App), but for org repos an admin must grant that app under the org's third-party access policy — a scoped PAT sidesteps that.

### GitLab

GitLab is a full code host alongside GitHub — gitlab.com or self-hosted. Its projects appear in the same repository picker (marked `GitLab ·`), and everything works on merge requests the way it does on pull requests: reviews and "check changes" follow-ups, inline findings as diff discussions, committable suggestions ("Apply suggestion"), the summary note, issue dispatch, the agent CLI and MCP. Connect it from the server environment:

```bash
# in .env
CAPILLARY_GITLAB_TOKEN=glpat-...                 # personal, project or group access token
GITLAB_BASE_URL=https://gitlab.example.com       # optional; blank = https://gitlab.com
```

Token scope: `api` to post findings, suggestions, notes, issues and commit statuses; `read_api` is enough if you only run reviews and never post. A GitLab token satisfies the login gate on its own, so GitHub-free deployments work with `CAPILLARY_REQUIRE_GITHUB_LOGIN=1`.

Merge-box status and auto-review mirror the GitHub App: a finished review sets a `Capillary review` commit status on the MR head (`CAPILLARY_CHECKS=0` disables), and a project webhook (Merge request events, URL `https://<capillary>/api/gitlab/webhook`, secret token = `GITLAB_WEBHOOK_SECRET`) queues a review when an MR is opened, reopened or marked ready, if `CAPILLARY_AUTO_REVIEW_ON_OPEN=1`.

---

## Docker deploy (single instance)

```bash
# Run the published image
CAPILLARY_IMAGE=ghcr.io/solesius/capillary-cr:latest docker compose up -d

# Build and run locally
make docker-up
```

The container serves the built Angular SPA and the API from the same origin on `:8080`. Durable storage and review captures live in docker-managed named volumes — no host directory setup or ownership configuration needed.

**Upgrading from 1.2.x (Deno).** The API now runs on Node; the container contract is unchanged — same port, env vars, volumes and uid — so `docker compose pull && docker compose up -d` is the whole upgrade, and rolling back to 1.2.1 reads the data the new image wrote. A few HTTP edge cases were tightened (e.g. malformed JSON is now `400 invalid_json` instead of `500`); the full list is in [docs/node-migration.md](docs/node-migration.md).

Key environment variables:

```
CAPILLARY_REQUIRE_GITHUB_LOGIN=1       # require GitHub login for all /api/* routes
CORS_ORIGIN=https://your-host.example  # comma-separated allow-list
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...         # optional; device flow works without it
ANTHROPIC_API_KEY=...                  # or whichever provider you use
NODE_OPTIONS=--max-old-space-size=768  # optional V8 tuning (DENO_V8_FLAGS still honoured)
```

Full variable reference in [`.env.example`](.env.example).

### Using your host's Claude Code / Codex login from the container

The container can drive the CLIs you are already logged into on the host — no API key in Capillary. Run a bridge on the host (Node 24+, after `cd api && npm ci`) and point the container at it:

```bash
node api/scripts/claude_ws_bridge.ts   # → CLAUDE_CODE_URL=ws://host.docker.internal:7898
node api/scripts/codex_ws_bridge.ts    # → CODEX_APP_SERVER_URL=ws://host.docker.internal:7899
```

The Claude bridge only spawns the exact non-interactive print-mode flag set Capillary emits; anything else is rejected before spawn. Compose already maps `host.docker.internal` on Linux.

---

## Agent CLI

Run a full review from a terminal, CI job, or another agent — no server needed:

```bash
cd api
GITHUB_TOKEN=ghp_... npm run review -- --repo owner/name --pr 123
CAPILLARY_GITLAB_TOKEN=glpat-... npm run review -- --source gitlab --repo group/project --mr 42
```

Live gate narration streams to stderr; the report lands on stdout (`--json` for the full run record). Exit codes are stable for automation: `0` approve/comment, `1` request_changes, `2` error. The model provider resolves exactly as the server does — Codex/Claude CLI logins, ws bridges, or provider keys.

---

## MCP

Capillary exposes a stdio MCP server for agent-to-agent use:

```bash
cd api && npm run mcp
```

Tools cover GitHub identity, repository and PR/MR listing across GitHub and GitLab, review run lifecycle, artifact retrieval, and CDP session management. Register it with any MCP client as a stdio server (Node 24+):

```json
{ "command": "node", "args": ["/path/to/capillary-cr/api/src/mcp/server.ts"], "env": { "GITHUB_TOKEN": "ghp_..." } }
```

---

## CDP / RetV pipeline

Run a functional goal against the local dev stack:

```bash
make cdp-retv ARGS="--provider anthropic --goal 'Open Run page and verify findings are visible'"
```

Or from a goal file:

```bash
cd api && npm run cdp:retv -- --provider anthropic --goal-file scripts/goals/view-items.txt --reuse-session
```

Supported providers: `anthropic`, `gemini`, `openrouter`, `ihhi_bedrock`, `github_copilot`, `codex_app_server`.

The runner exits non-zero on any failure, so it can wire directly into CI.

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system topology, request surface, agentic flow diagrams, and security posture. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

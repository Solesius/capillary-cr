
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

Requirements: [Deno](https://deno.com/) 2.x, Node.js 22+.

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

The review runs as an agentic loop, narrating its reasoning at each gate over SSE as it reads files, diffs, neighbors, and the graph. A completed run can be posted back to the PR as a summary comment — gated behind an explicit button, never automatic.

---

## Why CDP

Static review tells you what could go wrong. CDP tells you what does.

The RetV agent (`api/src/services/cdp_retv_agent_service.ts`) connects to a Chrome DevTools Protocol endpoint, takes a natural-language goal, and drives a real browser against your running application. It can navigate, click, type, assert text, take screenshots, and report structured findings. You give it a goal like:

```
"Open the Run page, switch to the Findings tab, and verify the severity badges are present"
```

It drives Chrome and tells you whether it worked, where it got stuck, and why. This runs against the actual app, not a mock. If your PR broke the review results page, the CDP agent finds it without you having to write a Playwright spec first.

---

## Stack

- **API** — Deno + Oak (TypeScript). Single process on `:8080`.
- **Frontend** — Angular 20. Standalone components, signals and `computed`, `OnPush` throughout. No NGXS.
- **Graph** — Three.js. WebGL torus rendered on canvas. Orbit controls, raycasting for hover.
- **Review engine** — TCSRTC-gated agentic loop with typed SSE events, hot-path coverage enforcement, and CPU semantic embeddings (MiniLM over wasm) relating files by meaning before any LLM call.
- **Sessions** — reviews run as durable server-side sessions: bounce between screens or reload, re-attach with a full narrative replay; run several concurrently (with a token-cost warning before each additional session).
- **LLM providers** — Anthropic, Gemini, OpenRouter, AWS Bedrock, GitHub Copilot, Codex. Server-side only; keys never touch the client.
- **Durable storage** — `celer-mem` SQLite FFI (optional write-through mirror; in-memory repository is source of truth).
- **Browser agent** — Chrome DevTools Protocol. Auto-detects a local Chrome binary or connects to an existing CDP endpoint.

---

## Local development

Requirements: Deno, Node.js 20+

```bash
make dev          # starts API (port 8080) and Angular dev server (port 4200) concurrently
make test         # Deno type-check + test, Angular unit tests, Playwright e2e scaffold
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

---

## Docker deploy (single instance)

```bash
# Run the published image
CAPILLARY_IMAGE=ghcr.io/solesius/capillary-cr:latest docker compose up -d

# Build and run locally
make docker-up
```

The container serves the built Angular SPA and the API from the same origin on `:8080`. Durable storage and review captures live in docker-managed named volumes — no host directory setup or ownership configuration needed.

Key environment variables:

```
CAPILLARY_REQUIRE_GITHUB_LOGIN=1       # require GitHub login for all /api/* routes
CORS_ORIGIN=https://your-host.example  # comma-separated allow-list
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...         # optional; device flow works without it
ANTHROPIC_API_KEY=...                  # or whichever provider you use
```

Full variable reference in [`.env.example`](.env.example).

---

## Agent CLI

Run a full review from a terminal, CI job, or another agent — no server needed:

```bash
cd api
GITHUB_TOKEN=ghp_... deno task review --repo owner/name --pr 123
```

Live gate narration streams to stderr; the report lands on stdout (`--json` for the full run record). Exit codes are stable for automation: `0` approve/comment, `1` request_changes, `2` error. The model provider resolves exactly as the server does — Codex/Claude CLI logins, ws bridges, or provider keys.

---

## MCP

Capillary exposes a stdio MCP server for agent-to-agent use:

```bash
cd api && deno task mcp
```

Tools cover GitHub identity, repository and PR listing, review run lifecycle, artifact retrieval, and CDP session management. Registration config for VS Code and Zed is at `.vscode/ihhi-mcp.json`.

---

## CDP / RetV pipeline

Run a functional goal against the local dev stack:

```bash
make cdp-retv ARGS="--provider anthropic --goal 'Open Run page and verify findings are visible'"
```

Or from a goal file:

```bash
cd api && deno task cdp:retv --provider anthropic --goal-file scripts/goals/view-items.txt --reuse-session
```

Supported providers: `anthropic`, `gemini`, `openrouter`, `ihhi_bedrock`, `github_copilot`, `codex_app_server`.

The runner exits non-zero on any failure, so it can wire directly into CI.

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system topology, request surface, agentic flow diagrams, and security posture. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

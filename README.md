
# Capillary
<img width="2508" height="627" alt="pic" src="https://github.com/user-attachments/assets/aa0fb72f-3ada-429f-909f-75f4506bc371" />



**A PR is not a patch. It is a disturbance in a software graph.**

Capillary is a code review system built around that premise. It takes a pull request, builds a dependency graph from the diff, projects changed and affected nodes onto a torus, and runs an agentic review through six TCSRTC gates — Target → Constrain → Sanitize → Review → Test → Confirm — streaming its reasoning and findings in real time. A second agent drives a real browser over CDP to run natural-language functional tests against your running app.

---

## Why a torus

Most review tools draw a flat list of files. Capillary draws a field.

When you change a file, risk propagates outward through the import graph the way fluid moves through capillary tissue — not uniformly, and not just through direct dependencies. The torus (`T²`) is the right shape for this because it has no boundary: you can follow a dependency ring continuously and come back to where you started. Changed files render in `#FFD400`. Wetted (transitively affected) files render in `#F2F2F2`. The shape of the disturbance is the review.

This is not decoration, and the geometry is real. A node's major-ring angle is a stable hash of its file path; its minor-ring angle is how disturbed it is — disturbed nodes migrate toward the inner rim, the saddle region of negative Gaussian curvature. Risk telemetry comes from the surface's actual differential geometry: Euler normal curvature and geodesic torsion along each node's flow direction. The graph is computed from the actual diff — the torus is the projection surface that makes the topology legible.

---

## Why TCSRTC

Static diff review asks one question: does this code look right? Capillary's agent instead walks six process gates — **Target → Constrain → Sanitize → Review → Test → Confirm** — narrating its reasoning at each gate as it reads files, diffs, neighbors, and the torus. What it finds is categorized under six TCSRCT analysis lenses, each asking a harder question than "does it look right":

| Lens | Question |
|---|---|
| **Trace** | Does this change preserve the runtime traversal paths that callers depend on? |
| **Contracts** | Do the API and type contracts still hold across the boundary? |
| **State** | Are state transitions still valid? Can you reach an illegal state now that you couldn't before? |
| **Runtime** | Are there new hazards at runtime — nulls, races, unbounded allocations, error paths that don't terminate? |
| **CodeShape** | Has the structural complexity drifted? Are abstractions holding or collapsing? |
| **Tests** | Where is the regression coverage thin? What changed that isn't tested? |

The review runs as an agentic loop where each cycle targets the next uncovered gate based on what the previous cycles found. It isn't a linear batch; it accumulates risk and focuses attention. Thinking, tool calls, and findings stream over SSE as the agent works, and a completed run can be posted back to the PR as a summary comment — gated behind an explicit button, never automatic.

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
- **Review engine** — TCSRTC-gated agentic loop with typed SSE events; findings categorized under TCSRCT analysis lenses.
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

GitHub OAuth setup (two minutes):

1. Go to https://github.com/settings/developers → OAuth Apps → New OAuth App
2. Homepage URL: `http://localhost:8080`
3. Callback URL: `http://localhost:8080/api/github/oauth/callback`
4. Copy your Client ID into `.env` as `GITHUB_OAUTH_CLIENT_ID`
5. Client Secret is optional — device flow works without it

```bash
cp .env.example .env
# fill in GITHUB_OAUTH_CLIENT_ID at minimum
# add an LLM provider key for the review agent (ANTHROPIC_API_KEY, GEMINI_API_KEY, etc.)
make dev
```

---

## Docker deploy (single instance)

```bash
# Run the published image
mkdir -p data   # durable-storage mount; create it first so it's owned by you, not root
CAPILLARY_IMAGE=ghcr.io/solesius/capillary-cr:latest docker compose up -d

# Build and run locally
make docker-up
```

The container serves the built Angular SPA and the API from the same origin on `:8080`. Review captures and durable storage are bind-mounted with host UID/GID ownership.

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

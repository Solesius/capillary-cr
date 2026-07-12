// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Host-side WebSocket bridge for the `claude` CLI.
//
// Run this on the machine where Claude Code is installed and logged in, then
// point a containerized Capillary API at it:
//
//   deno run --allow-net --allow-run --allow-env api/scripts/claude_ws_bridge.ts
//   # container env: CLAUDE_CODE_URL=ws://host.docker.internal:7898
//
// Protocol (one JSON object per text frame, see createClaudeWsSpawner):
//   client → bridge:  { args, stdin }            (first frame)
//   bridge → client:  { stream: "stdout"|"stderr", data } | { exit: code }
//
// Security: the bridge only accepts the exact non-interactive print-mode flag
// set the capillary transport emits (allowlist below). Anything else — other
// flags, permission overrides, tool grants — is rejected before spawn.
//
// Env:
//   CLAUDE_BRIDGE_PORT  listen port (default 7898)
//   CLAUDE_BRIDGE_HOST  bind address (default 0.0.0.0 so the Docker bridge
//                       network can reach it; firewall accordingly)
//   CLAUDE_CODE_BIN     path to the claude binary (default "claude")

const port = Number(Deno.env.get("CLAUDE_BRIDGE_PORT") || 7898);

// One empty scratch directory per bridge process — see spawn comment.
let scratchDir: string | null = null;
function scratchCwd(): string {
  if (!scratchDir) {
    scratchDir = Deno.makeTempDirSync({ prefix: "capillary_claude_hermetic_" });
  }
  return scratchDir;
}
const hostname = Deno.env.get("CLAUDE_BRIDGE_HOST") || "0.0.0.0";

// Deno.Command does not search PATH for a bare program name when the child
// env is replaced (clearEnv), so resolve an absolute path up front — same
// logic as the in-process transport's resolveClaudeBin().
function isExecutableFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

function resolveClaudeBin(): string {
  const configured = Deno.env.get("CLAUDE_CODE_BIN")?.trim() || "";
  if (configured) {
    return configured;
  }
  const home = Deno.env.get("HOME") || "";
  const searchDirs = (Deno.env.get("PATH") || "").split(":");
  if (home) {
    searchDirs.push(
      `${home}/.local/bin`,
      `${home}/.claude/local`,
      `${home}/.npm-global/bin`,
      `${home}/bin`,
    );
  }
  searchDirs.push("/usr/local/bin", "/usr/bin");
  for (const dir of searchDirs) {
    if (!dir) {
      continue;
    }
    const candidate = `${dir.replace(/\/+$/, "")}/claude`;
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return "claude";
}

const claudeBin = resolveClaudeBin();

// flag → does it consume a value token, and how is that value validated
const ALLOWED_FLAGS: Record<
  string,
  { takesValue: boolean; validate?: (value: string) => boolean }
> = {
  "-p": { takesValue: false },
  "--model": { takesValue: true, validate: (v) => /^[\w.@:-]+$/.test(v) },
  "--output-format": { takesValue: true, validate: (v) => v === "json" || v === "stream-json" },
  "--no-session-persistence": { takesValue: false },
  "--verbose": { takesValue: false },
  "--include-partial-messages": { takesValue: false },
  // Value is prompt text — safe in argv position (no shell), any content allowed.
  "--append-system-prompt": { takesValue: true },
};

function validateArgs(args: unknown): args is string[] {
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    return false;
  }
  for (let i = 0; i < args.length; i++) {
    const rule = ALLOWED_FLAGS[args[i]];
    if (!rule) {
      return false;
    }
    if (rule.takesValue) {
      const value = args[i + 1];
      if (value === undefined || (rule.validate && !rule.validate(value))) {
        return false;
      }
      i++;
    }
  }
  return true;
}

function log(...parts: unknown[]): void {
  console.log(`[claude-ws-bridge ${new Date().toISOString()}]`, ...parts);
}

function sendEnvelope(socket: WebSocket, envelope: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(envelope));
  }
}

async function pipeStream(
  stream: ReadableStream<Uint8Array>,
  socket: WebSocket,
  name: "stdout" | "stderr",
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const data = decoder.decode(chunk, { stream: true });
    if (data) {
      sendEnvelope(socket, { stream: name, data });
    }
  }
}

function runInvocation(socket: WebSocket, args: string[], stdin: string): void {
  // Same auth posture as the in-process transport: the CLI must use its own
  // subscription OAuth login, never an ambient API key.
  const env = Deno.env.toObject();
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(claudeBin, {
      args,
      // Hermetic cwd: the bridge often runs from some repo checkout, and an
      // agentic CLI grounds itself in whatever directory it lands in — when
      // that repo differs from the PR under review, reviews derail on a
      // phantom mismatch. An empty scratch dir removes disk from the picture;
      // the packet capillary sends is the only ground truth.
      cwd: scratchCwd(),
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env,
      clearEnv: true,
    }).spawn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`failed to spawn ${claudeBin}:`, message);
    sendEnvelope(socket, { stream: "stderr", data: `claude_bridge_spawn_failed: ${message}` });
    sendEnvelope(socket, { exit: 1 });
    socket.close();
    return;
  }

  log(`turn start — spawned ${claudeBin} (pid ${child.pid})`);

  const writer = child.stdin.getWriter();
  writer.write(new TextEncoder().encode(stdin))
    .then(() => writer.close())
    .catch(() => {});

  const stdoutDone = pipeStream(child.stdout, socket, "stdout").catch(() => {});
  const stderrDone = pipeStream(child.stderr, socket, "stderr").catch(() => {});

  socket.onclose = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
  };

  child.status.then(async (status) => {
    await Promise.allSettled([stdoutDone, stderrDone]);
    log(`turn done — pid ${child.pid} exit ${status.code}`);
    sendEnvelope(socket, { exit: status.code });
    socket.close();
  });
}

function handleConnection(socket: WebSocket): void {
  let started = false;
  socket.onmessage = (event) => {
    if (started || typeof event.data !== "string") {
      return;
    }
    started = true;
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      payload = null;
    }
    const record = (typeof payload === "object" && payload !== null)
      ? payload as Record<string, unknown>
      : null;
    const args = record?.args;
    const stdin = typeof record?.stdin === "string" ? record.stdin : "";
    if (!record || !validateArgs(args)) {
      log("rejected invocation: args failed allowlist");
      sendEnvelope(socket, { stream: "stderr", data: "claude_bridge_args_rejected" });
      sendEnvelope(socket, { exit: 1 });
      socket.close();
      return;
    }
    runInvocation(socket, args, stdin);
  };
}

Deno.serve({ port, hostname }, (request) => {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("claude ws bridge — connect with a WebSocket client", { status: 426 });
  }
  const { socket, response } = Deno.upgradeWebSocket(request);
  socket.onopen = () => handleConnection(socket);
  return response;
});

log(`listening on ws://${hostname}:${port} (bridging to \`${claudeBin}\`)`);

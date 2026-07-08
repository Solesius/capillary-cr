// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Host-side WebSocket bridge for `codex app-server`.
//
// Run this on the machine where the Codex CLI is installed and logged in, then
// point a containerized Capillary API at it:
//
//   deno run --allow-net --allow-run --allow-env api/scripts/codex_ws_bridge.ts
//   # container env: CODEX_APP_SERVER_URL=ws://host.docker.internal:7899
//
// Protocol: one JSON-RPC message per WebSocket text frame (matching the
// capillary codex transport's openWebSocketChannel). Each connection gets its
// own `codex app-server` child; frames are piped to the child's stdin as
// NDJSON lines and stdout lines come back as frames. Closing the socket kills
// the child and vice versa.
//
// Env:
//   CODEX_BRIDGE_PORT   listen port (default 7899)
//   CODEX_BRIDGE_HOST   bind address (default 0.0.0.0 so the Docker bridge
//                       network can reach it; firewall accordingly)
//   CODEX_APP_SERVER_CMD  override the spawned command (default "codex app-server")

const port = Number(Deno.env.get("CODEX_BRIDGE_PORT") || 7899);
const hostname = Deno.env.get("CODEX_BRIDGE_HOST") || "0.0.0.0";

function resolveCommand(): { command: string; args: string[] } {
  const override = Deno.env.get("CODEX_APP_SERVER_CMD")?.trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
  }
  return { command: "codex", args: ["app-server"] };
}

function log(...parts: unknown[]): void {
  console.log(`[codex-ws-bridge ${new Date().toISOString()}]`, ...parts);
}

async function pipeChildToSocket(child: Deno.ChildProcess, socket: WebSocket): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of child.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line && socket.readyState === WebSocket.OPEN) {
        socket.send(line);
      }
      newline = buffer.indexOf("\n");
    }
  }
}

async function drainStderr(child: Deno.ChildProcess): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of child.stderr) {
    const text = decoder.decode(chunk).trim();
    if (text) {
      log("app-server:", text);
    }
  }
}

function handleConnection(socket: WebSocket): void {
  const { command, args } = resolveCommand();
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(command, {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    log(`failed to spawn ${command}:`, error instanceof Error ? error.message : error);
    socket.close(1011, "codex_spawn_failed");
    return;
  }

  log(`connection open — spawned ${command} ${args.join(" ")} (pid ${child.pid})`);
  const writer = child.stdin.getWriter();
  const encoder = new TextEncoder();
  let closed = false;

  const shutdown = (reason: string) => {
    if (closed) {
      return;
    }
    closed = true;
    log(`connection closed (${reason}) — stopping pid ${child.pid}`);
    writer.close().catch(() => {});
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  };

  socket.onmessage = (event) => {
    if (typeof event.data !== "string" || closed) {
      return;
    }
    writer.write(encoder.encode(event.data + "\n")).catch(() => shutdown("stdin_write_failed"));
  };
  socket.onclose = () => shutdown("socket_closed");
  socket.onerror = () => shutdown("socket_error");

  pipeChildToSocket(child, socket)
    .catch(() => {})
    .finally(() => shutdown("app_server_stdout_ended"));
  drainStderr(child).catch(() => {});
  child.status.then((status) => shutdown(`app_server_exited code=${status.code}`));
}

Deno.serve({ port, hostname }, (request) => {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("codex ws bridge — connect with a WebSocket client", { status: 426 });
  }
  const { socket, response } = Deno.upgradeWebSocket(request);
  socket.onopen = () => handleConnection(socket);
  return response;
});

log(`listening on ws://${hostname}:${port} (bridging to \`${resolveCommand().command}\`)`);

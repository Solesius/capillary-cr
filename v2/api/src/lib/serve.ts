// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
// serve.ts — a fetch-shaped HTTP + WebSocket server for scripts and tests.
//
// `serve(options, handler)` runs `(Request) => Response` over node:http, and
// `upgradeWebSocket(request)` hands back a WebSocket immediately (handlers can
// be attached before the handshake completes) plus the Response to return.
// It mirrors the Deno.serve / Deno.upgradeWebSocket pair the host bridges and
// the fake-CDP test were written against. The production API does not use it;
// that runs on Express (see main.ts).

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import { WebSocketServer } from "ws";
import type { WebSocket as WsSocket } from "ws";

export type Handler = (request: Request) => Response | Promise<Response>;

export interface ServeOptions {
  port?: number;
  hostname?: string;
  onListen?: (addr: { hostname: string; port: number }) => void;
}

export interface Server {
  readonly addr: { hostname: string; port: number };
  readonly listening: Promise<void>;
  shutdown(): Promise<void>;
}

type MessageHandler = ((event: { data: string | ArrayBuffer }) => void) | null;
type CloseHandler = ((event: { code: number; reason: string }) => void) | null;
type BasicHandler = ((event: unknown) => void) | null;

/**
 * Server-side socket handed out by `upgradeWebSocket`. Starts CONNECTING and
 * binds to the real `ws` socket once the handshake completes, then fires
 * `onopen` — the same lifecycle as a browser/Deno WebSocket.
 */
export class UpgradedWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  onopen: BasicHandler = null;
  onmessage: MessageHandler = null;
  onclose: CloseHandler = null;
  onerror: BasicHandler = null;
  #real: WsSocket | null = null;
  #pendingClose: { code?: number; reason?: string } | null = null;

  get readyState(): number {
    return this.#real ? this.#real.readyState : UpgradedWebSocket.CONNECTING;
  }

  send(data: string | ArrayBufferLike | Uint8Array): void {
    if (!this.#real) {
      throw new Error("InvalidStateError: WebSocket is not open");
    }
    this.#real.send(data);
  }

  close(code?: number, reason?: string): void {
    if (!this.#real) {
      this.#pendingClose = { code, reason };
      return;
    }
    this.#real.close(code, reason);
  }

  bind(real: WsSocket): void {
    this.#real = real;
    real.on("message", (data, isBinary) => {
      const payload = isBinary
        ? new Uint8Array(data as Buffer).slice().buffer
        : (data as Buffer).toString("utf8");
      this.onmessage?.({ data: payload });
    });
    real.on("close", (code, reason) => this.onclose?.({ code, reason: reason.toString("utf8") }));
    real.on("error", (error) => this.onerror?.(error));
    this.onopen?.({});
    if (this.#pendingClose) {
      real.close(this.#pendingClose.code, this.#pendingClose.reason);
    }
  }
}

const UPGRADE = Symbol("capillary.upgrade");

interface UpgradeTicket {
  socket: UpgradedWebSocket;
}

type UpgradableRequest = Request & { [UPGRADE]?: { ticket: UpgradeTicket | null } };

export function upgradeWebSocket(request: Request): { socket: UpgradedWebSocket; response: Response } {
  const slot = (request as UpgradableRequest)[UPGRADE];
  if (!slot) {
    throw new TypeError("upgradeWebSocket: request is not an upgrade request");
  }
  const socket = new UpgradedWebSocket();
  slot.ticket = { socket };
  // 101 cannot be built through the Response constructor; the status here is
  // a marker that the server swaps for the real handshake.
  return { socket, response: new Response(null, { status: 200, headers: { "x-upgrade": "1" } }) };
}

function toRequest(req: IncomingMessage, host: string): Request {
  const url = `http://${req.headers.host ?? host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) as unknown as ReadableStream : undefined,
    // undici requires duplex for streaming request bodies
    duplex: hasBody ? "half" : undefined,
  });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body) {
    res.end();
    return;
  }
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    res.write(chunk);
  }
  res.end();
}

function errorResponse(error: unknown): Response {
  console.error("serve: handler failed", error);
  return new Response("Internal Server Error", { status: 500 });
}

export function serve(options: ServeOptions, handler: Handler): Server {
  const hostname = options.hostname ?? "0.0.0.0";
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => {
    const request = toRequest(req, hostname);
    Promise.resolve()
      .then(() => handler(request))
      .catch(errorResponse)
      .then((response) => writeResponse(res, response))
      .catch(() => res.destroy());
  });

  server.on("upgrade", (req: IncomingMessage, duplex: Duplex, head: Buffer) => {
    const request = toRequest(req, hostname) as UpgradableRequest;
    const slot: { ticket: UpgradeTicket | null } = { ticket: null };
    request[UPGRADE] = slot;
    Promise.resolve()
      .then(() => handler(request))
      .catch(errorResponse)
      .then((response) => {
        const ticket = slot.ticket;
        if (!ticket) {
          const body = `HTTP/1.1 ${response.status} ${response.statusText || "Error"}\r\n` +
            "Connection: close\r\nContent-Length: 0\r\n\r\n";
          duplex.end(body);
          return;
        }
        wss.handleUpgrade(req, duplex, head, (real) => ticket.socket.bind(real));
      })
      .catch(() => duplex.destroy());
  });

  const addr = { hostname, port: options.port ?? 0 };
  const listening = new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, hostname, () => {
      addr.port = (server.address() as AddressInfo).port;
      options.onListen?.(addr);
      resolve();
    });
  });

  return {
    addr,
    listening,
    shutdown: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

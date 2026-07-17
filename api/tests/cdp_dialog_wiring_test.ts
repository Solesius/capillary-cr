// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Integration coverage for the session-level dialog wiring — the seam the
// pure-helper tests cannot reach: #handleDialogOpening answering through the
// real CdpConnection, setSessionDialogPolicy, onSessionDialog fan-out, and
// the code-enforced single-responder contract on onSessionCdpEvent. Runs
// against a fake CDP endpoint (HTTP /json/* + WebSocket) — no browser.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { AppError } from "../src/domain/errors.ts";
import { CdpDriverService } from "../src/services/cdp_driver_service.ts";

interface FakeCdpCommand {
  method: string;
  params: Record<string, unknown>;
}

interface FakeCdp {
  baseUrl: string;
  commands: FakeCdpCommand[];
  pushEvent(method: string, params: Record<string, unknown>): void;
  close(): Promise<void>;
}

function startFakeCdp(): FakeCdp {
  const commands: FakeCdpCommand[] = [];
  let socket: WebSocket | null = null;

  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/json/version") {
      return Response.json({ Browser: "FakeChrome/1.0" });
    }
    if (url.pathname === "/json/new") {
      return Response.json({
        id: "fake_target_1",
        url: "about:blank",
        webSocketDebuggerUrl: `ws://${url.host}/devtools/page/fake_target_1`,
      });
    }
    if (url.pathname.startsWith("/json/close/")) {
      return new Response("Target is closing");
    }
    if (url.pathname.startsWith("/devtools/")) {
      const upgraded = Deno.upgradeWebSocket(req);
      upgraded.socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        commands.push({ method: message.method, params: message.params ?? {} });
        upgraded.socket.send(JSON.stringify({ id: message.id, result: {} }));
      };
      socket = upgraded.socket;
      return upgraded.response;
    }
    return new Response("not found", { status: 404 });
  });

  return {
    baseUrl: `http://127.0.0.1:${server.addr.port}`,
    commands,
    pushEvent(method, params) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("fake cdp: no live socket to push events on");
      }
      socket.send(JSON.stringify({ method, params }));
    },
    async close() {
      try {
        socket?.close();
      } catch {
        // already closed
      }
      await server.shutdown();
    },
  };
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function dialogAnswers(fake: FakeCdp): FakeCdpCommand[] {
  return fake.commands.filter((command) => command.method === "Page.handleJavaScriptDialog");
}

Deno.test({
  name: "session wiring answers a confirm per policy and notifies listeners",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeCdp();
    const driver = new CdpDriverService({ baseUrl: fake.baseUrl });
    try {
      const session = await driver.createSession("about:blank");
      const seen: { dialogType: string; message: string; action: string; url: string }[] = [];
      driver.onSessionDialog(session.sessionId, (occurrence) => seen.push(occurrence));

      // Default policy: confirm is dismissed, and the answer goes through the
      // real connection — the fake endpoint must receive it.
      fake.pushEvent("Page.javascriptDialogOpening", {
        type: "confirm",
        message: "Delete everything?",
        url: "http://app.test/page",
      });
      await until(() => dialogAnswers(fake).length === 1 && seen.length === 1);
      assertEquals(dialogAnswers(fake)[0].params.accept, false);
      assertEquals(seen[0].dialogType, "confirm");
      assertEquals(seen[0].message, "Delete everything?");
      assertEquals(seen[0].action, "dismissed");
      assertEquals(seen[0].url, "http://app.test/page");

      // Policy flip is live for the same session.
      driver.setSessionDialogPolicy(session.sessionId, "accept");
      fake.pushEvent("Page.javascriptDialogOpening", {
        type: "confirm",
        message: "Proceed?",
        url: "http://app.test/page",
      });
      await until(() => dialogAnswers(fake).length === 2 && seen.length === 2);
      assertEquals(dialogAnswers(fake)[1].params.accept, true);
      assertEquals(seen[1].action, "accepted");

      // Prompt carries an explicit empty promptText so the page gets a
      // deterministic value instead of undefined.
      driver.setSessionDialogPolicy(session.sessionId, "dismiss");
      fake.pushEvent("Page.javascriptDialogOpening", {
        type: "prompt",
        message: "Name?",
        url: "http://app.test/page",
      });
      await until(() => dialogAnswers(fake).length === 3 && seen.length === 3);
      assertEquals(dialogAnswers(fake)[2].params.accept, false);
      assertEquals(dialogAnswers(fake)[2].params.promptText, "");

      await driver.closeSession(session.sessionId);
    } finally {
      await fake.close();
    }
  },
});

Deno.test({
  name: "unsubscribed dialog listeners stop receiving; the driver still answers",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeCdp();
    const driver = new CdpDriverService({ baseUrl: fake.baseUrl });
    try {
      const session = await driver.createSession("about:blank");
      const seen: string[] = [];
      const unsubscribe = driver.onSessionDialog(
        session.sessionId,
        (occurrence) => seen.push(occurrence.message),
      );
      unsubscribe();

      fake.pushEvent("Page.javascriptDialogOpening", {
        type: "alert",
        message: "heads up",
        url: "http://app.test/",
      });
      // The DRIVER must still answer even with zero listeners — that is the
      // whole point of session-level handling.
      await until(() => dialogAnswers(fake).length === 1);
      assertEquals(dialogAnswers(fake)[0].params.accept, true);
      assertEquals(seen.length, 0);

      await driver.closeSession(session.sessionId);
    } finally {
      await fake.close();
    }
  },
});

Deno.test({
  name: "onSessionCdpEvent delivers generic events but reserves dialog events",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeCdp();
    const driver = new CdpDriverService({ baseUrl: fake.baseUrl });
    try {
      const session = await driver.createSession("about:blank");

      // Generic tap works (the seam the network feed builds on).
      const network: Record<string, unknown>[] = [];
      driver.onSessionCdpEvent(
        session.sessionId,
        "Network.responseReceived",
        (params) => network.push(params),
      );
      fake.pushEvent("Network.responseReceived", { requestId: "r1" });
      await until(() => network.length === 1);
      assertEquals(network[0].requestId, "r1");

      // Dialog events are code-reserved for onSessionDialog: a second
      // subscriber could answer dialogs and race the driver.
      const error = assertThrows(
        () => driver.onSessionCdpEvent(session.sessionId, "Page.javascriptDialogOpening", () => {}),
        AppError,
      );
      assert(error.message.includes("dialog_events_reserved"));

      await driver.closeSession(session.sessionId);
    } finally {
      await fake.close();
    }
  },
});

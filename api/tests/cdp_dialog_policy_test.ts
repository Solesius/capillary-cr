// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Pins the dialog-handling contract: the driver is the single, immediate
// responder to JavaScript dialogs (an unanswered dialog freezes the page and
// used to stall runs to their time budget), the policy only governs
// confirm/prompt, and protocol-event dispatch isolates subscribers.
import { assert, assertEquals } from "jsr:@std/assert";
import { CdpEventHub, resolveDialogAction } from "../src/services/cdp_driver_service.ts";
import { formatDialogObservation } from "../src/services/cdp_retv_agent_service.ts";

Deno.test("alert is accepted under both policies — it has no other answer", () => {
  assertEquals(resolveDialogAction("alert", "dismiss").accept, true);
  assertEquals(resolveDialogAction("alert", "accept").accept, true);
});

Deno.test("beforeunload is accepted under both policies — dismissing stalls navigation", () => {
  assertEquals(resolveDialogAction("beforeunload", "dismiss").accept, true);
  assertEquals(resolveDialogAction("beforeunload", "accept").accept, true);
});

Deno.test("confirm and prompt follow the session policy", () => {
  assertEquals(resolveDialogAction("confirm", "dismiss").accept, false);
  assertEquals(resolveDialogAction("prompt", "dismiss").accept, false);
  assertEquals(resolveDialogAction("confirm", "accept").accept, true);
  assertEquals(resolveDialogAction("prompt", "accept").accept, true);
});

Deno.test("an unknown dialog type defaults to the policy, not a crash", () => {
  assertEquals(resolveDialogAction("mystery", "dismiss").accept, false);
  assertEquals(resolveDialogAction("mystery", "accept").accept, true);
});

Deno.test("dialog observation names the type, quotes the message, states the action", () => {
  const line = formatDialogObservation({
    dialogType: "confirm",
    message: "Delete item?",
    action: "dismissed",
  });
  assertEquals(line, 'confirm appeared: "Delete item?" — auto-dismissed');
});

Deno.test("dialog observation truncates a long message", () => {
  const line = formatDialogObservation({
    dialogType: "alert",
    message: "x".repeat(500),
    action: "accepted",
  });
  assert(line.includes("…"));
  assert(line.length < 200);
  assert(line.endsWith("— auto-accepted"));
});

Deno.test("event hub delivers to every subscriber of a method", () => {
  const hub = new CdpEventHub();
  const seen: string[] = [];
  hub.on("Page.javascriptDialogOpening", (params) => seen.push(`a:${params.message}`));
  hub.on("Page.javascriptDialogOpening", (params) => seen.push(`b:${params.message}`));
  hub.dispatch("Page.javascriptDialogOpening", { message: "hi" });
  assertEquals(seen, ["a:hi", "b:hi"]);
});

Deno.test("event hub only delivers to the dispatched method", () => {
  const hub = new CdpEventHub();
  const seen: string[] = [];
  hub.on("Network.responseReceived", () => seen.push("network"));
  hub.dispatch("Page.javascriptDialogOpening", {});
  assertEquals(seen, []);
});

Deno.test("unsubscribe stops delivery without touching peers", () => {
  const hub = new CdpEventHub();
  const seen: string[] = [];
  const off = hub.on("Page.frameNavigated", () => seen.push("gone"));
  hub.on("Page.frameNavigated", () => seen.push("stays"));
  off();
  hub.dispatch("Page.frameNavigated", {});
  assertEquals(seen, ["stays"]);
});

Deno.test("a throwing handler never blocks its peers", () => {
  const hub = new CdpEventHub();
  const seen: string[] = [];
  hub.on("Network.loadingFailed", () => {
    throw new Error("bad subscriber");
  });
  hub.on("Network.loadingFailed", () => seen.push("survived"));
  hub.dispatch("Network.loadingFailed", {});
  assertEquals(seen, ["survived"]);
});

Deno.test("clear drops every subscription", () => {
  const hub = new CdpEventHub();
  const seen: string[] = [];
  hub.on("Page.loadEventFired", () => seen.push("fired"));
  hub.clear();
  hub.dispatch("Page.loadEventFired", {});
  assertEquals(seen, []);
});

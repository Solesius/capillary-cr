// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { AppError, notFound } from "../domain/errors.ts";

export type CdpWaitUntil = "load" | "domcontentloaded";

export type CdpWorkStep =
  | {
    action: "navigate";
    url: string;
    waitUntil?: CdpWaitUntil;
    timeoutMs?: number;
  }
  | {
    action: "waitForSelector";
    selector: string;
    timeoutMs?: number;
  }
  | {
    action: "click";
    selector: string;
    timeoutMs?: number;
  }
  | {
    action: "type";
    selector: string;
    text: string;
    clear?: boolean;
    timeoutMs?: number;
  }
  | {
    action: "assertText";
    selector: string;
    includes?: string;
    equals?: string;
    timeoutMs?: number;
  }
  | {
    action: "extractText";
    selector: string;
    timeoutMs?: number;
  }
  | {
    action: "evaluate";
    expression: string;
    returnByValue?: boolean;
  }
  | {
    action: "screenshot";
    format?: "png" | "jpeg";
    quality?: number;
  };

export interface CdpWorkUnitRequest {
  name?: string;
  stopOnFailure?: boolean;
  steps: CdpWorkStep[];
}

export interface CdpWorkStepResult {
  action: string;
  ok: boolean;
  durationMs: number;
  output?: unknown;
  error?: string;
}

export interface CdpWorkUnitResult {
  sessionId: string;
  name: string;
  success: boolean;
  startedAt: string;
  finishedAt: string;
  steps: CdpWorkStepResult[];
}

export interface CdpSessionSummary {
  sessionId: string;
  targetId: string;
  targetUrl: string;
  createdAt: string;
  lastActiveAt: string;
}

interface CdpTargetResponse {
  id: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface CdpEvaluateResponse {
  result: {
    type: string;
    value?: unknown;
    description?: string;
  };
  exceptionDetails?: {
    text?: string;
    exception?: {
      description?: string;
    };
  };
}

interface CdpSessionState extends CdpSessionSummary {
  connection: CdpConnection;
}

const DEFAULT_CHROME_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium-browser",
  "chromium",
  "chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  // Bundled in the container image; listed so auto-detect still works when a
  // stale compose file overrides CHROME_PATH with an empty string.
  "/headless-shell/headless-shell",
  "/snap/bin/chromium",
] as const;

type ProbeExecutable = (candidate: string) => Promise<boolean>;
type LaunchBrowser = (executablePath: string, args: string[]) => Deno.ChildProcess;

interface CdpDriverServiceOptions {
  baseUrl?: string;
  probeExecutable?: ProbeExecutable;
  launchBrowser?: LaunchBrowser;
}

export async function resolveChromeExecutablePath(
  probeExecutable: ProbeExecutable,
  chromePathEnv = Deno.env.get("CHROME_PATH") || "",
): Promise<string | null> {
  const seen = new Set<string>();

  for (const candidate of DEFAULT_CHROME_CANDIDATES) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    if (await probeExecutable(candidate)) {
      return candidate;
    }
  }

  const envPath = chromePathEnv.trim();
  if (envPath.length > 0 && await probeExecutable(envPath)) {
    return envPath;
  }

  return null;
}

async function probeExecutable(candidate: string): Promise<boolean> {
  try {
    const child = new Deno.Command(candidate, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).spawn();

    await child.status;
    return true;
  } catch {
    return false;
  }
}

function launchBrowser(executablePath: string, args: string[]): Deno.ChildProcess {
  return new Deno.Command(executablePath, {
    args,
    stdout: "null",
    stderr: "null",
  }).spawn();
}

class CdpConnection {
  #socket: WebSocket | null = null;
  #requestId = 0;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();

  async connect(url: string): Promise<void> {
    if (this.#socket) {
      return;
    }

    this.#socket = new WebSocket(url);

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };

      const onError = () => {
        cleanup();
        reject(new AppError("cdp_socket_failed", 502, "cdp_socket_failed"));
      };

      const cleanup = () => {
        this.#socket?.removeEventListener("open", onOpen);
        this.#socket?.removeEventListener("error", onError);
      };

      this.#socket?.addEventListener("open", onOpen);
      this.#socket?.addEventListener("error", onError);
    });

    this.#socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data));
      if (typeof payload.id !== "number") {
        return;
      }

      const pending = this.#pending.get(payload.id);
      if (!pending) {
        return;
      }

      this.#pending.delete(payload.id);
      if (payload.error) {
        pending.reject(new AppError(payload.error.message || "cdp_command_failed", 400, "cdp_command_failed"));
        return;
      }

      pending.resolve(payload.result);
    });

    this.#socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new AppError("cdp_socket_closed", 410, "cdp_socket_closed"));
      }
      this.#pending.clear();
      this.#socket = null;
    });
  }

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      throw new AppError("cdp_socket_not_open", 500, "cdp_socket_not_open");
    }

    this.#requestId += 1;
    const id = this.#requestId;

    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });

    this.#socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  close(): void {
    this.#socket?.close();
    this.#socket = null;
  }
}

export class CdpDriverService {
  #baseUrl = Deno.env.get("CDP_BASE_URL") || "http://127.0.0.1:9333";
  #sessions = new Map<string, CdpSessionState>();
  #probeExecutable: ProbeExecutable;
  #launchBrowser: LaunchBrowser;
  #launchedBrowser: Deno.ChildProcess | null = null;

  constructor(options: CdpDriverServiceOptions = {}) {
    this.#baseUrl = options.baseUrl || this.#baseUrl;
    this.#probeExecutable = options.probeExecutable || probeExecutable;
    this.#launchBrowser = options.launchBrowser || launchBrowser;
  }

  async createSession(startUrl = "about:blank"): Promise<CdpSessionSummary> {
    await this.assertCdpAvailable();

    const target = await this.createTarget(startUrl);
    const connection = new CdpConnection();
    await connection.connect(target.webSocketDebuggerUrl);

    await connection.send("Page.enable");
    await connection.send("Runtime.enable");
    await connection.send("DOM.enable");
    await connection.send("Network.enable");

    const sessionId = `cdp_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const summary: CdpSessionSummary = {
      sessionId,
      targetId: target.id,
      targetUrl: target.url,
      createdAt: now,
      lastActiveAt: now,
    };

    this.#sessions.set(sessionId, {
      ...summary,
      connection,
    });

    return summary;
  }

  listSessions(): CdpSessionSummary[] {
    return Array.from(this.#sessions.values()).map((session) => ({
      sessionId: session.sessionId,
      targetId: session.targetId,
      targetUrl: session.targetUrl,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
    }));
  }

  async executeWorkUnit(sessionId: string, request: CdpWorkUnitRequest): Promise<CdpWorkUnitResult> {
    const session = this.getSession(sessionId);
    if (!request.steps || request.steps.length === 0) {
      throw new AppError("work_unit_steps_required", 400, "work_unit_steps_required");
    }

    const startedAt = new Date().toISOString();
    const results: CdpWorkStepResult[] = [];
    const stopOnFailure = request.stopOnFailure ?? true;

    for (const step of request.steps) {
      const stepStart = Date.now();

      try {
        const output = await this.executeStep(session, step);
        results.push({
          action: step.action,
          ok: true,
          durationMs: Date.now() - stepStart,
          output,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "step_failed";
        results.push({
          action: step.action,
          ok: false,
          durationMs: Date.now() - stepStart,
          error: message,
        });

        if (stopOnFailure) {
          break;
        }
      }
    }

    session.lastActiveAt = new Date().toISOString();
    return {
      sessionId,
      name: request.name || "anonymous_work_unit",
      success: results.every((result) => result.ok),
      startedAt,
      finishedAt: new Date().toISOString(),
      steps: results,
    };
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.getSession(sessionId);
    session.connection.close();

    const closeUrl = `${this.#baseUrl}/json/close/${session.targetId}`;
    try {
      await fetch(closeUrl);
    } catch {
      // Best-effort close for target endpoint.
    }

    this.#sessions.delete(sessionId);
    return true;
  }

  private async executeStep(session: CdpSessionState, step: CdpWorkStep): Promise<unknown> {
    switch (step.action) {
      case "navigate":
        await this.navigate(session.connection, step.url, step.waitUntil || "load", step.timeoutMs || 15000);
        return { url: step.url, waitUntil: step.waitUntil || "load" };
      case "waitForSelector":
        await this.waitForSelector(session.connection, step.selector, step.timeoutMs || 10000);
        return { selector: step.selector };
      case "click":
        await this.waitForSelector(session.connection, step.selector, step.timeoutMs || 10000);
        await this.clickSelector(session.connection, step.selector);
        return { selector: step.selector };
      case "type":
        await this.waitForSelector(session.connection, step.selector, step.timeoutMs || 10000);
        await this.typeSelector(session.connection, step.selector, step.text, step.clear ?? true);
        return { selector: step.selector, length: step.text.length };
      case "assertText":
        await this.waitForSelector(session.connection, step.selector, step.timeoutMs || 10000);
        return await this.assertSelectorText(session.connection, step.selector, step.includes, step.equals);
      case "extractText":
        await this.waitForSelector(session.connection, step.selector, step.timeoutMs || 10000);
        return await this.extractSelectorText(session.connection, step.selector);
      case "evaluate":
        return await this.evaluateExpression(session.connection, step.expression, step.returnByValue ?? true);
      case "screenshot":
        return await this.captureScreenshot(session.connection, step.format || "png", step.quality);
      default:
        throw new AppError("unsupported_step_action", 400, "unsupported_step_action");
    }
  }

  private async assertCdpAvailable(): Promise<void> {
    const debugPort = this.resolveDebugPort();

    if (await this.isCdpReachable()) {
      return;
    }

    const launchAttempt = await this.tryLaunchLocalBrowserForCdp();
    if (launchAttempt.launched && await this.waitForCdpReachable(9000)) {
      return;
    }

    if (!launchAttempt.launched && await this.waitForCdpReachable(1200)) {
      return;
    }

    if (launchAttempt.reason === "browser_not_found") {
      throw new AppError(
        `cdp_unavailable: could not auto-detect Chrome. Set CHROME_PATH or start Chromium with --remote-debugging-port=${debugPort}.`,
        503,
        "cdp_unavailable",
      );
    }

    throw new AppError(
      `cdp_unavailable: start Chromium with --remote-debugging-port=${debugPort} or set CDP_BASE_URL. For headed local driving, try: /snap/bin/chromium --remote-debugging-port=${debugPort} --user-data-dir=/tmp/capillary-cdp-${debugPort} --no-first-run --no-default-browser-check --new-window about:blank`,
      503,
      "cdp_unavailable",
    );
  }

  private async isCdpReachable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.#baseUrl}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async waitForCdpReachable(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isCdpReachable()) {
        return true;
      }
      await this.sleep(160);
    }

    return false;
  }

  private isLocalBaseUrl(): boolean {
    try {
      const url = new URL(this.#baseUrl);
      return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "0.0.0.0";
    } catch {
      return false;
    }
  }

  private resolveDebugPort(): number {
    try {
      const url = new URL(this.#baseUrl);
      const parsed = Number(url.port || "9222");
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    } catch {
      // Fall through to default.
    }

    return 9222;
  }

  private async tryLaunchLocalBrowserForCdp(): Promise<{ launched: boolean; reason?: string }> {
    if (this.#launchedBrowser || !this.isLocalBaseUrl()) {
      return { launched: false };
    }

    const executablePath = await resolveChromeExecutablePath(this.#probeExecutable);
    if (!executablePath) {
      return { launched: false, reason: "browser_not_found" };
    }

    const debugPort = this.resolveDebugPort();
    const userDataDir = Deno.env.get("CDP_USER_DATA_DIR") || `/tmp/capillary-cdp-${debugPort}`;
    // Extra operator-set launch flags, e.g. the container image sets
    // CDP_LAUNCH_FLAGS="--headless=new --no-sandbox --disable-gpu
    // --disable-dev-shm-usage" — headless Chromium cannot start in a
    // non-root container without them. Unset for local headed driving.
    const extraFlags = (Deno.env.get("CDP_LAUNCH_FLAGS") || "")
      .split(/\s+/)
      .filter((flag) => flag.length > 0);
    const args = [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...extraFlags,
      "--new-window",
      "about:blank",
    ];

    try {
      this.#launchedBrowser = this.#launchBrowser(executablePath, args);
      return { launched: true };
    } catch {
      this.#launchedBrowser = null;
      return { launched: false, reason: "browser_launch_failed" };
    }
  }

  private async createTarget(startUrl: string): Promise<CdpTargetResponse> {
    const putUrl = `${this.#baseUrl}/json/new?${encodeURIComponent(startUrl)}`;
    let response = await fetch(putUrl, { method: "PUT" });

    if (!response.ok) {
      response = await fetch(putUrl);
    }

    if (!response.ok) {
      throw new AppError("cdp_target_create_failed", 502, "cdp_target_create_failed");
    }

    const payload = await response.json();
    if (!payload.webSocketDebuggerUrl || !payload.id) {
      throw new AppError("cdp_target_invalid", 502, "cdp_target_invalid");
    }

    return payload as CdpTargetResponse;
  }

  private getSession(sessionId: string): CdpSessionState {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw notFound("cdp_session_not_found");
    }
    return session;
  }

  private async navigate(
    connection: CdpConnection,
    url: string,
    waitUntil: CdpWaitUntil,
    timeoutMs: number,
  ): Promise<void> {
    if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("file://")) {
      throw new AppError("invalid_navigation_url", 400, "invalid_navigation_url");
    }

    await connection.send("Page.navigate", { url });
    await this.waitForDocumentReady(connection, waitUntil, timeoutMs);
  }

  private async waitForDocumentReady(
    connection: CdpConnection,
    waitUntil: CdpWaitUntil,
    timeoutMs: number,
  ): Promise<void> {
    const expectedState = waitUntil === "domcontentloaded" ? ["interactive", "complete"] : ["complete"];

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const state = await this.evaluateExpression(connection, "document.readyState", true);
      if (typeof state === "string" && expectedState.includes(state)) {
        return;
      }
      await this.sleep(120);
    }

    throw new AppError("navigation_timeout", 408, "navigation_timeout");
  }

  private async waitForSelector(
    connection: CdpConnection,
    selector: string,
    timeoutMs: number,
  ): Promise<void> {
    const selectorLiteral = JSON.stringify(selector);
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const exists = await this.evaluateExpression(
        connection,
        `Boolean(document.querySelector(${selectorLiteral}))`,
        true,
      );
      if (exists === true) {
        return;
      }

      await this.sleep(100);
    }

    throw new AppError(`selector_not_found: ${selector}`, 404, "selector_not_found");
  }

  private async clickSelector(connection: CdpConnection, selector: string): Promise<void> {
    const selectorLiteral = JSON.stringify(selector);
    const result = await this.evaluateExpression(
      connection,
      `(() => {
        const el = document.querySelector(${selectorLiteral});
        if (!el) return { ok: false, reason: "not_found" };
        el.scrollIntoView({ block: "center", inline: "center" });
        if (el instanceof HTMLElement) {
          el.click();
          return { ok: true };
        }
        return { ok: false, reason: "not_html_element" };
      })()`,
      true,
    );

    if (!isOkObject(result)) {
      throw new AppError(`click_failed: ${selector}`, 400, "click_failed");
    }
  }

  private async typeSelector(
    connection: CdpConnection,
    selector: string,
    text: string,
    clear: boolean,
  ): Promise<void> {
    const selectorLiteral = JSON.stringify(selector);
    const textLiteral = JSON.stringify(text);
    const clearLiteral = clear ? "true" : "false";

    const result = await this.evaluateExpression(
      connection,
      `(() => {
        const el = document.querySelector(${selectorLiteral});
        if (!el) return { ok: false, reason: "not_found" };

        if (!(el instanceof HTMLElement)) {
          return { ok: false, reason: "not_html_element" };
        }

        el.focus();

        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const current = ${clearLiteral} ? "" : el.value;
          el.value = current + ${textLiteral};
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, valueLength: el.value.length };
        }

        if (el.isContentEditable) {
          if (${clearLiteral}) {
            el.textContent = "";
          }
          el.textContent = (el.textContent || "") + ${textLiteral};
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return { ok: true, valueLength: (el.textContent || "").length };
        }

        return { ok: false, reason: "unsupported_element" };
      })()`,
      true,
    );

    if (!isOkObject(result)) {
      throw new AppError(`type_failed: ${selector}`, 400, "type_failed");
    }
  }

  private async assertSelectorText(
    connection: CdpConnection,
    selector: string,
    includes?: string,
    equals?: string,
  ): Promise<{ selector: string; text: string }> {
    const text = await this.extractSelectorText(connection, selector);

    if (typeof equals === "string" && text !== equals) {
      throw new AppError(`assert_text_failed_equals: ${selector}`, 409, "assert_text_failed");
    }

    if (typeof includes === "string" && !text.includes(includes)) {
      throw new AppError(`assert_text_failed_includes: ${selector}`, 409, "assert_text_failed");
    }

    return {
      selector,
      text,
    };
  }

  private async extractSelectorText(connection: CdpConnection, selector: string): Promise<string> {
    const selectorLiteral = JSON.stringify(selector);
    const text = await this.evaluateExpression(
      connection,
      `(() => {
        const el = document.querySelector(${selectorLiteral});
        if (!el) return null;
        return (el.textContent || "").trim();
      })()`,
      true,
    );

    if (typeof text !== "string") {
      throw new AppError(`extract_text_failed: ${selector}`, 404, "extract_text_failed");
    }

    return text;
  }

  private async evaluateExpression(
    connection: CdpConnection,
    expression: string,
    returnByValue: boolean,
  ): Promise<unknown> {
    const payload = await connection.send<CdpEvaluateResponse>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue,
    });

    if (payload.exceptionDetails) {
      const details = payload.exceptionDetails.exception?.description || payload.exceptionDetails.text || "evaluation_error";
      throw new AppError(details, 400, "evaluation_error");
    }

    return payload.result.value;
  }

  private async captureScreenshot(
    connection: CdpConnection,
    format: "png" | "jpeg",
    quality?: number,
  ): Promise<{ format: string; dataBase64: string }> {
    const payload = await connection.send<{ data: string }>("Page.captureScreenshot", {
      format,
      quality: format === "jpeg" ? quality || 80 : undefined,
      captureBeyondViewport: true,
    });

    return {
      format,
      dataBase64: payload.data,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function isOkObject(value: unknown): value is { ok: boolean } {
  return Boolean(
    value &&
      typeof value === "object" &&
      "ok" in value &&
      (value as Record<string, unknown>).ok === true,
  );
}

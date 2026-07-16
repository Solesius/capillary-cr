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
    /** Click at viewport coordinates — the ref-digest's bbox-center target. */
    action: "clickAt";
    x: number;
    y: number;
  }
  | {
    /** Type into the currently focused element (pair with clickAt). */
    action: "insertText";
    text: string;
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

export type CdpDialogPolicy = "accept" | "dismiss";

/** A JavaScript dialog the driver auto-handled on behalf of a session. */
export interface CdpDialogOccurrence {
  at: string;
  url: string;
  dialogType: string;
  message: string;
  action: "accepted" | "dismissed";
}

/**
 * How to answer a JavaScript dialog: alert has only an accept path, and
 * beforeunload must be accepted or the pending navigation stalls forever;
 * confirm/prompt follow the session policy (default "dismiss" — the least
 * state-changing answer). Exported for direct unit testing.
 */
export function resolveDialogAction(
  dialogType: string,
  policy: CdpDialogPolicy,
): { accept: boolean } {
  if (dialogType === "alert" || dialogType === "beforeunload") {
    return { accept: true };
  }
  return { accept: policy === "accept" };
}

/**
 * Registry for CDP protocol events (payloads without an id — dropped entirely
 * before this existed, which let an unanswered confirm() freeze a run until
 * its time budget died). Handler throws are swallowed so one bad subscriber
 * can never break the socket loop or its peers.
 */
export class CdpEventHub {
  #handlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
    let handlers = this.#handlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.#handlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  dispatch(method: string, params: Record<string, unknown>): void {
    const handlers = this.#handlers.get(method);
    if (!handlers) {
      return;
    }
    for (const handler of [...handlers]) {
      try {
        handler(params);
      } catch {
        // Subscriber isolation: a throwing handler never blocks peers.
      }
    }
  }

  clear(): void {
    this.#handlers.clear();
  }
}

interface CdpSessionState extends CdpSessionSummary {
  connection: CdpConnection;
  dialogPolicy: CdpDialogPolicy;
  dialogListeners: Set<(occurrence: CdpDialogOccurrence) => void>;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * Loopback target -> host-gateway variant, or null when the URL is not a
 * rewrite candidate. Used as a one-shot retry after a failed navigation:
 * inside a container, a user's "localhost" almost always means the host.
 */
export function rewriteLoopbackToHostGateway(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (
      !LOOPBACK_HOSTNAMES.has(parsed.hostname) && !LOOPBACK_HOSTNAMES.has(`[${parsed.hostname}]`)
    ) {
      return null;
    }
    parsed.hostname = "host.docker.internal";
    return parsed.toString();
  } catch {
    return null;
  }
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
  options: { excludeHeadlessShell?: boolean } = {},
): Promise<string | null> {
  const seen = new Set<string>();
  // headless-shell has no UI at all — useless for a headed launch.
  const excluded = (candidate: string) =>
    options.excludeHeadlessShell === true && candidate.includes("headless-shell");

  for (const candidate of DEFAULT_CHROME_CANDIDATES) {
    if (seen.has(candidate) || excluded(candidate)) {
      continue;
    }
    seen.add(candidate);

    if (await probeExecutable(candidate)) {
      return candidate;
    }
  }

  const envPath = chromePathEnv.trim();
  if (envPath.length > 0 && !excluded(envPath) && await probeExecutable(envPath)) {
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
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  #events = new CdpEventHub();

  /** Subscribe to a CDP protocol event (e.g. "Page.javascriptDialogOpening"). */
  on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
    return this.#events.on(method, handler);
  }

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
        if (typeof payload.method === "string") {
          this.#events.dispatch(payload.method, payload.params ?? {});
        }
        return;
      }

      const pending = this.#pending.get(payload.id);
      if (!pending) {
        return;
      }

      this.#pending.delete(payload.id);
      if (payload.error) {
        pending.reject(
          new AppError(payload.error.message || "cdp_command_failed", 400, "cdp_command_failed"),
        );
        return;
      }

      pending.resolve(payload.result);
    });

    this.#socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new AppError("cdp_socket_closed", 410, "cdp_socket_closed"));
      }
      this.#pending.clear();
      this.#events.clear();
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
    this.#events.clear();
    this.#socket = null;
  }
}

export class CdpDriverService {
  #baseUrl = Deno.env.get("CDP_BASE_URL") || "http://127.0.0.1:9333";
  #sessions = new Map<string, CdpSessionState>();
  #probeExecutable: ProbeExecutable;
  #launchBrowser: LaunchBrowser;
  #launchedBrowser: Deno.ChildProcess | null = null;
  /** Mode of the browser we spawned; null when none/external. */
  #launchedHeaded = false;
  /** The one headed co-engineer session — reused/focused, never duplicated. */
  #headedSessionId: string | null = null;

  constructor(options: CdpDriverServiceOptions = {}) {
    this.#baseUrl = options.baseUrl || this.#baseUrl;
    this.#probeExecutable = options.probeExecutable || probeExecutable;
    this.#launchBrowser = options.launchBrowser || launchBrowser;
  }

  async createSession(startUrl = "about:blank", headed = false): Promise<CdpSessionSummary> {
    await this.assertCdpAvailable(headed);

    const target = await this.createTarget(startUrl);
    const connection = new CdpConnection();
    await connection.connect(target.webSocketDebuggerUrl);

    await connection.send("Page.enable");
    await connection.send("Runtime.enable");
    await connection.send("DOM.enable");
    await connection.send("Network.enable");

    // Crisp preview frames: pin a stable logical viewport with a 2x device
    // scale factor so streamed screenshots are HiDPI instead of the headless
    // default stretched blurry across the stage. Env-tunable; best-effort
    // (non-page targets may reject the override).
    try {
      await connection.send("Emulation.setDeviceMetricsOverride", {
        width: Number(Deno.env.get("CDP_VIEWPORT_WIDTH")) || 1280,
        height: Number(Deno.env.get("CDP_VIEWPORT_HEIGHT")) || 800,
        deviceScaleFactor: Number(Deno.env.get("CDP_DEVICE_SCALE")) || 2,
        mobile: false,
      });
    } catch {
      // Keep the session usable at default metrics.
    }

    const sessionId = `cdp_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const summary: CdpSessionSummary = {
      sessionId,
      targetId: target.id,
      targetUrl: target.url,
      createdAt: now,
      lastActiveAt: now,
    };

    const state: CdpSessionState = {
      ...summary,
      connection,
      dialogPolicy: "dismiss",
      dialogListeners: new Set(),
    };

    // The driver is the SINGLE dialog responder for the session: an unanswered
    // JavaScript dialog freezes the page, which stalls every runner on it. A
    // second responder would race this one into "No dialog is showing" errors,
    // so consumers observe via onSessionDialog and never answer themselves.
    connection.on("Page.javascriptDialogOpening", (params) => {
      this.#handleDialogOpening(state, params);
    });

    this.#sessions.set(sessionId, state);

    return summary;
  }

  #handleDialogOpening(state: CdpSessionState, params: Record<string, unknown>): void {
    const dialogType = typeof params.type === "string" ? params.type : "alert";
    const { accept } = resolveDialogAction(dialogType, state.dialogPolicy);
    // Failures must never throw (an unhandled rejection here takes down the
    // process) but must never be silent either: if the answer genuinely
    // failed, the dialog may still be up — a frozen page with no diagnostic
    // trail is exactly the failure mode this feature exists to kill.
    const logAnswerFailure = (error: unknown) => {
      console.error(
        `[cdp] ${state.sessionId} dialog answer failed (${dialogType}):`,
        error instanceof Error ? error.message : String(error),
      );
    };
    try {
      state.connection.send("Page.handleJavaScriptDialog", {
        accept,
        ...(dialogType === "prompt" ? { promptText: "" } : {}),
      }).catch(logAnswerFailure);
    } catch (error) {
      // Socket closed between event and response.
      logAnswerFailure(error);
    }

    const occurrence: CdpDialogOccurrence = {
      at: new Date().toISOString(),
      url: typeof params.url === "string" ? params.url : state.targetUrl,
      dialogType,
      message: typeof params.message === "string" ? params.message : "",
      action: accept ? "accepted" : "dismissed",
    };
    for (const listener of [...state.dialogListeners]) {
      try {
        listener(occurrence);
      } catch {
        // Listener isolation mirrors CdpEventHub: observers cannot break us.
      }
    }
  }

  setSessionDialogPolicy(sessionId: string, policy: CdpDialogPolicy): void {
    this.getSession(sessionId).dialogPolicy = policy;
  }

  onSessionDialog(
    sessionId: string,
    listener: (occurrence: CdpDialogOccurrence) => void,
  ): () => void {
    const session = this.getSession(sessionId);
    session.dialogListeners.add(listener);
    return () => {
      session.dialogListeners.delete(listener);
    };
  }

  /** Generic protocol-event tap for a session (Network.*, Page.*, …). */
  onSessionCdpEvent(
    sessionId: string,
    method: string,
    handler: (params: Record<string, unknown>) => void,
  ): () => void {
    // The single-responder contract is enforced here, not by convention:
    // dialog events are observable only via onSessionDialog (notify-only), so
    // no second subscriber can ever answer a dialog and race the driver into
    // "No dialog is showing" errors.
    if (method === "Page.javascriptDialogOpening") {
      throw new AppError(
        "dialog_events_reserved: subscribe via onSessionDialog — the driver is the only responder",
        400,
        "dialog_events_reserved",
      );
    }
    return this.getSession(sessionId).connection.on(method, handler);
  }

  /**
   * Idempotent "Open Browser": the visible Chrome is the co-engineer surface,
   * so there is exactly one. If it is open with a live session, focus and
   * return it; if the user closed the window, relaunch; otherwise open it.
   */
  async openHeadedBrowser(startUrl = "about:blank"): Promise<CdpSessionSummary> {
    if (this.#headedSessionId && this.#launchedHeaded && this.#launchedBrowser) {
      const existing = this.#sessions.get(this.#headedSessionId);
      if (existing) {
        try {
          await existing.connection.send("Target.activateTarget", {
            targetId: existing.targetId,
          });
        } catch {
          // Focus is best-effort; the session is still the one to reuse.
        }
        return {
          sessionId: existing.sessionId,
          targetId: existing.targetId,
          targetUrl: existing.targetUrl,
          createdAt: existing.createdAt,
          lastActiveAt: existing.lastActiveAt,
        };
      }
    }
    const summary = await this.createSession(startUrl, true);
    this.#headedSessionId = summary.sessionId;
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

  async executeWorkUnit(
    sessionId: string,
    request: CdpWorkUnitRequest,
  ): Promise<CdpWorkUnitResult> {
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
        await this.navigate(
          session.connection,
          step.url,
          step.waitUntil || "load",
          step.timeoutMs || 15000,
        );
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
        return await this.assertSelectorText(
          session.connection,
          step.selector,
          step.includes,
          step.equals,
          step.timeoutMs || 10000,
        );
      case "extractText":
        await this.waitForSelector(session.connection, step.selector, step.timeoutMs || 10000);
        return await this.extractSelectorText(session.connection, step.selector);
      case "evaluate":
        return await this.evaluateExpression(
          session.connection,
          step.expression,
          step.returnByValue ?? true,
        );
      case "clickAt":
        return await this.clickAtPoint(session.connection, step.x, step.y);
      case "insertText":
        await session.connection.send("Input.insertText", { text: step.text });
        return { inserted: step.text.length };
      case "screenshot":
        return await this.captureScreenshot(session.connection, step.format || "png", step.quality);
      default:
        throw new AppError("unsupported_step_action", 400, "unsupported_step_action");
    }
  }

  private async assertCdpAvailable(headed = false): Promise<void> {
    const debugPort = this.resolveDebugPort();

    // A headed request must not silently reuse an already-running headless
    // browser we spawned — relaunch in the requested mode instead.
    if (
      await this.isCdpReachable() && !(headed && this.#launchedBrowser && !this.#launchedHeaded)
    ) {
      return;
    }

    const launchAttempt = await this.tryLaunchLocalBrowserForCdp(headed);
    if (headed && launchAttempt.reason === "headed_browser_not_found") {
      throw new AppError(
        "headed_unavailable",
        409,
        "headed_unavailable: no visible-browser executable here (containers have " +
          "only headless-shell). Run capillary bare-metal, or start Chrome on the " +
          "host with --remote-debugging-port and point CDP_BASE_URL at it.",
      );
    }
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
      return url.hostname === "127.0.0.1" || url.hostname === "localhost" ||
        url.hostname === "0.0.0.0";
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

  private async tryLaunchLocalBrowserForCdp(
    headed = false,
  ): Promise<{ launched: boolean; reason?: string }> {
    if (!this.isLocalBaseUrl()) {
      return { launched: false };
    }
    // Resolve the executable BEFORE touching any running browser: killing the
    // healthy headless instance and then discovering no headed Chrome exists
    // left CDP dead and every subsequent launch 5xx-ing. Never destroy a
    // working browser for a replacement that cannot start.
    const executablePath = await resolveChromeExecutablePath(
      this.#probeExecutable,
      undefined,
      { excludeHeadlessShell: headed },
    );
    if (!executablePath) {
      return {
        launched: false,
        reason: headed ? "headed_browser_not_found" : "browser_not_found",
      };
    }

    if (this.#launchedBrowser) {
      if (this.#launchedHeaded === headed) {
        return { launched: false };
      }
      // Mode switch requested and the replacement is confirmed launchable:
      // retire the spawned browser and relaunch.
      try {
        this.#launchedBrowser.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      this.#launchedBrowser = null;
      await this.sleep(400);
    }

    const debugPort = this.resolveDebugPort();
    const userDataDir = Deno.env.get("CDP_USER_DATA_DIR") || `/tmp/capillary-cdp-${debugPort}`;
    // Extra operator-set launch flags, e.g. the container image sets
    // CDP_LAUNCH_FLAGS="--headless=new --no-sandbox --disable-gpu
    // --disable-dev-shm-usage" — headless Chromium cannot start in a
    // non-root container without them. Unset for local headed driving.
    const extraFlags = (Deno.env.get("CDP_LAUNCH_FLAGS") || "")
      .split(/\s+/)
      .filter((flag) => flag.length > 0)
      // Headed launch: strip operator-set headless flags so the actual
      // browser window opens (bare-metal / host-CDP setups; a display-less
      // container will simply fail to launch and report cdp_unavailable).
      .filter((flag) => !headed || !flag.startsWith("--headless"));
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
      const child = this.#launchBrowser(executablePath, args);
      this.#launchedBrowser = child;
      this.#launchedHeaded = headed;
      // Track the browser's real lifetime: when the user closes the headed
      // window (process exits), forget it so the next Open click relaunches
      // instead of talking to a corpse.
      child.status.then(() => {
        if (this.#launchedBrowser === child) {
          this.#launchedBrowser = null;
          this.#headedSessionId = null;
        }
      }).catch(() => {});
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
    if (!(await this.landedOnErrorPage(connection))) {
      return;
    }

    // Chrome lands on chrome-error://chromewebdata/ when the target could
    // not be loaded. Inside a container the overwhelmingly common cause is
    // a loopback URL that means "the host" to the user but "this container"
    // to the browser — so retry once with the host gateway swapped in. On
    // bare metal host.docker.internal simply doesn't resolve and the retry
    // fails in milliseconds, so no environment detection is needed.
    const rewritten = rewriteLoopbackToHostGateway(url);
    if (rewritten) {
      await connection.send("Page.navigate", { url: rewritten });
      await this.waitForDocumentReady(connection, waitUntil, timeoutMs);
      if (!(await this.landedOnErrorPage(connection))) {
        console.log(`[cdp] ${url} unreachable from browser context; rewrote to ${rewritten}`);
        return;
      }
    }

    throw new AppError(
      "navigation_unreachable",
      502,
      `navigation_unreachable: target did not load` +
        (rewritten ? ` (tried ${url} and ${rewritten})` : ` (${url})`),
    );
  }

  private async landedOnErrorPage(connection: CdpConnection): Promise<boolean> {
    const landedUrl = await this.evaluateExpression(connection, "location.href", true);
    return typeof landedUrl === "string" && landedUrl.startsWith("chrome-error://");
  }

  private async waitForDocumentReady(
    connection: CdpConnection,
    waitUntil: CdpWaitUntil,
    timeoutMs: number,
  ): Promise<void> {
    const expectedState = waitUntil === "domcontentloaded"
      ? ["interactive", "complete"]
      : ["complete"];

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
    timeoutMs = 10000,
  ): Promise<{ selector: string; text: string }> {
    // Poll until the condition holds or the budget runs out: an element can
    // exist (waitForSelector passed) while the framework is still rendering
    // its text — a one-shot read produces false negatives against SPAs.
    const start = Date.now();
    let text = "";
    // Whitespace-normalized comparison on BOTH sides: the observation's
    // visibleText (what a planner quotes its expectation from) collapses
    // whitespace, while raw innerText carries newlines between the very same
    // words — so a byte-wise includes() failed on text that was visibly,
    // verbatim present. Caught by capillary functionally testing itself.
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    const wantIncludes = typeof includes === "string" ? normalize(includes) : undefined;
    const wantEquals = typeof equals === "string" ? normalize(equals) : undefined;
    while (true) {
      text = await this.extractSelectorText(connection, selector);
      const got = normalize(text);
      const equalsOk = wantEquals === undefined || got === wantEquals;
      const includesOk = wantIncludes === undefined || got.includes(wantIncludes);
      if (equalsOk && includesOk) {
        return { selector, text };
      }
      if (Date.now() - start >= timeoutMs) {
        break;
      }
      await this.sleep(150);
    }

    // Diagnostic failures: name what was expected and show what was actually
    // there, so a failed assert is a lead instead of a dead end.
    const excerpt = normalize(text).slice(0, 160);
    if (wantEquals !== undefined && normalize(text) !== wantEquals) {
      throw new AppError(
        `assert_text_failed_equals: ${selector} — expected "${wantEquals}", got "${excerpt}"`,
        409,
        "assert_text_failed",
      );
    }
    throw new AppError(
      `assert_text_failed_includes: ${selector} — expected to include "${wantIncludes}", got "${excerpt}"`,
      409,
      "assert_text_failed",
    );
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
      const details = payload.exceptionDetails.exception?.description ||
        payload.exceptionDetails.text || "evaluation_error";
      throw new AppError(details, 400, "evaluation_error");
    }

    return payload.result.value;
  }

  /** Real mouse click at viewport coordinates (pressed + released). */
  private async clickAtPoint(
    connection: CdpConnection,
    x: number,
    y: number,
  ): Promise<{ clicked: { x: number; y: number } }> {
    const base = { x, y, button: "left", clickCount: 1 } as const;
    await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    return { clicked: { x, y } };
  }

  private async captureScreenshot(
    connection: CdpConnection,
    format: "png" | "jpeg",
    quality?: number,
  ): Promise<{ format: string; dataBase64: string }> {
    // Force HiDPI at capture time: a clip with an explicit scale renders the
    // viewport at 2x regardless of whether the emulation override stuck —
    // the override-only approach still produced mushy frames on some targets.
    const scale = Number(Deno.env.get("CDP_DEVICE_SCALE")) || 2;
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    try {
      const metrics = await connection.send<{
        cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
        layoutViewport?: { clientWidth?: number; clientHeight?: number };
      }>("Page.getLayoutMetrics", {});
      const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport;
      if (viewport?.clientWidth && viewport?.clientHeight) {
        clip = { x: 0, y: 0, width: viewport.clientWidth, height: viewport.clientHeight, scale };
      }
    } catch {
      // Fall back to the plain capture below.
    }
    const payload = await connection.send<{ data: string }>("Page.captureScreenshot", {
      format,
      quality: format === "jpeg" ? quality || 80 : undefined,
      ...(clip ? { clip, captureBeyondViewport: false } : { captureBeyondViewport: true }),
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

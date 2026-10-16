// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
// proc.ts — the child-process edge.
//
// A small, Deno.Command-shaped facade over node:child_process. Call sites keep
// the web-stream idiom they were written against (stdin as a WritableStream,
// stdout/stderr as ReadableStreams, `status` as a promise) so the port is a
// rename, not a rewrite. Two Deno semantics are preserved deliberately:
//
// - `spawn()` throws synchronously when the program cannot be found, so the
//   candidate loops in the CDP and codex transports keep working unchanged.
//   (Node reports ENOENT asynchronously; we resolve the binary up front.)
// - `env` is merged onto the parent environment unless `clearEnv` is set.

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess as NodeChild, StdioOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";

export type Stdio = "piped" | "inherit" | "null";

export interface CommandOptions {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  clearEnv?: boolean;
  stdin?: Stdio;
  stdout?: Stdio;
  stderr?: Stdio;
}

export interface CommandStatus {
  success: boolean;
  code: number;
  signal: NodeJS.Signals | null;
}

export interface CommandOutput extends CommandStatus {
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface ChildProcess {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<CommandStatus>;
  kill(signal?: NodeJS.Signals): void;
  output(): Promise<CommandOutput>;
}

export class CommandNotFoundError extends Error {
  readonly code = "ENOENT";
  constructor(program: string) {
    super(`Failed to spawn '${program}': No such file or directory (os error 2)`);
    this.name = "NotFound";
  }
}

const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a program the way execvp would, or null when it cannot run. */
export function resolveProgram(program: string, env: NodeJS.ProcessEnv): string | null {
  if (program.includes("/")) {
    return isExecutable(program) ? program : null;
  }
  const dirs = (env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    const candidate = isAbsolute(dir) ? join(dir, program) : join(process.cwd(), dir, program);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function stdioOf(mode: Stdio | undefined, fallback: Stdio): "pipe" | "inherit" | "ignore" {
  const resolved = mode ?? fallback;
  return resolved === "piped" ? "pipe" : resolved === "inherit" ? "inherit" : "ignore";
}

function unavailable(name: string): never {
  throw new TypeError(`Cannot access '${name}': it was not set to "piped"`);
}

function statusOf(child: NodeChild): Promise<CommandStatus> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const signalCode = signal ? 128 + (SIGNAL_NUMBERS[signal] ?? 0) : 0;
      const exit = code ?? signalCode;
      resolve({ success: exit === 0 && signal === null, code: exit, signal });
    });
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function wrap(child: NodeChild): ChildProcess {
  const stdin = child.stdin ? Writable.toWeb(child.stdin) as WritableStream<Uint8Array> : null;
  const stdout = child.stdout
    ? Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    : null;
  const stderr = child.stderr
    ? Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>
    : null;
  const status = statusOf(child);
  // A late spawn failure (e.g. EACCES) rejects `status`; observers decide.
  status.catch(() => {});

  return {
    pid: child.pid ?? 0,
    get stdin() {
      return stdin ?? unavailable("stdin");
    },
    get stdout() {
      return stdout ?? unavailable("stdout");
    },
    get stderr() {
      return stderr ?? unavailable("stderr");
    },
    status,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      child.kill(signal);
    },
    async output() {
      const [out, err, result] = await Promise.all([
        stdout ? collect(stdout) : Promise.resolve(new Uint8Array(0)),
        stderr ? collect(stderr) : Promise.resolve(new Uint8Array(0)),
        status,
      ]);
      return { ...result, stdout: out, stderr: err };
    },
  };
}

export class Command {
  readonly #program: string;
  readonly #options: CommandOptions;

  constructor(program: string | URL, options: CommandOptions = {}) {
    this.#program = program instanceof URL ? program.pathname : program;
    this.#options = options;
  }

  spawn(): ChildProcess {
    const options = this.#options;
    const env = options.clearEnv
      ? { ...(options.env ?? {}) }
      : { ...process.env, ...(options.env ?? {}) };
    const resolved = resolveProgram(this.#program, env.PATH === undefined ? process.env : env);
    if (!resolved) {
      throw new CommandNotFoundError(this.#program);
    }
    // Deno defaults for spawn(): every stream inherits unless told otherwise.
    const stdio: StdioOptions = [
      stdioOf(options.stdin, "inherit"),
      stdioOf(options.stdout, "inherit"),
      stdioOf(options.stderr, "inherit"),
    ];
    return wrap(nodeSpawn(resolved, options.args ?? [], { cwd: options.cwd, env, stdio }));
  }

  /** Spawn, wait, and collect output (Deno's `Command.output()`). */
  output(): Promise<CommandOutput> {
    const options = this.#options;
    return new Command(this.#program, {
      ...options,
      stdin: options.stdin ?? "null",
      stdout: options.stdout ?? "piped",
      stderr: options.stderr ?? "piped",
    }).spawn().output();
  }
}

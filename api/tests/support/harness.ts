// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
// harness.ts — the test vocabulary the suite is written in, on node:test.
//
// `test` accepts both registration shapes the suite uses — `test(name, fn)`
// and `test({ name, ignore, fn })` — and the assertions keep their
// @std/assert signatures, so test bodies read exactly as before. Deno's
// resource/op sanitizer flags are accepted and ignored: node:test has no
// equivalent, and every test that set them opted out anyway.

import { strict as nodeAssert } from "node:assert";
import { test as nodeTest } from "node:test";

type TestFn = () => void | Promise<void>;

export interface TestDefinition {
  name: string;
  fn: TestFn;
  ignore?: boolean;
  only?: boolean;
  sanitizeOps?: boolean;
  sanitizeResources?: boolean;
  sanitizeExit?: boolean;
}

export function test(name: string, fn: TestFn): void;
export function test(definition: TestDefinition): void;
export function test(nameOrDefinition: string | TestDefinition, maybeFn?: TestFn): void {
  if (typeof nameOrDefinition === "string") {
    nodeTest(nameOrDefinition, () => maybeFn!());
    return;
  }
  const { name, fn, ignore, only } = nameOrDefinition;
  nodeTest(name, { skip: ignore === true, only: only === true }, () => fn());
}

export class AssertionError extends Error {
  override name = "AssertionError";
}

export function assert(expr: unknown, msg = ""): asserts expr {
  if (!expr) {
    throw new AssertionError(msg || "Expected actual: \"" + String(expr) + "\" to be truthy.");
  }
}

export function assertEquals<T>(actual: unknown, expected: T, msg?: string): asserts actual is T {
  nodeAssert.deepStrictEqual(actual, expected, msg);
}

// deno-style: (fn, ErrorClass?, msgIncludes?, msg?) or (fn, msg?)
type ErrorClass<E extends Error> = abstract new (...args: never[]) => E;

function checkError<E extends Error>(
  error: unknown,
  ErrorType?: ErrorClass<E>,
  msgIncludes?: string,
): E {
  if (ErrorType && !(error instanceof ErrorType)) {
    throw new AssertionError(
      `Expected error to be instance of "${ErrorType.name}", but was "${
        (error as Error)?.constructor?.name
      }".`,
    );
  }
  if (msgIncludes !== undefined) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(msgIncludes)) {
      throw new AssertionError(
        `Expected error message to include "${msgIncludes}", but got "${message}".`,
      );
    }
  }
  return error as E;
}

export function assertThrows<E extends Error = Error>(
  fn: () => unknown,
  ErrorTypeOrMsg?: ErrorClass<E> | string,
  msgIncludes?: string,
): E {
  try {
    fn();
  } catch (error) {
    if (typeof ErrorTypeOrMsg === "string") return error as E;
    return checkError(error, ErrorTypeOrMsg, msgIncludes);
  }
  throw new AssertionError(
    typeof ErrorTypeOrMsg === "string" ? ErrorTypeOrMsg : "Expected function to throw.",
  );
}

export async function assertRejects<E extends Error = Error>(
  fn: () => PromiseLike<unknown>,
  ErrorTypeOrMsg?: ErrorClass<E> | string,
  msgIncludes?: string,
): Promise<E> {
  try {
    await fn();
  } catch (error) {
    if (typeof ErrorTypeOrMsg === "string") return error as E;
    return checkError(error, ErrorTypeOrMsg, msgIncludes);
  }
  throw new AssertionError(
    typeof ErrorTypeOrMsg === "string"
      ? ErrorTypeOrMsg
      : "Expected function to reject.",
  );
}

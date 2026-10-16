// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { AppError } from "../domain/errors.ts";

export function rejectEmptyInput(value: string, fieldName: string): void {
  if (!value || value.trim().length === 0) {
    throw new AppError(`${fieldName} is required`, 400, `invalid_${fieldName}`);
  }
}

export function rejectPathTraversal(value: string, fieldName: string): void {
  if (value.includes("..") || value.includes("~") || value.includes("\\")) {
    throw new AppError(`${fieldName} contains invalid path traversal`, 400, `invalid_${fieldName}`);
  }
}

export function rejectControlCharacters(value: string, fieldName: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      throw new AppError(`${fieldName} contains control characters`, 400, `invalid_${fieldName}`);
    }
  }
}

export function rejectOversizedInput(value: string, fieldName: string, maxLength = 256): void {
  if (value.length > maxLength) {
    throw new AppError(`${fieldName} exceeds max length`, 400, `invalid_${fieldName}`);
  }
}

export function enforceDefensiveInput(value: string, fieldName: string): void {
  rejectEmptyInput(value, fieldName);
  rejectPathTraversal(value, fieldName);
  rejectControlCharacters(value, fieldName);
  rejectOversizedInput(value, fieldName);
}

/**
 * Validate free-text bodies (markdown comments, suggestion notes). Unlike
 * enforceDefensiveInput this permits the whitespace that real text contains —
 * tab, newline, carriage return — and only rejects genuinely dangerous
 * control characters. Sized for GitHub's comment limit.
 */
export function enforceTextBody(value: string, fieldName: string, maxLength = 65_536): void {
  rejectEmptyInput(value, fieldName);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isAllowedWhitespace = code === 9 || code === 10 || code === 13;
    if ((code < 32 && !isAllowedWhitespace) || code === 127) {
      throw new AppError(`${fieldName} contains control characters`, 400, `invalid_${fieldName}`);
    }
  }
  rejectOversizedInput(value, fieldName, maxLength);
}

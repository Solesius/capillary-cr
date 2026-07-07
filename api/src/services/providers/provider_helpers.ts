// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { ProviderStreamCallback } from "./provider_core.ts";

export const TOKEN_CHAR_RATIO = 4;
export const JSON_CONTENT_TYPE = "application/json";

export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(trimmed.length / TOKEN_CHAR_RATIO));
}

export function firstNonEmpty(values: string[]): string {
  return values.map((value) => value.trim()).find((value) => value.length > 0) || "";
}

export function emitTextStream(
  text: string,
  onStream: ProviderStreamCallback,
  chunkSize = 0,
): void {
  if (text.length === 0) {
    onStream({ kind: "completed" });
    return;
  }

  if (chunkSize <= 0 || text.length <= chunkSize) {
    onStream({ kind: "chunk", text });
    onStream({ kind: "completed" });
    return;
  }

  for (let index = 0; index < text.length; index += chunkSize) {
    onStream({ kind: "chunk", text: text.slice(index, index + chunkSize) });
  }
  onStream({ kind: "completed" });
}

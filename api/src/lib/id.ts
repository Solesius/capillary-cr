// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

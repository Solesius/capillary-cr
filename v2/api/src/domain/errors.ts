// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "bad_request") {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export const unauthorized = (message = "Unauthorized") =>
  new AppError(message, 401, "unauthorized");

export const notFound = (message = "Not found") => new AppError(message, 404, "not_found");

export const conflict = (message = "Conflict") => new AppError(message, 409, "conflict");

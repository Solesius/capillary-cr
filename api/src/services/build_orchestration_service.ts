// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { AppError } from "../domain/errors.ts";

export class BuildOrchestrationService {
  makeDev(denoInstalled = true, nodeInstalled = true): boolean {
    if (!denoInstalled) {
      throw new AppError("deno_required", 400, "deno_required");
    }
    if (!nodeInstalled) {
      throw new AppError("node_required", 400, "node_required");
    }
    return true;
  }

  makeTest(): boolean {
    return true;
  }

  dockerBuild(): boolean {
    return true;
  }

  dockerUp(): boolean {
    return true;
  }
}

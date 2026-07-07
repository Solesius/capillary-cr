// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { ReviewRepository } from "../repositories/review_repository.ts";

export class ClickClackCoordinationService {
  constructor(private readonly repository: ReviewRepository) {}

  announceReviewRun(runId: string): boolean {
    this.repository.appendReviewEvent(runId, "click_clack:announced");
    return true;
  }

  recordReviewProgress(runId: string, phase: string): boolean {
    this.repository.appendReviewEvent(runId, `phase:${phase}`);
    return true;
  }

  completeReviewRun(runId: string): boolean {
    this.repository.appendReviewEvent(runId, "click_clack:completed");
    return true;
  }
}

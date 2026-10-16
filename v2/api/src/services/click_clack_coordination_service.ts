// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { type ReviewRepository } from "../repositories/review_repository.ts";

export class ClickClackCoordinationService {
  private readonly repository: ReviewRepository;
  constructor(repository: ReviewRepository) {
    this.repository = repository;
  }

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

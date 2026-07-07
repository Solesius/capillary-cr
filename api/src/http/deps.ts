// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { InMemoryReviewRepository } from "../repositories/review_repository.ts";
import { ArtifactService } from "../services/artifact_service.ts";
import { CdpDriverService } from "../services/cdp_driver_service.ts";
import { ClickClackCoordinationService } from "../services/click_clack_coordination_service.ts";
import { DiffDagService } from "../services/diff_dag_service.ts";
import { GitHubOakService } from "../services/github_service.ts";
import { GraphMathService } from "../services/graph_math_service.ts";
import { LlmProviderService } from "../services/llm_provider_service.ts";
import { CdpRetvAgentService } from "../services/cdp_retv_agent_service.ts";
import { AgenticReviewService } from "../services/agentic_review_orchestrator_service.ts";
import { TcsrctReviewService } from "../services/tcsrct_review_service.ts";
import { DurableReviewStore } from "../services/storage/celer_review_store.ts";

const repository = new InMemoryReviewRepository();

// Opt-in durable storage: when CAPILLARY_STORAGE_DIR is set and the celer-mem
// native library is available, mirror review artifacts to disk and replay them
// on boot. Otherwise run purely in-memory (graceful fallback).
const storageDir = Deno.env.get("CAPILLARY_STORAGE_DIR");
if (storageDir) {
  const durable = await DurableReviewStore.tryOpen({ path: storageDir });
  if (durable) {
    await repository.attachDurableStore(durable);
    console.log(`durable review storage enabled at ${storageDir}`);
  } else {
    console.warn("CAPILLARY_STORAGE_DIR set but celer-mem native storage is unavailable; using in-memory store");
  }
}

const graphMath = new GraphMathService();
const diffDagService = new DiffDagService(repository, graphMath);
const tcsrctService = new TcsrctReviewService(repository);
const artifactService = new ArtifactService(repository);
const clickClackService = new ClickClackCoordinationService(repository);
const githubService = new GitHubOakService(repository);
const llmProviderService = new LlmProviderService(repository);
const reviewService = new AgenticReviewService(
  repository,
  clickClackService,
  diffDagService,
  githubService,
  tcsrctService,
  artifactService,
  llmProviderService,
);
const cdpDriverService = new CdpDriverService();
const cdpRetvAgentService = new CdpRetvAgentService(repository, cdpDriverService);

export const deps = {
  repository,
  githubService,
  reviewService,
  artifactService,
  cdpDriverService,
  cdpRetvAgentService,
  llmProviderService,
};

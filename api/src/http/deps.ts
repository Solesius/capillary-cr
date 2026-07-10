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
import { ReviewSessionHub } from "../services/review_session_hub.ts";
import { TcsrctReviewService } from "../services/tcsrct_review_service.ts";
import { DurableReviewStore } from "../services/storage/celer_review_store.ts";

const repository = new InMemoryReviewRepository();

// Opt-in durable storage: when CAPILLARY_STORAGE_DIR is set and the celer-mem
// native library is available, mirror review artifacts to disk and replay them
// on boot. Otherwise run purely in-memory (graceful fallback).
const storageDir = Deno.env.get("CAPILLARY_STORAGE_DIR");
if (storageDir) {
  // One retry: opening an existing database can transiently fail right at
  // boot (e.g. WAL recovery after an unclean container stop) and a single
  // miss must not silently demote the process to in-memory for its lifetime.
  let durable = await DurableReviewStore.tryOpen({ path: storageDir });
  if (!durable) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    durable = await DurableReviewStore.tryOpen({ path: storageDir });
  }
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

// Connect a GitHub identity at boot from an env token when present. A PAT
// (classic with repo scope, or fine-grained scoped to the org) surfaces org
// and private repos that device flow against the built-in OAuth app cannot —
// so a containerized deploy with CAPILLARY_GITHUB_TOKEN set just works, no
// UI login step.
if (Deno.env.get("CAPILLARY_GITHUB_TOKEN")?.trim() || Deno.env.get("GITHUB_TOKEN")?.trim()) {
  try {
    const identity = await githubService.connectGithub("valid");
    console.log(`GitHub identity connected from environment token: ${identity.login}`);
  } catch {
    console.warn("CAPILLARY_GITHUB_TOKEN/GITHUB_TOKEN set but GitHub connection failed; connect via the UI.");
  }
}

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
// Durable review sessions: runs execute detached from any client connection;
// browsers, the CLI, and agents attach for a full replay + live tail.
const reviewSessionHub = new ReviewSessionHub((request, onEvent) =>
  reviewService.runReviewStream(request, onEvent)
);

export const deps = {
  repository,
  githubService,
  reviewService,
  reviewSessionHub,
  artifactService,
  cdpDriverService,
  cdpRetvAgentService,
  llmProviderService,
};

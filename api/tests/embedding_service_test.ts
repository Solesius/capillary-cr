// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { assertEquals } from "jsr:@std/assert";
import {
  cosineSimilarity,
  FileEmbeddingProvider,
  FileForEmbedding,
  MiniLmEmbeddingService,
  semanticNeighbors,
} from "../src/services/embedding_service.ts";

// Deterministic fake provider: no model download, exercises the neighbor
// logic (ranking, floor, k-cap, empty-vector handling) hermetically.
function fakeProvider(assignments: Record<string, number[]>): FileEmbeddingProvider {
  return {
    embed(files: FileForEmbedding[]) {
      const vectors = new Map<string, Float32Array>();
      for (const file of files) {
        const raw = assignments[file.path] ?? [];
        const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
        vectors.set(file.path, Float32Array.from(raw.map((v) => v / norm)));
      }
      return Promise.resolve(vectors);
    },
  };
}

Deno.test("should_rank_neighbors_by_cosine_with_floor_and_cap", async () => {
  const provider = fakeProvider({
    "auth_service.ts": [1, 0.9, 0],
    "auth_middleware.ts": [0.9, 1, 0],
    "torus_math.ts": [0, 0.1, 1],
    "empty.ts": [],
  });
  const files = ["auth_service.ts", "auth_middleware.ts", "torus_math.ts", "empty.ts"]
    .map((path) => ({ path, content: "" }));

  const neighbors = await semanticNeighbors(provider, files, 2, 0.3);

  const forService = neighbors.get("auth_service.ts")!;
  assertEquals(forService[0].path, "auth_middleware.ts");
  assertEquals(forService.every((n) => n.similarity >= 0.3), true);
  assertEquals(forService.length <= 2, true);
  for (let i = 1; i < forService.length; i++) {
    assertEquals(forService[i - 1].similarity >= forService[i].similarity, true);
  }

  // Empty embedding: no neighbors, no NaNs.
  assertEquals(neighbors.get("empty.ts")!.length, 0);
});

Deno.test("should_compute_unit_cosine_for_identical_vectors", () => {
  const v = Float32Array.from([0.6, 0.8]);
  assertEquals(Math.abs(cosineSimilarity(v, v) - 1) < 1e-6, true);
});

// Real-model integration test: downloads the quantized MiniLM on first run
// (~30MB, cached afterwards), so it is opt-in. Run with:
//   CAPILLARY_EMBEDDING_TESTS=1 deno test --allow-all tests/embedding_service_test.ts
Deno.test({
  name: "should_embed_real_files_with_minilm_and_cluster_by_meaning",
  ignore: Deno.env.get("CAPILLARY_EMBEDDING_TESTS") !== "1",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const service = new MiniLmEmbeddingService();
    const files: FileForEmbedding[] = [
      {
        path: "auth_token_service.ts",
        content: "export class AuthTokenService { refreshAccessToken(refreshToken) { /* oauth */ } }",
      },
      {
        path: "auth_middleware.ts",
        content: "export function requireAccessToken(ctx) { validate bearer authorization header token }",
      },
      {
        path: "torus_math.ts",
        content: "export function geodesicTorsion(theta, alpha) { return curvature * Math.sin(alpha) * Math.cos(alpha); }",
      },
    ];

    const vectors = await service.embed(files);
    assertEquals(vectors.size, 3);
    assertEquals(vectors.get("auth_token_service.ts")!.length > 0, true);

    const authPair = cosineSimilarity(
      vectors.get("auth_token_service.ts")!,
      vectors.get("auth_middleware.ts")!,
    );
    const crossPair = cosineSimilarity(
      vectors.get("auth_token_service.ts")!,
      vectors.get("torus_math.ts")!,
    );
    assertEquals(authPair > crossPair, true);
  },
});

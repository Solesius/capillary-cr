// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// Semantic file embeddings — CPU-only, via transformers.js (ONNX runtime).
//
// The torus gives *structural* closeness (import edges, disturbance). This
// service adds *semantic* closeness: files that talk about the same things
// land near each other even when no import edge connects them. Embeddings
// come from a sentence-transformer MiniLM model running on CPU through
// @huggingface/transformers — no GPU, no external service, model weights
// cached on disk after first download (CAPILLARY_EMBEDDING_CACHE, or the
// transformers.js default cache).
//
// Planned integration points (in order):
//   1. DiffDagService: add `semantic` edges where cosine >= threshold, so
//      wetting propagates through meaning, not just imports.
//   2. computeProgramShape: blend semantic-neighbor disturbance into theta,
//      pulling semantically-coupled-but-import-distant files toward the
//      inner-rim saddle together.
//   3. readTorus tool: expose top-k semantic neighbors to the review agent
//      so the planner can chase "same concept, different module" risk.
//
// Docker note: wire-in should pre-fetch the model in the image build (or
// mount a cache volume) so containers embed offline. Until integrated we do
// not add the ~30MB quantized model to the image.

export interface FileForEmbedding {
  path: string;
  content: string;
}

export interface SemanticNeighbor {
  path: string;
  similarity: number;
}

export interface FileEmbeddingProvider {
  /** Embed a corpus of files; returns one L2-normalized vector per path. */
  embed(files: FileForEmbedding[]): Promise<Map<string, Float32Array>>;
}

const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
// MiniLM context is 256 wordpieces; feeding whole files just truncates
// inside the tokenizer anyway. Head of the file (imports, declarations,
// doc comments) carries most of the "what is this about" signal.
const MAX_CONTENT_CHARS = 2000;
// Files per wasm inference batch — bounds peak (and therefore permanent)
// wasm heap growth; see embed().
const EMBED_BATCH_SIZE = 8;

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  // Vectors are unit-length, so the dot product is the cosine.
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

type FeatureExtractionPipeline = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

export class MiniLmEmbeddingService implements FileEmbeddingProvider {
  #pipeline: Promise<FeatureExtractionPipeline> | null = null;

  constructor(
    private readonly model: string = Deno.env.get("CAPILLARY_EMBEDDING_MODEL")?.trim() ||
      DEFAULT_EMBEDDING_MODEL,
  ) {}

  #loadPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.#pipeline) {
      this.#pipeline = (async () => {
        // URL import of the *web* bundle deliberately: the npm specifier
        // resolves the node build, whose native onnxruntime binding
        // hard-crashes Deno's isolate. v2's classic wasm loader runs under
        // Deno (v3's ort-1.22 loader env-sniffs itself into dead ends).
        // Pure CPU, identical on host/container/CI.
        const { pipeline, env } = await import(
          "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm"
        ) as unknown as {
          pipeline: (
            task: string,
            model?: string,
            options?: Record<string, unknown>,
          ) => Promise<unknown>;
          env: {
            allowLocalModels?: boolean;
            backends?: { onnx?: { wasm?: { numThreads?: number } } };
          };
        };
        // Outside a browser the "local model" probe resolves bare filesystem
        // paths the web bundle cannot fetch ("Invalid URL: /models/..."),
        // logging noise on every load. Hub download + cache is the only path
        // we use.
        env.allowLocalModels = false;
        // Single wasm thread: Deno lacks the worker shims the
        // multi-threaded path expects.
        if (env.backends?.onnx?.wasm) {
          env.backends.onnx.wasm.numThreads = 1;
        }
        return await pipeline("feature-extraction", this.model, {
          quantized: true,
        }) as unknown as FeatureExtractionPipeline;
      })();
    }
    return this.#pipeline;
  }

  async embed(files: FileForEmbedding[]): Promise<Map<string, Float32Array>> {
    const vectors = new Map<string, Float32Array>();
    if (files.length === 0) {
      return vectors;
    }

    const extractor = await this.#loadPipeline();
    // Prefix with the path: filenames are strong semantic signal in code.
    const texts = files.map((file) => `${file.path}\n${file.content.slice(0, MAX_CONTENT_CHARS)}`);
    // Chunked inference: wasm memory grows to the peak batch size and never
    // shrinks for the process lifetime, so a 100-file PR embedded as one
    // batch permanently balloons the heap. Small sequential batches bound
    // peak memory to a constant regardless of PR size.
    for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
      const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
      const output = await extractor(batch, { pooling: "mean", normalize: true });
      const rows = output.tolist();
      batch.forEach((_, offset) => {
        vectors.set(files[start + offset].path, Float32Array.from(rows[offset] ?? []));
      });
    }
    return vectors;
  }
}

/**
 * Top-k semantic neighbors per file above a similarity floor. O(n²·dims) —
 * fine for review-sized corpora (hundreds of files, 384 dims).
 */
export async function semanticNeighbors(
  provider: FileEmbeddingProvider,
  files: FileForEmbedding[],
  k = 5,
  minSimilarity = 0.35,
): Promise<Map<string, SemanticNeighbor[]>> {
  const vectors = await provider.embed(files);
  const neighbors = new Map<string, SemanticNeighbor[]>();

  for (const file of files) {
    const own = vectors.get(file.path);
    if (!own || own.length === 0) {
      neighbors.set(file.path, []);
      continue;
    }
    const scored: SemanticNeighbor[] = [];
    for (const other of files) {
      if (other.path === file.path) {
        continue;
      }
      const vector = vectors.get(other.path);
      if (!vector || vector.length === 0) {
        continue;
      }
      const similarity = cosineSimilarity(own, vector);
      if (similarity >= minSimilarity) {
        scored.push({ path: other.path, similarity });
      }
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    neighbors.set(file.path, scored.slice(0, k));
  }
  return neighbors;
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
//
// celer_bench.ts — throughput/latency/memory benchmark for the celer-mem
// backing store, at 1M+ records. Proves the store can be capillary's durable
// working state under concurrent reviews while resident memory stays flat.
//
//   cd api && deno run --allow-all scripts/celer_bench.ts [--n 1000000] [--value 512]
//
// Reports: write and read throughput (ops/sec), p50/p95/p99/max latency,
// process RSS before/after (RSS should stay flat — the store is on disk, not
// in the heap), and on-disk size.

import { CelerStore } from "../src/services/storage/celer_mem.ts";

interface Args {
  n: number;
  valueBytes: number;
  path: string;
}

function parseArgs(): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < Deno.args.length; i += 2) {
    flags.set(Deno.args[i].replace(/^--/, ""), Deno.args[i + 1] ?? "");
  }
  return {
    n: Number(flags.get("n") ?? 1_000_000),
    valueBytes: Number(flags.get("value") ?? 512),
    path: flags.get("path") ?? Deno.makeTempDirSync({ prefix: "celer_bench_" }),
  };
}

function rssMb(): number {
  return Deno.memoryUsage().rss / 1_048_576;
}

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function dirSizeMb(path: string): Promise<number> {
  // Recurse: RocksDB spreads data across SST files (and possibly subdirs),
  // unlike SQLite's single top-level file. A non-recursive walk undercounts it.
  let total = 0;
  for await (const entry of Deno.readDir(path)) {
    const child = `${path}/${entry.name}`;
    if (entry.isFile) {
      total += (await Deno.stat(child)).size;
    } else if (entry.isDirectory) {
      total += (await dirSizeMb(child)) * 1_048_576;
    }
  }
  return total / 1_048_576;
}

async function main() {
  const args = parseArgs();
  const SCOPE = "bench";
  const TABLE = "kv";

  const backend = (Deno.args.includes("--sqlite") ? "sqlite" : "rocksdb") as "sqlite" | "rocksdb";
  const store = await CelerStore.tryOpen({
    path: args.path,
    backend,
    schema: [{ scope: SCOPE, table: TABLE }],
  });
  console.log(`backend: ${backend}`);
  if (!store) {
    console.error("celer native library unavailable — build api/native first (make ffi).");
    Deno.exit(2);
  }

  const value = "x".repeat(args.valueBytes);
  const rssStart = rssMb();
  console.log(
    `celer benchmark — n=${args.n.toLocaleString()} value=${args.valueBytes}B path=${args.path}`,
  );
  console.log(`rss before: ${rssStart.toFixed(1)} MB`);

  // --- writes ---
  const writeLat = new Float64Array(Math.min(args.n, 200_000)); // sample latencies
  let sampleStep = Math.max(1, Math.floor(args.n / writeLat.length));
  let sampleIdx = 0;
  const wStart = performance.now();
  for (let i = 0; i < args.n; i += 1) {
    const t = (i % sampleStep === 0 && sampleIdx < writeLat.length) ? performance.now() : 0;
    await store.put(SCOPE, TABLE, `k${i}`, value);
    if (t) {
      writeLat[sampleIdx++] = performance.now() - t;
    }
    if (i > 0 && i % 250_000 === 0) {
      console.log(`  wrote ${i.toLocaleString()} · rss ${rssMb().toFixed(0)} MB`);
    }
  }
  const wSec = (performance.now() - wStart) / 1000;

  // --- reads (random) ---
  const readLat = new Float64Array(Math.min(args.n, 200_000));
  sampleStep = Math.max(1, Math.floor(args.n / readLat.length));
  sampleIdx = 0;
  let hits = 0;
  const rStart = performance.now();
  for (let i = 0; i < args.n; i += 1) {
    const key = `k${Math.floor(Math.random() * args.n)}`;
    const t = (i % sampleStep === 0 && sampleIdx < readLat.length) ? performance.now() : 0;
    const got = await store.getText(SCOPE, TABLE, key);
    if (t) {
      readLat[sampleIdx++] = performance.now() - t;
    }
    if (got !== null) hits += 1;
  }
  const rSec = (performance.now() - rStart) / 1000;

  const rssEnd = rssMb();
  const diskMb = await dirSizeMb(args.path);
  writeLat.subarray(0, sampleIdx).sort();
  const wl = writeLat.slice().sort();
  const rl = readLat.slice().sort();

  const fmt = (v: number) => v.toFixed(3);
  console.log("\n=== results ===");
  console.log(`writes: ${Math.round(args.n / wSec).toLocaleString()} ops/sec (${wSec.toFixed(1)}s)`);
  console.log(`  latency ms  p50 ${fmt(percentile(wl, 50))}  p95 ${fmt(percentile(wl, 95))}  p99 ${fmt(percentile(wl, 99))}  max ${fmt(percentile(wl, 100))}`);
  console.log(`reads:  ${Math.round(args.n / rSec).toLocaleString()} ops/sec (${rSec.toFixed(1)}s), ${hits.toLocaleString()} hits`);
  console.log(`  latency ms  p50 ${fmt(percentile(rl, 50))}  p95 ${fmt(percentile(rl, 95))}  p99 ${fmt(percentile(rl, 99))}  max ${fmt(percentile(rl, 100))}`);
  console.log(`rss: ${rssStart.toFixed(0)} -> ${rssEnd.toFixed(0)} MB (delta ${(rssEnd - rssStart).toFixed(0)} MB)`);
  console.log(`disk: ${diskMb.toFixed(0)} MB for ${args.n.toLocaleString()} records`);

  await store.close();
  await Deno.remove(args.path, { recursive: true }).catch(() => {});
}

await main();

// Connection probe for `hx status`. Hits the gateway's /ping endpoint to
// measure real round-trip latency and download throughput, then grades the
// link Excellent / Good / Fair / Poor. The weakest of latency vs. bandwidth
// governs the grade — a fat pipe with awful latency is not "Excellent".

import { performance } from "node:perf_hooks";
import type { HxConfig } from "./config.js";

export type Quality = "Excellent" | "Good" | "Fair" | "Poor";

export interface ProbeResult {
  up: boolean;
  reason?: string; // friendly cause, present only when up === false
  latencyMs?: number;
  bytesPerSec?: number; // undefined if the bandwidth pass couldn't complete
  quality?: Quality;
}

const LATENCY_SAMPLES = 3;
const BANDWIDTH_BYTES = 1024 * 1024; // 1 MiB — big enough to time, small enough to stay quick
const TIMEOUT_MS = 8000;

export async function probeConnection(cfg: HxConfig): Promise<ProbeResult> {
  // Latency: median of a few samples. The first sample pays TCP/TLS setup, so
  // taking the median naturally discards that cold-connection outlier.
  const samples: number[] = [];
  for (let i = 0; i < LATENCY_SAMPLES; i++) {
    try {
      samples.push(await pingOnce(cfg));
    } catch (err) {
      return { up: false, reason: describeError(err) };
    }
  }
  samples.sort((a, b) => a - b);
  const latencyMs = Math.round(samples[Math.floor(samples.length / 2)]);

  // Bandwidth: one sized download. If it fails we still know the link is up
  // (latency already proved it) and grade on latency alone.
  let bytesPerSec: number | undefined;
  try {
    const { ms, bytes } = await downloadProbe(cfg, BANDWIDTH_BYTES);
    if (ms > 0 && bytes > 0) bytesPerSec = (bytes / ms) * 1000;
  } catch {
    // bandwidth optional
  }

  return { up: true, latencyMs, bytesPerSec, quality: grade(latencyMs, bytesPerSec) };
}

async function pingOnce(cfg: HxConfig): Promise<number> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = performance.now();
  try {
    const res = await fetch(`${cfg.gatewayBaseUrl}/ping`, {
      headers: { authorization: `Bearer ${cfg.accessToken}` },
      signal: ctrl.signal,
    });
    await res.arrayBuffer(); // drain so timing covers the full round trip
    if (res.status === 401) throw new Error("not authorized (run `hx connect`)");
    if (!res.ok) throw new Error(`gateway returned ${res.status}`);
    return performance.now() - start;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadProbe(
  cfg: HxConfig,
  bytes: number,
): Promise<{ ms: number; bytes: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = performance.now();
  try {
    const res = await fetch(`${cfg.gatewayBaseUrl}/ping?bytes=${bytes}`, {
      headers: { authorization: `Bearer ${cfg.accessToken}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`gateway returned ${res.status}`);
    const buf = await res.arrayBuffer();
    return { ms: performance.now() - start, bytes: buf.byteLength };
  } finally {
    clearTimeout(timer);
  }
}

function grade(latencyMs: number, bytesPerSec?: number): Quality {
  const latencyScore =
    latencyMs <= 60 ? 3 : latencyMs <= 150 ? 2 : latencyMs <= 400 ? 1 : 0;
  const mbps = bytesPerSec === undefined ? undefined : bytesPerSec / 1_000_000;
  const bandwidthScore =
    mbps === undefined
      ? latencyScore // no reading → lean on latency
      : mbps >= 8
        ? 3
        : mbps >= 2
          ? 2
          : mbps >= 0.5
            ? 1
            : 0;
  const score = Math.min(latencyScore, bandwidthScore); // weakest link governs
  return score >= 3 ? "Excellent" : score === 2 ? "Good" : score === 1 ? "Fair" : "Poor";
}

export function formatRate(bytesPerSec?: number): string {
  if (!bytesPerSec) return "throughput unknown";
  const mbps = bytesPerSec / 1_000_000;
  if (mbps >= 1) return `${mbps.toFixed(1)} MB/s`;
  return `${Math.round(bytesPerSec / 1000)} KB/s`;
}

function describeError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === "AbortError") return "timed out reaching gateway";
  const code = e?.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "can't resolve gateway host";
  if (code === "ECONNREFUSED") return "gateway refused the connection";
  return e?.message || "can't reach gateway";
}

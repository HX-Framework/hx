// Classifier golden (LETAIR-144 WS6, verification item 15): every new log
// line the perf work emits must classify as "info" in the HX Client UI — a
// healthy hourly summary rendering as a warning would train users to ignore
// warnings. classifyLogLine's warn/up patterns are content-sensitive
// (`failed=[1-9]`, `error`, `(+NB`, "unavailable", …), so the FORMAT itself
// is under test, across edge counter values.

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { classifyLogLine } from "./ui/data.js";
import { formatPerfLine, type PerfCounters } from "./watch.js";

const samples: Array<[string, PerfCounters]> = [
  ["idle hour", { passes: 2400, passMs: [1, 2, 3], uploads: 0, flushes: 0, sweeps: 60, hints: 0 }],
  ["busy hour", { passes: 2400, passMs: Array.from({ length: 500 }, (_, i) => i), uploads: 913, flushes: 720, sweeps: 60, hints: 4321 }],
  ["single pass", { passes: 1, passMs: [1234.7], uploads: 1, flushes: 1, sweeps: 1, hints: 0 }],
  // Counter values that would trip naive formats: a "failed=[1-9]"-shaped
  // number must never appear; uploads/flushes digits are safe by format.
  ["digit soup", { passes: 19, passMs: [9], uploads: 19, flushes: 91, sweeps: 19, hints: 91 }],
  // Polling (no file events): a sweep per pass.
  ["polling hour", { passes: 2400, passMs: [2], uploads: 0, flushes: 0, sweeps: 2400, hints: 0 }],
];

describe("formatPerfLine", () => {
  it("classifies as info for every sample (never warn/up)", () => {
    for (const [label, perf] of samples) {
      const line = formatPerfLine(perf);
      assert.equal(classifyLogLine(line), "info", `${label}: ${line}`);
    }
  });

  it("stays stable in shape (timestamp prefix added by the daemon logger)", () => {
    const line = formatPerfLine({ passes: 3, passMs: [5, 10, 20], uploads: 2, flushes: 1, sweeps: 1, hints: 4 });
    assert.match(line, /^\[hx\] perf: passes=3 passMs p50=\d+ p95=\d+ max=\d+ uploads=2 stateFlushes=1 sweeps=1 hints=4$/);
  });
});

describe("other new WS3/WS6 log lines", () => {
  it("the chunk-cap settled line classifies as info", () => {
    // Emitted once per destination when the growth probe learns a cap
    // (watch.ts). Growth is cloud-lane-only, so dk is always "letai" today —
    // but pin an org-id shape too in case that ever widens.
    for (const dk of ["letai", "org-abc123"]) {
      for (const mb of [4, 8, 16]) {
        const line = `[hx] chunk size settled at ${mb} MB for ${dk}`;
        assert.equal(classifyLogLine(line), "info", line);
      }
    }
  });

  it("the state-flush failure line classifies as warn (it IS a warning)", () => {
    const line = `[hx] state flush error: EBUSY: resource busy (will keep retrying)`;
    assert.equal(classifyLogLine(line), "warn", "a real failure renders warn, like its siblings");
  });

  it("the file-events fallback line classifies as warn (polling is the degraded mode)", () => {
    const line = `[hx] file events unavailable (/home/u/.claude/projects: ENOSPC: System limit for number of file watchers reached); polling the file tree every tick`;
    assert.equal(classifyLogLine(line), "warn");
  });
});

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
  ["idle hour", { passes: 2400, passMs: [1, 2, 3], uploads: 0, flushes: 0 }],
  ["busy hour", { passes: 2400, passMs: Array.from({ length: 500 }, (_, i) => i), uploads: 913, flushes: 720 }],
  ["single pass", { passes: 1, passMs: [1234.7], uploads: 1, flushes: 1 }],
  // Counter values that would trip naive formats: a "failed=[1-9]"-shaped
  // number must never appear; uploads/flushes digits are safe by format.
  ["digit soup", { passes: 19, passMs: [9], uploads: 19, flushes: 91 }],
];

describe("formatPerfLine", () => {
  it("classifies as info for every sample (never warn/up)", () => {
    for (const [label, perf] of samples) {
      const line = formatPerfLine(perf);
      assert.equal(classifyLogLine(line), "info", `${label}: ${line}`);
    }
  });

  it("stays stable in shape (timestamp prefix added by the daemon logger)", () => {
    const line = formatPerfLine({ passes: 3, passMs: [5, 10, 20], uploads: 2, flushes: 1 });
    assert.match(line, /^\[hx\] perf: passes=3 passMs p50=\d+ p95=\d+ max=\d+ uploads=2 stateFlushes=1$/);
  });
});

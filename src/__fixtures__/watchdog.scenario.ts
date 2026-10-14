// Child-process half of watchdog.test.ts: starts the watchdog thread with the
// limits it is given, then misbehaves (or not). It runs in its own process
// because the point is that the watchdog kills it.
//
//   bun watchdog.scenario.ts <mode> <dir> <freezeSeconds> <memoryCeilingMb>
//
//   freeze   beat for a second, then spin the main thread forever
//   memory   keep the event loop turning while RSS climbs past the ceiling
//   healthy  six seconds of normal work, with sync stalls well under the
//            freeze limit and garbage well under the ceiling, then exit 0
//
// Progress goes out with writeSync so the parent still sees it when the event
// loop is stuck. <dir> receives the trip log (watchdog.log) and the run marker
// (marker.json) that the worker annotates before it kills.

import { writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { startWatchdogThread } from "../watchdog.js";

const say = (line: string): void => {
  writeSync(1, `${line}\n`);
};

const [mode, dir, freezeArg, ceilingArg] = process.argv.slice(2);
if (!mode || !dir || !freezeArg || !ceilingArg) {
  throw new Error("usage: watchdog.scenario.ts <freeze|memory|healthy> <dir> <freezeSeconds> <memoryCeilingMb>");
}

const markerPath = join(dir, "marker.json");
const marker = { pid: process.pid, startedAtMs: Date.now() };
// eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own tmp dir
writeFileSync(markerPath, JSON.stringify(marker));
const watchdog = startWatchdogThread({
  limits: { freezeSeconds: Number(freezeArg), memoryCeilingMb: Number(ceilingArg) },
  logPath: join(dir, "watchdog.log"),
  marker: { path: markerPath, content: marker },
  onError: (message) => say(`watchdog error: ${message}`),
});
say("started");

if (mode === "freeze") {
  setTimeout(() => {
    say(`frozen ${Date.now()}`);
    for (;;) {
      // The main thread never yields again; only the worker can end this.
    }
  }, 1_000);
} else if (mode === "memory") {
  const held: Uint8Array[] = [];
  setInterval(() => {
    // fill() makes the pages resident; untouched zeroed pages are not in RSS.
    held.push(new Uint8Array(16 * 1048576).fill(1));
    say(`holding ${held.length * 16} MB`);
  }, 50);
} else if (mode === "healthy") {
  const startedAt = Date.now();
  const work = setInterval(() => {
    // About 50 MB of short-lived garbage, then a 300 ms synchronous stall:
    // busy, but the beat never misses more than about a second and a half.
    const garbage = Array.from({ length: 50_000 }, (_, i) => String(i).padEnd(1024, "x"));
    const until = Date.now() + 300;
    while (Date.now() < until) {
      // stall
    }
    say(`worked ${garbage.length}`);
    if (Date.now() - startedAt >= 6_000) {
      clearInterval(work);
      say(`checks ${watchdog.checks()}`);
      watchdog.stop();
      say("done");
    }
  }, 700);
} else {
  throw new Error(`unknown mode ${mode}`);
}

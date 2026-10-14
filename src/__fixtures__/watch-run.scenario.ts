// Child-process half of crash-loop.test.ts: begins a watch run in <dir>, hooks
// it to the process the way cmdWatch does, then waits for the test's signal or
// exits on its own.
//
//   bun watch-run.scenario.ts <mode> <dir>
//
//   wait        nothing else listens for signals: the backoff wait, before
//               startWatch arms state.ts's handlers
//   flush       a second SIGTERM listener that flushes for 50 ms and then
//               re-raises, the way state.ts's does
//   exit70      exits with code 70, the progress watchdog's code

import { writeSync } from "node:fs";
import { beginWatchRun, hookWatchRunToProcess } from "../crash-loop.js";

const say = (line: string): void => {
  writeSync(1, `${line}\n`);
};

const [mode, dir] = process.argv.slice(2);
if (!mode || !dir) throw new Error("usage: watch-run.scenario.ts <wait|flush|exit70> <dir>");

const run = beginWatchRun({ dir });
hookWatchRunToProcess(run);
if (mode === "flush") {
  process.once("SIGTERM", () => {
    setTimeout(() => {
      say("flushed");
      process.kill(process.pid, "SIGTERM");
    }, 50);
  });
}
if (mode === "exit70") setTimeout(() => process.exit(70), 50);
// Keeps the process alive until a signal ends it.
setTimeout(() => say("timed out"), 20_000);
say("ready");

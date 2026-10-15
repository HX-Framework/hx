// Write goldens from stored reference runs without running a binary: point it
// at the `<scenario>/reference` directories of a downloaded
// harness-differential-<os> artifact and commit the result under
// harness/golden/<os>/.
//
//   bun harness/run/write-goldens.ts --out harness/golden/Linux \
//       --run harness-out/baseline/reference [--run <dir> ...]

import { loadRun } from "../lib/compare.js";
import { writeGoldens } from "../lib/goldens.js";
import { scenarioByName } from "./scenarios.js";

const args = process.argv.slice(2);
const runs: string[] = [];
let out: string | undefined;
for (let i = 0; i < args.length; i++) {
  const next = args[i + 1];
  if (!next) continue;
  if (args[i] === "--run") {
    runs.push(next);
    i++;
  } else if (args[i] === "--out") {
    out = next;
    i++;
  }
}
if (!out || runs.length === 0) {
  console.error("usage: write-goldens.ts --out <dir> --run <reference run dir> [--run <dir> ...]");
  process.exit(64);
}
for (const dir of runs) {
  const run = loadRun(dir);
  const scenario = scenarioByName(run.meta.scenario);
  const written = writeGoldens(scenario, run, run.meta.name, [run.meta.version], out);
  console.error(`${run.meta.scenario}: ${written.length} golden${written.length === 1 ? "" : "s"} written under ${out}/${run.meta.scenario}`);
}

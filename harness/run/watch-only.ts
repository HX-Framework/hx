// A bare Bun process holding fs.watch({ recursive: true }) on the fixture's
// roots — the directories hx watches (src/fs-events.ts, eventDirsFor) — and
// nothing else, for a fixed number of seconds. measure.ts samples its
// resident memory from outside, once with the watch and once without, so the
// memory of the runtime's recursive watcher on a tree of this size is known
// on its own, apart from anything hx does with the events.
//
//   bun harness/run/watch-only.ts --home <home> --watch yes|no --seconds 20
//
// Prints one JSON line at the end: the roots found, the directories under
// them, whether the watch was armed, and the events it saw.

import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const home = arg("home") ?? "";
if (!home) {
  console.error("usage: watch-only.ts --home <home> [--watch yes|no] [--seconds n]");
  process.exit(64);
}
const armed = (arg("watch", "yes") ?? "yes") === "yes";
const seconds = Number(arg("seconds", "20"));

// The roots eventDirsFor names for the default data directories.
const roots = [
  join(home, ".claude", "projects"),
  join(home, ".claude", "sessions"),
  join(home, ".codex", "sessions"),
  join(home, ".codex", "archived_sessions"),
].filter((d) => existsSync(d));

function countDirs(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += 1 + countDirs(join(dir, e.name));
  }
  return n;
}
const dirCount = roots.reduce((a, r) => a + 1 + countDirs(r), 0);

let events = 0;
const watchers: FSWatcher[] = [];
if (armed) {
  for (const dir of roots) {
    const w = watch(dir, { recursive: true, persistent: false }, () => {
      events += 1;
    });
    w.on("error", (err) => {
      console.error(`watch error on ${dir}: ${(err as Error).message}`);
    });
    watchers.push(w);
  }
}
await new Promise((r) => setTimeout(r, seconds * 1000));
for (const w of watchers) w.close();
console.log(JSON.stringify({ roots: roots.length, dirCount, armed, events }));

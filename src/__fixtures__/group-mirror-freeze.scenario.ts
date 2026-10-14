// Child-process half of ccd-mirror-freeze.test.ts. It runs in its own process
// so that a regression hangs a child the test can kill, not the test runner.
//
// The call sequence below froze `hx watch` v77.7.0 on 2026-10-14 and still
// freezes v77.8.0. Three group-mirror builds, using only APIs both versions
// export:
//
//   1. Build at t0.
//   2. Change only the leveldb .log, build at t0 + 11 s. The 10 s records TTL
//      has lapsed and the session store is unchanged, so the old records
//      single-flight returned before its first await: its own `finally`
//      cleared the in-flight slot BEFORE the caller stored the promise in it,
//      and a settled promise stayed in the slot for good.
//   3. Change one session file, build again. The changed fingerprint chained
//      `.then` on the stuck promise and re-entered itself on every turn: an
//      endless chain of microtasks, so no timer, I/O callback or signal
//      handler ever ran again and memory grew until the process died.
//
// Progress lines go out with writeSync so the parent still sees them when the
// event loop starves. A "tick" every 100 ms is the heartbeat: the parent kills
// this process as soon as the ticks stop, because a starved loop also grows
// memory by about 1.5 GB a second. The parent passes the fixture root as
// argv[2].

import { mkdirSync, renameSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { buildGroupMirror, setCcdLeveldbDirForTests } from "../ccd-prefs.js";
import { setCcdSessionsDirForTests } from "../ccd.js";

const say = (line: string): void => {
  writeSync(1, `${line}\n`);
};
const heartbeat = setInterval(() => say("tick"), 100);

const root = process.argv[2];
if (!root) throw new Error("usage: group-mirror-freeze.scenario.ts <fixture-root>");

const ldb = join(root, "leveldb");
const org = join(root, "claude-code-sessions", "acct", "org");
mkdirSync(ldb, { recursive: true });
mkdirSync(org, { recursive: true });

// Distinct, explicit mtimes so both versions' change gates see every write
// regardless of the filesystem's timestamp resolution.
const at = (seconds: number): Date => new Date(1_700_000_000_000 + seconds * 1000);

const logPath = join(ldb, "000003.log");
const groupingState = {
  groupByByMode: { code: "custom" },
  customGroups: [{ id: "g1", name: "G" }],
  customGroupOrder: { g1: ["code:local_aaa"] },
};
writeFileSync(logPath, `_file://frame-store\x00{"state":${JSON.stringify(groupingState)}}\n`);
utimesSync(logPath, at(1), at(1));

const sessionPath = join(org, "local_aaa.json");
function writeSession(cliSessionId: string, seconds: number): void {
  // CCD writes a temp file and renames it over the old one.
  const body = JSON.stringify({ sessionId: "local_aaa", cliSessionId, title: "T", lastActivityAt: seconds });
  writeFileSync(`${sessionPath}.tmp`, body);
  renameSync(`${sessionPath}.tmp`, sessionPath);
  utimesSync(sessionPath, at(seconds), at(seconds));
  utimesSync(org, at(seconds), at(seconds));
}
writeSession("cli-1", 1);

setCcdLeveldbDirForTests(ldb);
setCcdSessionsDirForTests(join(root, "claude-code-sessions"));

const t0 = 1_000_000;

const first = await buildGroupMirror(t0);
say(`build 1 returned ${JSON.stringify(first.groups.map((g) => g.sessionIds))}`);

// Another Local Storage key written; the session store is untouched.
writeFileSync(logPath, `_file://frame-store\x00{"state":${JSON.stringify(groupingState)}}\n_file://other\x00{"x":1}\n`);
utimesSync(logPath, at(2), at(2));
await buildGroupMirror(t0 + 11_000);
say("build 2 returned");

writeSession("cli-22", 3);
// Ten minutes later: past every refresh TTL and full-stat interval in either
// version, so a working reader must re-read the changed session file.
setTimeout(() => say("timer fired"), 0);
say("build 3 started");
const third = await buildGroupMirror(t0 + 11_000 + 600_000);
say(`build 3 returned ${JSON.stringify(third.groups.map((g) => g.sessionIds))}`);
// Give the timer a turn in case the build finished without yielding to it.
await new Promise((resolve) => setTimeout(resolve, 0));
clearInterval(heartbeat);
say("done");

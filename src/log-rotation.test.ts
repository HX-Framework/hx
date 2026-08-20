// Nothing has ever rotated the daemon logs. One device reached 242 MB and
// 1,144,348 lines across two gateway migrations, 70% of it one error repeated
// 798,704 times — a file too large to be a diagnostic.
//
// Rotation MUST be copy-truncate, not rename: launchd (StandardOutPath) and
// systemd (StandardOutput=append:) open the log themselves and hold the
// descriptor for the process lifetime, so a rename leaves them writing to the
// same inode under its new name. These tests pin that the live descriptor
// keeps working across a rotation, which is the whole safety argument.
import { describe, it, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync, openSync, writeSync, closeSync, statSync, fstatSync, existsSync, utimesSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLogsIfLarge, seedBacklogLines, HX_DIR } from "./daemon.js";

let dir = "";
const make = (): string => {
  dir = mkdtempSync(join(tmpdir(), "hx-rot-"));
  return join(dir, "stdout.log");
};
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("rotateLogsIfLarge", () => {
  it("leaves a log under the cap untouched", async () => {
    const p = make();
    writeFileSync(p, "small\n");
    assert.deepEqual(await rotateLogsIfLarge(1024, [p]), []);
    assert.equal(readFileSync(p, "utf8"), "small\n");
  });

  it("copies to .1 and truncates in place once over the cap", async () => {
    const p = make();
    writeFileSync(p, "x".repeat(2048));
    assert.deepEqual(await rotateLogsIfLarge(1024, [p]), [p]);
    assert.equal(statSync(p).size, 0);
    assert.equal(readFileSync(`${p}.1`, "utf8").length, 2048);
  });

  it("keeps the SAME inode, so a service manager's open fd survives", async () => {
    const p = make();
    writeFileSync(p, "y".repeat(2048));
    const before = statSync(p).ino;
    await rotateLogsIfLarge(1024, [p]);
    assert.equal(statSync(p).ino, before);
  });

  it("an already-open O_APPEND descriptor keeps writing after the rotation", async () => {
    // This is launchd/systemd's descriptor, and the Windows tee's. If a rename
    // were used instead, this write would land in the rotated-away file and
    // stdout.log would stay empty forever.
    const p = make();
    const fd = openSync(p, "a");
    try {
      writeSync(fd, "z".repeat(2048));
      await rotateLogsIfLarge(1024, [p]);
      writeSync(fd, "after\n");
      // Asserted through the DESCRIPTOR rather than the path: the file it still
      // points at being exactly 6 bytes is the proof. The write landed at
      // offset 0 of the truncated file, not appended past the 2048 bytes that
      // were there before, and not into some other inode left by a rename.
      assert.equal(fstatSync(fd).size, "after\n".length);
    } finally {
      closeSync(fd);
    }
  });

  it("keeps only one previous generation", async () => {
    const p = make();
    writeFileSync(p, "a".repeat(2048));
    await rotateLogsIfLarge(1024, [p]);
    appendFileSync(p, "b".repeat(2048));
    await rotateLogsIfLarge(1024, [p]);
    assert.equal(readFileSync(`${p}.1`, "utf8"), "b".repeat(2048));
  });

  it("never throws on a missing log", async () => {
    const p = make();
    assert.deepEqual(await rotateLogsIfLarge(1024, [join(dir, "absent.log")]), []);
    assert.ok(p);
  });
});

// stdout.log/stderr.log are DEVICE-global while callers are per-lane: cli.ts
// starts the main and `--local` watchers concurrently in ONE process. Two
// overlapping rotations both pass the size check, then one truncates while the
// other is still copying — and the "previous generation" it promised ends up
// empty. Callers are gated too; this pins the function's own safety.
describe("rotateLogsIfLarge under concurrent callers", () => {
  it("coalesces overlapping calls instead of destroying the copy", async () => {
    const p = make();
    writeFileSync(p, "q".repeat(4096));
    const [a, b] = await Promise.all([
      rotateLogsIfLarge(1024, [p]),
      rotateLogsIfLarge(1024, [p]),
    ]);
    // Whatever the interleaving, the kept generation must be the real history.
    assert.equal(readFileSync(`${p}.1`, "utf8").length, 4096);
    assert.equal(statSync(p).size, 0);
    // IDENTITY, not deepEqual. The guard hands the second caller the first
    // call's promise, so both slots are the same array object; deepEqual passes
    // for any implementation — including one with the guard removed, where two
    // independent rotations return two equal arrays — so it asserted nothing
    // about the property this test is named for.
    assert.ok(a === b, "second caller must observe the first rotation, not run its own");
  });
});

// `hx logs` must be able to reach what the rotator kept, or the daemon promises
// a generation no command can retrieve.
describe("seedBacklogLines", () => {
  const gen = (from: number, to: number): string =>
    Array.from({ length: to - from }, (_, i) => `line ${from + i}`).join("\n");

  it("reaches into the previous generation when the live log is short", () => {
    // The case the rotation creates: 5 lines written since, 500 requested.
    const out = seedBacklogLines(gen(200, 205), gen(0, 200), 50);
    assert.equal(out.length, 50);
    assert.equal(out[0], "line 155");
    assert.equal(out[out.length - 1], "line 204");
  });

  it("does not touch the previous generation when the live log suffices", () => {
    const out = seedBacklogLines(gen(0, 100), gen(900, 999), 10);
    assert.deepEqual(out, Array.from({ length: 10 }, (_, i) => `line ${90 + i}`));
  });

  it("returns just the live lines when there is no previous generation", () => {
    assert.deepEqual(seedBacklogLines("a\nb\n", "", 50), ["a", "b"]);
  });

  it("handles an empty live log right after a rotation", () => {
    assert.deepEqual(seedBacklogLines("", "x\ny\n", 50), ["x", "y"]);
  });

  it("returns nothing when both are empty", () => {
    assert.deepEqual(seedBacklogLines("", "", 50), []);
  });

  it("tolerates a log with no trailing newline", () => {
    assert.deepEqual(seedBacklogLines("a\nb", "", 50), ["a", "b"]);
  });
});

// `hx logs --lines N` takes N straight from the user, and a rotated 32 MB log
// is roughly a million lines. unshift(...spread) made that a crash.
describe("seedBacklogLines at scale", () => {
  it("survives a linesBack larger than the spread limit", () => {
    const prev = Array.from({ length: 1_100_000 }, (_, i) => `line ${i}`).join("\n");
    const out = seedBacklogLines("tail\n", prev, 1_000_000);
    assert.equal(out.length, 1_000_000);
    assert.equal(out[out.length - 1], "tail");
  });
});

// The in-process guard cannot see another PROCESS, and a foreground `hx watch`
// runs the same command as the installed service. Staging plus an atomic rename
// is not enough: the rename is atomic, but it says nothing about what was
// copied — a second process that stats the log before the first truncates goes
// on to copy a file being emptied underneath it, then renames that short copy
// over the complete generation. Measured on a 600 MB log: 375 MB survived.
describe("rotateLogsIfLarge cross-process lock", () => {
  const lockPath = (): string => join(HX_DIR, "rotate.lock");

  it("stands down while another process holds the lock", async () => {
    const p = make();
    writeFileSync(p, "z".repeat(4096));
    writeFileSync(lockPath(), "99999");
    try {
      assert.deepEqual(await rotateLogsIfLarge(1024, [p]), []);
      // Untouched: no truncate, no generation written.
      assert.equal(statSync(p).size, 4096);
      assert.equal(existsSync(`${p}.1`), false);
    } finally {
      rmSync(lockPath(), { force: true });
    }
  });

  it("clears a lock left by a dead process WITHOUT rotating in the same round", async () => {
    // Breaking a lock and taking it in one step cannot be done atomically with
    // plain fs calls, and every attempt races: one process completes both steps
    // inside another's window, so the second deletes the first's FRESH lock and
    // wins its own create. Measured at 2 of 40 trials with 8 processes, and on
    // an 800 MB log that turned 800 MB of kept history into 580 MB.
    //
    // Clearing and returning has no race: unlink is idempotent and nobody
    // rotates in the round that breaks the lock.
    const p = make();
    writeFileSync(p, "z".repeat(4096));
    writeFileSync(lockPath(), "99999");
    const old = Date.now() / 1000 - 3600;
    utimesSync(lockPath(), old, old);
    try {
      assert.deepEqual(await rotateLogsIfLarge(1024, [p]), []);
      assert.equal(statSync(p).size, 4096, "the log must be untouched this round");
      assert.equal(existsSync(lockPath()), false, "the stale lock must be gone");
    } finally {
      rmSync(lockPath(), { force: true });
    }
  });

  it("rotates on the NEXT round, so a dead daemon delays rather than disables", async () => {
    const p = make();
    writeFileSync(p, "z".repeat(4096));
    writeFileSync(lockPath(), "99999");
    const old = Date.now() / 1000 - 3600;
    utimesSync(lockPath(), old, old);
    try {
      await rotateLogsIfLarge(1024, [p]);
      assert.deepEqual(await rotateLogsIfLarge(1024, [p]), [p]);
      assert.equal(statSync(p).size, 0);
      assert.equal(readFileSync(`${p}.1`, "utf8").length, 4096);
    } finally {
      rmSync(lockPath(), { force: true });
    }
  });

  it("never rejects when the lock cannot even be stat-ed", async () => {
    // throwIfNoEntry:false suppresses ENOENT only. EACCES/EIO/EPERM all throw,
    // and this runs inside a setInterval where Bun exits on an unhandled
    // rejection — an unreadable lock would have killed the daemon on the hour.
    const p = make();
    writeFileSync(p, "z".repeat(4096));
    writeFileSync(lockPath(), "99999");
    chmodSync(HX_DIR, 0o000);
    try {
      assert.deepEqual(await rotateLogsIfLarge(1024, [p]), []);
    } finally {
      chmodSync(HX_DIR, 0o755);
      rmSync(lockPath(), { force: true });
    }
  });

  it("releases the lock when it is done", async () => {
    const p = make();
    writeFileSync(p, "z".repeat(4096));
    await rotateLogsIfLarge(1024, [p]);
    assert.equal(existsSync(lockPath()), false);
  });

  it("releases the lock even when every target fails", async () => {
    await rotateLogsIfLarge(1024, [join(dir, "absent.log")]);
    assert.equal(existsSync(lockPath()), false);
  });
});

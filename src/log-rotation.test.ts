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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync, openSync, writeSync, closeSync, statSync, fstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLogsIfLarge, seedBacklogLines } from "./daemon.js";

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
    // Exactly one rotation happened; the other observed the same result.
    assert.deepEqual(a, b);
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

// Log rotation for the daemon's stdout.log / stderr.log, and the readers that
// must keep working across a rotation (`hx logs`, the UI's log tail).

import { afterEach, beforeEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fdWritesFile,
  holdLogFile,
  recentLogLines,
  releaseLogFile,
  rotateLogFile,
  rotateOwnLog,
  writeHeldLog,
} from "./daemon.js";

let dir = "";
let log = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hx-logs-"));
  log = join(dir, "stdout.log");
});

afterEach(() => {
  releaseLogFile(log);
  rmSync(dir, { recursive: true, force: true });
});

/** `count` numbered lines, each `width` bytes including the newline. */
function lines(from: number, count: number, width = 20): string {
  let out = "";
  for (let i = from; i < from + count; i++) out += `line ${i}`.padEnd(width - 1, ".") + "\n";
  return out;
}

describe("rotateLogFile", () => {
  it("leaves a log under the cap alone", () => {
    writeFileSync(log, lines(0, 10));
    assert.equal(rotateLogFile(log, 1000, 2), false);
    assert.equal(readFileSync(log, "utf8"), lines(0, 10));
    assert.equal(existsSync(`${log}.1`), false);
  });

  it("moves the newest lines to <log>.1 and empties the live file", () => {
    writeFileSync(log, lines(0, 100)); // 2000 bytes
    assert.equal(rotateLogFile(log, 1000, 2), true);
    assert.equal(statSync(log).size, 0);
    // The copy is the last 1000 bytes, and starts on a line: exactly the last 50.
    assert.equal(readFileSync(`${log}.1`, "utf8"), lines(50, 50));
  });

  it("starts the copy at the next whole line when the cut falls mid-line", () => {
    writeFileSync(log, lines(0, 100)); // 2000 bytes; 990 from the end is mid-line
    rotateLogFile(log, 990, 2);
    assert.equal(readFileSync(`${log}.1`, "utf8"), lines(51, 49));
  });

  it("shifts older copies up and keeps no more than `keep`", () => {
    writeFileSync(log, lines(0, 100));
    rotateLogFile(log, 1000, 2);
    writeFileSync(log, lines(100, 100));
    rotateLogFile(log, 1000, 2);
    writeFileSync(log, lines(200, 100));
    rotateLogFile(log, 1000, 2);
    assert.equal(readFileSync(`${log}.1`, "utf8"), lines(250, 50));
    assert.equal(readFileSync(`${log}.2`, "utf8"), lines(150, 50));
    assert.equal(existsSync(`${log}.3`), false);
    assert.equal(existsSync(`${log}.1.tmp`), false);
  });

  it("keeps only the tail of a log that grew far past the cap", () => {
    // The first daemon start after this change meets a 424 MB stdout.log.
    writeFileSync(log, lines(0, 10_000)); // 200 KB
    rotateLogFile(log, 1000, 2);
    assert.equal(readFileSync(`${log}.1`, "utf8"), lines(9950, 50));
  });

  it("returns false for a missing log", () => {
    assert.equal(rotateLogFile(join(dir, "absent.log"), 1000, 2), false);
  });

  // The launchd / systemd / container case: the writer is another process
  // holding an O_APPEND descriptor that rotation never touches. Windows does
  // not take this path (hx holds its own descriptor there; see rotateOwnLog).
  it.skipIf(process.platform === "win32")(
    "lets an O_APPEND writer keep writing, from offset 0, with no hole",
    () => {
      // "a+": append like the service manager's descriptor, and read the
      // result back through it rather than by path.
      const fd = openSync(log, "a+");
      try {
        writeSync(fd, lines(0, 100));
        assert.equal(rotateLogFile(log, 1000, 2), true);
        writeSync(fd, "after rotation\n");
        const live = Buffer.alloc(fstatSync(fd).size);
        readSync(fd, live, 0, live.length, 0);
        assert.equal(live.toString("utf8"), "after rotation\n");
        assert.equal(live.includes(0), false, "no NUL bytes from a stale write offset");
      } finally {
        closeSync(fd);
      }
    },
  );
});

describe("rotateOwnLog (hx holds the descriptor: the Windows tee)", () => {
  it("closes and reopens its descriptor so writes land in the fresh file", () => {
    assert.equal(holdLogFile(log), true);
    writeHeldLog(log, lines(0, 100));
    assert.equal(rotateOwnLog(log, 1000, 2), true);
    writeHeldLog(log, "after rotation\n");
    writeHeldLog(log, Buffer.from("bytes too\n"));
    assert.equal(readFileSync(log, "utf8"), "after rotation\nbytes too\n");
    assert.equal(readFileSync(`${log}.1`, "utf8"), lines(50, 50));
  });

  it("does nothing under the cap and keeps writing", () => {
    holdLogFile(log);
    writeHeldLog(log, "one\n");
    assert.equal(rotateOwnLog(log, 1000, 2), false);
    writeHeldLog(log, "two\n");
    assert.equal(readFileSync(log, "utf8"), "one\ntwo\n");
  });

  it("rotates a log nobody holds, like rotateLogFile", () => {
    writeFileSync(log, lines(0, 100));
    assert.equal(rotateOwnLog(log, 1000, 2), true);
    assert.equal(statSync(log).size, 0);
  });
});

describe("fdWritesFile", () => {
  it("matches a descriptor to the file it is open on", () => {
    writeFileSync(log, "");
    const fd = openSync(log, "a");
    try {
      assert.equal(fdWritesFile(fd, log), true);
      const other = join(dir, "other.log");
      writeFileSync(other, "");
      assert.equal(fdWritesFile(fd, other), false);
    } finally {
      closeSync(fd);
    }
  });

  // A log replaced under the descriptor is a different file: rotating it would
  // leave the one actually being written to grow unchecked. Windows will not
  // replace a file that is open, so this case cannot arise there.
  it.skipIf(process.platform === "win32")("does not match a log replaced under the descriptor", () => {
    writeFileSync(log, "");
    const fd = openSync(log, "a");
    try {
      const replacement = join(dir, "replacement.log");
      writeFileSync(replacement, "");
      renameSync(replacement, log);
      assert.equal(fdWritesFile(fd, log), false);
    } finally {
      closeSync(fd);
    }
  });

  it("is false for a descriptor that is not open", () => {
    assert.equal(fdWritesFile(987_654, log), false);
  });
});

describe("recentLogLines", () => {
  it("returns the last lines of the live log and its size", async () => {
    writeFileSync(log, lines(0, 100));
    const r = await recentLogLines(log, 3);
    assert.deepEqual(r.lines, lines(97, 3).trimEnd().split("\n"));
    assert.equal(r.size, 2000);
  });

  it("continues into <log>.1 right after a rotation", async () => {
    writeFileSync(log, lines(0, 100));
    rotateLogFile(log, 1000, 2);
    writeFileSync(log, lines(100, 2));
    const r = await recentLogLines(log, 5);
    assert.deepEqual(r.lines, lines(97, 5).trimEnd().split("\n"));
    assert.equal(r.size, 40); // follow from the end of the live file
  });

  it("reads a bounded tail of a huge log", async () => {
    writeFileSync(log, lines(0, 10_000));
    // 1000 bytes from the end begins exactly on a line: all 50 lines, none cut.
    const r = await recentLogLines(log, 1_000_000, 1000);
    assert.deepEqual(r.lines, lines(9950, 50).trimEnd().split("\n"));
  });

  it("drops a line the bounded read cuts in half", async () => {
    writeFileSync(log, lines(0, 10_000));
    // 990 bytes from the end falls mid-way through line 9950.
    const r = await recentLogLines(log, 1_000_000, 990);
    assert.deepEqual(r.lines, lines(9951, 49).trimEnd().split("\n"));
  });

  it("is empty for a missing log", async () => {
    assert.deepEqual(await recentLogLines(join(dir, "absent.log"), 10), { lines: [], size: 0 });
  });
});

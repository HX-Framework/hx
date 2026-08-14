import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { setGuiSubsystem } from "../scripts/pe-subsystem.js";

/** Minimal PE skeleton: MZ header, e_lfanew, PE signature, subsystem field. */
function fakePe(subsystem: number): Buffer {
  const buf = Buffer.alloc(0x200);
  buf.writeUInt16LE(0x5a4d, 0); // "MZ"
  const pe = 0x80;
  buf.writeUInt32LE(pe, 0x3c);
  buf.writeUInt32LE(0x00004550, pe); // "PE\0\0"
  buf.writeUInt16LE(subsystem, pe + 0x5c);
  return buf;
}

describe("setGuiSubsystem", () => {
  it("flips a console binary to windowless", () => {
    const b = fakePe(3);
    assert.equal(setGuiSubsystem(b), true);
    assert.equal(b.readUInt16LE(0x80 + 0x5c), 2);
  });

  it("is idempotent on an already-windowless binary", () => {
    const b = fakePe(2);
    assert.equal(setGuiSubsystem(b), false);
    assert.equal(b.readUInt16LE(0x80 + 0x5c), 2);
  });

  it("refuses anything that is not a console PE rather than guessing", () => {
    // A subsystem we do not recognise means our offsets are wrong, and writing
    // two bytes into the middle of an executable on a guess is how you ship a
    // corrupt binary that only fails on the customer's machine.
    assert.throws(() => setGuiSubsystem(fakePe(9)), /unexpected subsystem/);
    assert.throws(() => setGuiSubsystem(Buffer.alloc(0x200)), /not a PE image/);
  });
});

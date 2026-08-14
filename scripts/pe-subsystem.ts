/**
 * Flip a PE executable's subsystem from CONSOLE to GUI, in place.
 *
 * Why this exists: hx ships two Windows binaries from one source — `hx.exe`
 * (console, because the CLI needs somewhere to print) and `hx-svc.exe`
 * (windowless, so the scheduled task does not park a console window on the
 * desktop at every logon and every supervision tick).
 *
 * Bun's own flag for that, --windows-hide-console, is refused when
 * cross-compiling ("only available when compiling on Windows"). The obvious
 * answer — build the Windows artifacts on a windows-latest runner — does not
 * work either: `bun build --target=bun-windows-x64-baseline` there fails with
 * "Failed to extract executable for 'bun-windows-x64-baseline'", reproducibly.
 * Dropping --target on Windows would compile against the runner's own
 * non-baseline Bun and quietly produce a binary that needs AVX2, which is the
 * opposite of why every other x64 target here is baseline.
 *
 * So: cross-compile both from Linux, where the baseline target demonstrably
 * works, and set the subsystem byte on the service copy afterwards. The
 * subsystem field is precisely what --windows-hide-console sets; a patched
 * binary was verified on Windows 11 running as the scheduled task, with no
 * console window and its logs intact.
 *
 * Signing, when it lands, happens after this in the pipeline, so the signature
 * covers the patched bytes and stays valid.
 *
 * Layout (PE/COFF): offset 0x3C holds e_lfanew → the PE signature. The Optional
 * Header starts 24 bytes later, and its Subsystem field sits at +0x44 within it
 * — so PE + 0x5C. 2 = WINDOWS_GUI, 3 = WINDOWS_CUI.
 */
import { readFileSync, writeFileSync } from "node:fs";

const CONSOLE = 3;
const GUI = 2;

/** Patch `buf` in place. Exported for the test; throws rather than guessing. */
export function setGuiSubsystem(buf: Buffer): boolean {
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error("not a PE image (no MZ)");
  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(pe) !== 0x00004550) throw new Error("not a PE image (no PE\\0\\0)");
  const at = pe + 0x5c;
  const cur = buf.readUInt16LE(at);
  if (cur === GUI) return false; // already windowless — idempotent
  if (cur !== CONSOLE) throw new Error(`unexpected subsystem ${cur}; refusing to patch`);
  buf.writeUInt16LE(GUI, at);
  return true;
}

// Only act when run as a command; importing this for tests must not patch
// whatever happens to be in argv.
if (import.meta.main) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: pe-subsystem.mjs <file.exe>");
    process.exit(1);
  }
  const buf = readFileSync(target);
  const changed = setGuiSubsystem(buf);
  if (changed) writeFileSync(target, buf);
  console.log(`${target}: subsystem ${changed ? "CONSOLE -> GUI (windowless)" : "already GUI"}`);
}

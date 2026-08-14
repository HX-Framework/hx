// Path normalization shared by settings.ts (parse/validate) and roots.ts
// (resolution). Lives in its own module so settings can import root
// constants from roots without a require cycle (roots needs this helper).

import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

const HOME = homedir();

/**
 * Normalize one data-dir root: trim, expand a leading `~`, require an
 * absolute path, collapse `.`/`..` segments and trailing separators. Returns
 * null for anything unusable (relative, empty, control characters) — callers
 * drop such entries rather than half-honoring them. Env values go through
 * this exact same funnel (see roots.ts) so a garbage CLAUDE_CONFIG_DIR can't
 * produce a non-canonical root.
 */
export function normalizeDataDir(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.trim();
  if (!p || /[\0\r\n]/.test(p)) return null;
  if (p === "~") p = HOME;
  else if (p.startsWith("~/")) p = join(HOME, p.slice(2));
  if (!isAbsolute(p)) return null;
  p = normalize(p);
  // normalize() preserves a trailing separator — strip it (never the root).
  // Platform-aware: `\` is a legal filename character on POSIX, so stripping
  // it there would silently watch the wrong directory.
  while (
    p.length > 1 &&
    (p.endsWith("/") || (process.platform === "win32" && p.endsWith("\\")))
  ) {
    p = p.slice(0, -1);
  }
  return p;
}

// ── Canonical path comparison ────────────────────────────────────────────────
//
// Windows and macOS ship case-INSENSITIVE filesystems by default (NTFS, APFS);
// Linux does not. Comparing paths as raw strings therefore reports two
// spellings of one directory as two directories on exactly the platforms where
// they are the same place. Claude Code makes that concrete rather than
// theoretical: on a single Windows machine it writes both `C:\Users\me` and
// `c:\Users\me` as the session cwd. Separators vary the same way — `\` is a
// path separator on Windows but a LEGAL FILENAME CHARACTER on POSIX, so folding
// it is correct on win32 and corrupting anywhere else.
//
// Everything here takes `platform` as a defaulted parameter rather than reading
// `process.platform` inline, so win32/darwin behavior is testable from Linux CI
// (same shape as browserCommandFor in browser.ts).

/**
 * Canonical comparison key for a path — NOT a value to store or display.
 * On Linux this is the identity function, so behavior there is byte-identical.
 */
export function pathKey(p: string, platform: string = process.platform): string {
  const win = platform === "win32";
  const sep = win ? p.replace(/\\/g, "/") : p;
  return win || platform === "darwin" ? sep.toLowerCase() : sep;
}

/** Drop trailing separators from a key so `~/a/` and `~/a` compare equal. */
function trimKey(k: string): string {
  return k.replace(/\/+$/, "");
}

/** Same directory, however it was spelled? */
export function samePath(a: string, b: string, platform: string = process.platform): boolean {
  return trimKey(pathKey(a, platform)) === trimKey(pathKey(b, platform));
}

/**
 * Is `child` AT or UNDER `parent`? Boundary-aware, so `~/a` never matches
 * `~/ab`. An empty or root-only `parent` matches NOTHING: a rule that would
 * exclude the whole filesystem is treated as a no-op, which both preserves the
 * prior behavior and is the safer reading of a malformed rule.
 */
export function isPathPrefix(
  parent: string,
  child: string,
  platform: string = process.platform,
): boolean {
  const p = trimKey(pathKey(parent, platform));
  if (!p) return false;
  const c = trimKey(pathKey(child, platform));
  return c === p || c.startsWith(`${p}/`);
}

/**
 * Replace a leading home directory with `~`. Canonical (so `c:\users\me\x`
 * collapses against a `C:\Users\Me` home) and boundary-aware (so `/home/bobby`
 * is not rendered `~by` for the user `bob` — the old `startsWith` did exactly
 * that). Only the COMPARISON is canonical: every character after the home
 * prefix keeps its original spelling.
 */
export function collapseHome(
  p: string,
  home: string = HOME,
  platform: string = process.platform,
): string {
  if (!isPathPrefix(home, p, platform)) return p;
  return `~${p.slice(home.length)}`;
}

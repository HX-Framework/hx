// Device-local sync settings — the daemon-honored side of the HX Client UI's
// privacy controls. Lives in ~/.let/hx/settings.json (0600). The watch loop
// re-reads it every tick (it's tiny), so a change from the UI server — a
// separate process — takes effect within one poll interval. This file is the
// ONLY channel between the UI server and the running daemon: state.json stays
// single-writer (the daemon).
//
// Semantics (product-decided):
//   • pause      — uploads stop entirely; the daemon stays alive, heartbeats
//                  continue (the device reads "online, paused" — not vanished).
//   • personalSync=false — sessions that would attach to no workspace stay on
//                  this machine. Device-side signal: a session whose folder
//                  has NO detected git repo (repoSlug === null). A repo whose
//                  attribution is UNKNOWN (legacy state entry, repoSlug
//                  undefined) uploads — the safe default is "work".
//   • excludedFolders / excludeRules — never upload matching folders. Rules
//                  are ~-collapsed path prefixes and also cover folders that
//                  don't exist yet.
//   • dataDirs   — extra data-dir ROOTS to watch besides ~/.claude / ~/.codex
//                  (the CLAUDE_CONFIG_DIR / CODEX_HOME value itself, never the
//                  projects/ or sessions/ subdir). Entries may not exist yet —
//                  like excludeRules, they arm for when the dir appears.

import { join } from "node:path";
import { readFile, rename, writeFile } from "node:fs/promises";
import { HX_DIR } from "./hx-home.js";
import { collapseHome, isPathPrefix, normalizeDataDir, samePath } from "./pathnorm.js";
import {
  DEFAULT_CLAUDE_ROOT,
  DEFAULT_CODEX_ROOT,
  samePhysicalDir,
} from "./roots.js";

export { collapseHome, normalizeDataDir } from "./pathnorm.js";

export const SETTINGS_PATH = join(HX_DIR, "settings.json");

export interface ExcludedFolder {
  family: string;
  /** ~-collapsed working directory, as shown in the UI. */
  cwd: string;
}

/** Extra watch roots per family, normalized absolute paths. */
export interface DataDirs {
  claude: string[];
  codex: string[];
}

export interface HxSettings {
  /** null = not paused; untilMs null = paused until manually resumed. */
  pause: { untilMs: number | null } | null;
  personalSync: boolean;
  excludedFolders: ExcludedFolder[];
  excludeRules: string[];
  dataDirs: DataDirs;
  /** Operational tuning knobs (LETAIR-144) — an OPAQUE round-trip object.
   *  Subkeys are read by the consumers that own them (the watch loop / upload
   *  scheduler), never normalized here: field-rebuilding this object is
   *  exactly the historical bug that made settings.json unable to carry new
   *  keys (every write erased unknowns). Ops-only surface: written by hand,
   *  not exposed in the UI, absent by default. */
  tuning?: Record<string, unknown>;
}

export const DEFAULT_SETTINGS: HxSettings = {
  pause: null,
  personalSync: true,
  excludedFolders: [],
  excludeRules: [],
  dataDirs: { claude: [], codex: [] },
};

/** Hard cap per family — bounds the discovery fan-out a config can demand. */
export const MAX_DATA_DIRS_PER_FAMILY = 8;

function parseDataDirList(v: unknown, defaultRoot: string): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const dir = normalizeDataDir(item);
    if (!dir || out.includes(dir)) continue;
    // Self-heal PHYSICAL aliases — of the family default, or of an entry
    // already kept from this list (same dir via a symlinked spelling, or a
    // dir that BECAME a symlink after it was added). The resolver would
    // dedupe them at watch time anyway, but a lingering alias renders no
    // Remove row (ghost), eats one of the 8 slots, and — for default
    // aliases — used to trip full-array re-validation on every later
    // mutation. Dropped on read AND persisted-dropped on the next write;
    // first spelling wins.
    if (samePhysicalDir(dir, defaultRoot)) continue;
    if (out.some((kept) => samePhysicalDir(kept, dir))) continue;
    out.push(dir);
    if (out.length >= MAX_DATA_DIRS_PER_FAMILY) break;
  }
  return out;
}

/** Parse + normalize a dataDirs value from disk or a settings patch. */
export function parseDataDirs(v: unknown): DataDirs {
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  return {
    claude: parseDataDirList(o.claude, DEFAULT_CLAUDE_ROOT),
    codex: parseDataDirList(o.codex, DEFAULT_CODEX_ROOT),
  };
}

/**
 * Strict validation for a dataDirs PATCH from the UI server. Where the disk
 * parser silently drops garbage (a hand-edited file shouldn't brick the
 * daemon), an API write must reject it loudly. Returns an error message, or
 * null when the value is acceptable.
 */
export function dataDirsPatchError(v: unknown): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "dataDirs must be an object";
  for (const key of Object.keys(v)) {
    if (key !== "claude" && key !== "codex") return `unknown dataDirs family: ${key}`;
  }
  for (const family of ["claude", "codex"] as const) {
    const list = (v as Record<string, unknown>)[family];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return `dataDirs.${family} must be an array`;
    if (list.length > MAX_DATA_DIRS_PER_FAMILY) {
      return `dataDirs.${family}: at most ${MAX_DATA_DIRS_PER_FAMILY} locations`;
    }
    for (const item of list) {
      if (typeof item !== "string") return `dataDirs.${family}: entries must be strings`;
      if (!normalizeDataDir(item)) {
        return `dataDirs.${family}: not an absolute (or ~-prefixed) path`;
      }
    }
  }
  return null;
}

export async function readSettings(path: string = SETTINGS_PATH): Promise<HxSettings> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed
    // path under ~/.let/hx (tests inject a tmp path), never request input.
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown> & Partial<HxSettings>;
    // Unknown top-level keys ride through VERBATIM (`tuning`, and anything a
    // newer binary defines that this one doesn't know yet). The historical
    // five-field rebuild silently erased them on the next write — which made
    // settings.json unable to carry new keys across mixed-version fleets.
    const {
      pause: _pause,
      personalSync: _personal,
      excludedFolders: _folders,
      excludeRules: _rules,
      dataDirs: _dirs,
      ...unknownRest
    } = parsed;
    return {
      ...unknownRest,
      pause:
        parsed.pause && typeof parsed.pause === "object"
          ? { untilMs: typeof parsed.pause.untilMs === "number" ? parsed.pause.untilMs : null }
          : null,
      personalSync: parsed.personalSync !== false,
      excludedFolders: Array.isArray(parsed.excludedFolders)
        ? parsed.excludedFolders.filter(
            (f): f is ExcludedFolder =>
              typeof f?.family === "string" && typeof f?.cwd === "string",
          )
        : [],
      excludeRules: Array.isArray(parsed.excludeRules)
        ? parsed.excludeRules.filter((r): r is string => typeof r === "string")
        : [],
      dataDirs: parseDataDirs(parsed.dataDirs),
    };
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      excludedFolders: [],
      excludeRules: [],
      dataDirs: { claude: [], codex: [] },
    };
  }
}

/** Typed view of one tuning subkey — consumers own their keys' semantics;
 *  anything absent or mistyped reads as undefined (never a throw, never a
 *  normalization write-back). */
export function tuningValue(s: HxSettings, key: string): unknown {
  const t = s.tuning;
  if (!t || typeof t !== "object" || Array.isArray(t)) return undefined;
  return (t as Record<string, unknown>)[key];
}

// Writes are read-merge-write; two concurrent PATCHes (the UI's async add
// racing a fire-and-forget toggle, or two tabs) would silently drop one
// caller's fields. Chain per path — the same single-writer discipline
// state.json gets from schedulePersist — and give every write its own tmp
// name so racing processes can't rename each other's half-written files.
let writeSeq = 0;
const writeChains = new Map<string, Promise<HxSettings>>();

export function writeSettings(
  patch: Partial<HxSettings>,
  path: string = SETTINGS_PATH,
): Promise<HxSettings> {
  const prev = writeChains.get(path) ?? Promise.resolve(null as unknown as HxSettings);
  const next = prev.then(
    () => applySettingsPatch(patch, path),
    () => applySettingsPatch(patch, path),
  );
  writeChains.set(path, next);
  return next;
}

async function applySettingsPatch(
  patch: Partial<HxSettings>,
  path: string,
): Promise<HxSettings> {
  const current = await readSettings(path);
  const next: HxSettings = { ...current, ...patch };
  // dataDirs merges PER FAMILY: the validator accepts a patch that names only
  // one family, so an omitted family must mean "unchanged" — a whole-object
  // replace would silently erase the other family's roots on a 200. Also
  // normalize on write as well as read, so a patch that arrived un-normalized
  // (older UI, hand-edited file) never persists a non-canonical root.
  const patchDirs = (patch as { dataDirs?: unknown }).dataDirs;
  if (patchDirs !== undefined && patchDirs !== null && typeof patchDirs === "object" && !Array.isArray(patchDirs)) {
    const pd = patchDirs as Record<string, unknown>;
    // Non-array per-family values (a direct caller's garbage — the API
    // validator 400s them first) also mean "unchanged", same as omission:
    // parseDataDirList would turn them into a silent one-family wipe.
    next.dataDirs = parseDataDirs({
      claude: Array.isArray(pd.claude) ? pd.claude : current.dataDirs.claude,
      codex: Array.isArray(pd.codex) ? pd.codex : current.dataDirs.codex,
    });
  } else {
    // No dataDirs in the patch — or garbage (null/array) a direct caller
    // slipped past the API validator. Either way: keep the current roots;
    // parse re-normalizes legacy on-disk values, never wipes.
    next.dataDirs = parseDataDirs(current.dataDirs);
  }
  writeSeq += 1;
  const tmp = `${path}.${process.pid}.${writeSeq}.tmp`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see readSettings.
  await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await rename(tmp, path);
  return next;
}

export function isPaused(s: HxSettings, nowMs = Date.now()): boolean {
  if (!s.pause) return false;
  if (s.pause.untilMs === null) return true;
  return nowMs < s.pause.untilMs;
}

/**
 * Prefix match on ~-collapsed paths, boundary-aware ("~/a" ≠ "~/ab") and
 * canonical across separator spelling + filesystem case (see pathnorm.ts).
 *
 * The separator used to be a hardcoded "/", which made every rule a silent
 * no-op on Windows: a cwd of `C:\\Users\\me\\proj` can never start with
 * `C:\\Users\\me/`. excludeRules is a PRIVACY control, so failing to match
 * meant failing OPEN — the folder the user excluded uploaded anyway.
 *
 * Both sides are collapsed first so a hand-edited absolute rule still matches
 * the ~-collapsed cwd the daemon records.
 */
function ruleMatches(rule: string, cwd: string): boolean {
  return isPathPrefix(collapseHome(rule), collapseHome(cwd));
}

export interface FileSyncIdentity {
  family: string;
  /** ~-collapsed cwd; undefined = unknown (legacy state entry). */
  cwd?: string;
  /** null = known to have no repo; undefined = unknown. */
  repoSlug?: string | null;
  /** Gateway-confirmed workspace attribution; false = repo attaches to no
   *  workspace (personal); undefined = unknown (older gateway / unresolved). */
  attributed?: boolean;
}

/**
 * Should this file stay on the machine under the current settings?
 * Personal = no repo, or a repo the gateway confirmed attaches to no
 * workspace. Unknown identity (legacy entries, older gateways) never
 * matches — the safe default is to keep uploading work.
 */
export function shouldSkipFile(s: HxSettings, id: FileSyncIdentity): boolean {
  if (id.cwd !== undefined) {
    for (const ex of s.excludedFolders) {
      if (ex.family === id.family && samePath(ex.cwd, id.cwd)) return true;
    }
    for (const rule of s.excludeRules) {
      if (ruleMatches(rule, id.cwd)) return true;
    }
  }
  if (!s.personalSync && (id.repoSlug === null || id.attributed === false)) return true;
  return false;
}

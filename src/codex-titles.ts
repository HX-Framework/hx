// Read Codex CLI's OWN session title from its state SQLite DB.
//
// Codex does NOT put a title in the rollout JSONL the daemon ingests (the old
// `thread_meta.title` lookup in readHead never matched — modern codex writes no
// such record). The title lives in `~/.codex/state_<N>.sqlite` — the schema
// epoch is baked into the filename (const STATE_DB_FILENAME = "state_5.sqlite"
// in codex-rs), table `threads`:
//   • id     TEXT PRIMARY KEY  — the thread/session id, equal to the rollout's
//                               session_meta.payload.id (what readHead reads).
//   • title  TEXT NOT NULL     — codex's auto title (its own derivation: the
//                               first user message with protocol prefixes stripped).
//   • name   TEXT              — the user-set name (`codex rename` / `--name`),
//                               added in migration 0041; absent on older schemas.
//
// We NEVER invent a name: codex may change how it titles sessions, so we pass its
// stored value through verbatim — `name` (a deliberate user rename) wins over the
// auto `title`. Read-only and non-throwing: an absent DB, a locked/corrupt file,
// an older schema without `name`, or a codex install predating the state DB all
// degrade to "no title" (the session keeps its first-message floor), retried next
// pass.

import { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

export type CodexTitle = { title: string; source: "user" | "ai" };

// id→title map cached per codex home, reused until the DB's mtime+size changes or
// a short TTL lapses — a pass over many sessions then opens the DB at most once.
// Mirrors the caching in ccd.ts.
const TTL_MS = 10_000;
interface Cached {
  atMs: number;
  fp: string;
  map: Map<string, CodexTitle>;
}
const cache = new Map<string, Cached>();

/** Newest `state_<N>.sqlite` under a codex home, or null. Codex bakes the schema
 *  epoch into the filename (state_5.sqlite today); picking the highest N follows
 *  a bump without a code change and ignores stale older epochs left on disk. */
function stateDbPath(codexHome: string): string | null {
  let best: { n: number; p: string } | null = null;
  let entries: string[];
  try {
    entries = readdirSync(codexHome);
  } catch {
    return null; // no codex home (yet)
  }
  for (const e of entries) {
    const m = /^state_(\d+)\.sqlite$/.exec(e);
    if (!m) continue;
    const n = Number(m[1]);
    if (!best || n > best.n) best = { n, p: path.join(codexHome, e) };
  }
  return best?.p ?? null;
}

// Fingerprint the DB *and* its -wal sidecar: SQLite defaults to WAL mode, where
// a write lands in <db>-wal and the main file's mtime/size need not change until
// a checkpoint — so a title update would otherwise only be seen on the TTL lapse.
// Including -wal invalidates the cache the moment codex writes. (The TTL still
// bounds staleness if a filesystem reports mtime coarsely.)
function fingerprint(dbPath: string): string {
  const part = (p: string): string => {
    try {
      const s = statSync(p);
      return `${s.size}:${Math.trunc(s.mtimeMs)}`;
    } catch {
      return "-";
    }
  };
  const db = part(dbPath);
  if (db === "-") return "absent";
  return `${db}|${part(`${dbPath}-wal`)}`;
}

/** codex's own name for one row: a user rename beats the auto title; both trimmed
 *  and empty-rejected so a blank never becomes a title. */
function pick(nameRaw: unknown, titleRaw: unknown): CodexTitle | null {
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (name) return { title: name, source: "user" };
  const title = typeof titleRaw === "string" ? titleRaw.trim() : "";
  if (title) return { title, source: "ai" };
  return null;
}

/** Read every thread's title from a codex home's state DB. Never throws: any
 *  failure (no DB, locked, corrupt, unexpected schema) yields an empty map. */
function loadMap(codexHome: string): Map<string, CodexTitle> {
  const out = new Map<string, CodexTitle>();
  const dbPath = stateDbPath(codexHome);
  if (!dbPath) return out;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    // `name` (migration 0041) is absent on older schemas — try with it, fall
    // back to title-only rather than introspect, so both schemas just work.
    let rows: Array<{ id: unknown; name?: unknown; title: unknown }>;
    try {
      rows = db.query(`SELECT id, name, title FROM threads`).all() as typeof rows;
    } catch {
      rows = db.query(`SELECT id, title FROM threads`).all() as typeof rows;
    }
    for (const row of rows) {
      if (typeof row.id !== "string") continue;
      const t = pick(row.name, row.title);
      if (t) out.set(row.id, t);
    }
  } catch {
    // absent `threads` table, locked/corrupt DB, or a codex too old for it.
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort */
    }
  }
  return out;
}

function mapFor(codexHome: string): Map<string, CodexTitle> {
  const nowMs = Date.now();
  const dbPath = stateDbPath(codexHome);
  const fp = dbPath ? fingerprint(dbPath) : "absent";
  const hit = cache.get(codexHome);
  if (hit && nowMs - hit.atMs < TTL_MS && hit.fp === fp) return hit.map;
  const map = loadMap(codexHome);
  cache.set(codexHome, { atMs: nowMs, fp, map });
  return map;
}

/** Codex's own name for a session id, or null when codex has none. `name` (a
 *  user `codex rename`) wins over the auto `title`. Passed through verbatim — we
 *  never derive a name ourselves. */
export function readCodexTitle(codexHome: string, sessionId: string): CodexTitle | null {
  if (!sessionId) return null;
  return mapFor(codexHome).get(sessionId) ?? null;
}

/** Test seam — drop the cache so a fixture DB is re-read within one process. */
export function resetCodexTitleCacheForTests(): void {
  cache.clear();
}

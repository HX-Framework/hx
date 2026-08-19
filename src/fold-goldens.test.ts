// Fold-freeze characterization golden (LETAIR-144, verification items 3/17).
//
// The perf work's core correctness guarantee is that the pure status folds
// are NOT edited — every percentage and bucket is computed by the exact same
// code from equivalent inputs. This golden pins their combined output over a
// rich fixture: the expected JSON was CAPTURED BY RUNNING THIS SAME HARNESS
// ON THE PRISTINE BASE COMMIT (e3fea5e) and committed verbatim, so any
// behavioral drift in electUploaders / filterWatched / snapshotFrom /
// collectSkipped / collectBehind / buildLedger fails this test byte-for-byte.
//
// Regenerate ONLY from an unmodified base checkout:
//   GOLDEN_WRITE=1 bun test src/fold-goldens.test.ts
// (writes src/__fixtures__/fold-goldens.expected.json — never regenerate on a
// branch that touches fold code; that would defeat the freeze.)

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildLedger } from "./ledger.js";
import type { DiscoveredFile } from "./sources.js";
import type { DataRoot } from "./roots.js";
import type { HxSettings } from "./settings.js";
import type { FileState, HxState } from "./state.js";
import { collectBehind, collectSkipped, filterWatched, snapshotFrom } from "./watch.js";

const NOW = 1_755_400_000_000; // fixed clock — every age in the ledger derives from it
const H = 3_600_000;

const file = (path: string, size: number, mtimeMs: number, source: "claude" | "codex" = "claude"): DiscoveredFile => ({
  path,
  size,
  mtimeMs,
  source,
  rootDir: "/home/u/.claude",
});

const fstate = (over: Partial<FileState> & { path: string; sessionId: string }): FileState => ({
  family: "claude-cli",
  offsets: {},
  lastMtimeMs: 0,
  lastUploadAtMs: 0,
  ...over,
});

function fixture(): {
  files: DiscoveredFile[];
  state: HxState;
  settings: HxSettings;
  roots: DataRoot[];
} {
  const files: DiscoveredFile[] = [
    file("/home/u/.claude/projects/pa/s1.jsonl", 10_000, NOW - 1 * H), // fully delivered
    file("/home/u/.claude/projects/pa/s2.jsonl", 50_000, NOW - 2 * H), // mid-upload, multi-dest
    file("/home/u/.claude/projects/pb/s3.jsonl", 20_000, NOW - 3 * H), // held on an offline vault
    file("/home/u/.claude/projects/pb/s4-live.jsonl", 9_000, NOW - 1 * H), // twin (live, newer)
    file("/home/u/.claude/projects/pc/s4-copy.jsonl", 9_500, NOW - 20 * H), // twin (stale copy, larger)
    file("/home/u/.claude/projects/pd/s5.jsonl", 4_000, NOW - 5 * H), // excluded folder
    file("/home/u/.claude/projects/pe/s6.jsonl", 6_000, NOW - 6 * H), // tombstoned session
    file("/home/u/.claude/projects/pf/s7.jsonl", 7_000, NOW - 7 * H), // personal (repo-less), gate armed
  ];
  const state: HxState = {
    files: {
      "/home/u/.claude/projects/pa/s1.jsonl": fstate({
        path: "/home/u/.claude/projects/pa/s1.jsonl",
        sessionId: "s1",
        cwd: "~/work/a",
        repoSlug: "acme/a",
        attributed: true,
        offsets: { letai: 10_000 },
        lastKnownSize: 10_000,
        lastMtimeMs: NOW - 1 * H,
        lastUploadAtMs: NOW - 1 * H,
      }),
      "/home/u/.claude/projects/pa/s2.jsonl": fstate({
        path: "/home/u/.claude/projects/pa/s2.jsonl",
        sessionId: "s2",
        cwd: "~/work/a",
        repoSlug: "acme/a",
        attributed: true,
        offsets: { letai: 50_000, orgV: 30_000 },
        lastKnownSize: 50_000,
        lastMtimeMs: NOW - 2 * H,
        lastUploadAtMs: NOW - 2 * H,
      }),
      "/home/u/.claude/projects/pb/s3.jsonl": fstate({
        path: "/home/u/.claude/projects/pb/s3.jsonl",
        sessionId: "s3",
        cwd: "~/work/b",
        repoSlug: "acme/b",
        attributed: true,
        offsets: { letai: 20_000, orgV: 0 },
        lastKnownSize: 20_000,
        lastMtimeMs: NOW - 3 * H,
        lastUploadAtMs: NOW - 3 * H,
        skipReason: "vault_offline",
        consecutiveFailures: 4,
        nextAttemptAtMs: NOW + 10 * 60_000,
        blocker: {
          reason: "vault_offline",
          destinations: [
            {
              vaultOrgId: "orgV",
              reason: "vault_offline",
              orgName: "Vault Org",
              orgSlug: "vault-org",
              projectId: null,
              projectName: null,
              projectSlug: null,
              repoSlug: "acme/b",
              lastSeenAt: "2026-08-15T00:00:00.000Z",
            },
          ],
          firstSeenAtMs: NOW - 26 * H,
          lastSeenAtMs: NOW - 1 * H,
        },
      }),
      "/home/u/.claude/projects/pb/s4-live.jsonl": fstate({
        path: "/home/u/.claude/projects/pb/s4-live.jsonl",
        sessionId: "s4",
        cwd: "~/work/b",
        repoSlug: "acme/b",
        offsets: { letai: 8_000 },
        lastKnownSize: 9_000,
        lastMtimeMs: NOW - 1 * H,
        lastUploadAtMs: NOW - 1 * H,
      }),
      "/home/u/.claude/projects/pc/s4-copy.jsonl": fstate({
        path: "/home/u/.claude/projects/pc/s4-copy.jsonl",
        sessionId: "s4",
        cwd: "~/work/b",
        repoSlug: "acme/b",
        offsets: { letai: 9_500 },
        lastKnownSize: 9_500,
        lastMtimeMs: NOW - 20 * H,
        lastUploadAtMs: NOW - 20 * H,
      }),
      "/home/u/.claude/projects/pd/s5.jsonl": fstate({
        path: "/home/u/.claude/projects/pd/s5.jsonl",
        sessionId: "s5",
        cwd: "~/private/d",
        repoSlug: null,
        offsets: {},
        lastKnownSize: 4_000,
        lastMtimeMs: NOW - 5 * H,
      }),
      "/home/u/.claude/projects/pe/s6.jsonl": fstate({
        path: "/home/u/.claude/projects/pe/s6.jsonl",
        sessionId: "s6",
        cwd: "~/work/e",
        repoSlug: "acme/e",
        offsets: { letai: 1_000 },
        lastKnownSize: 6_000,
        lastMtimeMs: NOW - 6 * H,
      }),
      "/home/u/.claude/projects/pf/s7.jsonl": fstate({
        path: "/home/u/.claude/projects/pf/s7.jsonl",
        sessionId: "s7",
        cwd: "~/personal/f",
        repoSlug: null,
        attributed: false,
        offsets: {},
        lastKnownSize: 7_000,
        lastMtimeMs: NOW - 7 * H,
      }),
      // Aged-out mid-upload: still tracked, no longer discovered, under a root.
      "/home/u/.claude/projects/pg/s8.jsonl": fstate({
        path: "/home/u/.claude/projects/pg/s8.jsonl",
        sessionId: "s8",
        cwd: "~/work/g",
        repoSlug: "acme/g",
        offsets: { letai: 2_000 },
        lastKnownSize: 12_000,
        lastMtimeMs: NOW - 40 * 24 * H,
      }),
      // Unwatched: partially-uploaded under NO current root (root removed).
      "/mnt/old-root/.claude/projects/px/s9.jsonl": fstate({
        path: "/mnt/old-root/.claude/projects/px/s9.jsonl",
        sessionId: "s9",
        cwd: "~/work/x",
        offsets: { letai: 100 },
        lastKnownSize: 5_000,
        lastMtimeMs: NOW - 50 * 24 * H,
      }),
      // Child lane entry (excluded from session surfaces, counted separately).
      "/home/u/.claude/projects/pa/s1/subagents/agent-x1.jsonl": fstate({
        path: "/home/u/.claude/projects/pa/s1/subagents/agent-x1.jsonl",
        sessionId: "s1",
        offsets: { letai: 500 },
        lastKnownSize: 800,
        lastMtimeMs: NOW - 1 * H,
      }),
    },
    destinations: {
      letai: { vaultOrgId: null, status: "ready", observedAtMs: NOW - 1 * H },
      orgV: {
        vaultOrgId: "orgV",
        status: "held",
        orgName: "Vault Org",
        orgSlug: "vault-org",
        lastSeenAt: "2026-08-15T00:00:00.000Z",
        heldSinceMs: NOW - 26 * H,
        observedAtMs: NOW - 1 * H,
        consecutiveErrors: 3,
        lastErrorCode: "403 SignatureDoesNotMatch",
        lastErrorAtMs: NOW - 2 * H,
        failingSinceMs: NOW - 12 * H,
      },
    },
    deletedSessions: { "claude-cli:s6": NOW - 10 * H },
    artifacts: { "claude-cli:s1:tasks": "hash1" },
    childUploaders: { "s1:x1:": "/home/u/.claude/projects/pa/s1/subagents/agent-x1.jsonl" },
  };
  const settings: HxSettings = {
    pause: null,
    personalSync: false,
    excludedFolders: [{ family: "claude-cli", cwd: "~/private/d" }],
    excludeRules: [],
    dataDirs: { claude: [], codex: [] },
  };
  const roots: DataRoot[] = [{ configDir: "/home/u/.claude", origin: "default", exists: true }];
  return { files, state, settings, roots };
}

function computeAll(): unknown {
  const { files, state, settings, roots } = fixture();
  // Election happens upstream of these folds and is not exported on the base
  // commit; it is frozen by the diff itself (zero edits to electUploaders —
  // the review gate checks that). The fixture applies its known outcome: the
  // stale s4 twin loses to the newer live file and is shadowed.
  const elected = files.filter((f) => f.path !== "/home/u/.claude/projects/pc/s4-copy.jsonl");
  const watched = filterWatched(elected, state, settings);
  const discovered = new Set(files.map((f) => f.path));
  const liveSessions = new Set<string>();
  for (const f of files) {
    const fs = state.files[f.path];
    if (fs) liveSessions.add(`${fs.family}:${fs.sessionId}`);
  }
  const { behind, unwatched } = collectBehind(state, discovered, liveSessions, roots);
  return {
    watchedPaths: watched.map((f) => f.path).sort(),
    snapshot: snapshotFrom(watched, state),
    skipped: collectSkipped(watched, state),
    behind: behind.sort((a, b) => a.path.localeCompare(b.path)),
    unwatched,
    ledger: buildLedger({
      files: watched,
      state,
      incompleteSessions: new Set(behind.map((b) => b.sessionId)).size,
      nowMs: NOW,
      orgNames: { orgV: "Vault Org" },
    }),
  };
}

const EXPECTED_PATH = join(import.meta.dir, "__fixtures__", "fold-goldens.expected.json");

describe("fold-freeze golden", () => {
  it("matches the output captured on the pristine base commit", () => {
    const actual = JSON.stringify(computeAll(), null, 2);
    if (process.env["GOLDEN_WRITE"] === "1") {
      mkdirSync(dirname(EXPECTED_PATH), { recursive: true });
      writeFileSync(EXPECTED_PATH, actual);
      return;
    }
    // Normalize CRLF: a Windows checkout with core.autocrlf rewrites the
    // fixture's line endings on disk; the golden pins fold OUTPUT bytes, not
    // the checkout's text-encoding policy.
    const expected = readFileSync(EXPECTED_PATH, "utf8").replace(/\r\n/g, "\n");
    assert.equal(actual, expected);
  });
});

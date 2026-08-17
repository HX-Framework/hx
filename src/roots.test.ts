import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type HxSettings } from "./settings.js";
import {
  DEFAULT_CLAUDE_ROOT,
  DEFAULT_CODEX_ROOT,
  invalidateRootsMemo,
  duplicateRootError,
  isUnderRoots,
  resolveDataRoots,
  rootsSignature,
  samePhysicalDir,
  type DataRoot,
} from "./roots.js";

const settingsWith = (dataDirs: HxSettings["dataDirs"]): HxSettings => ({
  ...DEFAULT_SETTINGS,
  dataDirs,
});

const tmp = () => mkdtempSync(join(tmpdir(), "hx-roots-"));

describe("resolveDataRoots", () => {
  it("zero-config: exactly the default roots, nothing else", () => {
    const r = resolveDataRoots(DEFAULT_SETTINGS, {});
    assert.deepEqual(
      r.claude.map((d) => [d.configDir, d.origin]),
      [[DEFAULT_CLAUDE_ROOT, "default"]],
    );
    assert.deepEqual(
      r.codex.map((d) => [d.configDir, d.origin]),
      [[DEFAULT_CODEX_ROOT, "default"]],
    );
  });

  it("orders default → settings → env, with per-family env vars", () => {
    const base = tmp();
    const a = join(base, "a");
    const b = join(base, "b");
    mkdirSync(a);
    const r = resolveDataRoots(settingsWith({ claude: [a], codex: [] }), {
      CLAUDE_CONFIG_DIR: b,
      CODEX_HOME: join(base, "codex-home"),
    });
    // The default root's `exists` reflects the machine running the tests
    // (CI has no ~/.claude) — assert identity/origin for it, exists only for
    // the tmp-based entries, which are deterministic.
    assert.deepEqual(
      r.claude.map((d) => [d.configDir, d.origin]),
      [
        [DEFAULT_CLAUDE_ROOT, "default"],
        [a, "settings"],
        [b, "env"],
      ],
    );
    assert.equal(r.claude[1]?.exists, true);
    assert.equal(r.claude[2]?.exists, false); // listed though missing — arms for creation
    assert.deepEqual(
      r.codex.map((d) => [d.configDir, d.origin]),
      [
        [DEFAULT_CODEX_ROOT, "default"],
        [join(base, "codex-home"), "env"],
      ],
    );
  });

  it("drops relative or garbage env values instead of half-honoring them", () => {
    const r = resolveDataRoots(DEFAULT_SETTINGS, {
      CLAUDE_CONFIG_DIR: "relative/claude",
      CODEX_HOME: "",
    });
    assert.equal(r.claude.length, 1);
    assert.equal(r.codex.length, 1);
  });

  it("expands ~ in settings entries", () => {
    const r = resolveDataRoots(settingsWith({ claude: ["~/custom-hx-root"], codex: [] }), {});
    assert.equal(r.claude[1]?.configDir, join(homedir(), "custom-hx-root"));
  });

  it("dedupes a symlinked twin of a watched root by physical identity", () => {
    const base = tmp();
    const real = join(base, "real-root");
    const link = join(base, "link-root");
    mkdirSync(real);
    symlinkSync(real, link);
    const r = resolveDataRoots(settingsWith({ claude: [real], codex: [] }), {
      CLAUDE_CONFIG_DIR: link,
    });
    // default + real; the symlink resolves to the same physical dir and drops.
    assert.deepEqual(
      r.claude.map((d) => d.configDir),
      [DEFAULT_CLAUDE_ROOT, real],
    );
  });

  it("dedupes repeated missing dirs by normalized name", () => {
    const missing = join(tmp(), "not-created-yet");
    const r = resolveDataRoots(settingsWith({ claude: [missing, `${missing}/`], codex: [] }), {
      CLAUDE_CONFIG_DIR: missing,
    });
    assert.deepEqual(
      r.claude.map((d) => d.configDir),
      [DEFAULT_CLAUDE_ROOT, missing],
    );
    assert.equal(r.claude[1]?.exists, false);
  });
});

// Asserts POSIX path semantics with POSIX literals ("/a", "relative/path"),
// so it cannot hold on Windows, where those are not absolute and normalize
// with backslashes. Not a gap in Windows support — the behavior under test
// is the platform's, and the Windows-specific paths have their own tests.
describe.skipIf(process.platform === "win32")("isUnderRoots", () => {
  const roots: DataRoot[] = [{ configDir: "/data/hx-a", origin: "settings", exists: true }];
  it("matches the root itself and its children, boundary-aware", () => {
    assert.equal(isUnderRoots("/data/hx-a", roots), true);
    assert.equal(isUnderRoots("/data/hx-a/projects/x/s.jsonl", roots), true);
    assert.equal(isUnderRoots("/data/hx-ab/projects/x/s.jsonl", roots), false);
    assert.equal(isUnderRoots("/elsewhere", roots), false);
  });

  it("handles the filesystem root without doubling the separator", () => {
    const slash: DataRoot[] = [{ configDir: "/", origin: "settings", exists: true }];
    assert.equal(isUnderRoots("/", slash), true);
    assert.equal(isUnderRoots("/anything/at/all.jsonl", slash), true);
  });
});

describe("duplicateRootError", () => {
  it("rejects the family default (any spelling) and passes real extras", () => {
    assert.match(duplicateRootError({ claude: [DEFAULT_CLAUDE_ROOT] }) ?? "", /already watched/);
    assert.match(duplicateRootError({ codex: [`${DEFAULT_CODEX_ROOT}/`] }) ?? "", /already watched/);
    assert.equal(duplicateRootError({ claude: ["/data/elsewhere"], codex: [] }), null);
    assert.equal(duplicateRootError({}), null);
  });

  it("exempts entries already present in current settings — stale aliases must not brick mutations", () => {
    // "/data/claude" is a pre-existing entry whose dir later became a symlink
    // to the default; validating only NEW entries lets unrelated mutations
    // through (the write path self-heals the alias).
    assert.equal(
      duplicateRootError(
        { claude: [DEFAULT_CLAUDE_ROOT], codex: [] },
        { claude: [DEFAULT_CLAUDE_ROOT], codex: [] },
      ),
      null,
    );
    assert.match(
      duplicateRootError(
        { claude: ["/data/other", DEFAULT_CLAUDE_ROOT] },
        { claude: ["/data/other"], codex: [] },
      ) ?? "",
      /already watched/,
    );
  });

  it("rejects a NEW symlinked spelling of an already-watched custom root", () => {
    const base = tmp();
    const real = join(base, "real-root");
    const link = join(base, "twin-root");
    mkdirSync(real);
    symlinkSync(real, link);
    // Twin of an existing settings entry → 400.
    assert.match(
      duplicateRootError({ claude: [real, link] }, { claude: [real], codex: [] }) ?? "",
      /already watched/,
    );
    // Twin pair arriving in the SAME patch → 400 too.
    assert.match(duplicateRootError({ claude: [real, link] }) ?? "", /already watched/);
  });
});

describe("samePhysicalDir", () => {
  it("matches identical strings, symlinked twins, and rejects distinct dirs", () => {
    const base = tmp();
    const real = join(base, "real");
    const link = join(base, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    assert.equal(samePhysicalDir(real, real), true);
    assert.equal(samePhysicalDir(real, link), true);
    assert.equal(samePhysicalDir(real, join(base, "other")), false);
    // Missing dirs fall back to string identity.
    assert.equal(samePhysicalDir("/nope/a", "/nope/a"), true);
    assert.equal(samePhysicalDir("/nope/a", "/nope/b"), false);
  });
});

describe("rootsSignature", () => {
  it("changes when the set, origin, or existence changes — stable otherwise", () => {
    const a = resolveDataRoots(DEFAULT_SETTINGS, {});
    const b = resolveDataRoots(DEFAULT_SETTINGS, {});
    assert.equal(rootsSignature(a), rootsSignature(b));
    const withExtra = resolveDataRoots(settingsWith({ claude: ["/data/x"], codex: [] }), {});
    assert.notEqual(rootsSignature(a), rootsSignature(withExtra));
  });
});

describe("resolveDataRoots memo", () => {
  it("collapses same-key calls within the TTL; a settings change bypasses it", () => {
    invalidateRootsMemo();
    const base = tmp();
    const dir = join(base, "root-a");
    const s = settingsWith({ claude: [dir], codex: [] });
    const first = resolveDataRoots(s, {});
    assert.equal(first.claude[1]?.exists, false);
    // Same key inside the TTL: the memoized value comes back — an fs change
    // between two same-tick calls is deliberately NOT re-observed (roots were
    // only ever read at tick boundaries; the TTL sits under the tick).
    mkdirSync(dir);
    assert.equal(resolveDataRoots(s, {}), first);
    // A different input key (settings edit) resolves fresh immediately.
    const s2 = settingsWith({ claude: [dir, join(base, "root-b")], codex: [] });
    const fresh = resolveDataRoots(s2, {});
    assert.equal(fresh.claude[1]?.exists, true);
    // And after the memo drops, the same key re-observes the filesystem.
    invalidateRootsMemo();
    assert.equal(resolveDataRoots(s, {}).claude[1]?.exists, true);
  });
});

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CLAUDE_ROOT } from "./roots.js";
import {
  DEFAULT_SETTINGS,
  MAX_DATA_DIRS_PER_FAMILY,
  dataDirsPatchError,
  isPaused,
  normalizeDataDir,
  parseDataDirs,
  readSettings,
  shouldSkipFile,
  writeSettings,
  type HxSettings,
} from "./settings.js";

const tmpPath = () => join(mkdtempSync(join(tmpdir(), "hx-settings-")), "settings.json");

// Asserts POSIX path semantics with POSIX literals ("/a", "relative/path"),
// so it cannot hold on Windows, where those are not absolute and normalize
// with backslashes. Not a gap in Windows support — the behavior under test
// is the platform's, and the Windows-specific paths have their own tests.
describe.skipIf(process.platform === "win32")("settings file", () => {
  it("defaults when absent or corrupt, round-trips patches", async () => {
    const p = tmpPath();
    assert.deepEqual(await readSettings(p), DEFAULT_SETTINGS);
    await writeSettings({ personalSync: false }, p);
    await writeSettings({ pause: { untilMs: 123 } }, p);
    const s = await readSettings(p);
    assert.equal(s.personalSync, false); // earlier patch survives later ones
    assert.deepEqual(s.pause, { untilMs: 123 });
  });

  it("serializes concurrent writers — no lost updates, no shared tmp", async () => {
    const p = tmpPath();
    await Promise.all([
      writeSettings({ personalSync: false }, p),
      writeSettings({ excludeRules: ["~/kept"] }, p),
      writeSettings({ dataDirs: { claude: ["/data/kept"], codex: [] } }, p),
    ]);
    const s = await readSettings(p);
    assert.equal(s.personalSync, false);
    assert.deepEqual(s.excludeRules, ["~/kept"]);
    assert.deepEqual(s.dataDirs.claude, ["/data/kept"]);
  });

  it("sanitizes malformed fields instead of trusting them", async () => {
    const p = tmpPath();
    await writeSettings(
      {
        excludedFolders: [{ family: "claude-cli", cwd: "~/x" }, { nope: 1 } as never],
        excludeRules: ["~/ok", 42 as never],
      },
      p,
    );
    const s = await readSettings(p);
    assert.deepEqual(s.excludedFolders, [{ family: "claude-cli", cwd: "~/x" }]);
    assert.deepEqual(s.excludeRules, ["~/ok"]);
  });
});

describe.skipIf(process.platform === "win32")("normalizeDataDir", () => {
  it("expands ~, requires absolute, strips trailing separators, collapses dots", () => {
    assert.equal(normalizeDataDir("~/data"), join(homedir(), "data"));
    assert.equal(normalizeDataDir("~"), homedir());
    assert.equal(normalizeDataDir("/a/b/"), "/a/b");
    assert.equal(normalizeDataDir("/a/./b/../c"), "/a/c");
    assert.equal(normalizeDataDir("  /a/b  "), "/a/b");
  });

  it("rejects relative paths, empties, and control characters - not spaces", () => {
    assert.equal(normalizeDataDir("relative/path"), null);
    assert.equal(normalizeDataDir(""), null);
    assert.equal(normalizeDataDir("   "), null);
    assert.equal(normalizeDataDir("/Users/John Doe/claude-data"), "/Users/John Doe/claude-data");
    assert.equal(normalizeDataDir("/a\0b"), null);
    assert.equal(normalizeDataDir("/a\nb"), null);
  });

  it("keeps trailing backslashes on POSIX — a legal filename character there", () => {
    if (process.platform === "win32") return;
    assert.equal(normalizeDataDir("/data/foo\\"), "/data/foo\\");
  });
});

describe.skipIf(process.platform === "win32")("parseDataDirs", () => {
  it("normalizes, dedupes, drops non-strings, caps per family", () => {
    const parsed = parseDataDirs({
      claude: ["/a/", "/a", "~/x", 42, "relative", ...Array.from({ length: 12 }, (_, i) => `/cap/${i}`)],
      codex: "not-an-array",
    });
    assert.equal(parsed.claude[0], "/a");
    assert.equal(parsed.claude[1], join(homedir(), "x"));
    assert.ok(parsed.claude.length <= MAX_DATA_DIRS_PER_FAMILY);
    assert.deepEqual(parsed.codex, []);
  });

  it("self-heals entries that alias the family default (would brick mutations)", async () => {
    const parsed = parseDataDirs({
      claude: [DEFAULT_CLAUDE_ROOT, `${DEFAULT_CLAUDE_ROOT}/`, "/data/real"],
      codex: [],
    });
    assert.deepEqual(parsed.claude, ["/data/real"]);
    // A poisoned on-disk file heals on the next unrelated write.
    const p = tmpPath();
    writeFileSync(
      p,
      JSON.stringify({ dataDirs: { claude: [DEFAULT_CLAUDE_ROOT, "/data/real"], codex: [] } }),
    );
    await writeSettings({ personalSync: false }, p);
    const raw = JSON.parse(readFileSync(p, "utf-8")) as { dataDirs: { claude: string[] } };
    assert.deepEqual(raw.dataDirs.claude, ["/data/real"]);
  });

  it("survives a legacy settings file with no dataDirs field", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "hx-settings-")), "settings.json");
    writeFileSync(p, JSON.stringify({ personalSync: false, excludeRules: ["~/x"] }));
    const s = await readSettings(p);
    assert.deepEqual(s.dataDirs, { claude: [], codex: [] });
    assert.equal(s.personalSync, false);
  });

  it("round-trips through writeSettings with write-time normalization", async () => {
    const p = tmpPath();
    await writeSettings({ dataDirs: { claude: ["~/data-root/", "not-absolute"], codex: [] } }, p);
    const s = await readSettings(p);
    assert.deepEqual(s.dataDirs, { claude: [join(homedir(), "data-root")], codex: [] });
  });

  it("merges partial-family patches — an omitted family means unchanged, never wiped", async () => {
    const p = tmpPath();
    await writeSettings({ dataDirs: { claude: ["/data/c1"], codex: ["/data/x1"] } }, p);
    // The validator accepts a claude-only patch; codex must survive it.
    await writeSettings({ dataDirs: { claude: ["/data/c2"] } as never }, p);
    const s = await readSettings(p);
    assert.deepEqual(s.dataDirs, { claude: ["/data/c2"], codex: ["/data/x1"] });
    // And an explicit empty list still clears intentionally.
    await writeSettings({ dataDirs: { codex: [] } as never }, p);
    assert.deepEqual((await readSettings(p)).dataDirs, { claude: ["/data/c2"], codex: [] });
  });

  it("treats garbage dataDirs in a patch as unchanged, never a wipe", async () => {
    const p = tmpPath();
    await writeSettings({ dataDirs: { claude: ["/data/c1"], codex: ["/data/x1"] } }, p);
    await writeSettings({ dataDirs: null as never }, p);
    await writeSettings({ dataDirs: ["/sneaky"] as never }, p);
    // Per-family garbage is the same class, one level down.
    await writeSettings({ dataDirs: { claude: "junk", codex: null } as never }, p);
    assert.deepEqual((await readSettings(p)).dataDirs, {
      claude: ["/data/c1"],
      codex: ["/data/x1"],
    });
  });
});

describe("dataDirsPatchError", () => {
  it("accepts valid shapes, including partial families", () => {
    assert.equal(dataDirsPatchError({ claude: ["/a"], codex: [] }), null);
    assert.equal(dataDirsPatchError({ claude: ["~/x"] }), null);
    assert.equal(dataDirsPatchError({}), null);
  });

  it("rejects loudly what the disk parser would drop silently", () => {
    assert.match(dataDirsPatchError(null) ?? "", /must be an object/);
    assert.match(dataDirsPatchError([]) ?? "", /must be an object/);
    assert.match(dataDirsPatchError({ gemini: [] }) ?? "", /unknown dataDirs family/);
    assert.match(dataDirsPatchError({ claude: "nope" }) ?? "", /must be an array/);
    assert.match(dataDirsPatchError({ claude: [42] }) ?? "", /entries must be strings/);
    assert.match(dataDirsPatchError({ claude: ["relative"] }) ?? "", /absolute/);
    assert.match(
      dataDirsPatchError({ claude: Array.from({ length: 9 }, (_, i) => `/x/${i}`) }) ?? "",
      /at most/,
    );
  });
});

describe("isPaused", () => {
  it("handles unpaused, timed, expired, and forever", () => {
    assert.equal(isPaused({ ...DEFAULT_SETTINGS, pause: null }, 100), false);
    assert.equal(isPaused({ ...DEFAULT_SETTINGS, pause: { untilMs: 200 } }, 100), true);
    assert.equal(isPaused({ ...DEFAULT_SETTINGS, pause: { untilMs: 200 } }, 300), false);
    assert.equal(isPaused({ ...DEFAULT_SETTINGS, pause: { untilMs: null } }, 1e15), true);
  });
});

describe("shouldSkipFile", () => {
  const base: HxSettings = { ...DEFAULT_SETTINGS };

  it("matches excluded folders by family + cwd exactly", () => {
    const s: HxSettings = { ...base, excludedFolders: [{ family: "claude-cli", cwd: "~/w/app" }] };
    assert.equal(shouldSkipFile(s, { family: "claude-cli", cwd: "~/w/app" }), true);
    assert.equal(shouldSkipFile(s, { family: "codex-cli", cwd: "~/w/app" }), false);
    assert.equal(shouldSkipFile(s, { family: "claude-cli", cwd: "~/w/app2" }), false);
  });

  it("matches path rules as boundary-aware prefixes, future folders included", () => {
    const s: HxSettings = { ...base, excludeRules: ["~/personal-finance"] };
    assert.equal(shouldSkipFile(s, { family: "claude-cli", cwd: "~/personal-finance" }), true);
    assert.equal(shouldSkipFile(s, { family: "claude-cli", cwd: "~/personal-finance/q3" }), true);
    assert.equal(shouldSkipFile(s, { family: "claude-cli", cwd: "~/personal-finances" }), false);
  });

  it("matches a rule written as an absolute path against the ~-collapsed cwd", () => {
    // Rules are stored ~-collapsed, but a hand-edited settings.json (or an
    // older UI) can carry an absolute one. Both sides collapse before the
    // compare, so it still matches instead of silently failing open.
    const s = { ...DEFAULT_SETTINGS, excludeRules: [join(homedir(), "personal-finance")] };
    assert.equal(shouldSkipFile(s, { family: "claude-cli", cwd: "~/personal-finance/q3" }), true);
    assert.equal(shouldSkipFile(s, { family: "claude-cli", cwd: "~/work" }), false);
  });

  it("gates personal (repo-less) sessions only when personalSync is off", () => {
    const off: HxSettings = { ...base, personalSync: false };
    assert.equal(shouldSkipFile(off, { family: "claude-cli", cwd: "~/notes", repoSlug: null }), true);
    assert.equal(shouldSkipFile(off, { family: "claude-cli", cwd: "~/w", repoSlug: "acme/app" }), false);
    assert.equal(shouldSkipFile(base, { family: "claude-cli", cwd: "~/notes", repoSlug: null }), false);
  });

  it("treats unknown identity as work — never skips legacy entries blindly", () => {
    const strict: HxSettings = {
      ...base,
      personalSync: false,
      excludeRules: ["~/w"],
    };
    // No cwd, no repoSlug (legacy entry): neither rule nor personal gate fires.
    assert.equal(shouldSkipFile(strict, { family: "claude-cli" }), false);
    // repoSlug undefined (unknown) is NOT the same as null (known repo-less).
    assert.equal(shouldSkipFile({ ...base, personalSync: false }, { family: "claude-cli", cwd: "~/x" }), false);
  });
});

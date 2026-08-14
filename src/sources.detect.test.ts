import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectRepoSlug, normalizeGithubSlug, repoSlugFromEncodedCwd } from "./sources.js";

// ── Encoded workdir names (the ephemeral-workdir attribution convention) ────

describe("repoSlugFromEncodedCwd", () => {
  it("parses the pool convention <prefix>@<owner>@<name>@<6-char mkdtemp rand>", () => {
    assert.equal(
      repoSlugFromEncodedCwd("/private/var/folders/xx/T/forge-pool@let-ai@let-forge@Ab12Cd"),
      "let-ai/let-forge",
    );
  });

  it("lowercases and takes the DEEPEST matching segment", () => {
    assert.equal(
      repoSlugFromEncodedCwd("/tmp/pool@Acme@Other@aaaaaa/nested/run@let-ai@Viktoria@zZ9880"),
      "let-ai/viktoria",
    );
  });

  it("returns null for ordinary paths (including plain forge-pool- dirs)", () => {
    assert.equal(repoSlugFromEncodedCwd("/private/var/folders/xx/T/forge-pool-0JY3WP"), null);
    assert.equal(repoSlugFromEncodedCwd("/Users/max/work/let-forge"), null);
    assert.equal(repoSlugFromEncodedCwd("/tmp/a@b"), null); // too few separators
  });

  it("requires exactly mkdtemp's 6 alphanumeric suffix — @-riddled names don't false-positive", () => {
    assert.equal(repoSlugFromEncodedCwd("/tmp/p@owner@name@x"), null); // 1-char tail
    assert.equal(repoSlugFromEncodedCwd("/tmp/mail@foo@bar@baz.eml"), null); // dot in tail
    assert.equal(repoSlugFromEncodedCwd("/tmp/a@b@c@dddddddd"), null); // 8-char tail
    // A false positive would BLOCK rule repair (stored slug wins), so the
    // guard matters more than parse reach.
  });

  it("rejects segments whose owner/name carry illegal characters", () => {
    assert.equal(repoSlugFromEncodedCwd("/tmp/p@own er@name@abc123"), null);
  });
});

// ── Multi-remote git config parsing ─────────────────────────────────────────

describe("detectRepoSlug remote selection", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "hx-detect-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeGitConfig(body: string): Promise<void> {
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await writeFile(path.join(dir, ".git", "config"), body);
  }

  it("prefers origin when it is a GitHub remote", async () => {
    await writeGitConfig(
      `[remote "upstream"]\n\turl = git@github.com:acme/upstream.git\n` +
        `[remote "origin"]\n\turl = https://github.com/let-ai/let-forge.git\n`,
    );
    assert.equal(await detectRepoSlug(dir), "let-ai/let-forge");
  });

  it("falls back to the first GitHub remote when origin is absent", async () => {
    await writeGitConfig(`[remote "upstream"]\n\turl = git@github.com:Acme/Tool.git\n`);
    assert.equal(await detectRepoSlug(dir), "acme/tool");
  });

  it("falls back to a GitHub remote when origin is NOT GitHub", async () => {
    await writeGitConfig(
      `[remote "origin"]\n\turl = https://gitlab.com/acme/tool.git\n` +
        `[remote "github"]\n\turl = git@github.com:acme/tool.git\n`,
    );
    assert.equal(await detectRepoSlug(dir), "acme/tool");
  });

  it("still returns null with no GitHub remote anywhere", async () => {
    await writeGitConfig(`[remote "origin"]\n\turl = https://gitlab.com/acme/tool.git\n`);
    assert.equal(await detectRepoSlug(dir), null);
  });
});

describe("normalizeGithubSlug", () => {
  it("normalizes ssh / https / trailing-slash forms", () => {
    assert.equal(normalizeGithubSlug("git@github.com:A/B.git"), "a/b");
    assert.equal(normalizeGithubSlug("https://github.com/A/B/"), "a/b");
    assert.equal(normalizeGithubSlug("ssh://git@github.com/A/B.git"), "a/b");
  });
});

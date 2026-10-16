import { describe, expect, test } from "bun:test";

import { statPathPattern, summarizeStatTrace } from "./stat-trace.js";

const HOME = "/tmp/w/home-idle";

describe("statPathPattern", () => {
  test("names the run's own parts of a path", () => {
    expect(statPathPattern(`${HOME}/.claude/projects/-tmp-w-home-idle-work-acme/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b.jsonl`, HOME)).toBe("<HOME>/.claude/projects/<project>/<uuid>.jsonl");
    expect(statPathPattern(`${HOME}/.claude/projects/-x/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b/subagents/agent-ab12CD34ef56.jsonl`, HOME)).toBe("<HOME>/.claude/projects/<project>/<uuid>/subagents/agent-<id>.jsonl");
    expect(statPathPattern(`${HOME}/work/acme-repo/packages/pkg-a1b2c`, HOME)).toBe("<HOME>/work/acme-repo/packages/pkg-<id>");
    expect(statPathPattern("", HOME)).toBe("<descriptor>");
  });
});

describe("summarizeStatTrace", () => {
  const t = (s: number): string => (1_760_000_000 + s).toFixed(6);
  const trace = [
    `4242 ${t(0)} statx(AT_FDCWD, "${HOME}/.claude/projects/-a/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b.jsonl", AT_STATX_SYNC_AS_STAT, STATX_ALL, {stx_mask=STATX_ALL}) = 0`,
    `4242 ${t(1)} readlink("/tmp", 0x7ffd, 4095) = -1 EINVAL (Invalid argument)`,
    `4243 ${t(16)} statx(AT_FDCWD, "${HOME}/.let/hx/settings.json", AT_STATX_SYNC_AS_STAT, STATX_ALL <unfinished ...>`,
    `4242 ${t(16)} fstat(3, {st_mode=S_IFDIR|0755, st_size=4096, ...}) = 0`,
    `4243 ${t(16)} <... statx resumed>{stx_mask=STATX_ALL}) = 0`,
    `4242 ${t(20)} readlink("${HOME}", 0x7ffd, 4095) = -1 EINVAL (Invalid argument)`,
    `${t(21)} newfstatat(AT_FDCWD, "${HOME}/.let/hx/settings.json", {st_mode=S_IFREG|0600}, 0) = 0`,
    "+++ exited with 0 +++",
  ].join("\n");

  test("counts by syscall and path, the start-up pass apart", () => {
    const s = summarizeStatTrace(trace, HOME, 15_000, 45_000);
    expect(s.startupStatCalls).toBe(1);
    // Idle: statx + fstat + newfstatat = 3 stat-family calls over 30 s.
    expect(s.idleStatPerSec).toBe(0.1);
    expect(s.idleReadlinkPerSec).toBe(0);
    expect(s.text).toContain("start-up (first 15 s): 2 calls");
    expect(s.text).toContain("idle (the 30 s after): 4 calls");
    expect(s.text).toContain("statx      <HOME>/.let/hx/settings.json");
    expect(s.text).toContain("fstat      <descriptor>");
  });
});

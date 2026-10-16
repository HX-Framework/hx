// The stat-family, readlink and openat calls of a traced daemon, by path:
// which files a binary checks and opens at start-up and at idle
// (harness/run/measure.ts runs `strace -f -ttt -s 4096 -e
// trace=%%stat,readlink,readlinkat,openat` and hands the output here).

const STAT_FAMILY = new Set(["stat", "lstat", "fstat", "newfstatat", "fstatat64", "statx", "stat64", "lstat64", "fstat64"]);

/** A traced path with the run's own parts named: the fixture home, session
 *  and agent ids, the encoded project directories, numbers. */
export function statPathPattern(p: string, home: string): string {
  if (p === "") return "<descriptor>";
  let s = p.split(home).join("<HOME>");
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
  s = s.replace(/agent-[A-Za-z0-9]+/g, "agent-<id>");
  s = s.replace(/wf_[A-Za-z0-9]+/g, "wf_<id>");
  s = s.replace(/pkg-[a-z0-9]+/g, "pkg-<id>");
  s = s.replace(/\/-[^/]+/g, "/<project>");
  return s.replace(/\d{2,}/g, "<n>");
}

/** `strace -f -ttt -s 4096 -e trace=%%stat,readlink…` output, counted by
 *  syscall and path pattern, the first `startupMs` apart from the rest. An
 *  open of a directory (O_DIRECTORY: a directory read) is counted apart from
 *  an open of a file. */
export function summarizeStatTrace(
  text: string,
  home: string,
  startupMs: number,
  totalMs: number,
): { text: string; idleStatPerSec: number; idleReadlinkPerSec: number; idleOpenPerSec: number; startupStatCalls: number } {
  const phases = [new Map<string, number>(), new Map<string, number>()];
  let t0 = -1;
  let idleStat = 0;
  let idleReadlink = 0;
  let idleOpen = 0;
  let startupStat = 0;
  // "1234 1760000000.123456 statx(AT_FDCWD, "/path", …) = 0" (the pid only
  // with -f and several threads); a "<… statx resumed>" line carries no path
  // and was counted on its first half.
  const line = /^(?:\d+\s+)?(\d+\.\d+)\s+([a-z0-9_]+)\((.*)$/;
  for (const l of text.split("\n")) {
    const m = line.exec(l);
    if (!m) continue;
    const t = Number(m[1]) * 1000;
    if (t0 < 0) t0 = t;
    const name = m[2]!;
    const quoted = /"((?:[^"\\]|\\.)*)"/.exec(m[3]!);
    const isOpen = name === "openat" || name === "open";
    const directory = isOpen && m[3]!.includes("O_DIRECTORY") ? " (directory)" : "";
    const pattern = `${name.padEnd(10)} ${quoted ? statPathPattern(quoted[1]!, home) : "<descriptor>"}${directory}`;
    const idle = t - t0 >= startupMs;
    const map = phases[idle ? 1 : 0]!;
    map.set(pattern, (map.get(pattern) ?? 0) + 1);
    const isStat = STAT_FAMILY.has(name);
    if (idle && isStat) idleStat += 1;
    if (idle && name.startsWith("readlink")) idleReadlink += 1;
    if (idle && isOpen) idleOpen += 1;
    if (!idle && isStat) startupStat += 1;
  }
  const idleSecs = (totalMs - startupMs) / 1000;
  const table = (map: Map<string, number>): string =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([k, n]) => `  ${String(n).padStart(7)}  ${k}`)
      .join("\n");
  const total = (map: Map<string, number>): number => [...map.values()].reduce((a, b) => a + b, 0);
  const out = [
    `start-up (first ${startupMs / 1000} s): ${total(phases[0]!)} calls`,
    table(phases[0]!),
    "",
    `idle (the ${idleSecs} s after): ${total(phases[1]!)} calls`,
    table(phases[1]!),
    "",
  ].join("\n");
  const perSec = (n: number): number => Math.round((n / idleSecs) * 10) / 10;
  return { text: out, idleStatPerSec: perSec(idleStat), idleReadlinkPerSec: perSec(idleReadlink), idleOpenPerSec: perSec(idleOpen), startupStatCalls: startupStat };
}

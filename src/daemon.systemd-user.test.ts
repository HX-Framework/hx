// Runs the rendered systemd unit under a real systemd USER manager and reads
// back what the kernel applied: nice, I/O class, and the cgroup limits.
//
// Opt-in: it installs, starts and removes a probe unit in the user's systemd,
// so it only runs when HX_TEST_SYSTEMD_USER=1. CI's "systemd user unit" job
// sets it after starting a user manager for the runner (loginctl
// enable-linger). Everywhere else — macOS, Windows, a Linux laptop's plain
// `bun test` — it is skipped.

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { renderSystemdUnit } from "./daemon.js";

const enabled = process.platform === "linux" && process.env.HX_TEST_SYSTEMD_USER === "1";

function systemctl(...args: string[]): string {
  const r = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `systemctl --user ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function prop(unit: string, name: string): string {
  return systemctl("show", unit, `--property=${name}`, "--value");
}

/** A cgroup attribute of the unit, or null when its controller is not delegated. */
function cgroupFile(controlGroup: string, file: string): string | null {
  const path = join("/sys/fs/cgroup", controlGroup, file);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}

describe.skipIf(!enabled)("systemd user unit on a real user manager", () => {
  it("applies nice, the idle I/O class, and the cgroup limits", () => {
    const name = `hx-unit-probe-${process.pid}.service`;
    const unitDir = join(homedir(), ".config", "systemd", "user");
    const unitPath = join(unitDir, name);
    const dir = mkdtempSync(join(tmpdir(), "hx-unit-"));
    // Stands in for the hx binary: the unit runs `<bin> watch`.
    const fakeHx = join(dir, "hx");
    writeFileSync(fakeHx, "#!/bin/sh\nexec sleep 300\n", { mode: 0o755 });
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      unitPath,
      renderSystemdUnit(fakeHx, { stdout: join(dir, "stdout.log"), stderr: join(dir, "stderr.log") }),
    );
    try {
      systemctl("daemon-reload");
      systemctl("start", name);
      const pid = Number(prop(name, "MainPID"));
      assert.ok(pid > 0, "the probe unit has a main process");
      const controlGroup = prop(name, "ControlGroup");
      const uid = process.getuid?.() ?? 0;
      const delegated = readFileSync(
        `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`,
        "utf8",
      ).trim();

      // /proc/<pid>/stat: field 19 is the nice value. Fields after the
      // parenthesised command name are space-separated.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const nice = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[16]);
      const ionice = spawnSync("ionice", ["-p", String(pid)], { encoding: "utf8" }).stdout.trim();
      const observed = {
        systemd: systemctl("--version").split("\n")[0],
        delegatedControllers: delegated,
        nice,
        ionice,
        "cpu.weight": cgroupFile(controlGroup, "cpu.weight"),
        "memory.high": cgroupFile(controlGroup, "memory.high"),
        "memory.max": cgroupFile(controlGroup, "memory.max"),
        "memory.swap.max": cgroupFile(controlGroup, "memory.swap.max"),
        unitProperties: systemctl(
          "show",
          name,
          "--property=Nice,IOSchedulingClass,CPUWeight,MemoryHigh,MemoryMax,MemorySwapMax,RestartUSec,StartLimitIntervalUSec,StartLimitBurst",
        ),
      };
      console.log(JSON.stringify(observed, null, 2));

      // Exec settings: applied to the forked process in every user unit.
      assert.equal(nice, 10);
      assert.match(ionice, /^idle/);
      // cgroup settings: applied when the controller is delegated to the user
      // manager. memory always is on the unified hierarchy; cpu since 252.
      assert.equal(observed["memory.high"], String(1024 ** 3));
      assert.equal(observed["memory.max"], String(2 * 1024 ** 3));
      assert.equal(observed["memory.swap.max"], String(512 * 1024 ** 2));
      if (delegated.split(" ").includes("cpu")) assert.equal(observed["cpu.weight"], "20");
    } finally {
      spawnSync("systemctl", ["--user", "stop", name]);
      try {
        unlinkSync(unitPath);
      } catch {
        /* already gone */
      }
      spawnSync("systemctl", ["--user", "daemon-reload"]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

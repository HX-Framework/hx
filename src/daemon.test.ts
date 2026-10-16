import { test, expect, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STOP_GRACE_SECONDS,
  awaitExitOrKill,
  bootstrapBinPath,
  clientOfBinary,
  definitionBinPath,
  insertHookBlock,
  parseWinState,
  planDefinitionUpdate,
  reloadedRecently,
  renderBootstrap,
  renderPlist,
  renderSystemdUnit,
  renderTaskXml,
  serviceManagerOf,
  shquote,
  slotRunsHx2,
  stripHookBlock,
  windowsServiceBinary,
  type DaemonOps,
} from "./daemon.js";

test("shquote wraps in single quotes", () => {
  expect(shquote("/home/user/.let/bin/hx")).toBe("'/home/user/.let/bin/hx'");
});

test("shquote escapes embedded single quotes so it can't break out", () => {
  // A path with a quote must not terminate the quoting early.
  expect(shquote("/tmp/a'b")).toBe(`'/tmp/a'\\''b'`);
});

test("renderBootstrap emits the guarded, self-healing launcher", () => {
  const out = renderBootstrap("/home/user/.let/bin/hx");
  // Guards: only run when connected and not disabled.
  expect(out).toContain("config.json");
  expect(out).toContain("disabled");
  // Detach + respawn, mirroring systemd Restart=always / RestartSec=5.
  expect(out).toContain("setsid sh -c");
  expect(out).toContain("while true; do");
  expect(out).toContain("watch >>");
  expect(out).toContain("sleep 5");
  // Already-running guard via a zombie-aware liveness check (not bare kill -0).
  expect(out).toContain("__hx_alive");
  expect(out).toContain("/proc/");
});

test("renderBootstrap guards the supervisor with a lifetime-held flock singleton", () => {
  const out = renderBootstrap("/home/user/.let/bin/hx");
  // Atomic "at most one supervisor": take an flock before writing the pidfile;
  // bow out if another holds it. Kernel releases on death, so no stale leak.
  expect(out).toContain("flock -n 9");
  // Guarded so an image without flock still starts (fast-path-only fallback).
  expect(out).toContain("if command -v flock");
});

test("renderBootstrap shell-escapes the binary path", () => {
  const evil = "/tmp/weird '; rm -rf ~; '/hx";
  const out = renderBootstrap(evil);
  // The whole path — metacharacters and all — sits inside a single-quoted token,
  // so it's an inert literal, never executed. Its embedded quotes are neutralized
  // as '\'' (close, escaped-quote, reopen).
  expect(out).toContain(shquote(evil));
  expect(out).toContain(`'\\''`);
});

test("insertHookBlock adds the marker block once (idempotent)", () => {
  const once = insertHookBlock("# my bashrc\nexport FOO=1\n");
  expect(once).toContain("# >>> hx >>>");
  expect(once).toContain("# <<< hx <<<");
  expect(once).toContain("bootstrap.sh");
  // Second application is a no-op — no duplicate block.
  const twice = insertHookBlock(once);
  expect(twice).toBe(once);
  expect(twice.match(/# >>> hx >>>/g)).toHaveLength(1);
});

test("stripHookBlock removes exactly what insertHookBlock added", () => {
  const original = "# my bashrc\nexport FOO=1\n";
  const wired = insertHookBlock(original);
  const unwired = stripHookBlock(wired);
  expect(unwired).not.toContain("# >>> hx >>>");
  expect(unwired).toContain("export FOO=1");
});

test("stripHookBlock leaves an unrelated file untouched", () => {
  const content = "# my bashrc\nexport FOO=1\n";
  expect(stripHookBlock(content)).toBe(content);
});

describe("windows: task definition", () => {
  it("runs the windowless service binary when it is installed", () => {
    const has = (p: string): boolean => p.endsWith("hx-svc.exe");
    assert.equal(
      windowsServiceBinary("C:\\Users\\me\\.let\\bin\\hx.exe", has),
      "C:\\Users\\me\\.let\\bin\\hx-svc.exe",
    );
  });

  it("falls back to the CLI binary when the service build is absent", () => {
    // Running from source, or an install predating the two-binary split: a
    // visible console window beats refusing to mirror.
    assert.equal(
      windowsServiceBinary("C:\\Users\\me\\.let\\bin\\hx.exe", () => false),
      "C:\\Users\\me\\.let\\bin\\hx.exe",
    );
  });

  it("lifts the execution time limit", () => {
    // The DEFAULT is 3 days, after which the scheduler kills a healthy mirror.
    const xml = renderTaskXml("C:\\hx-svc.exe", "CORP\\me");
    assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  });

  it("carries a logon trigger and a 5-minute supervision repeat", () => {
    const xml = renderTaskXml("C:\\hx-svc.exe", "CORP\\me");
    assert.match(xml, /<LogonTrigger>/);
    assert.match(xml, /<Interval>PT5M<\/Interval>/);
    // IgnoreNew makes the scheduler the single-instance owner, so the repeat
    // trigger is a no-op while the mirror is alive.
    assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  });

  it("keeps running on battery", () => {
    // The defaults refuse to start, and stop a running task, on battery power —
    // which on a laptop fleet would mean "syncs only when plugged in".
    const xml = renderTaskXml("C:\\hx-svc.exe", "CORP\\me");
    assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
    assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  });

  it("runs unelevated, as the invoking user", () => {
    const xml = renderTaskXml("C:\\hx-svc.exe", "CORP\\me");
    assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
    assert.match(xml, /<UserId>CORP\\me<\/UserId>/);
  });

  it("escapes a path containing XML metacharacters", () => {
    const xml = renderTaskXml("C:\\a & b\\hx-svc.exe", "CORP\\me");
    assert.match(xml, /<Command>C:\\a &amp; b\\hx-svc\.exe<\/Command>/);
  });
});

describe("windows: parseWinState", () => {
  it("reads a running task", () => {
    assert.deepEqual(parseWinState("Running\r\n4812\r\n"), { loaded: true, pid: 4812 });
  });

  it("reads a registered but idle task", () => {
    assert.deepEqual(parseWinState("Ready\r\n\r\n"), { loaded: true, pid: null });
  });

  it("treats a disabled task as not loaded", () => {
    // `hx stop` disables so the stop survives the next logon — the same reason
    // the systemd backend reports a disabled unit as not loaded.
    assert.deepEqual(parseWinState("Disabled\r\n\r\n"), { loaded: false, pid: null });
  });

  it("reads an unregistered task", () => {
    assert.deepEqual(parseWinState("Absent\r\n\r\n"), { loaded: false, pid: null });
  });

  it("ignores junk where the pid should be", () => {
    assert.deepEqual(parseWinState("Running\r\nnot-a-pid\r\n"), { loaded: true, pid: null });
    assert.deepEqual(parseWinState(""), { loaded: false, pid: null });
  });
});

// ───────────────────── service definitions (launchd, systemd) ─────────────────────

const MAC_BIN = "/Users/me/.let/bin/hx";
const MAC_LOGS = { stdout: "/Users/me/.let/hx/stdout.log", stderr: "/Users/me/.let/hx/stderr.log" };
const LINUX_BIN = "/home/me/.let/bin/hx";
const LINUX_LOGS = { stdout: "/home/me/.let/hx/stdout.log", stderr: "/home/me/.let/hx/stderr.log" };

// What every device installed before the background limits: the exact output
// of the previous templates. The upgrade tests below start from these.
function legacyPlist(bin: string, logs: { stdout: string; stderr: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>ai.let.hx-vision</string>
    <key>ProgramArguments</key>
    <array>
      <string>${bin}</string>
      <string>watch</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key><false/>
    </dict>
    <key>StandardOutPath</key><string>${logs.stdout}</string>
    <key>StandardErrorPath</key><string>${logs.stderr}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
  </dict>
</plist>
`;
}

function legacyUnit(bin: string, logs: { stdout: string; stderr: string }): string {
  return `[Unit]
Description=hx-vision session mirror
After=network-online.target

[Service]
Type=simple
ExecStart=${bin} watch
Restart=always
RestartSec=5
StandardOutput=append:${logs.stdout}
StandardError=append:${logs.stderr}

[Install]
WantedBy=default.target
`;
}

/** The `key=value` lines of one `[section]` of a systemd unit. */
function unitSection(unit: string, name: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of unit.split("\n")) {
    const header = line.match(/^\[(.+)\]$/);
    if (header) current = header[1];
    else if (current === name && line.includes("=")) out.push(line);
  }
  return out;
}

describe("launchd: plist", () => {
  it("matches the snapshot", () => {
    expect(renderPlist(MAC_BIN, MAC_LOGS)).toMatchSnapshot();
  });

  it("runs as a background process", () => {
    const plist = renderPlist(MAC_BIN, MAC_LOGS);
    // ProcessType=Background puts the job in the darwin-background band: lowest
    // CPU priority, throttled disk and network I/O.
    assert.match(plist, /<key>ProcessType<\/key><string>Background<\/string>/);
    assert.match(plist, /<key>LowPriorityBackgroundIO<\/key><true\/>/);
    assert.match(plist, /<key>Nice<\/key><integer>10<\/integer>/);
  });

  it("respawns at most once a minute", () => {
    // launchd's default is every 10 s: a crash loop re-ran the startup
    // catch-up pass six times a minute.
    assert.match(renderPlist(MAC_BIN, MAC_LOGS), /<key>ThrottleInterval<\/key><integer>60<\/integer>/);
  });

  it("sends SIGKILL 5 s after the SIGTERM of a stop", () => {
    // A frozen daemon never runs its JavaScript SIGTERM handler; launchd's
    // default wait is system-defined.
    assert.match(renderPlist(MAC_BIN, MAC_LOGS), /<key>ExitTimeOut<\/key><integer>5<\/integer>/);
  });

  it("says that hx owns the file, in a comment plist parsers skip", () => {
    const plist = renderPlist(MAC_BIN, MAC_LOGS);
    const open = plist.indexOf("<!--");
    const close = plist.indexOf("-->", open);
    assert.ok(open !== -1 && close !== -1, "the plist has a comment");
    const comment = plist.slice(open + "<!--".length, close);
    assert.ok(comment.trim().startsWith("Managed by hx."));
    // An XML comment may not contain "--".
    assert.ok(!comment.includes("--"));
  });

  it("escapes a binary path containing XML metacharacters", () => {
    assert.match(renderPlist("/Users/a & b/hx", MAC_LOGS), /<string>\/Users\/a &amp; b\/hx<\/string>/);
  });

  // plutil ships with macOS only; CI's Linux and Windows jobs skip this.
  test.skipIf(!Bun.which("plutil"))("is a valid plist with the right value types (plutil)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hx-plist-"));
    try {
      const file = join(dir, "hx.plist");
      writeFileSync(file, renderPlist(MAC_BIN, MAC_LOGS));
      const lint = spawnSync("plutil", ["-lint", file], { encoding: "utf8" });
      assert.equal(lint.status, 0, lint.stdout + lint.stderr);
      const json = spawnSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
      const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
      assert.equal(parsed.ProcessType, "Background");
      assert.equal(parsed.LowPriorityBackgroundIO, true);
      assert.equal(parsed.Nice, 10);
      assert.equal(parsed.ThrottleInterval, 60);
      assert.equal(parsed.ExitTimeOut, STOP_GRACE_SECONDS);
      assert.deepEqual(parsed.ProgramArguments, [MAC_BIN, "watch"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("systemd: unit", () => {
  it("matches the snapshot", () => {
    expect(renderSystemdUnit(LINUX_BIN, LINUX_LOGS)).toMatchSnapshot();
  });

  it("sends SIGKILL 5 s after the SIGTERM of a stop, not systemd's default 90 s", () => {
    const service = unitSection(renderSystemdUnit(LINUX_BIN, LINUX_LOGS), "Service");
    assert.ok(service.includes(`TimeoutStopSec=${STOP_GRACE_SECONDS}`));
  });

  it("lowers CPU and I/O priority", () => {
    const service = unitSection(renderSystemdUnit(LINUX_BIN, LINUX_LOGS), "Service");
    assert.ok(service.includes("Nice=10"));
    assert.ok(service.includes("IOSchedulingClass=idle"));
    assert.ok(service.includes("CPUWeight=20"));
  });

  it("caps memory, swap included", () => {
    const service = unitSection(renderSystemdUnit(LINUX_BIN, LINUX_LOGS), "Service");
    assert.ok(service.includes("MemoryHigh=1G"));
    assert.ok(service.includes("MemoryMax=2G"));
    // Without a swap cap the kernel pages the overflow out instead of stopping it.
    assert.ok(service.includes("MemorySwapMax=512M"));
  });

  it("spaces restarts a minute apart and gives up on a crash at startup", () => {
    const unit = renderSystemdUnit(LINUX_BIN, LINUX_LOGS);
    const service = unitSection(unit, "Service");
    assert.ok(service.includes("Restart=always"));
    assert.ok(service.includes("RestartSec=60"));
    // Start limits are [Unit] settings; systemd ignores them in [Service].
    const unitKeys = unitSection(unit, "Unit");
    assert.ok(unitKeys.includes("StartLimitIntervalSec=600"));
    assert.ok(unitKeys.includes("StartLimitBurst=5"));
    assert.ok(!service.some((l) => l.startsWith("StartLimit")));
  });

  it("keeps sending output to the log files", () => {
    const service = unitSection(renderSystemdUnit(LINUX_BIN, LINUX_LOGS), "Service");
    assert.ok(service.includes(`StandardOutput=append:${LINUX_LOGS.stdout}`));
    assert.ok(service.includes(`StandardError=append:${LINUX_LOGS.stderr}`));
  });

  // Runs wherever systemd is installed (CI's Linux job); skipped on macOS and
  // Windows. Catches a misspelt key or a value systemd would reject: both are
  // only warnings at load time, and the unit would start without the limit.
  test.skipIf(!Bun.which("systemd-analyze"))("passes systemd-analyze verify", () => {
    const dir = mkdtempSync(join(tmpdir(), "hx-unit-"));
    try {
      const file = join(dir, "hx-vision.service");
      // ExecStart must name an existing executable for verify to pass.
      const truePath = Bun.which("true") ?? "/bin/true";
      writeFileSync(
        file,
        renderSystemdUnit(truePath, { stdout: join(dir, "stdout.log"), stderr: join(dir, "stderr.log") }),
      );
      const r = spawnSync("systemd-analyze", ["verify", file], { encoding: "utf8" });
      const aboutUs = `${r.stdout}\n${r.stderr}`
        .split("\n")
        .filter((l) => l.includes("hx-vision.service"));
      assert.deepEqual(aboutUs, [], `systemd-analyze verify:\n${r.stdout}${r.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("windows: background priority", () => {
  it("starts the task below normal priority", () => {
    // 7 = BELOW_NORMAL_PRIORITY_CLASS; 4–6 would be normal.
    assert.match(renderTaskXml("C:\\hx-svc.exe", "CORP\\me"), /<Priority>7<\/Priority>/);
  });

  it("matches the snapshot", () => {
    expect(renderTaskXml("C:\\Users\\me\\.let\\bin\\hx-svc.exe", "CORP\\me")).toMatchSnapshot();
  });
});

// ───────────────────── keeping installed definitions current ─────────────────────

describe("serviceManagerOf", () => {
  const noCgroup = (): string => {
    throw new Error("no /proc");
  };

  it("recognises the launchd job by its label", () => {
    assert.equal(serviceManagerOf({ XPC_SERVICE_NAME: "ai.let.hx-vision" }, "darwin", noCgroup), "launchd");
  });

  it("ignores a terminal and other launchd jobs", () => {
    assert.equal(serviceManagerOf({ XPC_SERVICE_NAME: "0" }, "darwin", noCgroup), null);
    assert.equal(serviceManagerOf({}, "darwin", noCgroup), null);
    assert.equal(serviceManagerOf({ XPC_SERVICE_NAME: "com.apple.Terminal" }, "darwin", noCgroup), null);
  });

  it("recognises the systemd unit by its cgroup (v2)", () => {
    const cgroup = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/hx-vision.service\n";
    assert.equal(serviceManagerOf({}, "linux", () => cgroup), "systemd");
  });

  it("recognises the systemd unit by its cgroup (v1)", () => {
    const cgroup = [
      "12:memory:/user.slice/user-1000.slice/user@1000.service",
      "1:name=systemd:/user.slice/user-1000.slice/user@1000.service/hx-vision.service",
      "0::/user.slice/user-1000.slice/user@1000.service/hx-vision.service",
      "",
    ].join("\n");
    assert.equal(serviceManagerOf({}, "linux", () => cgroup), "systemd");
  });

  it("ignores a terminal session, a container, and a missing /proc", () => {
    const terminal = "0::/user.slice/user-1000.slice/session-3.scope\n";
    assert.equal(serviceManagerOf({}, "linux", () => terminal), null);
    assert.equal(serviceManagerOf({}, "linux", () => "0::/\n"), null);
    assert.equal(serviceManagerOf({}, "linux", noCgroup), null);
  });

  it("never claims Windows", () => {
    assert.equal(serviceManagerOf({ XPC_SERVICE_NAME: "ai.let.hx-vision" }, "win32", noCgroup), null);
  });
});

describe("definitionBinPath", () => {
  it("reads the plist's program, unescaping XML", () => {
    assert.equal(definitionBinPath("launchd", legacyPlist("/Users/a &amp; b/hx", MAC_LOGS)), "/Users/a & b/hx");
    assert.equal(definitionBinPath("launchd", renderPlist(MAC_BIN, MAC_LOGS)), MAC_BIN);
  });

  it("reads the unit's ExecStart", () => {
    assert.equal(definitionBinPath("systemd", legacyUnit(LINUX_BIN, LINUX_LOGS)), LINUX_BIN);
    assert.equal(definitionBinPath("systemd", renderSystemdUnit(LINUX_BIN, LINUX_LOGS)), LINUX_BIN);
  });

  it("returns null for a file it does not recognise", () => {
    assert.equal(definitionBinPath("launchd", "<plist></plist>"), null);
    assert.equal(definitionBinPath("systemd", "[Service]\nExecStart=/usr/bin/other\n"), null);
  });
});

describe("planDefinitionUpdate", () => {
  const same = (a: string, b: string): boolean => a === b;

  it("upgrades the plist every device has today", () => {
    const plan = planDefinitionUpdate("launchd", legacyPlist(MAC_BIN, MAC_LOGS), MAC_BIN, same, MAC_LOGS);
    assert.deepEqual(plan, { action: "rewrite", next: renderPlist(MAC_BIN, MAC_LOGS) });
  });

  it("upgrades the unit every device has today", () => {
    const plan = planDefinitionUpdate("systemd", legacyUnit(LINUX_BIN, LINUX_LOGS), LINUX_BIN, same, LINUX_LOGS);
    assert.deepEqual(plan, { action: "rewrite", next: renderSystemdUnit(LINUX_BIN, LINUX_LOGS) });
  });

  it("leaves a current definition alone, so the reload happens once", () => {
    for (const [kind, installed, bin, logs] of [
      ["launchd", renderPlist(MAC_BIN, MAC_LOGS), MAC_BIN, MAC_LOGS],
      ["systemd", renderSystemdUnit(LINUX_BIN, LINUX_LOGS), LINUX_BIN, LINUX_LOGS],
    ] as const) {
      assert.deepEqual(planDefinitionUpdate(kind, installed, bin, same, logs), { action: "current" });
    }
  });

  it("keeps the binary path exactly as the definition spells it", () => {
    // The service runs a symlink to this binary: the upgrade must not
    // re-point it at the symlink's target.
    const link = "/Users/me/bin/hx";
    const viaLink = (a: string, b: string): boolean => a === b || (a === link && b === MAC_BIN);
    const plan = planDefinitionUpdate("launchd", legacyPlist(link, MAC_LOGS), MAC_BIN, viaLink, MAC_LOGS);
    assert.deepEqual(plan, { action: "rewrite", next: renderPlist(link, MAC_LOGS) });
  });

  it("leaves a definition that runs another binary alone", () => {
    const plan = planDefinitionUpdate("systemd", legacyUnit("/opt/hx/hx", LINUX_LOGS), LINUX_BIN, same, LINUX_LOGS);
    assert.equal(plan.action, "skip");
  });

  it("leaves a file it cannot read alone", () => {
    const plan = planDefinitionUpdate("launchd", "<plist></plist>", MAC_BIN, same, MAC_LOGS);
    assert.equal(plan.action, "skip");
  });
});

describe("reloadedRecently", () => {
  const next = renderSystemdUnit(LINUX_BIN, LINUX_LOGS);
  const now = Date.UTC(2026, 9, 14, 12);
  const marker = (content: string, at: number): string =>
    JSON.stringify({ sha256: createHash("sha256").update(content).digest("hex"), at });

  it("blocks a second reload to the same definition within the hour", () => {
    assert.equal(reloadedRecently(marker(next, now - 5 * 60_000), next, now), true);
  });

  it("allows it again after an hour", () => {
    assert.equal(reloadedRecently(marker(next, now - 61 * 60_000), next, now), false);
  });

  it("does not block a reload to a different definition", () => {
    assert.equal(reloadedRecently(marker("older", now - 60_000), next, now), false);
  });

  it("ignores a missing, corrupt, or future-dated marker", () => {
    assert.equal(reloadedRecently(null, next, now), false);
    assert.equal(reloadedRecently("{not json", next, now), false);
    assert.equal(reloadedRecently(marker(next, now + 60_000), next, now), false);
  });
});

describe("stopping a daemon that ignores SIGTERM", () => {
  it("awaitExitOrKill waits for an exit, and sends SIGKILL only after the grace", () => {
    let t = 0;
    let aliveUntil = 0;
    const killed: number[] = [];
    const deps = {
      alive: () => t < aliveUntil,
      kill: (pid: number) => {
        killed.push(pid);
        aliveUntil = t;
      },
      sleep: (ms: number) => {
        t += ms;
      },
      now: () => t,
    };
    aliveUntil = 300; // exits on its own, as a healthy daemon does on SIGTERM
    assert.equal(awaitExitOrKill(11, 5_000, deps), false);
    assert.deepEqual(killed, []);

    t = 0;
    aliveUntil = Infinity; // never exits: the frozen daemon
    assert.equal(awaitExitOrKill(12, 5_000, deps), true);
    assert.deepEqual(killed, [12]);
    assert.ok(t >= 5_000 && t < 5_200, `killed at ${t} ms`);
  });

  it.skipIf(process.platform === "win32")(
    "awaitExitOrKill ends a real process that ignores SIGTERM, and leaves alone one that exits",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "hx-stop-"));
      try {
        // Launched through sh so the process is not this test's child, as the
        // daemon is launchd's or systemd's child and never the CLI's.
        const launch = (name: string, script: string): number => {
          const ready = join(dir, name);
          const code = `${script}; require("node:fs").writeFileSync(${JSON.stringify(ready)}, ""); setTimeout(() => {}, 30000);`;
          const r = spawnSync("sh", ["-c", `"$0" -e '${code}' >/dev/null 2>&1 & echo $!`, process.execPath]);
          const pid = Number(r.stdout.toString().trim());
          const deadline = Date.now() + 10_000;
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own tmp dir
          while (!existsSync(ready) && Date.now() < deadline) Bun.sleepSync(20);
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own tmp dir
          assert.ok(existsSync(ready), `${name} never started`);
          return pid;
        };
        // Liveness from ps, where a zombie (an exited process its new parent
        // has not reaped yet) reads as gone; kill(pid, 0) still finds one.
        const alive = (pid: number): boolean => {
          const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
          return stat !== "" && !stat.startsWith("Z");
        };
        const deps = { alive, kill: (pid: number) => process.kill(pid, "SIGKILL"), sleep: Bun.sleepSync, now: Date.now };

        const stubborn = launch("stubborn", `process.on("SIGTERM", () => {})`);
        process.kill(stubborn, "SIGTERM");
        assert.equal(awaitExitOrKill(stubborn, 500, deps), true, "needed SIGKILL");
        assert.equal(alive(stubborn), false);

        const polite = launch("polite", "void 0");
        process.kill(polite, "SIGTERM");
        assert.equal(awaitExitOrKill(polite, 5_000, deps), false, "exited on SIGTERM");
        assert.equal(alive(polite), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

// ── The shared service slot (hx2) ───────────────────────────────────────────
// hx2 installs the same definitions under the same label; hx reads which of
// the two the installed definition runs, and leaves a slot running hx2 alone.

describe("the shared service slot", () => {
  const opsWithSlot = (bin: string | null): DaemonOps =>
    ({
      managerName: "launchd",
      install: async () => {},
      uninstall: async () => {},
      start: async () => {},
      stop: async () => ({ wasRunning: false }),
      restart: async () => {},
      state: async () => ({ loaded: true, pid: 42 }),
      slotBinary: () => bin,
    }) as DaemonOps;

  it("names the client of a binary by its file name", () => {
    assert.equal(clientOfBinary("/Users/me/.let/bin/hx2"), "hx2");
    assert.equal(clientOfBinary("C:\\Users\\me\\.let\\bin\\hx2-svc.exe"), "hx2");
    assert.equal(clientOfBinary("C:\\Users\\me\\.let\\bin\\HX.EXE"), "hx");
    assert.equal(clientOfBinary("/home/me/.let/bin/hx"), "hx");
    assert.equal(clientOfBinary("/opt/hx-old/hx-session-vault"), null);
  });

  it("reads the binary out of every definition hx writes", () => {
    const logs = { stdout: "/o.log", stderr: "/e.log" };
    assert.equal(definitionBinPath("launchd", renderPlist("/Users/me/.let/bin/hx2", logs)), "/Users/me/.let/bin/hx2");
    assert.equal(definitionBinPath("systemd", renderSystemdUnit("/home/me/.let/bin/hx2", logs)), "/home/me/.let/bin/hx2");
    assert.equal(bootstrapBinPath(renderBootstrap("/home/me/.let/bin/hx2")), "/home/me/.let/bin/hx2");
    assert.equal(bootstrapBinPath(renderBootstrap("/tmp/it's/hx2")), "/tmp/it's/hx2");
    assert.equal(bootstrapBinPath("echo nothing here"), null);
  });

  it("sees hx2 in the slot, and only hx2", () => {
    assert.equal(slotRunsHx2(opsWithSlot("/Users/me/.let/bin/hx2")), "/Users/me/.let/bin/hx2");
    assert.equal(slotRunsHx2(opsWithSlot("/Users/me/.let/bin/hx")), null);
    assert.equal(slotRunsHx2(opsWithSlot(null)), null);
    // A backend without the probe (an older test double) reads as empty.
    const { slotBinary: _drop, ...bare } = opsWithSlot("/x/hx2");
    assert.equal(slotRunsHx2(bare as DaemonOps), null);
  });

  it("re-registers a Windows slot that runs hx2 with hx2's service build", () => {
    const has = (p: string): boolean => p.endsWith("hx2-svc.exe") || p.endsWith("hx-svc.exe");
    assert.equal(
      windowsServiceBinary("C:\\Users\\me\\.let\\bin\\hx2-svc.exe", has),
      "C:\\Users\\me\\.let\\bin\\hx2-svc.exe",
    );
    assert.equal(
      windowsServiceBinary("C:\\Users\\me\\.let\\bin\\hx.exe", has),
      "C:\\Users\\me\\.let\\bin\\hx-svc.exe",
    );
  });
});

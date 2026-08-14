import { test, expect, describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  insertHookBlock,
  parseWinState,
  renderBootstrap,
  renderTaskXml,
  shquote,
  stripHookBlock,
  windowsServiceBinary,
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

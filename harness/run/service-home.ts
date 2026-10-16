// What the scripts that run the real background service share
// (harness/run/switch.ts, harness/run/service-commands.ts): a fixture home
// the service can run in, the environment the clients run with, and a look at
// which `watch` processes are running.
//
// launchd and systemd start the service with the user's own HOME, not the
// caller's, so for them the fixture is linked into the real home (~/.claude,
// ~/.codex, and Claude Desktop's folder on macOS) and the client's files are
// written to the real ~/.let/hx. That runs on CI runners only, and refuses to
// start when any of those paths already exists. The container shell hook runs
// with the fixture as HOME.

import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { FakeGateway } from "../gateway/gateway.js";
import { generateHome, type Manifest, type Shape } from "../fixtures/gen-home.js";
import { clientEnv, writeClientFiles } from "./run-scenario.js";

export type Client = "hx" | "hx2";
export type Manager = "launchd" | "systemd" | "shell-hook";
export const MANAGERS: Manager[] = ["launchd", "systemd", "shell-hook"];

/** What `status` and `start` call each manager (src/daemon.ts managerName). */
export const MANAGER_NAME: Record<Manager, string> = { launchd: "launchd", systemd: "systemd (user)", "shell-hook": "shell hook (container)" };

export interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
}

export async function run(cmd: string[], env: Record<string, string>, timeoutMs = 120_000): Promise<Spawned> {
  const proc = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** `<hx|hx2> watch` processes running now, by client. */
export async function watchProcesses(): Promise<Record<Client, number[]>> {
  const r = await run(["ps", "-A", "-o", "pid=,args="], { PATH: process.env.PATH ?? "/usr/bin:/bin" });
  const found: Record<Client, number[]> = { hx: [], hx2: [] };
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+watch(\s|$)/.exec(line);
    if (!m) continue;
    const name = basename(m[2]!);
    if (name === "hx" || name === "hx2") found[name].push(Number(m[1]));
  }
  return found;
}

/** SIGKILL every `<hx|hx2> watch` process still running. */
export async function killWatchProcesses(): Promise<void> {
  const left = await watchProcesses();
  for (const pid of [...left.hx, ...left.hx2]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
}

export interface ServiceHome {
  manager: Manager;
  /** The HOME the clients and the service use. */
  home: string;
  /** Where the fixture was generated. */
  fixture: string;
  manifest: Manifest;
  /** The environment every client command runs with. */
  env: Record<string, string>;
  /** The clients' own files, connected to `cloud`; ~/.let/hx starts empty. */
  connect(cloud: FakeGateway, gatewayUrl: string): void;
  /** Unlink the fixture from the real home and remove ~/.let/hx there. */
  release(): void;
}

const LINKED = [".claude", ".codex", join("Library", "Application Support", "Claude")];

export function prepareServiceHome(o: { manager: Manager; work: string; name: string; shape: Shape; seed: string }): ServiceHome {
  const realHome = o.manager !== "shell-hook";
  if (realHome && process.env.GITHUB_ACTIONS !== "true") {
    throw new Error(`--manager ${o.manager} runs the service in this user's real home: CI runners only`);
  }
  const fixture = join(o.work, o.name);
  const home = realHome ? homedir() : fixture;
  if (realHome) {
    for (const rel of [...LINKED, join(".let", "hx")]) {
      let present = false;
      try {
        lstatSync(join(home, rel));
        present = true;
      } catch {
        // absent, as it must be
      }
      if (present) throw new Error(`refusing to run: ${join(home, rel)} already exists`);
    }
  }
  mkdirSync(o.work, { recursive: true });
  const manifest = generateHome({ out: fixture, shape: o.shape, seed: o.seed });
  const linked: string[] = [];
  if (realHome) {
    for (const rel of LINKED) {
      const source = join(fixture, rel);
      if (!existsSync(source)) continue;
      const target = join(home, rel);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target);
      linked.push(target);
    }
  }
  const env: Record<string, string> = clientEnv(home);
  // systemctl --user finds the user manager through these two; without them
  // it fails, and the clients pick the shell hook.
  if (o.manager === "systemd") {
    for (const k of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
      const v = process.env[k];
      if (v) env[k] = v;
    }
  }
  const hxDir = join(home, ".let", "hx");
  return {
    manager: o.manager,
    home,
    fixture,
    manifest,
    env,
    connect(cloud, gatewayUrl) {
      rmSync(hxDir, { recursive: true, force: true });
      writeClientFiles(home, cloud, gatewayUrl, {});
    },
    release() {
      for (const l of linked) {
        try {
          unlinkSync(l);
        } catch {
          // gone
        }
      }
      if (realHome) rmSync(hxDir, { recursive: true, force: true });
    },
  };
}

/** "hx version: X" → X. */
export async function versionOf(bin: string, env: Record<string, string>): Promise<string> {
  const r = await run([bin, "--version"], env);
  const m = /version: (\d+\.\d+\.\d+)/.exec(r.stdout);
  if (!m) throw new Error(`no version from ${bin}: ${r.stdout}${r.stderr}`);
  return m[1]!;
}

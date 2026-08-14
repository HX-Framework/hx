// Best-effort "open this URL in the user's browser", shared by `hx connect`
// (gateway approve page) and `hx ui` (the local HX Client UI).
//
// URLs handed here may be untrusted (verificationUriComplete comes straight
// off a gateway response): never hand one to a shell (a value like
// "https://x/$(...)" would execute), and only ever open http(s). Validate the
// scheme, then spawn with an argv array so the URL is a single non-shell
// argument.
//
// WSL: the session runs in Linux but the user's browser lives on the Windows
// side, where `xdg-open` can't reach. Prefer `wslview` (wslu's opener) when
// installed, else `explorer.exe` (works via Windows interop); both take the
// URL as one argv. Callers always print the URL too, so a machine with
// neither still leaves the user one paste away.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";

/** True when running inside Windows Subsystem for Linux. */
export function isWsl(): boolean {
  if (os.platform() !== "linux") return false;
  try {
    return readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

/**
 * Pick the opener command for a platform. `hasCommand` answers "is this
 * binary on PATH" so the WSL preference order stays testable.
 */
export function browserCommandFor(
  platform: string,
  wsl: boolean,
  hasCommand: (cmd: string) => boolean,
): [string, string[]] {
  if (platform === "darwin") return ["open", []];
  if (platform === "win32") return ["explorer", []];
  if (wsl && hasCommand("wslview")) return ["wslview", []];
  if (wsl) return ["explorer.exe", []];
  return ["xdg-open", []];
}

export function openBrowser(url: string): void {
  // Best-effort, fail silently — callers print the URL regardless.
  try {
    const scheme = new URL(url).protocol;
    if (scheme !== "http:" && scheme !== "https:") return;
  } catch {
    return;
  }
  const [cmd, baseArgs] = browserCommandFor(
    os.platform(),
    isWsl(),
    (c) => Bun.which(c) !== null,
  );
  const child = spawn(cmd, [...baseArgs, url], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

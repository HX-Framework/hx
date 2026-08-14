// Container detection for `hx ui`.
//
// Why the UI cares: on a normal host, `hx ui` binds 127.0.0.1 and opens the
// browser for you. Inside a container that loopback is the CONTAINER's own
// loopback, so your host browser can't reach it — the page never loads. To make
// a published port (`docker run -p 8000:8000`) actually forward to us, we must
// listen on a wildcard instead. We bind "::" (dual-stack IPv4+IPv6, with an
// IPv4-only "0.0.0.0" fallback if the container has no IPv6 — see tryServeUi) so
// an IPv6 client can reach us wherever the platform actually forwards IPv6 (e.g.
// native Linux Docker). But the link `hx ui` PRINTS uses 127.0.0.1, not
// localhost (see cli.ts `uiHost`): Docker Desktop (Windows/macOS) also publishes
// the port on the host's IPv6, and "localhost" resolves to IPv6 (::1) first
// there — Docker Desktop accepts that IPv6 connection then drops it (its IPv6
// forwarding is unreliable), so the browser gets an empty response. The 127.0.0.1
// literal forces the IPv4 path, which works on every platform. We switch this
// bind automatically on detecting a container, so plain `hx ui` needs no flags.
//
// Is auto-binding a wildcard a security downgrade? No. The bind address only picks
// which interfaces the socket listens on; it is NOT the access boundary. Two
// gates do that, both independent of the bind:
//   (1) the Host-header allowlist (only localhost/127.0.0.1/[::1] spellings) —
//       this stops a BROWSER (DNS-rebinding) and any raw-IP hit (a request to
//       the container IP 403s), but a non-browser peer can forge Host: localhost,
//       so it is not the peer gate;
//   (2) the per-run session token (256-bit, never sent to a peer) — THIS stops a
//       network peer: a sibling container on the bridge can reach the socket and
//       forge the Host header, but without the token it gets only the data-free
//       static shell and a version string.
// Nothing leaves the container regardless of bind unless the operator runs `-p`
// (an explicit publish gesture). Caveat: `docker run --network host` shares the
// host's netns, so the wildcard bind is then a real LAN bind (still token-gated)
// — the price of collapsing network isolation. See SECURITY.md.
//
// We deliberately do NOT try to detect whether the port was published (`-p`):
// Docker injects no signal about the host's port mapping into the container.
// Since a container started without `-p` is exactly the unreachable case, `hx
// ui` always prints the make-it-reachable instructions when it's in a container.

import { existsSync, readFileSync } from "node:fs";

/**
 * Pure decision over the raw container signals — kept separate from the
 * filesystem reads so it's unit-testable.
 *   • /.dockerenv          — Docker writes this into every container.
 *   • /run/.containerenv   — Podman's equivalent marker.
 *   • /proc/1/cgroup       — names the container runtime for PID 1 on cgroup v1
 *                            and many v2 setups (docker/containerd/kubepods/lxc).
 */
export function containerFromSignals(sig: {
  dockerenv: boolean;
  containerenv: boolean;
  cgroup: string | null;
}): boolean {
  if (sig.dockerenv || sig.containerenv) return true;
  if (sig.cgroup && /\b(docker|containerd|kubepods|libpod|podman|lxc)\b/i.test(sig.cgroup)) {
    return true;
  }
  return false;
}

/** PID 1's cgroup line, or null if it can't be read (non-Linux, locked down). */
function readInitCgroup(): string | null {
  try {
    return readFileSync("/proc/1/cgroup", "utf8");
  } catch {
    return null;
  }
}

/**
 * Best-effort "am I running inside a Linux container?".
 *
 * Gated to linux on purpose: hx running natively on macOS/Windows is never a
 * container for our purposes, and we must NOT auto-widen its bind to 0.0.0.0
 * (that would be a real LAN exposure). A container on a Mac/Windows host runs
 * inside Docker's Linux VM, so ITS platform is linux and detection still fires.
 */
export function isInsideContainer(): boolean {
  if (process.platform !== "linux") return false;
  return containerFromSignals({
    dockerenv: existsSync("/.dockerenv"),
    containerenv: existsSync("/run/.containerenv"),
    cgroup: readInitCgroup(),
  });
}

/**
 * The lines printed under the launch URL when `hx ui` runs in a container.
 * Always shown in a container (we can't tell if `-p` was passed), so it doubles
 * as the fix for the unreachable case and a harmless note when already reachable.
 */
export function containerAccessNote(port: number): string[] {
  return [
    `[hx]   ↑ running inside a container — open that link in your HOST machine's browser.`,
    `[hx]     if it doesn't load, this container isn't publishing port ${port}. Recreate it`,
    `[hx]     with the port published, then run \`hx ui\` again:`,
    `[hx]         docker run -p ${port}:${port} …    (a running container can't have -p added)`,
  ];
}

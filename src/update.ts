// `hx update` — fetch the newest hx binary from the workbench-api
// download proxy, verify its SHA-256, and atomically swap it over the
// currently-running binary's path. If the daemon is loaded, restart it
// so the new code starts handling uploads.
//
// The binary itself lives in a GitHub release on the public `hx-framework/hx`
// repo (rolling `builds/hx-X.Y.Z`, immutable `releases/hx-X.Y.Z`). We never
// hit github.com directly from a customer laptop — workbench-api's
// `GET /api/hx-gateway/download/:asset` is a server-side proxy that
// authenticates to GitHub with a PAT and streams the asset back. So
// `hx update` just talks to its own gateway, no auth needed.
//
// ── Update trust boundary (read before touching the fetch/verify path) ──────
// What the client trusts today: (1) the transport — every update URL must be
// https (`assertSecureFetchUrl`), the only exception being the loopback
// `--local` dev gateway; and (2) the gateway's honesty — we fetch the binary
// and its SHA-256 from the SAME download proxy, so the sha proves integrity in
// transit (no truncation/bit-flip) but NOT provenance: a gateway that is
// compromised or successfully impersonated can serve attacker bytes together
// with a matching sha, and this client would install them and run them as the
// user. There is currently NO publisher signature over the release verified
// against a key pinned in the client. Closing that gap (e.g. cosign/sigstore or
// an Ed25519 signature over the asset, checked against a compiled-in public key
// before write) is the remaining hardening for the self-update path; until it
// lands, gateway trust + TLS is the whole trust chain. See SECURITY.md.
//
// Atomic swap rationale: on POSIX, `rename(2)` on the same filesystem
// replaces the destination inode in one operation. A process already
// executing the old binary keeps its open file descriptor on the old
// inode (which is unlinked but not freed); the kernel only releases the
// inode once that process exits. So overwriting while the daemon runs
// is safe — the running daemon keeps its old code until we restart it.

import { platform, arch } from "node:os";
import { rename, writeFile, mkdir, chmod, unlink, readFile, readdir } from "node:fs/promises";
import { basename, join, win32 as winPath } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { dirname } from "node:path";
import { getDaemonOps, type DaemonOps, type DaemonState } from "./daemon.js";
import { HX_VERSION, parseStableSemver, compareStableSemver } from "./version.js";
import { assertSecureFetchUrl } from "./net.js";

/**
 * A single progress tick emitted while `hx update` fetches + unpacks the new
 * binary. The caller (cli.ts) renders these as the install.sh-style bar; the
 * three phases map onto its labels Downloading / Unpacking / Verifying.
 */
export interface UpdateProgress {
  /** Which stage of the update this tick reports. */
  phase: "download" | "unpack" | "verify";
  /** Overall completion to render, 0–100. */
  pct: number;
  /** Bytes received so far — download phase only. */
  received?: number;
  /** Total bytes expected, or 0 when the server omitted Content-Length — download phase only. */
  total?: number;
}

export interface UpdateOpts {
  /**
   * Absolute base URL for the workbench-api `hx-gateway` mount, e.g.
   * `https://workbench.let.ai/_api/hx-gateway`. The download proxy lives
   * one path segment deeper at `${gatewayBaseUrl}/download/:asset`.
   *
   * Typically passed from the saved `hx connect` config (`cfg.gatewayBaseUrl`).
   */
  gatewayBaseUrl: string;
  /** Override the destination binary path. Defaults to `process.execPath`. */
  binPath?: string;
  log?: (msg: string) => void;
  /**
   * Progress callback for the binary download + unpack + verify. Optional —
   * defaults to a no-op, so headless callers (and tests) need not supply one.
   */
  onProgress?: (ev: UpdateProgress) => void;
  /** Override the daemon controls. Defaults to the platform's `getDaemonOps()`. */
  daemonOps?: DaemonOps;
}

export interface UpdateResult {
  /** Asset filename downloaded, e.g. "hx-darwin-arm64". */
  asset: string;
  /** SHA-256 hex of the downloaded binary, or null when nothing was downloaded. */
  sha256: string | null;
  /** Final path the new binary was installed to. */
  installedPath: string;
  /** Whether the daemon was restarted because it was loaded. */
  daemonRestarted: boolean;
  /**
   * True when the running binary was already current (remote version not newer,
   * or byte-identical) — no download, swap, or daemon restart was performed.
   */
  alreadyLatest: boolean;
  /** The running binary's compiled-in semver (HX_VERSION) at update time. */
  localVersion: string;
  /** The release's advertised semver, or null if it couldn't be determined. */
  remoteVersion: string | null;
}

/**
 * True iff `remote` is a valid semver strictly newer than `local`. `null` or
 * an unparseable remote returns false — the caller then falls through to the
 * post-download SHA guard, so a bad version file never blocks an update.
 */
export function isRemoteNewer(local: string, remote: string | null): boolean {
  if (!remote) return false;
  const r = parseStableSemver(remote);
  const l = parseStableSemver(local);
  if (!r || !l) return false;
  return compareStableSemver(r, l) > 0;
}

export async function runUpdate(opts: UpdateOpts): Promise<UpdateResult> {
  const binPath = opts.binPath ?? process.execPath;
  const log = opts.log ?? noop;
  const onProgress = opts.onProgress ?? noopProgress;
  const downloadBase = `${opts.gatewayBaseUrl.replace(/\/+$/, "")}/download`;

  // Refuse to fetch the self-update binary over a downgraded transport. The
  // update path is the highest-value target (attacker bytes here run as the
  // user), so the SHA guard below is not enough on its own — a gateway that can
  // serve the binary can serve a matching sha too. Require https before any
  // update fetch (http allowed only for the loopback `--local` dev gateway).
  assertSecureFetchUrl(downloadBase, "hx update");

  const target = detectTarget();
  const asset = `hx-${target}`;
  const localVersion = HX_VERSION; // string, e.g. "76.0.0"

  // ── Skip the whole download when we're already current ────────────────
  // Cheap pre-check (a few bytes): the release advertises its version, so we
  // only spend the ~24 MB binary download + a daemon restart when the remote
  // is strictly newer than the running binary. If the version can't be read
  // (a release predating this asset, or a transient blip) we fall through and
  // let the post-download SHA guard below still short-circuit a no-op.
  const remoteVersion = await fetchRemoteVersion(downloadBase);
  if (remoteVersion !== null && !isRemoteNewer(localVersion, remoteVersion)) {
    return alreadyLatest(asset, binPath, localVersion, remoteVersion);
  }

  // Release ships the executable gzipped only — ~24 MB on the wire vs
  // ~60 MB raw. Sha covers the decompressed bytes, matching install.sh
  // and the runtime contract ("the file we exec is the file the sha
  // attests to").
  const binUrl = `${downloadBase}/${asset}.gz`;
  const shaUrl = `${downloadBase}/${asset}.sha256`;

  // Stream the ~24 MB binary with a live progress bar (0–85% of the run); the
  // remaining 15% covers the unpack + verify steps below, mirroring install.sh's
  // phasing so `hx update` and `curl … | sh` show the same download experience.
  const gzBytes = await fetchBytesWithProgress(binUrl, (received, total) => {
    const pct = total > 0 ? Math.min(85, Math.floor((received * 85) / total)) : 0;
    onProgress({ phase: "download", pct, received, total });
  });

  onProgress({ phase: "unpack", pct: 90 });
  const binBytes = gunzipSync(gzBytes);
  const shaText = (await fetchBytes(shaUrl)).toString("utf8").trim();
  onProgress({ phase: "verify", pct: 96 });
  const actual = assertSha(asset, binBytes, shaText);
  onProgress({ phase: "verify", pct: 100 });

  // Fallback no-op guard: if the freshly-downloaded binary is byte-identical
  // to the one already installed, there is nothing to swap or restart. Covers
  // the path where the version pre-check above was inconclusive.
  if ((await sha256OfFile(binPath)) === actual) {
    return alreadyLatest(asset, binPath, localVersion, remoteVersion);
  }

  await installBinary(binBytes, binPath);
  log(`installed → ${binPath}`);

  // Windows ships TWO binaries built from this same source: hx.exe (console —
  // the CLI) and hx-svc.exe (compiled --windows-hide-console; what the
  // scheduled task runs, so the background mirror doesn't park a console window
  // on the desktop). Updating only the CLI would leave the DAEMON running the
  // old code while `hx --version` reports the new one — precisely the lie the
  // restart-is-fatal branch below exists to prevent.
  if (platform() === "win32") {
    const svcAsset = `${asset}-svc`;
    const svcTarget = winPath.join(winPath.dirname(binPath), "hx-svc.exe");
    const svcGz = await fetchBytes(`${downloadBase}/${svcAsset}.gz`);
    const svcBytes = gunzipSync(svcGz);
    const svcShaText = (await fetchBytes(`${downloadBase}/${svcAsset}.sha256`)).toString("utf8").trim();
    assertSha(svcAsset, svcBytes, svcShaText);
    await installBinary(svcBytes, svcTarget);
    log(`installed → ${svcTarget}`);
  }

  // Restart the daemon iff it was loaded. We don't auto-load if the user had
  // never run `hx start` — that's a separate decision.
  //
  // Crucially, a restart failure is FATAL: the binary on disk is new but the
  // running daemon is still the old one (or down). Reporting "updated to
  // latest" here would be a lie — so we throw with the actual daemon state and
  // a concrete next step, and the caller never prints success.
  const ops = opts.daemonOps ?? getDaemonOps();
  const before = await ops.state();
  let daemonRestarted = false;
  if (before.loaded) {
    log(`restarting daemon (was ${before.pid ? `pid ${before.pid}` : "loaded but idle"})`);
    try {
      await ops.restart({ binPath });
    } catch (err) {
      const after = await ops
        .state()
        .catch((): DaemonState => ({ loaded: false, pid: null }));
      const next =
        after.loaded && after.pid !== null
          ? `the previous version is still running (pid ${after.pid}); run \`hx restart\` to load the new binary.`
          : `the daemon is not running; run \`hx start\` to launch the new binary.`;
      throw new Error(
        `binary installed at ${binPath}, but the daemon failed to restart: ` +
          `${(err as Error).message}\n${next}`,
        { cause: err },
      );
    }
    daemonRestarted = true;
  }

  return {
    asset,
    sha256: actual,
    installedPath: binPath,
    daemonRestarted,
    alreadyLatest: false,
    localVersion,
    remoteVersion,
  };
}

/** Shared "nothing to do" result — the running binary is already current. */
function alreadyLatest(
  asset: string,
  binPath: string,
  localVersion: string,
  remoteVersion: string | null,
): UpdateResult {
  return {
    asset,
    sha256: null,
    installedPath: binPath,
    daemonRestarted: false,
    alreadyLatest: true,
    localVersion,
    remoteVersion,
  };
}

/** Cheap update check for the UI: current vs advertised remote version. */
export async function checkForUpdate(
  gatewayBaseUrl: string,
): Promise<{ current: string; latest: string | null; updateAvailable: boolean }> {
  const downloadBase = `${gatewayBaseUrl.replace(/\/+$/, "")}/download`;
  assertSecureFetchUrl(downloadBase, "hx update check");
  const latest = await fetchRemoteVersion(downloadBase);
  return { current: HX_VERSION, latest, updateAvailable: isRemoteNewer(HX_VERSION, latest) };
}

/**
 * Fetch the release's advertised semver from the download proxy. Returns null
 * on any failure (older release without the asset, network blip, non-semver
 * body) so callers can fall back rather than hard-fail.
 */
async function fetchRemoteVersion(downloadBase: string): Promise<string | null> {
  try {
    const res = await secureFetch(`${downloadBase}/hx-version`);
    if (!res.ok) return null;
    const raw = (await res.text()).trim();
    return parseStableSemver(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort GC of staging files (`<bin>.new.<uuid>`) left by a prior run that
 * died between write and rename. Never throws — a failed sweep must not block an
 * update. Only removes siblings matching the exact `<binName>.new.` prefix.
 */
async function sweepStaleTempFiles(binPath: string): Promise<void> {
  try {
    const dir = dirname(binPath);
    // `.new.*` = a run that died between write and rename. `.old.*` = a Windows
    // swap whose cleanup failed because the parked binary was still executing
    // (see installBinary) — it becomes deletable once that process exits.
    const prefixes = [`${basename(binPath)}.new.`, `${basename(binPath)}.old.`];
    const entries = await readdir(dir);
    await Promise.all(
      entries
        .filter((name) => prefixes.some((pre) => name.startsWith(pre)))
        .map((name) => unlink(`${dir}/${name}`).catch(() => {})),
    );
  } catch {
    // Directory unreadable or gone — nothing to sweep.
  }
}

/**
 * Verify decompressed bytes against the sibling `.sha256`. Returns the hex
 * digest so callers can reuse it (the no-op guard compares it to what's on
 * disk). Throws on a malformed or mismatched sum.
 */
function assertSha(asset: string, bin: Buffer, shaText: string): string {
  // sha256sum format: "<hex>  <filename>" (two spaces). Tolerate a bare hex
  // string too — both forms are valid input here.
  const expected = shaText.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`malformed sha256 for ${asset}: ${shaText.slice(0, 200)}`);
  }
  const actual = sha256(bin);
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
  }
  return actual;
}

/**
 * Install `bytes` at `target`, replacing whatever is there.
 *
 * POSIX: one rename(2) (see the atomic-swap note at the top of this file) —
 * safe even while the old binary is executing, because that process keeps its
 * fd on the now-unlinked inode.
 *
 * WINDOWS HAS NO SUCH GUARANTEE. A running .exe is a mapped image section: it
 * cannot be overwritten or deleted (ERROR_ACCESS_DENIED). It CAN be renamed on
 * the same volume, so park the old one aside, move the new one into place, then
 * clean up. A parked file that won't delete because its process is still alive
 * is swept by a later run rather than failing the update.
 */
async function installBinary(bytes: Buffer, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await sweepStaleTempFiles(target);
  // Create the staging file EXCLUSIVELY at an unpredictable name. `flag: "wx"`
  // (O_CREAT|O_EXCL) refuses to open an existing path, so a same-uid attacker
  // can't pre-plant a symlink and have us clobber its target; the random suffix
  // removes the predictable-path race entirely.
  const tmpPath = `${target}.new.${randomUUID()}`;
  await writeFile(tmpPath, bytes, { flag: "wx", mode: 0o755 });
  // chmod is meaningless on Windows (mode maps only onto the read-only
  // attribute), so only normalize past a umask where that actually applies.
  if (process.platform !== "win32") await chmod(tmpPath, 0o755);

  try {
    if (process.platform === "win32") {
      // Park into %TEMP%, not beside the binary. Neither copy can be deleted at
      // swap time — this process is executing one and the daemon the other — so
      // parking in place left ~190 MB of .old files sitting in the install
      // directory until the NEXT update swept them, tripling the footprint of a
      // tool that is already 94 MB twice over. TEMP is somewhere Windows
      // already cleans. Falls back to in-place if TEMP is on another volume,
      // where rename cannot reach.
      let parked = join(tmpdir(), `${basename(target)}.old.${randomUUID()}`);
      let movedAside = false;
      try {
        await rename(target, parked);
        movedAside = true;
      } catch (err) {
        // ENOENT = first install; there is nothing to move out of the way.
        if ((err as { code?: string }).code !== "ENOENT") {
          parked = `${target}.old.${randomUUID()}`;
          await rename(target, parked);
          movedAside = true;
        }
      }
      try {
        await rename(tmpPath, target);
      } catch (err) {
        // Put the old binary back rather than leaving the install with none.
        if (movedAside) await rename(parked, target).catch(() => {});
        throw err;
      }
      await unlink(parked).catch(() => {});
    } else {
      await rename(tmpPath, target);
    }
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** SHA-256 of a file on disk, or null if it can't be read (e.g. first install). */
async function sha256OfFile(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path));
  } catch {
    return null;
  }
}

function detectTarget(): string {
  const osMap: Record<string, string> = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  };
  const archMap: Record<string, string> = {
    x64: "x64",
    arm64: "arm64",
  };
  const os = osMap[platform()];
  const a = archMap[arch()];
  if (!os) throw new Error(`hx update: unsupported OS ${platform()}`);
  if (!a) throw new Error(`hx update: unsupported arch ${arch()}`);
  return `${os}-${a}`;
}

/**
 * A `fetch` that follows redirects MANUALLY so every hop is scheme-checked. The
 * plain `redirect: "follow"` would silently chase an https gateway's 30x to an
 * `http://` (or otherwise attacker-chosen) host — defeating the pre-request
 * `assertSecureFetchUrl` guard, since the SHA is served from the same redirected
 * origin. Here we assert each Location is a secure URL before following it, so
 * the update binary and its sha can never be fetched over a downgraded hop.
 */
export async function secureFetch(url: string): Promise<Response> {
  const MAX_REDIRECTS = 5;
  let current = url;
  for (let hop = 0; ; hop++) {
    assertSecureFetchUrl(current, "hx update");
    const res = await fetch(current, {
      headers: { "User-Agent": `hx/${HX_VERSION}` },
      redirect: "manual",
    });
    // 3xx with a Location = a redirect the runtime did not follow (manual mode).
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`hx update: too many redirects fetching ${url}`);
    }
    // Resolve relative Locations against the current URL before re-checking.
    current = new URL(location, current).toString();
  }
}

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await secureFetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Like `fetchBytes`, but streams the response body and reports bytes-received
 * against the response's Content-Length as data arrives — the feed for the
 * download progress bar. The download proxy always sets Content-Length for the
 * binary, but we tolerate its absence (total = 0 → caller shows an
 * indeterminate pulse). Falls back to a single buffered read if the runtime
 * hands us no readable body.
 */
async function fetchBytesWithProgress(
  url: string,
  onChunk: (received: number, total: number) => void,
): Promise<Buffer> {
  const res = await secureFetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    onChunk(buf.length, total || buf.length);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  onChunk(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      chunks.push(Buffer.from(value));
      received += value.length;
      onChunk(received, total);
    }
  }
  return Buffer.concat(chunks);
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function noop(_: string): void {
  /* no-op log */
}

function noopProgress(_: UpdateProgress): void {
  /* no-op progress */
}

// Re-exported as a convenience for cli.ts; keeps the unused-import linter happy
// if someone wants to delete the binary directly.
export const unlinkFile = unlink;

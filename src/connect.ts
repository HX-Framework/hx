// Device-code "connect this laptop" flow.
//
// 1. POST /devices/code → { deviceCode, userCode, verificationUriComplete, interval }
// 2. Open the verification URL in the user's browser (best-effort).
// 3. Poll POST /devices/poll every `interval` seconds until approved.
// 4. Write { accessToken, userId, deviceName } to ~/.hx/config.json.
//
// Surfaced on the CLI as `hx connect` (with `hx login` as a hidden alias
// for binaries / installers that pre-date the rename).

import os from "node:os";
import { openBrowser } from "./browser.js";
import { writeConfig, ensureDeviceId, type HxConfig } from "./config.js";
import { assertSecureFetchUrl } from "./net.js";

interface CodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

interface PollPending {
  status: "pending";
}
interface PollApproved {
  status: "approved";
  accessToken: string;
  userId: string;
  // The device's final name as the gateway stored it — the browser approve
  // page lets the user (re)name the device, and that name wins over the
  // hostname default sent with the code request. Absent on older gateways.
  deviceName?: string | null;
}
type PollResponse = PollPending | PollApproved;

// ── pairing-code card ───────────────────────────────────────────────────
// The browser approve page says "Check this matches your terminal", so the
// code must actually be in the terminal and must stand out — a boxed
// label/value card in install.sh's palette (dim chrome, 256-colour-39
// accent), box-drawing glyphs on UTF-8 locales with an ASCII fallback, and
// no colour when stdout isn't a TTY.
//
// Contract with the installer: install.sh backgrounds `hx connect` with its
// output going to ~/.let/hx/connect.log, then lifts the code back out of that
// log by grepping for the XXXX-XXXX shape (uppercase A–Z minus I/O plus 2–9 —
// the gateway's user-code alphabet). The card is plain text in that log (not
// a TTY), and nothing hx prints before the card matches that shape — keep it
// that way when touching output above or inside the card.

export interface PairingCardOpts {
  userCode: string;
  /** Host of the approve page, e.g. "workbench.let.ai" — the second card row. */
  approveHost: string;
  /** Paint ANSI colours. Callers pass stdout-is-a-TTY. */
  tty: boolean;
  /** Use box-drawing glyphs. Callers pass the locale sniff. */
  utf8: boolean;
}

/** The boxed pairing-code card, as printable lines. Exported for scratch/tests. */
export function renderPairingCard(o: PairingCardOpts): string[] {
  const dim = o.tty ? "\x1b[2m" : "";
  const acc = o.tty ? "\x1b[1m\x1b[38;5;39m" : ""; // bold + the install.sh blue
  const rst = o.tty ? "\x1b[0m" : "";
  const [tl, tr, bl, br, hr, vr] = o.utf8
    ? ["╭", "╮", "╰", "╯", "─", "│"]
    : ["+", "+", "+", "+", "-", "|"];

  const rows = [
    { label: "Pairing code", value: o.userCode, accent: true },
    { label: "Workbench", value: o.approveHost, accent: false },
  ];
  const labelW = Math.max(...rows.map((r) => r.label.length));
  const valueW = Math.max(...rows.map((r) => r.value.length));
  // 3-space pad, label, 3-space gap, value, 3-space pad — mirrored by the
  // installer's draw_code_card so both surfaces render the same card.
  const inner = 3 + labelW + 3 + valueW + 3;

  const edge = (l: string, r: string) => `  ${dim}${l}${hr.repeat(inner)}${r}${rst}`;
  const gap = `  ${dim}${vr}${rst}${" ".repeat(inner)}${dim}${vr}${rst}`;
  const row = (r: (typeof rows)[number]) =>
    `  ${dim}${vr}${rst}   ${dim}${r.label.padEnd(labelW)}${rst}   ` +
    (r.accent ? `${acc}${r.value.padEnd(valueW)}${rst}` : r.value.padEnd(valueW)) +
    `   ${dim}${vr}${rst}`;

  return [edge(tl, tr), gap, ...rows.map(row), gap, edge(bl, br)];
}

function isUtf8Locale(): boolean {
  const locale = process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "";
  return /utf-?8/i.test(locale);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export interface ConnectOptions {
  gatewayBaseUrl: string;
  deviceName?: string;
  log: (msg: string) => void;
  /** Where to save the approved connection. Defaults to the main
   *  ~/.let/hx/config.json; `hx connect --local` passes writeLocalConfig so
   *  the tee lane's token never clobbers the main gateway's. */
  persist?: (cfg: HxConfig) => Promise<void>;
}

export async function connect(opts: ConnectOptions): Promise<void> {
  const deviceName = opts.deviceName ?? `${os.hostname()} (${os.userInfo().username})`;
  // Reuse this machine's stable id so the server can re-link sessions hidden
  // by a prior removal/disconnect to the token it's about to issue.
  const deviceId = await ensureDeviceId();
  // The poll step receives the device access token from the gateway, so refuse
  // to run the pairing handshake over cleartext to a non-loopback host.
  assertSecureFetchUrl(opts.gatewayBaseUrl, "hx connect");
  // Report this machine's REAL platform so the workbench Devices page shows the
  // actual OS rather than sniffing the approving browser's userAgent, which
  // mislabels e.g. a headless Linux VM approved from a Mac.
  const codeRes = await fetch(`${opts.gatewayBaseUrl}/devices/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceName, deviceId, os: os.platform(), arch: os.arch() }),
  });
  if (!codeRes.ok) {
    const txt = await codeRes.text().catch(() => "");
    throw new Error(`device-code request failed: ${codeRes.status} ${txt}`);
  }
  const code = (await codeRes.json()) as CodeResponse;
  const tty = Boolean(process.stdout.isTTY);
  const utf8 = isUtf8Locale();

  opts.log("");
  opts.log("  Opening your browser to approve this device…");
  opts.log("");
  for (const line of renderPairingCard({
    userCode: code.userCode,
    approveHost: hostOf(code.verificationUriComplete),
    tty,
    utf8,
  })) {
    opts.log(line);
  }
  opts.log("");
  opts.log("  Check the code matches what your browser shows, then approve there.");
  opts.log("");
  opts.log("  Browser didn't open? Visit:");
  opts.log(`    ${code.verificationUriComplete}`);
  opts.log("");
  opts.log("  Waiting for approval… (Ctrl+C to cancel)");

  openBrowser(code.verificationUriComplete);

  const deadline = Date.now() + code.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(code.interval * 1000);
    const pollRes = await fetch(`${opts.gatewayBaseUrl}/devices/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: code.deviceCode }),
    });
    if (pollRes.status === 410) {
      throw new Error("device code expired before approval");
    }
    if (pollRes.status === 202) continue;
    if (!pollRes.ok) {
      const txt = await pollRes.text().catch(() => "");
      throw new Error(`poll failed: ${pollRes.status} ${txt}`);
    }
    const data = (await pollRes.json()) as PollResponse;
    if (data.status === "approved") {
      // Cache the gateway's name, not the hostname default computed above:
      // the approve page may have renamed the device, and every other surface
      // (the workbench Devices page, later `hx connect` runs) shows THAT name.
      // Caching the local default here is how the CLI ended up claiming a
      // device name that matched no row on the Devices page.
      const finalName =
        typeof data.deviceName === "string" && data.deviceName.trim()
          ? data.deviceName.trim()
          : deviceName;
      await (opts.persist ?? writeConfig)({
        gatewayBaseUrl: opts.gatewayBaseUrl,
        accessToken: data.accessToken,
        userId: data.userId,
        deviceName: finalName,
      });
      const grn = tty ? "\x1b[32m" : "";
      const rst = tty ? "\x1b[0m" : "";
      const mark = utf8 ? "✓ " : "";
      opts.log("");
      opts.log(`  ${grn}${mark}Connected as "${finalName}".${rst}`);
      return;
    }
  }
  throw new Error("connect timed out");
}

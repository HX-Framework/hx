import { useApp } from "../store";
import { plural } from "../data";
import { fmtBytes, fmtClock, fmtRelative, type ProbeInfo } from "../api";
import { copyText } from "../store";
import { useState } from "react";

function probeLine(p: ProbeInfo | null, probing: boolean): { v: string; vs: string } {
  if (probing) return { v: "Testing…", vs: "3 pings + a 1 MiB download" };
  if (!p) return { v: "Not tested yet", vs: "runs on demand — nothing probes in the background" };
  if (!p.up) return { v: "Down", vs: p.reason ?? "gateway unreachable" };
  const rate = p.bytesPerSec ? ` · ${(p.bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s` : "";
  return { v: `${p.quality ?? "OK"} — ${p.latencyMs ?? "?"} ms${rate}`, vs: "probed just now — 3 pings + a 1 MiB download" };
}

export function DeviceDetail() {
  const {
    view, goto, snap, email, activeFolders, probe, probing, runProbe,
    daemonAct, retryBlockedAct, update, checkUpdate, runUpdateAct,
  } = useApp();
  const [copied, setCopied] = useState(false);
  const [engFlash, setEngFlash] = useState<string | null>(null);
  const [engBusy, setEngBusy] = useState(false);
  const [retryFlash, setRetryFlash] = useState<string | null>(null);

  const engAction = (action: "start" | "stop" | "restart") => {
    setEngBusy(true);
    void daemonAct(action)
      .then((msg) => {
        setEngFlash(msg);
        setTimeout(() => setEngFlash(null), 4500);
      })
      .finally(() => setEngBusy(false));
  };

  const doRetry = () => {
    void retryBlockedAct().then((msg) => {
      setRetryFlash(msg);
      setTimeout(() => setRetryFlash(null), 4500);
    });
  };

  const device = snap?.device;
  const daemon = device?.daemon;
  const running = Boolean(daemon?.loaded && daemon.pid);
  const doctor = snap?.doctor;
  const waiting = Math.max(0, (snap?.sync.total ?? 0) - (snap?.sync.done ?? 0));
  const q = probeLine(probe, probing);
  // Held lanes are invisible to every session-derived number on this panel:
  // discovery never walks the child-lane tree.
  const heldLanes = doctor?.childLanes?.held ?? 0;
  const nextRetry = doctor?.blockers.map((b) => (b.nextRetryAt ? Date.parse(b.nextRetryAt) : 0)).filter((t) => t > 0).sort()[0];

  const copyDiagnostics = () => {
    if (!doctor) return;
    if (copyText(JSON.stringify(doctor, null, 2))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <section className={`view${view === "device" ? " active" : ""}`} id="view-device">
      <div className="kicker">System</div>
      <h1>Device Detail</h1>
      <p className="lede">Everything this device’s <code className="hx">hx</code> client is doing — friendly at a glance, specific enough to debug over a screen share.</p>

      <div className="panel">
        <h2>Identity</h2>
        <div className="facts">
          <div className="frw">
            <span className="k">Name</span>
            <span><span className="v devname">{device?.name ?? "…"}</span><div className="vs">named when the device was approved — rename from your workbench</div></span>
          </div>
          <div className="frw"><span className="k">Platform</span><span><span className="v">{device ? `${device.platform} ${device.arch}` : "…"}</span><div className="vs">service manager: {daemon?.managerName ?? "…"}</div></span></div>
          <div className="frw">
            <span className="k"><code className="hx">hx</code> version</span>
            <span>
              <span className="v mono" id="verVal">{device?.hxVersion ?? "…"}</span>
              <div className={`vs${update.done || update.check ? " okv" : ""}`} id="verSub">
                {update.running ? (update.progress ?? "updating…")
                  : update.error ? update.error
                  : update.done ? update.done
                  : update.checking ? "checking…"
                  : update.check
                    ? update.check.updateAvailable
                      ? `${update.check.latest} is available — nothing was installed yet.`
                      : "You’re on the latest version."
                    : "self-updates via the gateway"}
              </div>
            </span>
            <span style={{ display: "flex", gap: 8 }}>
              <button className="btn ghost sm" id="updateBtn" disabled={update.checking || update.running} onClick={checkUpdate}>Check for updates</button>
              {update.check?.updateAvailable && !update.done && (
                <button className="btn sm" id="updateNowBtn" disabled={update.running} onClick={runUpdateAct}>Update to {update.check.latest}</button>
              )}
            </span>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Connection</h2>
        <div className="facts">
          <div className="frw">
            <span className="k">Status</span>
            <span>
              <span className="v" id="connStatusV">{device ? (device.connected ? "Connected" : "Not connected") : "…"}</span>
              <div className="vs" id="connStatusVs">{device?.connected ? `as ${email ?? "…"} · this device is approved` : "run `hx connect` to approve this device — sessions stay on this machine until then"}</div>
            </span>
          </div>
          <div className="frw"><span className="k">Gateway</span><span><span className="v mono">{device?.gatewayHost ?? "not configured"}</span></span></div>
          <div className="frw">
            <span className="k">Link quality</span>
            <span>
              <span className="v" id="connQualV">{q.v}</span>
              <div className={`vs${probe && !probing ? " okv" : ""}`} id="connQualVs">{q.vs}</div>
            </span>
            <button className="btn ghost sm" id="connTestBtn" disabled={probing} onClick={runProbe}>Test connection</button>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Sync Engine</h2>
        <div className="facts">
          <div className="frw">
            <span className="k">State</span>
            <span>
              <span className="v" id="engState">{daemon ? (running ? "Running — watching" : "Stopped") : "…"}</span>
              <div className={`vs${engFlash ? " okv" : ""}`} id="engStateSub">{engFlash ?? (daemon
                ? running
                  ? `daemon running · pid ${daemon.pid} · via ${daemon.managerName}`
                  : "daemon not running — sessions still queue safely; start it from here any time"
                : "")}</div>
            </span>
            <span style={{ display: "flex", gap: 8 }}>
              <button className="btn ghost sm" id="restartBtn" disabled={engBusy || !running} onClick={() => engAction("restart")}>Restart</button>
              <button className="btn ghost sm" id="stopBtn" disabled={engBusy} onClick={() => engAction(running ? "stop" : "start")}>{running ? "Stop" : "Start"}</button>
            </span>
          </div>
          <div className="frw">
            <span className="k">Last pass</span>
            <span><span className="v" id="lpV">{fmtRelative(snap?.sync.lastUploadAtMs ?? 0)}</span><div className="vs">most recent successful upload from this device</div></span>
            <button className="btn ghost sm" id="tickBtn" disabled={engBusy || !running} onClick={() => engAction("restart")}>Sync now</button>
          </div>
          {/* "fully caught up" is a claim about the device, and `waiting` counts
              SESSIONS only — a held agent lane is invisible to it. Unqualified,
              this row said "Empty / fully caught up" in the same panel as
              "Catching up" and "1 lane held". */}
          <div className="frw"><span className="k">Queue</span><span><span className="v">{waiting > 0 ? plural(waiting, "session") : heldLanes > 0 ? plural(heldLanes, "lane") : "Empty"}</span><div className="vs">{waiting > 0 ? "waiting to upload on the next pass" : heldLanes > 0 ? "agent lanes held — release with hx retry --blocked" : "fully caught up"}</div></span></div>
          <div className="frw"><span className="k">Backoff</span><span><span className="v">{nextRetry ? `next retry ${fmtClock(nextRetry)}` : "None"}</span></span></div>
          <div className="frw"><span className="k">Cadence</span><span><span className="v">Every 1.5 seconds</span><div className="vs">file changes are noticed by polling</div></span></div>
        </div>
      </div>

      <div className="panel">
        <h2>Local Folders</h2>
        <p style={{ fontSize: 15, color: "var(--text-muted)", maxWidth: 640, margin: "2px 0 0" }}>
          This device watches the Claude Code and Codex session homes, currently holding <b id="devFolderCount">{plural(activeFolders.length, "folder")}</b>. The full folder-by-folder picture — what’s watched, where each folder goes, and why — lives in one place:
        </p>
        <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}><button className="btn ghost" onClick={() => goto("folders")}>Open Folders &amp; Destinations</button></div>
      </div>

      <div className="panel">
        <h2>Local Files</h2>
        <div className="facts">
          <div className="frw"><span className="k">State</span><span><span className="v mono">~/.let/hx/state.json</span><div className="vs">per-file upload offsets, one entry per session</div></span></div>
          <div className="frw"><span className="k">Config</span><span><span className="v mono">~/.let/hx/config.json</span><div className="vs">device credentials — never shown here</div></span></div>
          <div className="frw"><span className="k">Logs</span><span><span className="v mono">~/.let/hx/stdout.log</span><div className="vs">see Client Logs for a live view</div></span></div>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 18, justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={() => goto("logs")}>View client logs</button>
          <button className="btn ghost" onClick={copyDiagnostics}>{copied ? "Copied" : "Copy diagnostics"}</button>
        </div>
      </div>

      <div className="panel" id="doctorSection">
        <h2>Sync Doctor</h2>
        <div className="h2sub">Live — anything that isn’t syncing (which sessions are held, at which destination, since when) and any gaps the sync bar can’t see. Updates on its own.</div>
        <div id="doctorOut" style={{ padding: "8px 0 4px" }}>
          {!doctor ? (
            <div className="rowlist"><div className="row"><div className="who"><b>Loading…</b></div></div></div>
          ) : (
            <div className="rowlist">
              <div className="row">
                <span className={`dot${doctor.sync.percent < 100 || !doctor.ok ? " warn" : ""}`}></span>
                <div className="who"><b>Sync</b><div className="sub">{doctor.sync.done} of {doctor.sync.total} sessions · {fmtBytes(doctor.sync.totalBytes)} — {doctor.sync.percent}%</div></div>
                {/* Keyed on the VERDICT, not on one of its inputs. With held
                    lanes as the only fault, percent is 100 while ok is false —
                    so this row answered "Healthy" directly above the warn-pilled
                    "Agent lanes — 1 lane held" row, on the very panel Overview
                    sends the user to when it says "Caught up: No". */}
                <div><span className={`pill ${doctor.sync.percent === 100 && doctor.ok ? "ok" : "warn"}`}>{doctor.sync.percent === 100 && doctor.ok ? "Healthy" : "Catching up"}</span></div>
                <div className="m">generated just now</div>
              </div>
              <div className="row">
                <span className={`dot${doctor.gaps.sessions > 0 ? " warn" : ""}`}></span>
                <div className="who"><b>Sync gaps</b><div className="sub">{doctor.gaps.sessions > 0
                  ? `${doctor.gaps.sessions} partial on server — ${doctor.gaps.localFileDeleted} with the local file deleted, ${doctor.gaps.outsideScanWindow} aged out of the scan window`
                  : "0 partial on server — no local files deleted, none aged out of the scan window"}</div></div>
                <div><span className={`pill ${doctor.gaps.sessions > 0 ? "warn" : "ok"}`}>{doctor.gaps.sessions > 0 ? String(doctor.gaps.sessions) : "None"}</span></div>
                <div className="m">—</div>
              </div>
              {(doctor.childLanes?.held ?? 0) > 0 && (
                // Overview clears "Caught up" for held child lanes and points
                // the user HERE. Every other row on this panel is
                // parent-session-only — blockers come from report.skipped,
                // which is built from discovered files, and discovery never
                // walks the subagents tree — so without this row the panel
                // showed "1 of 1 sessions, 100%, Healthy" and no blockers, to
                // someone sent to it to find out what was wrong.
                <div className="row">
                  <span className="dot warn"></span>
                  <div className="who"><b>Agent lanes</b><div className="sub">{plural(doctor.childLanes?.held ?? 0, "lane")} held — these upload separately from their session and will not retry until released with <span className="mono">hx retry --blocked</span></div></div>
                  <div><span className="pill warn">{doctor.childLanes?.held ?? 0}</span></div>
                  <div className="m">—</div>
                </div>
              )}
              {doctor.blockers.map((b, i) => (
                <div className="row" key={i}>
                  <span className="dot warn"></span>
                  <div className="who"><b>{plural(b.sessionCount, "session")} {b.reason === "quarantine" ? "awaiting a routing decision" : `held at ${b.destination?.orgName ?? b.destination?.orgSlug ?? "an organization vault"}`}</b><div className="sub">{b.reason === "vault_offline" ? "Session Vault offline — retrying with backoff" : b.reason === "vault_home_unreachable" ? "Home Fortress not connected — retrying with backoff" : b.reason === "quarantine" ? "Routing not decided yet — the gateway will place these once the parent upload lands" : "store unreachable — retrying with backoff"}</div></div>
                  <div><span className="pill warn">Held</span></div>
                  <div className="m">{b.nextRetryAt ? `next retry ${fmtClock(Date.parse(b.nextRetryAt))}` : "retrying"}</div>
                </div>
              ))}
            </div>
          )}
          {/* Held lanes are releasable by exactly this button, and blockers
              contains parent sessions only — so the panel told the user to run
              `hx retry --blocked` and then withheld the control that runs it. */}
          {doctor && (doctor.blockers.length > 0 || (doctor.childLanes?.held ?? 0) > 0) && (
            <>
              {/* A quarantine has no destination to bring online and no
                  repository to move — the gateway has simply not chosen where
                  these go yet. Offering the Fortress fix there sends the reader
                  after something that does not exist. */}
              {doctor.blockers.some((b) => b.reason !== "quarantine") ? (
                <div className="why-note" style={{ marginTop: 12 }}><b>Fix:</b> bring the Session Vault back online, or ask an admin to move the repository to a live destination. Nothing is lost — held sessions send automatically on reconnect.</div>
              ) : (
                <div className="why-note" style={{ marginTop: 12 }}><b>Nothing to fix here:</b> the gateway has not chosen a destination for these sessions yet. It resolves once the parent upload lands, or once the uploader’s org memberships are unambiguous. Nothing is lost.</div>
              )}
              <div className="why-act">
                <button className="btn ghost sm" id="retryBtn" onClick={doRetry}>Retry blocked now</button>
                <button className="btn ghost sm" onClick={() => goto("folders")}>Open Folders &amp; Destinations</button>
              </div>
              <div className={`resultline${retryFlash ? " on" : ""}`} id="retryResult">{retryFlash}</div>
            </>
          )}
        </div>
        <details className="cliref">
          <summary>Prefer the command line?</summary>
          <p style={{ fontSize: 14.5, color: "var(--text-muted)", margin: "4px 0 10px" }}>Everything in this app is also <code className="hx">hx</code> in a terminal:</p>
          <div className="clirow"><span className="c">hx status</span><span className="d">The Overview — account, gateway, daemon, connection quality, sync progress.</span></div>
          <div className="clirow"><span className="c">hx doctor sync</span><span className="d">The Sync Doctor section above — blocked sessions, gaps, and the fix (add <span className="mono">--json</span> for automation).</span></div>
          <div className="clirow"><span className="c">hx retry --blocked</span><span className="d">Clear destination backoff and retry immediately.</span></div>
          <div className="clirow"><span className="c">hx logs</span><span className="d">Client Logs, as a live tail of the same files.</span></div>
          <div className="clirow"><span className="c">hx start · stop · restart</span><span className="d">The background mirror service.</span></div>
          <div className="clirow"><span className="c">hx tick</span><span className="d">One upload pass, then done.</span></div>
          <div className="clirow"><span className="c">hx backfill</span><span className="d">Upload task lists &amp; plans for sessions synced before task tracking existed.</span></div>
          <div className="clirow"><span className="c">hx update</span><span className="d">Fetch the latest <code className="hx">hx</code> and restart the daemon.</span></div>
          <div className="clirow"><span className="c">hx connect · disconnect</span><span className="d">Signing this device in and out.</span></div>
          <div className="clirow"><span className="c">hx uninstall</span><span className="d">Remove <code className="hx">hx</code> from this device entirely.</span></div>
          <div className="clirow"><span className="c">hx watch</span><span className="d">The sync daemon itself, run in the foreground — what this whole app is watching.</span></div>
          <div className="clirow"><span className="c">hx ui</span><span className="d">Opens this app.</span></div>
        </details>
      </div>
    </section>
  );
}

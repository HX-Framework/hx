import { useEffect, useState } from "react";
import { useApp } from "../store";
import { fmtRelative, type ProbeInfo } from "../api";
import { MonitorIc, MoonSunIc } from "../icons";

function probeLabel(p: ProbeInfo | null): string {
  if (!p) return "not tested yet";
  if (!p.up) return `down — ${p.reason ?? "unreachable"}`;
  const rate = p.bytesPerSec ? ` · ${(p.bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s` : "";
  return `${p.quality ?? "OK"} — ${p.latencyMs ?? "?"} ms${rate}`;
}

export function Topbar() {
  const { goto, snap, email, probe, probing, runProbe } = useApp();
  const [theme, setTheme] = useState<"light" | "dark">(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const device = snap?.device;
  const running = Boolean(device?.daemon.loaded && device.daemon.pid);
  const connected = Boolean(device?.connected);
  const up = connected && running;
  const label = !device ? "…" : !connected ? "Not connected" : running ? "Connected" : "Mirror stopped";
  const deviceName = device?.name ?? "this device";
  const waiting = Math.max(0, (snap?.sync.total ?? 0) - (snap?.sync.done ?? 0));
  const initials = email ? email.slice(0, 2).toUpperCase() : "–";

  return (
    <div className="topbar">
      <div className="mark"><i></i><i></i><i></i><i></i></div>
      <div className="wordmark">HX Client</div>

      <div className="chip" id="connChip" style={{ marginLeft: 8 }}>
        <span className="dot" id="connDot" style={{ background: up ? "var(--ok)" : "var(--border-strong)" }}></span> <span id="connLabel">{label}</span>
        <div className="pop left">
          <div className="plbl">Link quality</div>
          <span id="popQuality">{probing ? "testing…" : probeLabel(probe)}</span>
          <div className="plbl">Gateway</div>
          {device?.gatewayHost ?? "not configured"}
          <div className="plbl">Last upload</div>
          <span id="popLast">{fmtRelative(snap?.sync.lastUploadAtMs ?? 0)}</span>
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button className="btn ghost sm" id="popTestBtn" disabled={probing} onClick={runProbe}>Test connection</button>
            <button className="btn ghost sm" onClick={() => goto("device")}>Sync Engine →</button>
          </div>
        </div>
      </div>

      <div className="spacer"></div>

      <button className="iconbtn" id="themeBtn" title="Switch theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
        <MoonSunIc dark={theme === "dark"} />
      </button>

      <div className="chip click" id="deviceChip" onClick={() => goto("device")}>
        <MonitorIc />
        <b className="devname">{deviceName}</b>
        <div className="pop">
          <div className="pname devname">{deviceName}</div>
          <div className="psub">{device ? `${device.platform} ${device.arch} · ` : ""}<code className="hx">hx</code> {device?.hxVersion ?? ""}</div>
          <div className="plbl">Right now</div>
          {waiting > 0 ? `${waiting} session${waiting === 1 ? "" : "s"} waiting to upload` : "Fully synced"}
          <div style={{ marginTop: 14 }}><span style={{ color: "var(--accent)", fontWeight: 600 }}>Click for device detail →</span></div>
        </div>
      </div>

      <div className="chip">
        <span className="avatar">{initials}</span> <b>{email ?? "…"}</b>
        <div className="pop">
          <div className="pname">{email ?? "signed-in user"}</div>
          <div className="psub">signed in on this device</div>
          <div className="plbl">Gateway</div>
          {snap?.device.gatewayHost ?? "not configured"}
        </div>
      </div>
    </div>
  );
}

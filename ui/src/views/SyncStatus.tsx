import { useRef, useState } from "react";
import { useApp } from "../store";
import { plural } from "../data";
import { fmtBytes, fmtClock, fmtRelative, type ActivityEntry } from "../api";
import { CloudIc } from "../icons";

/** 24 hourly MB/session buckets ending at the current hour. */
function hourlyBuckets(entries: ActivityEntry[], nowMs: number) {
  const HOUR = 3_600_000;
  const end = Math.floor(nowMs / HOUR) * HOUR + HOUR;
  const buckets = Array.from({ length: 24 }, (_, i) => ({
    startMs: end - (24 - i) * HOUR,
    bytes: 0,
    sessions: new Set<string>(),
  }));
  for (const e of entries) {
    const idx = Math.floor((e.at - (end - 24 * HOUR)) / HOUR);
    if (idx >= 0 && idx < 24) {
      buckets[idx].bytes += e.bytes;
      buckets[idx].sessions.add(e.sessionId);
    }
  }
  return buckets.map((b) => ({ startMs: b.startMs, bytes: b.bytes, sessions: b.sessions.size }));
}

function Chart({ entries }: { entries: ActivityEntry[] }) {
  const [tip, setTip] = useState<{ text: string; left: number } | null>(null);
  const barsRef = useRef<HTMLDivElement>(null);
  const buckets = hourlyBuckets(entries, Date.now());
  const maxBytes = Math.max(1, ...buckets.map((b) => b.bytes));
  const maxMb = Math.max(0.1, maxBytes / (1024 * 1024));
  const hh = (ms: number) => String(new Date(ms).getHours()).padStart(2, "0");
  return (
    <div className="chart">
      <div className="yaxis"><span>{maxMb >= 1 ? `${Math.ceil(maxMb)} MB` : `${Math.ceil(maxMb * 1024)} KB`}</span><span>{maxMb >= 1 ? `${Math.ceil(maxMb) / 2} MB` : `${Math.ceil((maxMb * 1024) / 2)} KB`}</span><span>0</span></div>
      <div className="plot">
        <div className="gridl" style={{ top: 0 }}></div>
        <div className="gridl" style={{ top: "50%" }}></div>
        <div
          className="bars" id="bars" ref={barsRef}
          onMouseOver={(e) => {
            const t = e.target as HTMLElement;
            if (t.tagName === "I" && t.dataset.tip) {
              const r = t.getBoundingClientRect();
              const pr = barsRef.current!.getBoundingClientRect();
              setTip({ text: t.dataset.tip, left: r.left - pr.left + r.width / 2 });
            }
          }}
          onMouseLeave={() => setTip(null)}
        >
          <div className="tip" id="barTip" style={tip ? { display: "block", left: tip.left } : undefined}>{tip?.text}</div>
          {buckets.map((b) => (
            <i
              key={b.startMs}
              className={b.bytes / maxBytes >= 0.5 ? "hot" : undefined}
              style={{ height: Math.max(3, (b.bytes / maxBytes) * 100) + "%" }}
              data-tip={`${hh(b.startMs)}:00–${hh(b.startMs + 3_600_000)}:00 · ${fmtBytes(b.bytes)} · ${plural(b.sessions, "session")}`}
            />
          ))}
        </div>
        <div className="axis"><span>{hh(buckets[0].startMs)}:00</span><span>{hh(buckets[6].startMs)}:00</span><span>{hh(buckets[12].startMs)}:00</span><span>{hh(buckets[18].startMs)}:00</span><span>now</span></div>
      </div>
    </div>
  );
}

export function SyncStatus() {
  const { view, goto, snap, destinations, activity, settings, resumeAll } = useApp();
  const paused = settings?.pause != null;
  const pausedUntil = settings?.pause?.untilMs ?? null;

  const sync = snap?.sync;
  const doctor = snap?.doctor;
  // Not yet fully mirrored = total − done (includes actively-uploading
  // sessions, not only ones held on an offline store), so the count agrees
  // with the "N of M mirrored" doctor line.
  const waiting = Math.max(0, (sync?.total ?? 0) - (sync?.done ?? 0));
  const recent = snap?.recent ?? [];
  const last = recent[0];
  const destLabel = (key: string) => destinations.find((d) => d.key === key)?.label ?? key;

  const dayStart = new Date().setHours(0, 0, 0, 0);
  const today = (activity ?? []).filter((e) => e.at >= dayStart);
  const todaySessions = new Set(today.map((e) => e.sessionId)).size;
  const todayBytes = today.reduce((n, e) => n + e.bytes, 0);

  return (
    <section className={`view${view === "activity" ? " active" : ""}`} id="view-activity">
      <div className="kicker">This device</div>
      <h1>Sync Status</h1>
      <p className="lede">What <code className="hx">hx</code> is syncing right now, what’s queued, and what this device has been sending.</p>

      {paused && (
        <div className="banner warn" id="pauseBanner" style={{ display: "flex" }}>
          <span className="badge">II</span>
          <span className="btxt"><b>Syncing is paused.</b> {pausedUntil ? `It resumes at ${fmtClock(pausedUntil)}.` : "It stays paused until you resume it."} Sessions keep queueing safely on this machine.</span>
          <button className="btn" id="pauseBannerResume" onClick={resumeAll}>Resume now</button>
        </div>
      )}

      <div className="stats">
        <div className="stat"><span className="lbl">On disk</span><div className="big">{sync?.total ?? "…"}</div><div className="sub">{sync ? `sessions · ${fmtBytes(sync.totalBytes)}` : ""}</div></div>
        <div className="stat"><span className="lbl">Mirrored</span><div className="big">{doctor ? `${doctor.sync.percent}%` : "…"}</div><div className="sub">{doctor ? `${doctor.sync.done} of ${doctor.sync.total} sessions` : ""}</div></div>
        <div className="stat"><span className="lbl">{activity && activity.length > 0 ? "Sent today" : "Waiting"}</span>
          {activity && activity.length > 0
            ? <><div className="big">{todaySessions}</div><div className="sub">{todaySessions > 0 ? `sessions · ${fmtBytes(todayBytes)}` : "nothing yet today"}</div></>
            : <><div className="big">{sync ? waiting : "…"}</div><div className="sub">{waiting > 0 ? "still syncing" : "nothing queued"}</div></>}
        </div>
        <div className="stat"><span className="lbl">Last sent</span><div className="big">{fmtRelative(sync?.lastUploadAtMs ?? 0).replace(" ago", "")}</div><div className="sub">{last ? `ago, to ${last.dests.map(destLabel).join(" · ")}` : "ago"}</div></div>
      </div>

      {activity && activity.length > 0 && (
        <div className="panel">
          <h2>Data Sent</h2>
          <div className="h2sub">Last 24 hours — hover any bar for the exact numbers.</div>
          <Chart entries={activity} />
        </div>
      )}

      {doctor && doctor.blockers.length > 0 && (
        <div className="panel">
          <h2>Held Right Now</h2>
          <div className="h2sub">Destinations that can’t take uploads at the moment — nothing is lost; queued sessions send on reconnect.</div>
          <div className="rowlist">
            {doctor.blockers.map((b, i) => (
              <div className="row" key={i}>
                <span className="dot warn"></span>
                <div className="who"><b>{b.orgName ?? "Organization vault"}</b><div className="sub">{b.reason === "vault_offline" ? "Session Vault offline — sessions held safely until it reconnects" : b.reason === "vault_home_unreachable" ? "Home Fortress not connected — sessions held safely until it comes online" : "store unreachable — retrying with backoff"}</div></div>
                <div><span className="pill warn">Held</span></div>
                <div className="m">{plural(b.sessions, "session")}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="panel">
        <h2>Recently Synced</h2>
        <div className="h2sub">Newest first — the most recent sessions this device uploaded.</div>
        <div className="rowlist" id="syncNow">
          {recent.length === 0 && (
            <div className="empty">
              <span className="ico"><CloudIc /></span>
              <b>Nothing uploaded yet</b>
              <p>Sessions appear here as the mirror sends them.</p>
            </div>
          )}
          {recent.map((r) => (
            <div className="row" key={`${r.atMs}-${r.title}`}>
              <span className="dot"></span>
              <div className="who"><span className="t">{fmtClock(r.atMs)}</span><b>{r.title}</b><div className="sub">{r.folder}</div></div>
              <div>{r.dests.map((d) => (
                <span key={d} className={`pill ${d === "letai" ? "cloud" : "fortress"} mini`}>{destLabel(d)}</span>
              ))}</div>
              <div className="m">{fmtBytes(r.sizeBytes)}</div>
            </div>
          ))}
          <div style={{ padding: "12px 4px 4px", fontSize: 14, color: "var(--text-subtle)" }}>The complete record lives in <a href="#" onClick={(e) => { e.preventDefault(); goto("logs"); }}>Client Logs</a>.</div>
        </div>
      </div>
    </section>
  );
}

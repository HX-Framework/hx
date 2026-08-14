import { useEffect, useRef, useState } from "react";
import { copyText, useApp } from "../store";
import { GPill } from "../components/GPill";
import { CheckIc, CopyIc, MaxiMiniIc, SearchIc } from "../icons";

const LEVEL_LABEL: Record<"all" | "up" | "warn", string> = { all: "Everything", up: "Uploads", warn: "Warnings & errors" };
const LEVEL_OPTIONS: ["all" | "up" | "warn", string][] = [["all", "Everything"], ["up", "Uploads"], ["warn", "Warnings & errors"]];

export function Logs() {
  const { view, snap, logs, logFull, setLogFull } = useApp();
  const [level, setLevel] = useState<"all" | "up" | "warn">("all");
  const [levelMenuOpen, setLevelMenuOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);

  const q = filter.trim();
  const ql = q.toLowerCase();
  const visible = logs.map((l) => {
    const okLevel = level === "all" || l.level === level;
    const okText = !ql || l.body.toLowerCase().includes(ql);
    return okLevel && okText;
  });
  const shown = visible.filter(Boolean).length;
  const total = logs.length;

  useEffect(() => {
    if (!autoScroll || !paneRef.current) return;
    paneRef.current.scrollTop = paneRef.current.scrollHeight;
  }, [logs, autoScroll, level, filter]);

  const copyVisible = () => {
    const text = logs.filter((_, i) => visible[i]).map((l) => l.body).join("\n");
    if (copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  const download = () => {
    const blob = new Blob([logs.map((l) => l.body).join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "hx-client.log";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className={`view${view === "logs" ? " active" : ""}`} id="view-logs">
      <div className="kicker">System</div>
      <h1>Client Logs</h1>
      <p className="lede">The one technical page — the <code className="hx">hx</code> daemon’s own words, for when something needs a closer look. Logs stay on this machine.</p>

      <div id="logShell" className={logFull ? "full" : undefined}>
        <div className="logtitle">Client Logs — <span className="devname">{snap?.device.name ?? "this device"}</span></div>
        <div className="logbar">
          <GPill id="logLevelPill" label="Show" value={LEVEL_LABEL[level]} valueId="logLevelVal" menuId="logLevelMenu" open={levelMenuOpen} setOpen={setLevelMenuOpen}>
            {LEVEL_OPTIONS.map(([lf, label]) => (
              <button key={lf} className={level === lf ? "sel" : undefined} onClick={() => { setLevel(lf); setLevelMenuOpen(false); }}>{label}</button>
            ))}
          </GPill>
          <div className="search compact">
            <SearchIc />
            <input id="logFilter" placeholder="Filter rows…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <span style={{ flex: 1 }}></span>
          <button className="iconbtn" id="logCopyBtn" title="Copy visible rows" onClick={copyVisible}>
            {copied ? <CheckIc /> : <CopyIc />}
          </button>
          <button className={`fpill${autoScroll ? " sel" : ""}`} id="autoScrollBtn" onClick={() => setAutoScroll(!autoScroll)}>Auto-scroll: {autoScroll ? "On" : "Off"}</button>
          <button className="btn ghost" onClick={download}>Download</button>
          <button className="iconbtn" id="logMaxBtn" title="Full-page view" onClick={() => setLogFull(!logFull)}>
            <MaxiMiniIc full={logFull} />
          </button>
        </div>
        <div className={`minibanner${q.length > 0 ? " on" : ""}`} id="logFilterBanner">
          <span id="logFilterText">{q.length > 0 ? `Filtering rows in real time for “${q}” — showing ${shown} of ${total}.` : ""}</span>
          <span style={{ flex: 1 }}></span>
          <button className="btn link sm" id="logFilterClear" onClick={() => setFilter("")}>Clear</button>
        </div>
        <div className="logpane scrolly" id="logPane" ref={paneRef}>
          {logs.length === 0 && <div className="ln">No log lines yet — the daemon writes to ~/.let/hx/stdout.log as it runs.</div>}
          {logs.map((l, i) => (
            <div key={i} className={`ln${l.level === "up" ? " up" : l.level === "warn" ? " warnl" : ""}`} data-l={l.level} style={{ display: visible[i] ? "" : "none" }}>
              {l.body}
            </div>
          ))}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 20 }}>
        <h2>Log Files on Disk</h2>
        <PathRow k="Full log" p="~/.let/hx/stdout.log" />
        <PathRow k="Errors only" p="~/.let/hx/stderr.log" />
      </div>
    </section>
  );
}

function PathRow({ k, p }: { k: string; p: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="pathrow">
      <span className="k">{k}</span><span className="p">{p}</span>
      <button className="btn ghost sm" onClick={() => { if (copyText(p)) { setCopied(true); setTimeout(() => setCopied(false), 1200); } }}>{copied ? "Copied" : "Copy path"}</button>
    </div>
  );
}

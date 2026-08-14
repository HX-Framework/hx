import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../store";
import { fmtBytes, fmtClock } from "../api";
import { SearchIc } from "../icons";

// The inspector lists every session the device knows, newest upload first;
// selecting one loads a real preview of the transcript tail — the same bytes
// that upload.

interface Item {
  path: string;
  title: string;
  folder: string;
  dests: string[];
  sizeBytes: number;
  atMs: number;
}

export function InspectorModal() {
  const { inspOpen, setInspOpen, inspInitialPath, snap, activeFolders, sessionsFor, loadSessions, previewFor, loadPreview, destinations } = useApp();
  const [selPath, setSelPath] = useState<string | null>(null);
  const [inspQuery, setInspQuery] = useState("");

  // Load sessions for every folder once the modal opens (bounded: folders on a
  // device are few; each list is fetched once and cached in the store).
  useEffect(() => {
    if (!inspOpen) return;
    for (const f of activeFolders) loadSessions(f.id);
  }, [inspOpen, activeFolders, loadSessions]);

  const items: Item[] = activeFolders.flatMap((f) =>
    (sessionsFor(f.id) ?? []).map((s) => ({
      path: s.path,
      title: s.title,
      folder: f.path,
      dests: s.dests,
      sizeBytes: s.sizeBytes,
      atMs: s.lastUploadAtMs,
    })),
  ).sort((a, b) => b.atMs - a.atMs);

  useEffect(() => {
    if (!inspOpen) return;
    if (inspInitialPath) setSelPath(inspInitialPath);
    else if (!selPath && items.length > 0) setSelPath(items[0].path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspOpen, inspInitialPath, items.length]);

  useEffect(() => {
    if (inspOpen && selPath) loadPreview(selPath);
  }, [inspOpen, selPath, loadPreview]);

  const qq = inspQuery.trim();
  const q = qq.toLowerCase();
  const filtered = items.filter((x) => !q || (x.title + " " + x.folder).toLowerCase().includes(q));

  // Case-insensitive match highlighting in the list.
  const hl = (s: string): ReactNode => {
    if (!q) return s;
    const rx = new RegExp(`(${qq.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
    const parts = s.split(rx);
    return parts.map((p, i) => (i % 2 === 1 ? <mark key={i} className="hl">{p}</mark> : p));
  };

  const x = filtered.find((i) => i.path === selPath) ?? filtered[0] ?? null;
  const lines = x ? previewFor(x.path) : undefined;
  const destLabel = (key: string) => destinations.find((d) => d.key === key)?.label ?? key;
  const destText = x ? (x.dests.length > 0 ? x.dests.map(destLabel).join(" · ") : "not uploaded yet") : "";

  return (
    <div className={`overlayw${inspOpen ? " open" : ""}`} id="inspOverlay" onClick={(e) => { if (e.target === e.currentTarget) setInspOpen(false); }}>
      <div className="modal" style={{ width: "min(900px,100%)" }}>
        <div className="mhead">
          <div className="row1"><h3>What Leaves This Machine</h3><button className="x" onClick={() => setInspOpen(false)}>✕</button></div>
          <p className="msub">A preview of the transcript text <code className="hx">hx</code> uploads — read straight from the session file on disk.</p>
        </div>
        <div className="mbody scrolly">
          <div className="insp">
            <div className="listcol">
              <div className="search compact" style={{ flex: "none", width: "100%" }}>
                <SearchIc />
                <input id="inspFilter" placeholder="Filter sessions…" value={inspQuery} onChange={(e) => setInspQuery(e.target.value)} />
              </div>
              <div className="ilist scrolly" id="inspList">
                {filtered.length ? filtered.map((it) => (
                  <div key={it.path} className={`item${x && it.path === x.path ? " sel" : ""}`} onClick={() => setSelPath(it.path)}>
                    <b>{hl(it.title)}</b><span className="s">{hl(`${it.atMs > 0 ? `sent ${fmtClock(it.atMs)}` : "waiting"} · ${fmtBytes(it.sizeBytes)}`)}</span>
                  </div>
                )) : (
                  <div className="item" style={{ color: "var(--text-subtle)" }}>{items.length === 0 ? (snap ? "No sessions found." : "Loading…") : "No matches."}</div>
                )}
              </div>
            </div>
            <div>
              <div className="headr" id="inspHead">
                {x && <><span className={`pill ${x.dests.some((d) => d !== "letai") ? "fortress" : "cloud"}`}>{destText}</span><span className="m">{fmtBytes(x.sizeBytes)}{x.atMs > 0 ? ` · sent ${fmtClock(x.atMs)}` : " · waiting to send"}</span></>}
              </div>
              <div className="transcript scrolly" id="inspBody">
                {!x && <div style={{ color: "var(--text-subtle)" }}>Select a session on the left.</div>}
                {x && lines === undefined && <div style={{ color: "var(--text-subtle)" }}>Loading preview…</div>}
                {x && lines && lines.length === 0 && <div style={{ color: "var(--text-subtle)" }}>No preview available for this file format.</div>}
                {x && lines && lines.map((l, i) => (
                  <div key={i}><span className={l.role === "Tool" ? "toolr" : "role"}>{l.role}:</span> {l.text}</div>
                ))}
                {x && lines && lines.length > 0 && (
                  <div style={{ color: "var(--text-subtle)", marginTop: 8 }}>… preview ends here — the full transcript is {fmtBytes(x.sizeBytes)}</div>
                )}
              </div>
              {x && <div className="honesty" id="inspFoot">The full {fmtBytes(x.sizeBytes)} transcript is exactly what uploads to {destText} — nothing else is read or sent.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

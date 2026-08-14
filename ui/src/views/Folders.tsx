import { useState } from "react";
import { useApp, type GroupBy } from "../store";
import { plural, TOOL_NOTE, TOOL_ORDER, toolNotesFor } from "../data";
import { fmtBytes, fmtClock, fmtRelative, type FolderInfo, type SessionInfo } from "../api";
import { GPill } from "../components/GPill";
import { CellA, CellB, CellC } from "../components/FolderCells";
import { BranchIc, CloudIc, FortressIc, SearchIc } from "../icons";

const GLBL: Record<GroupBy, string> = { tool: "Tool", dir: "Directory", dest: "Destination" };

function SessionRow({ s }: { s: SessionInfo }) {
  const { openInspector } = useApp();
  const status = s.deleted
    ? "Deleted from HX — local file kept; no longer uploads"
    : s.pendingBytes > 0
      ? `${fmtBytes(s.pendingBytes)} waiting to send`
      : s.lastUploadAtMs > 0
        ? `sent ${fmtClock(s.lastUploadAtMs)}`
        : "not uploaded yet";
  return (
    <div className="poprow" style={{ alignItems: "center", gap: 12 }}>
      <span className="grow" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</span>
      <span className={`st ${s.deleted ? "off" : s.pendingBytes > 0 ? "warny" : "on"}`} style={{ flexShrink: 0 }}>{status}</span>
      <button className="btn ghost sm" style={{ flexShrink: 0 }} onClick={(e) => { e.stopPropagation(); openInspector(s.path); }}>Inspect</button>
    </div>
  );
}

function FolderWhy({ f }: { f: FolderInfo }) {
  const { destinations, sessionsFor, destLabels, isExcluded, isPersonalGated, excludeFolder, includeFolder, setPersonal, goto } = useApp();
  const sessions = sessionsFor(f.id);
  const labels = destLabels(f);
  const orgDest = f.dests.some((d) => d !== "letai");
  const personalOnly = f.dests.length > 0 && f.dests.every((d) => d === "letai");

  if (isExcluded(f)) {
    return (
      <>
        <div className="why-note"><b>Excluded.</b> Nothing new from this folder leaves this machine — it isn’t uploaded to any destination while excluded. Anything uploaded before stays where it is.</div>
        <div className="why-act"><button className="btn ghost sm" onClick={() => { includeFolder(f); goto("activity"); }}>Include again</button></div>
      </>
    );
  }
  if (isPersonalGated(f)) {
    return (
      <>
        <div className="why-note"><b>Personal sync is off</b>, so this repo-less folder stays on this machine. Turn personal sync back on to resume uploading it to your private space.</div>
        <div className="why-act"><button className="btn ghost sm" onClick={() => setPersonal(true)}>Turn personal sync on</button></div>
      </>
    );
  }

  const chain = f.repo ? (
    <>
      <span className="step"><BranchIc /> {f.repo}</span><span className="arr">→</span>
      {f.unlinkedRepo && (
        <><span className="step dashed">no workspace claims this repo</span><span className="arr">→</span></>
      )}
      <span className="step hl">{orgDest ? <FortressIc /> : <CloudIc />} {labels.join(" · ")}</span>
    </>
  ) : (
    <>
      <span className="step dashed">no git repo</span><span className="arr">→</span>
      <span className="step hl"><CloudIc /> {f.dests.length > 0 ? `${labels.join(" · ")} — personal` : "personal, once uploaded"}</span>
    </>
  );

  const note = f.repo ? (
    f.unlinkedRepo ? (
      <div className="why-note">This folder has a git repo, but no workspace in your organizations claims it — so its sessions upload as <b>personal</b>: your private space, visible only to you. <b>If this is company code</b>, an admin can attach <span className="mono">{f.repo}</span> to a project and future sessions route to that organization.</div>
    ) : orgDest ? (
      <div className="why-note">This folder’s git repo routes to {labels.filter((l) => l !== "let.ai").map((l, i) => <b key={l}>{i > 0 ? " and " : ""}{l}</b>)}. Where an organization runs its own Session Vault, session content rests on its servers.</div>
    ) : (
      <div className="why-note">{personalOnly
        ? <>Uploads from this folder rest in let.ai-hosted storage. Which workspace each session attaches to — and who can see it — is decided by your workbench and shown with each session in My Sessions.</>
        : <>Uploads from this folder haven’t started yet. Routing is decided by your workbench at upload time.</>}</div>
    )
  ) : (
    <div className="why-note">No git repository — sessions from this folder upload as personal and attach to no workspace. Only you can see them.</div>
  );

  return (
    <>
      <div className="chain">{chain}</div>
      {note}
      <div className="why-note" style={{ marginTop: 10 }}>
        <b>Sessions in this folder</b> <span className="psub">· {f.sessions} on this machine · last activity {fmtRelative(f.lastUploadAtMs)}</span>
      </div>
      {sessions === undefined ? (
        <div className="why-note">Loading sessions…</div>
      ) : sessions.length === 0 ? (
        <div className="why-note">No session files in the recent scan window.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {sessions.slice(0, 8).map((s) => <SessionRow key={s.path} s={s} />)}
          {sessions.length > 8 && <div className="psub" style={{ marginTop: 4 }}>+ {sessions.length - 8} more</div>}
        </div>
      )}
      {destinations.length === 0 && null}
      <div className="why-act"><button className="btn ghost sm" onClick={() => excludeFolder(f)}>Exclude this folder</button></div>
    </>
  );
}

export function FolderRow({ f }: { f: FolderInfo }) {
  const { openRows, toggleRow, openDest, loadSessions, isExcluded, isPersonalGated } = useApp();
  const open = openRows.has(f.id);
  const excluded = isExcluded(f);
  const dim = excluded || isPersonalGated(f);
  return (
    <div className={`frow${dim ? " dim" : ""}${open ? " open" : ""}`} data-id={f.id}>
      <div className="line" onClick={() => { if (!open) loadSessions(f.id); toggleRow(f.id); }}>
        <CellA f={f} />
        <CellB f={f} isExcluded={excluded} destAction={openDest} />
        <CellC f={f} />
        <div className="chev"></div>
      </div>
      <div className="fwhy">{open && <FolderWhy f={f} />}</div>
    </div>
  );
}

interface Group { title: string; note: string; destKey?: string; items: FolderInfo[]; }

export function groupsFor(
  list: FolderInfo[],
  groupBy: GroupBy,
  destLabel: (key: string) => string,
  toolNotes: Record<string, string> = TOOL_NOTE,
): Group[] {
  if (groupBy === "tool") {
    return TOOL_ORDER.map((t) => ({
      title: t,
      note: list.some((f) => f.tool === t) ? (toolNotes[t] ? `· ${toolNotes[t]}` : "") : "· nothing found on this device",
      items: list.filter((f) => f.tool === t),
    })).filter((g) => g.items.length > 0 || toolNotes[g.title] !== undefined);
  }
  if (groupBy === "dir") {
    const m = new Map<string, FolderInfo[]>();
    for (const f of list) {
      const parts = f.path.split("/");
      const k = parts.length > 1 ? parts.slice(0, 2).join("/") || "/" : f.path;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(f);
    }
    return [...m.entries()].map(([title, items]) => ({ title, note: "", items }));
  }
  // dest: a folder fanning out to several stores appears under each.
  const m = new Map<string, FolderInfo[]>();
  for (const f of list) {
    const keys = f.dests.length > 0 ? f.dests : ["(not uploaded yet)"];
    for (const k of keys) {
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(f);
    }
  }
  return [...m.entries()].map(([key, items]) => ({
    title: key === "(not uploaded yet)" ? key : destLabel(key),
    destKey: key === "(not uploaded yet)" ? undefined : key,
    note: "",
    items,
  }));
}

export function Folders() {
  const { view, groupBy, setGroupBy, query, setQuery, allFolders, destinations, openDest, settings, setPersonal, dataRoots } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);

  const destLabel = (key: string) => destinations.find((d) => d.key === key)?.label ?? key;
  const q = query.trim().toLowerCase();
  const list = allFolders.filter((f) => !q ||
    [f.path, f.repo, f.tool, ...f.dests.map(destLabel)]
      .filter(Boolean).join(" ").toLowerCase().includes(q));
  const groups = groupsFor(list, groupBy, destLabel, toolNotesFor(dataRoots));
  const personalOff = settings?.personalSync === false;

  return (
    <section className={`view${view === "folders" ? " active" : ""}`} id="view-folders">
      <div className="kicker">This device</div>
      <h1>Folders &amp; Destinations</h1>
      <p className="lede">Every folder where an agentic tool keeps sessions, and the exact place each one is stored. Open a row to see <i>why</i> it goes where it goes.</p>

      {personalOff && (
        <div className="banner info" id="personalOffBanner" style={{ display: "flex" }}>
          <span className="badge">i</span>
          <span><b>Personal session sync is off.</b> Dimmed repo-less folders stay on this machine only. Work folders continue to sync.</span>
          <button className="btn" id="reenableBtn" onClick={() => setPersonal(true)}>Turn back on</button>
        </div>
      )}

      <div className="toolbar">
        <GPill id="groupPill" label="Group by" value={GLBL[groupBy]} valueId="groupVal" menuId="groupMenu" open={menuOpen} setOpen={setMenuOpen}>
          {(Object.keys(GLBL) as GroupBy[]).map((g) => (
            <button key={g} className={groupBy === g ? "sel" : undefined} onClick={() => { setGroupBy(g); setMenuOpen(false); }}>{GLBL[g]}</button>
          ))}
        </GPill>
        <div className="search">
          <SearchIc />
          <input id="folderSearch" placeholder="Search folders, repos, destinations…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      <div id="folderList">
        {!list.length ? (
          <div className="ftable"><div className="empty">{q ? `Nothing matches “${query}”.` : "No session folders found on this device yet."}</div></div>
        ) : groups.map((g) => (
          <div className="toolgrp" key={g.title}>
            <div className="toolhdr">
              {g.destKey
                ? <b className="grplink" onClick={() => openDest(g.destKey as string)}>{g.title}</b>
                : <b>{g.title}</b>}
              <span className="cnt">{g.items.length ? "· " + plural(g.items.reduce((n, f) => n + f.sessions, 0), "session") + " " : ""}{g.note}</span>
            </div>
            {g.items.length > 0 && <div className="ftable">{g.items.map((f) => <FolderRow key={`${g.title}:${f.id}`} f={f} />)}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

import { useApp } from "../store";
import { plural } from "../data";
import { fmtBytes, fmtRelative } from "../api";
import { CellA, CellB, CellC } from "../components/FolderCells";
import { CliToolIc, DesktopToolIc, FortressIc } from "../icons";

const TOOL_ROWS: { family: string; label: string; cli: boolean }[] = [
  { family: "claude-cli", label: "Claude Code CLI", cli: true },
  { family: "claude-desktop", label: "Claude Code Desktop", cli: false },
  { family: "codex-cli", label: "Codex CLI", cli: true },
  { family: "codex-desktop", label: "Codex Desktop", cli: false },
];

export function Overview() {
  const {
    view, goto, openDest, snap, email,
    activeFolders, destinations, unlinkedFolders,
    reviewUnlinked, jumpFortressList, jumpDoctor, setInspOpen,
  } = useApp();

  const act = activeFolders;
  const top = [...act].sort((a, b) => b.sessions - a.sessions).slice(0, 4);
  const toolsPresent = new Set(act.map((f) => f.family));
  const orgDests = destinations.filter((d) => !d.personal);
  const personalDests = destinations.filter((d) => d.personal);
  const doctor = snap?.doctor;
  const caughtUp = doctor ? doctor.ok && doctor.sync.done >= doctor.sync.total : null;
  // Sessions not yet fully mirrored = total − done. This is the honest
  // "in flight" number: it includes a session that's simply mid-upload (a
  // growing/active transcript), not only ones held on an offline store — so
  // "not caught up" and "nothing in flight" can never contradict each other.
  const inFlight = Math.max(0, (snap?.sync.total ?? 0) - (snap?.sync.done ?? 0));
  const held = snap?.sync.waiting ?? 0; // held on an unavailable store (subset)
  const onDisk = snap?.sync.total ?? 0;
  const firstUnlinked = unlinkedFolders[0];
  const daemon = snap?.device.daemon;

  return (
    <section className={`view${view === "overview" ? " active" : ""}`} id="view-overview">
      <div className="kicker">This device</div>
      <h1>My sessions, and where they go</h1>
      <p className="lede"><code className="hx">hx</code> mirrors the agentic coding sessions on this machine so they’re never lost. Here’s what’s picked up, where every session is stored, and who can see it.</p>

      <div className="stats">
        <div className="stat">
          <span className="lbl">Folders watched</span>
          <div className="big statlink" onClick={() => goto("folders")}><span id="ovFolders">{act.length}</span><div className="pop">See which folders →</div></div>
          <div className="sub">across <span className="dashy">{plural(toolsPresent.size, "tool")}<div className="pop">
            <b>Tools detected on this device</b>
            {TOOL_ROWS.map((t, i) => {
              const n = act.filter((f) => f.family === t.family).length;
              return (
                <div key={t.family} className="poprow" style={i === 0 ? { marginTop: 8 } : undefined}>
                  <span className="ico">{t.cli ? <CliToolIc /> : <DesktopToolIc />}</span>
                  <span className="grow">{t.label}</span>
                  <span className={`st ${n > 0 ? "on" : "offy"}`}>{n > 0 ? plural(n, "folder") : "none found"}</span>
                </div>
              );
            })}
          </div></span></div>
        </div>
        <div className="stat">
          <span className="lbl">Sessions</span>
          <div className="big statlink" id="ovSessionsLink" onClick={() => setInspOpen(true)}><span id="ovSessions">{snap ? onDisk : "…"}</span><div className="pop">Preview what leaves this machine →</div></div>
          <div className="sub">{fmtBytes(snap?.sync.totalBytes ?? 0)} · on this machine</div>
        </div>
        <div className="stat">
          <span className="lbl">Destinations</span>
          <div className="big statlink" id="ovDestsBig" onClick={jumpFortressList}>{destinations.length}<div className="pop">Jump to the destination list →</div></div>
          <div className="sub">
            {orgDests.length > 0 && <span className="dashy">{orgDests.length} company<div className="pop">
              <b>Organization vaults</b>
              {orgDests.map((d, i) => (
                <div key={d.key} className="poprow" style={i === 0 ? { marginTop: 8 } : undefined}>
                  <span className="ico"><FortressIc /></span><span className="grow">{d.label}</span>
                  <span className={`st ${d.blocked ? "warny" : "on"}`}>{d.blocked ? "Held" : "Connected"}</span>
                </div>
              ))}
            </div></span>}
            {orgDests.length > 0 && personalDests.length > 0 && " · "}
            {personalDests.length > 0 && <span className="dashy">{personalDests.length} let.ai-hosted<div className="pop">
              <b>let.ai-hosted storage</b>
              <div style={{ marginTop: 6 }}>Holds your personal sessions (visible only to you) and sessions of organizations that use let.ai-managed storage. Who can see each session follows its workspace, not where it rests.</div>
            </div></span>}
          </div>
        </div>
        <div className="stat">
          <span className="lbl">Caught up</span>
          <div className="big"><span className="hovinfo" id="yesLink" onClick={jumpDoctor}>{caughtUp === null ? "…" : caughtUp ? "Yes" : "No"}<div className="pop">
            {caughtUp === false && doctor ? (
              <>
                <b>{doctor.sync.done} of {doctor.sync.total} sessions mirrored ({doctor.sync.percent}%).</b>
                <div style={{ marginTop: 6 }}>{doctor.blockedSessions > 0 ? `${plural(doctor.blockedSessions, "session")} held at a destination — ` : "The rest is still uploading — an active session is normally a little behind. "}Device Detail → Sync Doctor explains exactly what’s pending and why.</div>
              </>
            ) : (
              <>
                <b>Everything on this machine is mirrored.</b>
                <div style={{ marginTop: 6 }}>All {snap?.sync.total ?? 0} sessions are safely stored at their destinations. If this ever says <b>No</b>, this card explains what’s pending, and Device Detail → Sync Doctor walks through the fix.</div>
              </>
            )}
          </div></span></div>
          <div className="sub">{inFlight > 0 ? (held > 0 ? `${plural(held, "session")} held` : `${plural(inFlight, "session")} still syncing`) : "nothing in flight"}</div>
        </div>
      </div>

      {firstUnlinked && (
        <div className="banner warn" id="unlinkedBanner">
          <span className="badge">!</span>
          <span className="btxt"><b>{plural(unlinkedFolders.length, "folder looks", "folders look")} like company code but {unlinkedFolders.length === 1 ? "isn’t" : "aren’t"} linked to a workspace.</b> <span className="mono">{firstUnlinked.path}</span> has a git repo no project claims, so its sessions upload as personal. If that’s wrong, an admin can attach the repo to a project.</span>
          <button className="btn" id="reviewBtn" onClick={() => reviewUnlinked(firstUnlinked.id)}>Review</button>
        </div>
      )}

      <div className="sechead" id="fortressHead">Where Sessions Are Stored</div>
      <div className="panel" id="fortressPanel" style={{ paddingTop: 8, paddingBottom: 8 }}>
        <div className="rowlist" id="fortressList">
          {destinations.length === 0 && (
            <div className="empty">
              <span className="ico"><FortressIc /></span>
              <b>Nothing uploaded yet</b>
              <p>Once the first sync pass runs, every place this device’s sessions rest shows up here.</p>
            </div>
          )}
          {destinations.map((d) => (
            <div key={d.key} className="row fortrow" data-fortress={d.key} onClick={() => openDest(d.key)}>
              <span className={`dot${d.blocked ? " warn" : ""}`}></span>
              <div className="who"><b>{d.label}</b><div className="sub">{d.personal ? "let.ai-hosted storage" : "organization vault"}</div></div>
              <div><span className={`pill ${d.blocked ? "warn" : "ok"}`}>{d.blocked ? "Held — retrying" : "Connected"}</span></div>
              <div className="fortmeta"><div>{plural(d.sessions, "session")} · {fmtBytes(d.bytes)}</div><div>last sent {fmtRelative(d.lastUploadAtMs)}</div></div>
              <div className="chev"></div>
            </div>
          ))}
        </div>
      </div>

      <div className="sechead">Most Active Folders <a href="#" id="allFoldersLink" onClick={(e) => { e.preventDefault(); goto("folders"); }}>All {act.length} folders →</a></div>
      <div className="ftable" id="ovPreview" style={{ marginBottom: 20 }}>
        {top.map((f) => (
          <div key={f.id} className="prevrow" onClick={() => goto("folders")}>
            <CellA f={f} />
            <CellB f={f} destAction={openDest} />
            <CellC f={f} />
          </div>
        ))}
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>This Device</h2>
          <div className="facts">
            <div className="frw"><span className="k">Device</span><span><span className="v devname">{snap?.device.name ?? "…"}</span><div className="vs">{snap ? `${snap.device.platform} ${snap.device.arch}` : ""}</div></span></div>
            <div className="frw"><span className="k"><code className="hx">hx</code> version</span><span><span className="v mono">{snap?.device.hxVersion ?? "…"}</span><div className="vs">{daemon ? `service: ${daemon.managerName}` : ""}</div></span></div>
            <div className="frw"><span className="k">Signed in as</span><span><span className="v">{email ?? "…"}</span></span></div>
            <div className="frw"><span className="k">Gateway</span><span><span className="v mono">{snap?.device.gatewayHost ?? "not configured"}</span></span></div>
          </div>
        </div>
        <div className="panel">
          <h2>Right Now</h2>
          <div className="facts">
            <div className="frw"><span className="k">Mirror</span><span><span className="v">{daemon ? (daemon.loaded && daemon.pid ? "Running" : "Stopped") : "…"}</span><div className="vs">{daemon?.pid ? `${daemon.managerName} · pid ${daemon.pid}` : daemon?.managerName ?? ""}</div></span></div>
            <div className="frw"><span className="k">Still syncing</span><span><span className="v">{inFlight > 0 ? plural(inFlight, "session") : "nothing"}</span><div className="vs">{inFlight > 0 ? (held > 0 ? `${held} held on an offline store` : "finishing on the next pass") : "fully caught up"}</div></span></div>
            <div className="frw"><span className="k">Last upload</span><span><span className="v">{fmtRelative(snap?.sync.lastUploadAtMs ?? 0)}</span></span></div>
            <div className="frw"><span className="k">What’s uploaded</span><span><span className="v"><a href="#" onClick={(e) => { e.preventDefault(); goto("privacy"); }}>See what leaves this machine</a></span></span></div>
          </div>
        </div>
      </div>
    </section>
  );
}

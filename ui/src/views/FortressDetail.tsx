import { useApp } from "../store";
import { plural } from "../data";
import { fmtBytes, fmtRelative } from "../api";
import { CellA, CellB, CellC } from "../components/FolderCells";

export function FortressDetail() {
  const { view, goto, currentDest, destinations, foldersOfDest } = useApp();

  const dest = destinations.find((d) => d.key === currentDest) ?? null;
  const mine = dest ? foldersOfDest(dest.key) : [];

  return (
    <section className={`view${view === "fortress" ? " active" : ""}`} id="view-fortress">
      <div className="kicker"><a href="#" onClick={(e) => { e.preventDefault(); goto("overview"); }}>← Overview</a></div>
      <h1 id="ftTitle">{dest ? dest.label : "Destination"}</h1>
      <p className="lede" id="ftLede">{dest
        ? (dest.personal
          ? "let.ai-hosted storage. Your personal sessions rest here (visible only to you), alongside sessions of organizations that use let.ai-managed storage — visibility always follows each session’s workspace."
          : "An organization vault. Sessions in this organization’s repositories rest under its own storage configuration.")
        : ""}</p>
      <div className="panel">
        <h2>Folders Stored Here</h2>
        <div id="ftFolders">
          {mine.length ? (
            <div className="ftable">
              {mine.map((f) => (
                <div key={f.id} className="prevrow" onClick={() => goto("folders")}>
                  <CellA f={f} />
                  <CellB f={f} />
                  <CellC f={f} />
                </div>
              ))}
            </div>
          ) : (
            <div className="ftable"><div className="empty">No folders route here right now.</div></div>
          )}
        </div>
      </div>
      <div className="grid2">
        <div className="panel">
          <h2>Connection</h2>
          <div className="facts" id="ftConn">
            {dest && (
              <>
                <div className="frw"><span className="k">Status</span><span><span className="v">{dest.blocked ? "Held — retrying" : "Connected"}</span><div className="vs">last upload {fmtRelative(dest.lastUploadAtMs)}</div></span></div>
                {dest.blocked && (
                  <div className="frw"><span className="k">Held</span><span><span className="v">{plural(dest.blocked.sessions, "session")}</span><div className="vs">{dest.blocked.reason === "vault_offline" ? "Session Vault offline — held safely until it reconnects; nothing is lost" : dest.blocked.reason === "vault_home_unreachable" ? "Home Fortress not connected — held safely until it comes online; nothing is lost" : "store unreachable — retrying with backoff"}</div></span></div>
                )}
              </>
            )}
          </div>
        </div>
        <div className="panel">
          <h2>Storage</h2>
          <div className="facts" id="ftStore">
            {dest && (
              <>
                <div className="frw"><span className="k">Sessions</span><span><span className="v">{plural(dest.sessions, "session")}</span><div className="vs">{fmtBytes(dest.bytes)} uploaded, across {plural(dest.folders, "folder")}</div></span></div>
                <div className="frw"><span className="k">Uploaded bytes</span><span><span className="v">{fmtBytes(dest.bytes)}</span><div className="vs">confirmed committed to this destination</div></span></div>
                <div className="frw"><span className="k">Last sent</span><span><span className="v">{fmtRelative(dest.lastUploadAtMs)}</span></span></div>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

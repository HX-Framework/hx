import { useRef, useState } from "react";
import { copyText, useApp } from "../store";
import { plural } from "../data";
import { fmtBytes, fmtClock } from "../api";
import { GPill } from "../components/GPill";
import { CloudIc, FolderIc, FortressIc } from "../icons";

const PAUSE_OPTIONS: [string, string][] = [
  ["15", "Pause for 15 minutes"],
  ["60", "Pause for 1 hour"],
  ["240", "Pause for 4 hours"],
  ["tomorrow", "Pause until tomorrow morning"],
  ["forever", "Pause until I resume it"],
];

function pauseLabel(untilMs: number | null): string {
  if (untilMs === null) return "Paused until I resume it";
  return `Paused — resumes at ${fmtClock(untilMs)}`;
}

const ROOT_FAMILIES: { key: "claude" | "codex"; label: string }[] = [
  { key: "claude", label: "Claude Code" },
  { key: "codex", label: "Codex" },
];

export function Privacy() {
  const {
    view, goto, openInspector, destinations, allFolders, isExcluded,
    settings, setPersonal, pickPause, resumeAll,
    addRule, removeRule, askConfirm, disconnectAct,
    dataRoots, dataRootsFrom, shellDetected, addDataDir, removeDataDir, snap,
  } = useApp();
  const [pauseMenuOpen, setPauseMenuOpen] = useState(false);
  const [ruleVal, setRuleVal] = useState("");
  const [cmdCopied, setCmdCopied] = useState(false);
  const ruleRef = useRef<HTMLInputElement>(null);
  const [dirVals, setDirVals] = useState<{ claude: string; codex: string }>({ claude: "", codex: "" });
  const [dirErrs, setDirErrs] = useState<{ claude: string; codex: string }>({ claude: "", codex: "" });

  const paused = settings?.pause != null;
  const personalOn = settings?.personalSync !== false;
  const rules = settings?.excludeRules ?? [];
  const excludedCount = allFolders.filter(isExcluded).length;

  const doAddRule = () => {
    const v = ruleVal.trim();
    if (v && !rules.includes(v)) {
      addRule(v);
      setRuleVal("");
      ruleRef.current?.focus();
    }
  };

  const setDirErr = (family: "claude" | "codex", msg: string) =>
    setDirErrs((prev) => ({ ...prev, [family]: msg }));

  const doAddDir = async (family: "claude" | "codex", raw?: string) => {
    const v = (raw ?? dirVals[family]).trim();
    if (!v) return;
    // Pre-check the two knowable rejections so the input never appears to
    // accept-and-drop; anything else surfaces the server's own 400 text.
    if (!(v.startsWith("/") || v === "~" || v.startsWith("~/"))) {
      setDirErr(family, "Enter an absolute path, or one starting with ~/.");
      return;
    }
    if ((settings?.dataDirs?.[family] ?? []).length >= 8) {
      setDirErr(family, "At most 8 locations per tool — remove one first.");
      return;
    }
    const err = await addDataDir(family, v);
    if (err) {
      setDirErr(family, err);
      return;
    }
    setDirErr(family, "");
    if (raw === undefined) setDirVals((prev) => ({ ...prev, [family]: "" }));
  };

  return (
    <section className={`view${view === "privacy" ? " active" : ""}`} id="view-privacy">
      <div className="kicker">Settings</div>
      <h1>Privacy Controls</h1>
      <p className="lede">Everything <code className="hx">hx</code> does is visible and reversible from here. Settings apply to this device and take effect within seconds.</p>

      <div className="panel">
        <h2>Uploads</h2>
        <div className="setrow">
          <label className="switch"><input type="checkbox" className="personal-master" checked={personalOn} disabled={!settings} onChange={(e) => setPersonal(e.target.checked)} /><span className="track"></span></label>
          <div className="txt"><b>Sync personal sessions to my private space</b><p>Sessions in folders without a git repository attach to no workspace — only you can ever see them. Off = they never leave this machine.</p></div>
        </div>
        <div className="setrow">
          <div className="txt">
            <b>Pause all syncing</b>
            <p>Temporarily stop every upload — work and personal. Sessions queue safely on this machine and catch up on resume.</p>
            <div className={`pausestate${paused ? " on" : ""}`} id="pauseState">{paused && settings?.pause ? pauseLabel(settings.pause.untilMs) : ""}</div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className="btn ghost" id="resumeBtn" style={{ display: paused ? "" : "none" }} onClick={resumeAll}>Resume now</button>
            <GPill id="pausePill" value={paused ? "Paused" : "Not paused"} valueId="pauseVal" menuId="pauseMenu" open={pauseMenuOpen} setOpen={setPauseMenuOpen}>
              {PAUSE_OPTIONS.map(([p, label]) => (
                <button key={p} onClick={() => { pickPause(p); setPauseMenuOpen(false); }}>{label}</button>
              ))}
            </GPill>
          </div>
        </div>
        <div className="setrow">
          <div className="txt">
            <b>Excluded folders</b>
            <p>Never uploaded, regardless of any other setting. {excludedCount > 0 ? `${plural(excludedCount, "folder is", "folders are")} excluded right now.` : "Each folder is excluded or included on its own row in Folders & Destinations."}</p>
          </div>
          <button className="btn ghost" id="reviewExclBtn" onClick={() => goto("folders")}>→ Folders &amp; Destinations</button>
        </div>
        <div className="setrow">
          <div className="txt">
            <b>Future Folders</b>
            <p>Paths <code className="hx">hx</code> hasn’t detected sessions in yet — the moment one appears there, it stays on this machine. Anything already uploaded stays where it is.</p>
            <div className="rulebox" id="pathRules">
              {rules.length ? rules.map((p) => (
                <div className="rulerow" key={p}><span className="ico"><FolderIc /></span><span className="p">{p}</span><button className="btn ghost sm" onClick={() => removeRule(p)}>Remove</button></div>
              )) : (
                <div className="empty">
                  <span className="ico"><FolderIc /></span>
                  <b>No future folders yet</b>
                  <p>Add a path below — the moment sessions appear there, they stay on this machine.</p>
                </div>
              )}
              <div className="ruleadd">
                <span className="ico"><FolderIc /></span>
                <input id="ruleInput" ref={ruleRef} placeholder="~/folder-that-does-not-exist-yet" value={ruleVal} onChange={(e) => setRuleVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doAddRule(); }} />
                <button className="btn sm" id="ruleAddBtn" disabled={!settings} onClick={doAddRule}>Add</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Watched Locations</h2>
        <div className="setrow">
          <div className="txt">
            <b>Where session logs are read from</b>
            <p>
              <code className="hx">hx</code> mirrors sessions from these data folders. The defaults are always watched.
              If a tool writes somewhere else (a relocated <span className="mono">CLAUDE_CONFIG_DIR</span> or <span className="mono">CODEX_HOME</span>), add that folder here — new sessions in it start syncing within seconds{dataRootsFrom === "local" ? ". Shown from this app’s own view — the background service hasn’t reported its watch list yet" : snap?.device.daemon.pid == null ? ". The background service is stopped — this is its last-known list" : ""}.
            </p>
            {ROOT_FAMILIES.map(({ key, label }) => {
              const roots = dataRoots.filter((r) => r.family === key);
              const suggestion = shellDetected[key];
              return (
                <div key={key}>
                  <div className="rowdiv">{label}</div>
                  <div className="rulebox" style={{ marginTop: 6 }}>
                    {roots.map((r) => (
                      <div className="rulerow" key={r.configDir}>
                        <span className="ico"><FolderIc /></span>
                        <span className="p" title={r.configDir}>{r.display}</span>
                        <span className="meta">
                          {r.origin === "default" ? "default" : r.origin === "env" ? "from environment" : plural(r.files, "file")}
                          {r.exists ? "" : " · not created yet"}
                        </span>
                        {r.origin === "settings" && (
                          <button
                            className="btn ghost sm"
                            onClick={() => void (async () => setDirErr(key, (await removeDataDir(key, r.configDir)) ?? ""))()}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))}
                    {suggestion && (
                      <div className="rulerow">
                        <span className="ico"><FolderIc /></span>
                        <span className="p" title={suggestion}>{suggestion}</span>
                        <span className="meta trunc" title="This folder is set via an environment variable your shell exports, but the background service doesn't read shell profiles — add it so it's always watched.">
                          set in your shell — not watched yet
                        </span>
                        <button className="btn sm" onClick={() => void doAddDir(key, suggestion)}>Add</button>
                      </div>
                    )}
                    <div className="ruleadd">
                      <span className="ico"><FolderIc /></span>
                      <input
                        placeholder={key === "claude" ? "/path/to/claude-data-dir" : "/path/to/codex-home"}
                        value={dirVals[key]}
                        onChange={(e) => setDirVals((prev) => ({ ...prev, [key]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === "Enter") void doAddDir(key); }}
                      />
                      <button className="btn sm" disabled={!settings} onClick={() => void doAddDir(key)}>Add</button>
                    </div>
                    {dirErrs[key] && (
                      <div className="rulerow"><span className="err">{dirErrs[key]}</span></div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>What Leaves This Machine</h2>
        <div className="setrow">
          <div className="txt"><b>Preview outgoing data</b><p>Open a preview of the transcript text this device uploads — the exact same bytes, nothing more.</p></div>
          <button className="btn ghost" id="inspectorBtn" onClick={() => openInspector()}>Open inspector</button>
        </div>
        <div className="setrow">
          <div className="txt"><b>Where sessions rest</b>
            <div className="rulebox" style={{ marginTop: 10 }}>
              {destinations.length === 0 ? (
                <div className="empty">
                  <span className="ico"><CloudIc /></span>
                  <b>Nothing uploaded yet</b>
                  <p>Once the first sync pass runs, every place this device’s sessions rest shows up here.</p>
                </div>
              ) : destinations.map((d) => (
                <div className="rulerow" key={d.key}>
                  <span className="ico">{d.personal ? <CloudIc /> : <FortressIc />}</span>
                  <span className="p">{d.label}</span>
                  <span style={{ color: "var(--text-subtle)", fontSize: 13 }}>{plural(d.sessions, "session")} · {fmtBytes(d.bytes)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="setrow">
          <div className="txt"><b>Logs stay local</b><p>The daemon’s own logs never upload anywhere — read them any time in Client Logs, or on disk under <span className="mono">~/.let/hx/</span>.</p></div>
          <button className="btn ghost" onClick={() => goto("logs")}>→ Client Logs</button>
        </div>
      </div>

      <div className="panel danger">
        <h2>Danger Zone</h2>
        <div className="setrow">
          <div className="txt"><b>Disconnect this device</b><p>Revokes this device’s access token immediately — the mirror fails its next upload until you run <span className="mono">hx connect</span> again. Previously-mirrored sessions are hidden from your workbench, not deleted; they return when this device reconnects.</p></div>
          <button className="btn danger" onClick={() => askConfirm(
            "Disconnect this device?",
            "The access token is revoked immediately and syncing stops. Nothing already uploaded is deleted — sessions are hidden and return when you reconnect.",
            "Disconnect",
            () => void disconnectAct(),
          )}>Disconnect</button>
        </div>
        <div className="setrow">
          <div className="txt"><b>Uninstall <code className="hx">hx</code> from this device</b><p>Stops the daemon and removes the <code className="hx">hx</code> program. Run it from a terminal so you can choose whether local state goes too:</p>
            <div className="rulebox" style={{ marginTop: 8 }}>
              <div className="rulerow"><span className="p mono">hx uninstall</span><button className="btn ghost sm" onClick={() => { if (copyText("hx uninstall")) { setCmdCopied(true); setTimeout(() => setCmdCopied(false), 1200); } }}>{cmdCopied ? "Copied" : "Copy"}</button></div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

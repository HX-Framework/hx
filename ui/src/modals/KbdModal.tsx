import { useApp } from "../store";

export function KbdModal() {
  const { kbdOpen, setKbdOpen } = useApp();
  return (
    <div className={`overlayw${kbdOpen ? " open" : ""}`} id="kbdOverlay" onClick={(e) => { if (e.target === e.currentTarget) setKbdOpen(false); }}>
      <div className="modal" style={{ width: "min(540px,100%)" }}>
        <div className="mhead">
          <div className="row1"><h3>Keyboard Shortcuts</h3><button className="x" onClick={() => setKbdOpen(false)}>✕</button></div>
          <p className="msub">Available anywhere, except while typing in a field.</p>
        </div>
        <div className="mbody scrolly" style={{ paddingBottom: 26 }}>
          <div className="clirow"><span className="c"><span className="kbd">1</span> – <span className="kbd">6</span></span><span className="d">Go to a section: Overview, Folders &amp; Destinations, Sync Status, Privacy Controls, Device Detail, Client Logs.</span></div>
          <div className="clirow"><span className="c"><span className="kbd">?</span></span><span className="d">Show or hide this menu.</span></div>
          <div className="clirow"><span className="c"><span className="kbd">Esc</span></span><span className="d">Close dialogs and menus, or leave the full-page log view.</span></div>
        </div>
      </div>
    </div>
  );
}

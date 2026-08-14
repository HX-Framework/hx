import { useEffect } from "react";
import { AppProvider, useApp } from "./store";
import { Topbar } from "./components/Topbar";
import { SideNav } from "./components/SideNav";
import { FooterBand } from "./components/FooterBand";
import { Overview } from "./views/Overview";
import { Folders } from "./views/Folders";
import { SyncStatus } from "./views/SyncStatus";
import { Privacy } from "./views/Privacy";
import { DeviceDetail } from "./views/DeviceDetail";
import { FortressDetail } from "./views/FortressDetail";
import { Logs } from "./views/Logs";
import { KbdModal } from "./modals/KbdModal";
import { InspectorModal } from "./modals/InspectorModal";
import { ConfirmModal } from "./modals/ConfirmModal";

function Chrome() {
  const { snap, error, authError, loading } = useApp();
  const deviceName = snap?.device.name;
  useEffect(() => {
    document.title = deviceName ? `HX Client — ${deviceName}` : "HX Client";
  }, [deviceName]);
  if (loading && !snap) {
    return <div className="bootstate">Loading…</div>;
  }
  if (error && !snap) {
    // Distinguish a stale/missing one-time key (the server is fine — the LINK
    // isn't) from the server actually being unreachable.
    if (authError === "link-expired") {
      return (
        <div className="bootstate">
          <b>This sign-in link has expired.</b>
          <p>Run <code className="hx">hx ui</code> again in your terminal and open the fresh link it prints (each link is valid for an hour).</p>
        </div>
      );
    }
    if (authError === "no-key") {
      return (
        <div className="bootstate">
          <b>Open the link <code className="hx">hx ui</code> printed.</b>
          <p>This page needs the one-time key in that link’s address — a bare <span className="mono">localhost</span> address or a new tab won’t have it.</p>
        </div>
      );
    }
    return (
      <div className="bootstate">
        <b>Can’t reach the hx ui server.</b>
        <p>Make sure <code className="hx">hx ui</code> is still running, then open the link it printed.</p>
      </div>
    );
  }
  return (
    <>
      <Topbar />
      <div className="shell">
        <SideNav />
        <main>
          <Overview />
          <Folders />
          <SyncStatus />
          <Privacy />
          <DeviceDetail />
          <FortressDetail />
          <Logs />
        </main>
      </div>
      <FooterBand />
      <KbdModal />
      <InspectorModal />
      <ConfirmModal />
    </>
  );
}

export function App() {
  return (
    <AppProvider>
      <Chrome />
    </AppProvider>
  );
}

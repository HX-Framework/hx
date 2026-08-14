import { Fragment } from "react";
import { useApp, type View } from "../store";

const ITEMS: { group: string | null; view: View; n: string; label: string }[] = [
  { group: "This device", view: "overview", n: "01", label: "Overview" },
  { group: null, view: "folders", n: "02", label: "Folders & Destinations" },
  { group: null, view: "activity", n: "03", label: "Sync Status" },
  { group: "Settings", view: "privacy", n: "04", label: "Privacy Controls" },
  { group: "System", view: "device", n: "05", label: "Device Detail" },
  { group: null, view: "logs", n: "06", label: "Client Logs" },
];

export function SideNav() {
  const { view, goto } = useApp();
  return (
    <nav className="side">
      {ITEMS.map((it) => (
        <Fragment key={it.view}>
          {it.group && <div className="navlbl">{it.group}</div>}
          <button className={view === it.view ? "active" : undefined} onClick={() => goto(it.view)}>
            <span className="n">{it.n}</span> {it.label}
          </button>
        </Fragment>
      ))}
    </nav>
  );
}

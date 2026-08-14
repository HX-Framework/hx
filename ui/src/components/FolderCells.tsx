import { useApp } from "../store";
import type { FolderInfo } from "../api";
import { plural } from "../data";
import { BranchIc, CloudIc, FolderIc, FortressIc, PersonIc, SlashIc } from "../icons";

// Strict two-line cells — every cell shares the same line grid so icons,
// destinations, and counts all read as vertical columns.

export function CellA({ f }: { f: FolderInfo }) {
  const np = f.unlinkedRepo ? <> <span className="pill warn mini">no workspace</span></> : null;
  return (
    <div className="cell cellA">
      <div className="cl l1"><span className="ico"><FolderIc /></span><span className="tx path">{f.path}</span></div>
      <div className="cl l2">
        {f.repo
          ? <><span className="ico"><BranchIc /></span><span className="tx repo">{f.repo}</span>{np}<span className="tx">· {f.tool}</span></>
          : <><span className="ico" style={{ visibility: "hidden" }}><BranchIc /></span><span className="tx" style={{ fontStyle: "italic" }}>no git repo</span><span className="tx">· {f.tool}</span></>}
      </div>
    </div>
  );
}

export function CellB({ f, isExcluded = false, destAction }: { f: FolderInfo; isExcluded?: boolean; destAction?: (destKey: string) => void }) {
  const { destinations } = useApp();
  if (isExcluded) {
    return (
      <div className="cell cellB">
        <div className="cl l1 exc"><span className="ico"><SlashIc /></span><span className="tx">Excluded</span></div>
        <div className="cl l2"><span className="ico" style={{ visibility: "hidden" }}><PersonIc /></span><span className="tx">Not uploaded while excluded</span></div>
      </div>
    );
  }
  if (f.dests.length === 0) {
    return (
      <div className="cell cellB">
        <div className="cl l1"><span className="ico"><CloudIc /></span><span className="tx" style={{ fontStyle: "italic" }}>not uploaded yet</span></div>
        <div className="cl l2"><span className="ico" style={{ visibility: "hidden" }}><PersonIc /></span><span className="tx">appears after the first sync pass</span></div>
      </div>
    );
  }
  const rows = f.dests.map((key) => {
    const dest = destinations.find((d) => d.key === key);
    return { key, label: dest?.label ?? key, personal: dest?.personal ?? key === "letai", blocked: Boolean(dest?.blocked) };
  });
  const first = rows[0];
  const second = rows[1];
  return (
    <div className="cell cellB">
      <div className={`cl l1 ${first.personal ? "cloudy" : "fortress"}`}>
        <span className="ico">{first.personal ? <CloudIc /> : <FortressIc />}</span>
        <span className="tx destlink" onClick={destAction ? (e) => { e.stopPropagation(); destAction(first.key); } : undefined}>{first.label}</span>
        {first.blocked && <span className="pill warn mini">held</span>}
      </div>
      <div className="cl l2">
        {second ? (
          <>
            <span className="ico">{second.personal ? <CloudIc /> : <FortressIc />}</span>
            <span className="tx destlink" onClick={destAction ? (e) => { e.stopPropagation(); destAction(second.key); } : undefined}>{second.label}</span>
            {rows.length > 2 && <span className="tx">· +{rows.length - 2} more</span>}
          </>
        ) : (
          <><span className="ico" style={{ visibility: "hidden" }}><PersonIc /></span><span className="tx">{first.personal ? "let.ai-hosted storage" : "organization vault"}</span></>
        )}
      </div>
    </div>
  );
}

export function CellC({ f }: { f: FolderInfo }) {
  return (
    <div className="cell cellC">
      <div>{plural(f.sessions, "session")}</div>
    </div>
  );
}

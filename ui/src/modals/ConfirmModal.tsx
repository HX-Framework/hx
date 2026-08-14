import { useApp } from "../store";

/** App-styled confirm dialog for destructive actions (never window.confirm). */
export function ConfirmModal() {
  const { confirm, answerConfirm } = useApp();
  return (
    <div className={`overlayw${confirm?.open ? " open" : ""}`} onClick={(e) => { if (e.target === e.currentTarget) answerConfirm(false); }}>
      <div className="modal" style={{ width: "min(480px,100%)" }}>
        <div className="mhead">
          <div className="row1"><h3>{confirm?.title}</h3><button className="x" onClick={() => answerConfirm(false)}>✕</button></div>
          <p className="msub">{confirm?.message}</p>
        </div>
        <div className="mbody" style={{ display: "flex", gap: 10, justifyContent: "flex-end", padding: "14px 24px 20px" }}>
          <button className="btn ghost" onClick={() => answerConfirm(false)}>Cancel</button>
          <button className="btn danger" onClick={() => answerConfirm(true)}>{confirm?.action}</button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, type ReactNode } from "react";

// Custom dropdown pill — no native <select> anywhere. Closes on outside
// click, on Esc, and when an option is picked.
export function GPill({
  id, label, value, valueId, menuId, open, setOpen, children,
}: {
  id?: string;
  label?: string;
  value: string;
  valueId?: string;
  menuId?: string;
  open: boolean;
  setOpen: (b: boolean) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  return (
    <div className="gpill" id={id} ref={ref} onClick={(e) => { if (!(e.target as Element).closest(".menu")) setOpen(!open); }}>
      {label ? <span className="lbl">{label}</span> : null} <span id={valueId}>{value}</span> <span className="caret"></span>
      <div className={`menu${open ? " openm" : ""}`} id={menuId}>{children}</div>
    </div>
  );
}

// Every SVG from the prototype, 1:1. "s" variants are the 15px icons.

export const FolderIc = () => (
  <svg className="ic s" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
);
export const FortressIc = () => (
  <svg className="ic s" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3l7 3v5c0 4.8-3.2 7.7-7 9-3.8-1.3-7-4.2-7-9V6z"/></svg>
);
export const CloudIc = () => (
  <svg className="ic s" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M7 18h9a4 4 0 0 0 .8-7.9A5.5 5.5 0 0 0 6.2 9.7 3.5 3.5 0 0 0 7 18z"/></svg>
);
export const BranchIc = () => (
  <svg className="ic s" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="8" r="2.4"/><path d="M6 8.4v7.2M18 10.4c0 4-5 3.2-9 4.2"/></svg>
);
export const PersonIc = () => (
  <svg className="ic s" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="8" r="3.4"/><path d="M5.5 19.5c.9-3.4 3.4-5 6.5-5s5.6 1.6 6.5 5"/></svg>
);
export const SlashIc = () => (
  <svg className="ic s" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/></svg>
);
export const CopyIc = () => (
  <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>
);
export const CheckIc = () => (
  <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4.5 12.5l5 5 10-11"/></svg>
);

// Chrome / toolbar icons
export const MonitorIc = () => (
  <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="5" width="16" height="12" rx="2"/><path d="M9 21h6M12 17v4"/></svg>
);
export const SearchIc = () => (
  <svg className="ic s" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: "var(--text-subtle)" }}><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
);
export const MoonSunIc = ({ dark }: { dark: boolean }) => (
  <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    {dark
      ? <><circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></>
      : <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>}
  </svg>
);
export const MaxiMiniIc = ({ full }: { full: boolean }) => (
  <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    {full ? <path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5"/> : <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>}
  </svg>
);
// Tools popover icons (Overview "3 tools" card)
export const CliToolIc = () => (
  <svg className="ic s" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 17l6-5-6-5M12 19h8"/></svg>
);
export const DesktopToolIc = () => (
  <svg className="ic s" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="5" width="16" height="12" rx="2"/><path d="M9 21h6"/></svg>
);
export const OctocatIc = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2.17c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.66.41.36.78 1.06.78 2.14v3.17c0 .31.2.68.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"/></svg>
);

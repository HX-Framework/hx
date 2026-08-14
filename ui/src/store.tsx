import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import {
  api,
  authErrorKind,
  subscribeEvents,
  type ActivityEntry,
  type AuthErrorKind,
  type DataRootInfo,
  type DestinationInfo,
  type FolderInfo,
  type LogLine,
  type ProbeInfo,
  type SessionInfo,
  type Settings,
  type Snapshot,
  type UpdateCheck,
} from "./api";

export type View = "overview" | "folders" | "activity" | "privacy" | "device" | "logs" | "fortress";
export type GroupBy = "tool" | "dir" | "dest";

const SNAPSHOT_POLL_MS = 5_000;
const LOGS_POLL_MS = 4_000;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Re-triggerable one-shot CSS animation, same trick as the prototype.
export function retrigger(el: Element, cls: string) {
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
}

export function copyText(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    return true;
  } catch {
    return false;
  }
}

const VIEW_KEYS: Record<string, View> = { "1": "overview", "2": "folders", "3": "activity", "4": "privacy", "5": "device", "6": "logs" };

interface AppState {
  view: View;
  goto: (v: View) => void;
  currentDest: string | null;
  openDest: (key: string) => void;

  groupBy: GroupBy;
  setGroupBy: (g: GroupBy) => void;
  query: string;
  setQuery: (q: string) => void;
  openRows: Set<string>;
  toggleRow: (id: string) => void;

  kbdOpen: boolean;
  setKbdOpen: (b: boolean) => void;
  inspOpen: boolean;
  setInspOpen: (b: boolean) => void;
  inspInitialPath: string | null;
  openInspector: (path?: string) => void;
  logFull: boolean;
  setLogFull: (b: boolean) => void;

  // Live data
  snap: Snapshot | null;
  loading: boolean;
  error: string | null;
  authError: AuthErrorKind | null;
  email: string | null;
  probe: ProbeInfo | null;
  probing: boolean;
  runProbe: () => void;
  logs: LogLine[];
  activity: ActivityEntry[] | null;
  sessionsFor: (folderId: string) => SessionInfo[] | undefined;
  loadSessions: (folderId: string) => void;
  previewFor: (path: string) => { role: string; text: string }[] | undefined;
  loadPreview: (path: string) => void;

  // Settings + actions (all real: settings.json + daemon/gateway calls)
  settings: Settings | null;
  isExcluded: (f: FolderInfo) => boolean;
  isPersonalGated: (f: FolderInfo) => boolean;
  setPersonal: (on: boolean) => void;
  pickPause: (opt: string) => void;
  resumeAll: () => void;
  excludeFolder: (f: FolderInfo) => void;
  includeFolder: (f: FolderInfo) => void;
  addRule: (v: string) => void;
  removeRule: (v: string) => void;
  dataRoots: DataRootInfo[];
  dataRootsFrom: "daemon" | "local";
  shellDetected: { claude?: string; codex?: string };
  /** Resolve to null on success, or error text to show inline. Both refetch
   *  settings first so the mutation never rides a stale (or never-loaded)
   *  baseline — a null-settings baseline would PATCH empty arrays over every
   *  configured root. */
  addDataDir: (family: "claude" | "codex", dir: string) => Promise<string | null>;
  removeDataDir: (family: "claude" | "codex", dir: string) => Promise<string | null>;
  daemonAct: (action: "start" | "stop" | "restart") => Promise<string>;
  retryBlockedAct: () => Promise<string>;
  disconnectAct: () => Promise<void>;
  update: {
    checking: boolean;
    check: UpdateCheck | null;
    running: boolean;
    progress: string | null;
    done: string | null;
    error: string | null;
  };
  checkUpdate: () => void;
  runUpdateAct: () => void;
  confirm: { open: boolean; title: string; message: string; action: string } | null;
  askConfirm: (title: string, message: string, action: string, onYes: () => void) => void;
  answerConfirm: (yes: boolean) => void;

  // Derived
  allFolders: FolderInfo[];
  activeFolders: FolderInfo[];
  destinations: DestinationInfo[];
  foldersOfDest: (destKey: string) => FolderInfo[];
  destLabels: (f: FolderInfo) => string[];
  unlinkedFolders: FolderInfo[];

  reviewUnlinked: (folderId: string) => void;
  jumpFortressList: () => void;
  jumpDoctor: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const s = useContext(Ctx);
  if (!s) throw new Error("useApp outside provider");
  return s;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>("overview");
  const [currentDest, setCurrentDest] = useState<string | null>(null);
  const [groupBy, setGroupByState] = useState<GroupBy>("tool");
  const [query, setQueryState] = useState("");
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [kbdOpen, setKbdOpen] = useState(false);
  const [inspOpen, setInspOpen] = useState(false);
  const [inspInitialPath, setInspInitialPath] = useState<string | null>(null);
  const [logFull, setLogFull] = useState(false);

  const openInspector = (path?: string) => {
    setInspInitialPath(path ?? null);
    setInspOpen(true);
  };

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<AuthErrorKind | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeInfo | null>(null);
  const [probing, setProbing] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  const [sessions, setSessions] = useState<Map<string, SessionInfo[]>>(new Map());
  const [previews, setPreviews] = useState<Map<string, { role: string; text: string }[]>>(new Map());
  const sessionsInFlight = useRef<Set<string>>(new Set());
  const previewsInFlight = useRef<Set<string>>(new Set());

  const [settings, setSettings] = useState<Settings | null>(null);
  const [update, setUpdate] = useState<AppState["update"]>({
    checking: false, check: null, running: false, progress: null, done: null, error: null,
  });
  const [confirm, setConfirm] = useState<AppState["confirm"]>(null);
  const confirmYes = useRef<(() => void) | null>(null);

  // ── polling + server-sent nudges ──────────────────────────────────────
  const refetchSnap = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const pull = async () => {
      try {
        const s = await api.snapshot();
        if (!alive) return;
        setSnap(s);
        setError(null);
        setAuthError(null);
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message);
        setAuthError(authErrorKind(e));
      } finally {
        if (alive) setLoading(false);
      }
    };
    refetchSnap.current = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        void pull();
      }, 300);
    };
    void pull();
    const t = setInterval(pull, SNAPSHOT_POLL_MS);
    const unsubscribe = subscribeEvents((evt) => {
      if (!alive) return;
      if (evt.type === "changed") refetchSnap.current();
      else if (evt.type === "update-progress") {
        setUpdate((u) => ({
          ...u,
          running: true,
          progress: `${evt.phase}${evt.pct !== undefined ? ` — ${Math.round(evt.pct)}%` : "…"}`,
        }));
      } else if (evt.type === "update-done") {
        setUpdate((u) => ({
          ...u,
          running: false,
          progress: null,
          done: evt.alreadyLatest
            ? `Already on the latest version (${evt.version}).`
            : `Updated to ${evt.version}${evt.daemonRestarted ? " — daemon restarted" : ""}. Restart \`hx ui\` for the new client.`,
        }));
      } else if (evt.type === "update-error") {
        setUpdate((u) => ({ ...u, running: false, progress: null, error: evt.message }));
      }
    });
    return () => {
      alive = false;
      clearInterval(t);
      if (debounce) clearTimeout(debounce);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    void api.whoami().then((w) => setEmail(w.email)).catch(() => {});
    void api.settings().then(setSettings).catch(() => {});
  }, []);

  // Activity journal backs the Sync Status chart; refreshed with the view.
  useEffect(() => {
    if (view !== "activity") return;
    let alive = true;
    const pull = async () => {
      try {
        const r = await api.activity(24);
        if (alive) setActivity(r.entries);
      } catch {
        if (alive) setActivity([]);
      }
    };
    void pull();
    const t = setInterval(pull, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [view]);

  const logsActive = view === "logs" || logFull;
  useEffect(() => {
    if (!logsActive) return;
    let alive = true;
    const pull = async () => {
      try {
        const r = await api.logs(500);
        if (alive) setLogs(r.lines);
      } catch {
        // snapshot polling surfaces connectivity problems; keep last lines
      }
    };
    void pull();
    const t = setInterval(pull, LOGS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [logsActive]);

  const goto = (v: View) => {
    setView(v);
    window.scrollTo(0, 0);
  };

  const openDest = (key: string) => {
    setCurrentDest(key);
    goto("fortress");
  };

  const setGroupBy = (g: GroupBy) => {
    setGroupByState(g);
    setOpenRows(new Set());
  };

  const setQuery = (q: string) => {
    setQueryState(q);
    setOpenRows(new Set());
  };

  const toggleRow = (id: string) => {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runProbe = () => {
    setProbing(true);
    void api
      .probe()
      .then(setProbe)
      .catch(() => setProbe({ up: false, reason: "probe failed" }))
      .finally(() => setProbing(false));
  };

  const loadSessions = (folderId: string) => {
    if (sessions.has(folderId) || sessionsInFlight.current.has(folderId)) return;
    sessionsInFlight.current.add(folderId);
    void api
      .sessions(folderId)
      .then((list) => setSessions((prev) => new Map(prev).set(folderId, list)))
      .catch(() => {})
      .finally(() => sessionsInFlight.current.delete(folderId));
  };

  const loadPreview = (path: string) => {
    if (previews.has(path) || previewsInFlight.current.has(path)) return;
    previewsInFlight.current.add(path);
    void api
      .sessionPreview(path)
      .then((r) => setPreviews((prev) => new Map(prev).set(path, r.lines)))
      .catch(() => setPreviews((prev) => new Map(prev).set(path, [])))
      .finally(() => previewsInFlight.current.delete(path));
  };

  // ── settings actions (each patches settings.json; the daemon notices
  // within one 1.5 s tick, and a follow-up refetch shows the effect) ─────
  const patch = (p: Partial<Settings>) => {
    void api
      .patchSettings(p)
      .then((s) => {
        setSettings(s);
        setTimeout(() => refetchSnap.current(), 2_000);
      })
      .catch(() => {});
  };

  const setPersonal = (on: boolean) => patch({ personalSync: on });
  const pickPause = (opt: string) => {
    if (opt === "forever") return patch({ pause: { untilMs: null } });
    if (opt === "tomorrow") {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(8, 0, 0, 0);
      return patch({ pause: { untilMs: d.getTime() } });
    }
    patch({ pause: { untilMs: Date.now() + Number(opt) * 60_000 } });
  };
  const resumeAll = () => patch({ pause: null });

  const isExcluded = (f: FolderInfo) =>
    Boolean(settings?.excludedFolders.some((e) => e.family === f.family && e.cwd === f.path)) ||
    Boolean(settings?.excludeRules.some((r) => {
      const rr = r.replace(/\/+$/, "");
      return rr.length > 0 && (f.path === rr || f.path.startsWith(`${rr}/`));
    }));
  const isPersonalGated = (f: FolderInfo) => settings?.personalSync === false && f.repo === null;

  const excludeFolder = (f: FolderInfo) => {
    const cur = settings?.excludedFolders ?? [];
    if (cur.some((e) => e.family === f.family && e.cwd === f.path)) return;
    patch({ excludedFolders: [...cur, { family: f.family, cwd: f.path }] });
  };
  const includeFolder = (f: FolderInfo) => {
    const cur = settings?.excludedFolders ?? [];
    patch({ excludedFolders: cur.filter((e) => !(e.family === f.family && e.cwd === f.path)) });
  };
  const addRule = (v: string) => {
    const cur = settings?.excludeRules ?? [];
    if (cur.includes(v)) return;
    patch({ excludeRules: [...cur, v] });
  };
  const removeRule = (v: string) => {
    patch({ excludeRules: (settings?.excludeRules ?? []).filter((r) => r !== v) });
  };
  // Watched-locations settings. Both mutations re-GET settings first: the
  // boot fetch is one-shot and PATCHes carry full per-family arrays, so a
  // stale (or failed-to-load) baseline would silently erase other roots —
  // fresh-read-then-write shrinks that window to milliseconds and makes the
  // null-settings state safe. The server validates strictly (400 + message)
  // and the daemon adopts changes within one tick. Errors are returned, not
  // swallowed, so a refused location never LOOKS accepted.
  const mutateDataDirs = async (
    family: "claude" | "codex",
    change: (cur: string[]) => string[],
  ): Promise<string | null> => {
    try {
      const fresh = await api.settings();
      setSettings(fresh);
      const cur = fresh.dataDirs ?? { claude: [], codex: [] };
      const nextList = change(cur[family]);
      if (
        nextList.length === cur[family].length &&
        nextList.every((d, i) => d === cur[family][i])
      ) {
        return null; // no-op (already present / already gone)
      }
      const s = await api.patchSettings({ dataDirs: { ...cur, [family]: nextList } });
      setSettings(s);
      setTimeout(() => refetchSnap.current(), 2_000);
      return null;
    } catch (err) {
      return err instanceof Error && err.message ? err.message : "couldn't save this change";
    }
  };
  const addDataDir = (family: "claude" | "codex", dir: string) =>
    mutateDataDirs(family, (cur) => (cur.includes(dir) ? cur : [...cur, dir]));
  const removeDataDir = (family: "claude" | "codex", dir: string) =>
    mutateDataDirs(family, (cur) => cur.filter((d) => d !== dir));

  const daemonAct = async (action: "start" | "stop" | "restart"): Promise<string> => {
    try {
      const r = await api.daemon(action);
      setTimeout(() => refetchSnap.current(), 500);
      return r.pid
        ? `daemon ${action === "stop" ? "stopped" : "running"} · pid ${r.pid} · via ${r.managerName}`
        : `daemon ${action === "stop" ? "stopped" : "not running"} (${r.managerName})`;
    } catch {
      return `couldn't ${action} the daemon — try \`hx ${action}\` in a terminal`;
    }
  };

  const retryBlockedAct = async (): Promise<string> => {
    try {
      const r = await api.retryBlocked();
      setTimeout(() => refetchSnap.current(), 500);
      return r.restarted
        ? `Released ${r.sessions} blocked session${r.sessions === 1 ? "" : "s"} — daemon restarted for an immediate retry.`
        : `Released ${r.sessions} blocked session${r.sessions === 1 ? "" : "s"}.`;
    } catch {
      return "Retry failed — try `hx retry --blocked` in a terminal.";
    }
  };

  const disconnectAct = async (): Promise<void> => {
    try {
      await api.disconnect();
    } finally {
      refetchSnap.current();
    }
  };

  const checkUpdate = () => {
    setUpdate((u) => ({ ...u, checking: true, error: null, done: null }));
    void api
      .updateCheck()
      .then((c) => setUpdate((u) => ({ ...u, checking: false, check: c })))
      .catch(() => setUpdate((u) => ({ ...u, checking: false, error: "update check failed" })));
  };
  const runUpdateAct = () => {
    setUpdate((u) => ({ ...u, running: true, progress: "starting…", error: null, done: null }));
    void api.startUpdate().catch(() =>
      setUpdate((u) => ({ ...u, running: false, progress: null, error: "couldn't start the update" })),
    );
  };

  const askConfirm = (title: string, message: string, action: string, onYes: () => void) => {
    confirmYes.current = onYes;
    setConfirm({ open: true, title, message, action });
  };
  const answerConfirm = (yes: boolean) => {
    setConfirm(null);
    const fn = confirmYes.current;
    confirmYes.current = null;
    if (yes && fn) fn();
  };

  const allFolders = snap?.folders ?? [];
  const activeFolders = allFolders.filter((f) => !isExcluded(f) && !isPersonalGated(f));
  const destinations = snap?.destinations ?? [];
  const foldersOfDest = (destKey: string) => activeFolders.filter((f) => f.dests.includes(destKey));
  const destLabels = (f: FolderInfo) =>
    f.dests.length > 0
      ? f.dests.map((key) => destinations.find((d) => d.key === key)?.label ?? key)
      : ["not uploaded yet"];
  const unlinkedFolders = activeFolders.filter((f) => f.unlinkedRepo);

  // Review → land on the exact folder row being reviewed, highlighted.
  const reviewUnlinked = (folderId: string) => {
    flushSync(() => {
      setGroupByState("tool");
      setOpenRows(new Set());
      setView("folders");
    });
    window.scrollTo(0, 0);
    const row = document.querySelector(`#folderList .frow[data-id="${CSS.escape(folderId)}"]`);
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      retrigger(row, "flashrow");
    }
  };

  const jumpFortressList = () => {
    const p = document.getElementById("fortressPanel");
    if (!p) return;
    p.scrollIntoView({ behavior: "smooth", block: "center" });
    retrigger(p, "flash");
  };

  const jumpDoctor = () => {
    flushSync(() => setView("device"));
    window.scrollTo(0, 0);
    const mp = document.getElementById("doctorSection");
    if (mp) {
      mp.scrollIntoView({ behavior: "smooth", block: "center" });
      retrigger(mp, "flash");
    }
  };

  // Keyboard: ? for the menu, 1–6 for sections, Esc for dialogs / fullscreen logs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (logFull) {
          setLogFull(false);
          return;
        }
        setKbdOpen(false);
        setInspOpen(false);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") {
        setKbdOpen((o) => !o);
        return;
      }
      const v = VIEW_KEYS[e.key];
      if (v) goto(v);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logFull]);

  const value: AppState = {
    view, goto, currentDest, openDest,
    groupBy, setGroupBy, query, setQuery, openRows, toggleRow,
    kbdOpen, setKbdOpen, inspOpen, setInspOpen, inspInitialPath, openInspector,
    logFull, setLogFull,
    snap, loading, error, authError, email,
    probe, probing, runProbe,
    logs,
    activity,
    sessionsFor: (id) => sessions.get(id),
    loadSessions,
    previewFor: (p) => previews.get(p),
    loadPreview,
    settings, isExcluded, isPersonalGated,
    setPersonal, pickPause, resumeAll,
    excludeFolder, includeFolder, addRule, removeRule,
    dataRoots: snap?.dataRoots ?? [],
    dataRootsFrom: snap?.dataRootsFrom ?? "local",
    shellDetected: snap?.shellDetected ?? {},
    addDataDir, removeDataDir,
    daemonAct, retryBlockedAct, disconnectAct,
    update, checkUpdate, runUpdateAct,
    confirm, askConfirm, answerConfirm,
    allFolders, activeFolders, destinations, foldersOfDest, destLabels, unlinkedFolders,
    reviewUnlinked, jumpFortressList, jumpDoctor,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

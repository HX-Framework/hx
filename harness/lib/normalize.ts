// Normalization: what two runs are allowed to differ in before they are
// compared.
//
// The rules are deliberately few and each one names the thing it hides:
//
//   • the candidate's name — hx2 prints `hx2` wherever hx prints `hx`, in its
//     output, its User-Agent and its release asset names. This is the ONE
//     allowed behavioral difference between the two binaries (the program
//     doc, "What exactly the same means", row 5), so it is a rule here and
//     not a diff;
//   • the version string each binary reports — a candidate built from a
//     later commit carries a later version;
//   • wall-clock time — timestamps that fall inside the run's window become
//     seconds relative to an anchor and compare with a tolerance; timestamps
//     outside it (the fixed content timestamps inside transcripts) are kept
//     and compared exactly;
//   • the probe `hx status` runs — latency, throughput and the grade they
//     earn vary with the machine, not the binary;
//   • paths and ports that name the run itself — the fixture home, the
//     harness work directory, the gateway's port, a UI port, a pid, a launch
//     token.
//
// In "golden" mode (comparing a run against a committed expectation that may
// be months old) calendar dates are hidden too.

export interface NormalizeContext {
  candidateName: "hx" | "hx2";
  /** Version strings reported by the binaries in this comparison. */
  versions: string[];
  home: string;
  workDir: string;
  gatewayUrl: string;
  fortressUrl: string | null;
  /** Timestamps in [anchorMs - windowBeforeMs, anchorMs + windowAfterMs] are run-relative. */
  anchorMs: number;
  windowBeforeMs: number;
  windowAfterMs: number;
  mode: "diff" | "golden";
}

export const DEFAULT_WINDOW_BEFORE_MS = 45 * 24 * 60 * 60 * 1000;
export const DEFAULT_WINDOW_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/g;
const LOCAL_STAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /gm;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function projectDirName(p: string): string {
  return p.replace(/[/\\.]/g, "-");
}

function inWindow(ms: number, ctx: NormalizeContext): boolean {
  return ms >= ctx.anchorMs - ctx.windowBeforeMs && ms <= ctx.anchorMs + ctx.windowAfterMs;
}

export function normalizeText(input: string, ctx: NormalizeContext): string {
  let s = input;
  if (ctx.candidateName === "hx2") s = s.replace(/\bhx2\b/g, "hx");
  for (const v of ctx.versions) {
    if (v) s = s.replace(new RegExp(escapeRe(v), "g"), "<version>");
  }
  if (ctx.fortressUrl) s = s.split(ctx.fortressUrl).join("<FORTRESS>");
  s = s.split(ctx.gatewayUrl).join("<GATEWAY>");
  s = s.replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/g, "<LOCAL-URL>");
  s = s.replace(/\b(?:127\.0\.0\.1|localhost):\d+/g, "<host:port>");
  s = s.split(ctx.home).join("<HOME>");
  s = s.split(ctx.workDir).join("<WORK>");
  // Claude Code names a project dir after the cwd with every separator and
  // dot replaced by "-", so the fixture home shows up inside such names too.
  s = s.split(projectDirName(ctx.home)).join("<HOME>");
  s = s.split(projectDirName(ctx.workDir)).join("<WORK>");
  // Text has no tolerance, so a timestamp inside the window becomes a bare
  // placeholder; JSON timestamps keep their offset and a tolerance (below).
  s = s.replace(ISO_RE, (m) => {
    const ms = Date.parse(m);
    return Number.isFinite(ms) && inWindow(ms, ctx) ? "<t>" : m;
  });
  s = s.replace(LOCAL_STAMP_RE, "<stamp> ");
  // toLocaleString() / toLocaleTimeString() under en-US: "10/15/2026, 9:12:34 PM", "9:12:34 PM".
  s = s.replace(/\b\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M\b/g, "<local-datetime>");
  s = s.replace(/\b\d{1,2}:\d{2}:\d{2} [AP]M\b/g, "<local-time>");
  // hx status: the connection probe.
  s = s.replace(/up — (?:Excellent|Good|Fair|Poor) \(\d+ ms, [^)]*\)/g, "up — <quality> (<latency>, <rate>)");
  // Which file the client tried first against a refusing gateway follows
  // discovery order; the refusal itself is the fact.
  s = s.replace(/\[error\] \S+\.jsonl: ([a-z-]+(?: [a-z-]+)* failed: 5\d\d\b)/g, "[error] <a transcript>: $1");
  // The stuck line's countdown is measured against the moment the tick ran,
  // and its failure count climbs with every retry the run had time for:
  // both follow timing. The reason — and the hold it names — is the fact.
  s = s.replace(/waiting out a retry backoff for another \d+ min \(\d+ consecutive failures/g, "waiting out a retry backoff for another <n> min (<n> consecutive failures");
  // Daemon pids, launch tokens, session tokens, sha prefixes.
  s = s.replace(/\bpid \d+/g, "pid <n>");
  s = s.replace(/#k=[A-Za-z0-9_-]+/g, "#k=<token>");
  s = s.replace(/sha256 [0-9a-f]{12}…/g, "sha256 <sha>…");
  if (ctx.mode === "golden") {
    s = s.replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}(?:, \d{4})?\b/g, "<date>");
    s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<date>");
  }
  return s;
}

/** A run-relative timestamp, carried through JSON as its own object. */
export interface RelTime {
  $t: number;
}

export function isRelTime(v: unknown): v is RelTime {
  return typeof v === "object" && v !== null && "$t" in v && Object.keys(v).length === 1;
}

/** Keys whose values are per-run secrets or measurements, never facts. */
const TOKEN_KEYS = new Set(["sessionToken", "launchToken", "ownerKey", "serverProof"]);
const MEASURE_KEYS = new Set(["latencyMs", "bytesPerSec"]);

export interface JsonOptions {
  /** Sort arrays of objects by their content: for lists the client orders
   *  by a tie-prone key (hx ui folders by session count, recent uploads by
   *  millisecond, sessions by last upload) where discovery order decides
   *  ties. Arrays of primitives keep their order. */
  sortObjectArrays?: boolean;
}

/**
 * Normalize a JSON value: strings through normalizeText, epoch-millisecond
 * numbers inside the window into run-relative seconds, object keys sorted,
 * per-run tokens and probe measurements replaced.
 */
export function normalizeJson(value: unknown, ctx: NormalizeContext, opts: JsonOptions = {}): unknown {
  if (typeof value === "string") return normalizeText(value, ctx);
  if (typeof value === "number") {
    if (Number.isFinite(value) && value > 1e12 && value < 4e12 && inWindow(value, ctx)) {
      return ctx.mode === "golden" ? "<t>" : { $t: Math.round((value - ctx.anchorMs) / 1000) };
    }
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => normalizeJson(v, ctx, opts));
    if (opts.sortObjectArrays && items.some((v) => v && typeof v === "object" && !isRelTime(v))) {
      return [...items].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
    }
    return items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const nk = normalizeText(k, ctx);
      const v = (value as Record<string, unknown>)[k];
      if (TOKEN_KEYS.has(k) && typeof v === "string") out[nk] = "<token>";
      else if (MEASURE_KEYS.has(k) && typeof v === "number") out[nk] = "<measured>";
      else if (k === "quality" && typeof v === "string") out[nk] = "<quality>";
      else out[nk] = normalizeJson(v, ctx, opts);
    }
    return out;
  }
  return value;
}

/** A stable sort key: the normalized value with run-relative times masked,
 *  so a one-second drift cannot reorder two runs differently. */
function sortKey(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (isRelTime(x) ? "<t>" : x));
}

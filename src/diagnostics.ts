import type { SyncReport, SyncSkippedEntry } from "./watch.js";
import type { FileSkipReason, SyncBlockerDestination } from "./state.js";
import type { ResolvedRoots, RootOrigin } from "./roots.js";
import { formatOutage, type SyncLedger } from "./ledger.js";
import { collapseHome } from "./settings.js";

export interface DoctorSession {
  family: string;
  sessionId: string;
}

export interface DoctorRemediation {
  fortressSettingsUrl: string | null;
  repositorySettingsUrl: string | null;
  guidance: string;
  retryCommand: "hx retry --blocked";
}

export interface DoctorBlocker {
  reason: FileSkipReason;
  sessionCount: number;
  sessions: DoctorSession[];
  destination: SyncBlockerDestination | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  nextRetryAt: string | null;
  remediation: DoctorRemediation;
}

export interface DoctorRoot {
  family: "claude" | "codex";
  configDir: string;
  origin: RootOrigin;
  exists: boolean;
}

export interface SyncDoctorReport {
  ok: boolean;
  generatedAt: string;
  sync: {
    total: number;
    done: number;
    percent: number;
    totalBytes: number;
  };
  blockedSessions: number;
  gaps: {
    sessions: number;
    localFileDeleted: number;
    outsideScanWindow: number;
  };
  blockers: DoctorBlocker[];
  /** Every session in exactly one bucket + the health percentage. Unlike
   *  `sync` above (a min-across-destinations count kept for the gateway's
   *  wire format) this is what `hx status` shows. */
  ledger: SyncLedger;
  /** The data roots the report was computed over (empty on legacy callers). */
  roots: DoctorRoot[];
  /** Partially-synced sessions under no current root (a removed data root) —
   *  informational, not an error: nothing will pick them up as configured. */
  unwatchedSessions: number;
  /** Sessions the settings filters dropped before any upload was attempted. */
  excluded: SyncReport["excluded"];
  /** Tracked files discovery did not return, split by whether they still exist. */
  undiscovered: SyncReport["undiscovered"];
  /** Child agent lanes — tracked, uploaded separately, previously unreported. */
  childLanes: SyncReport["childLanes"];
}

interface MutableBlocker {
  reason: FileSkipReason;
  destination: SyncBlockerDestination | null;
  sessions: Map<string, DoctorSession>;
  firstObservedAtMs: number | null;
  lastObservedAtMs: number | null;
  nextRetryAtMs: number | null;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function originOf(gatewayBaseUrl: string): string | null {
  try {
    return new URL(gatewayBaseUrl).origin;
  } catch {
    return null;
  }
}

function settingsUrls(
  gatewayBaseUrl: string,
  destination: SyncBlockerDestination | null,
): DoctorRemediation {
  const origin = originOf(gatewayBaseUrl);
  const org = destination?.orgSlug;
  const project = destination?.projectSlug;
  return {
    fortressSettingsUrl:
      origin && org ? `${origin}/${encodeURIComponent(org)}/settings#fortress` : null,
    repositorySettingsUrl:
      origin && org && project
        ? `${origin}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/settings#repositories`
        : null,
    guidance:
      "Bring the Fortress online, or detach/move the repository to a project backed by a live Fortress.",
    retryCommand: "hx retry --blocked",
  };
}

function destinationKey(reason: FileSkipReason, destination: SyncBlockerDestination | null): string {
  if (!destination) return `${reason}:legacy`;
  return [
    reason,
    destination.vaultOrgId,
    destination.projectId ?? "",
    destination.repoSlug ?? "",
  ].join(":");
}

/** Group skipped files by the destination actually holding them. The output
 * deliberately excludes local paths and all transcript/content fields. */
export function groupSyncBlockers(skipped: SyncSkippedEntry[]): MutableBlocker[] {
  const groups = new Map<string, MutableBlocker>();
  for (const entry of skipped) {
    const destinations = entry.blocker?.destinations.length
      ? entry.blocker.destinations
      : [null];
    for (const destination of destinations) {
      const key = destinationKey(entry.reason, destination);
      let group = groups.get(key);
      if (!group) {
        group = {
          reason: entry.reason,
          destination,
          sessions: new Map(),
          firstObservedAtMs: null,
          lastObservedAtMs: null,
          nextRetryAtMs: null,
        };
        groups.set(key, group);
      }
      group.sessions.set(`${entry.family}:${entry.sessionId}`, {
        family: entry.family,
        sessionId: entry.sessionId,
      });
      const first = entry.blocker?.firstSeenAtMs;
      const last = entry.blocker?.lastSeenAtMs;
      const next = entry.nextAttemptAtMs;
      if (first !== undefined) {
        group.firstObservedAtMs =
          group.firstObservedAtMs === null ? first : Math.min(group.firstObservedAtMs, first);
      }
      if (last !== undefined) {
        group.lastObservedAtMs =
          group.lastObservedAtMs === null ? last : Math.max(group.lastObservedAtMs, last);
      }
      if (next !== undefined) {
        group.nextRetryAtMs =
          group.nextRetryAtMs === null ? next : Math.min(group.nextRetryAtMs, next);
      }
    }
  }
  return [...groups.values()];
}

export function buildSyncDoctorReport(
  report: SyncReport,
  gatewayBaseUrl: string,
  nowMs = Date.now(),
  roots: ResolvedRoots | null = null,
): SyncDoctorReport {
  const groups = groupSyncBlockers(report.skipped);
  const blockedSessionKeys = new Set(
    report.skipped.map((entry) => `${entry.family}:${entry.sessionId}`),
  );
  const gone = new Set(report.behind.filter((entry) => entry.sourceGone).map((entry) => entry.sessionId));
  const aged = new Set(
    report.behind
      .filter((entry) => !entry.sourceGone && !gone.has(entry.sessionId))
      .map((entry) => entry.sessionId),
  );
  const percent =
    report.snapshot.total === 0
      ? 100
      : Math.floor((report.snapshot.done / report.snapshot.total) * 100);
  const blockers = groups.map((group): DoctorBlocker => ({
    reason: group.reason,
    sessionCount: group.sessions.size,
    sessions: [...group.sessions.values()].sort((a, b) =>
      `${a.family}:${a.sessionId}`.localeCompare(`${b.family}:${b.sessionId}`),
    ),
    destination: group.destination,
    firstObservedAt: iso(group.firstObservedAtMs),
    lastObservedAt: iso(group.lastObservedAtMs),
    nextRetryAt: iso(group.nextRetryAtMs),
    remediation: settingsUrls(gatewayBaseUrl, group.destination),
  }));
  const gapSessions = new Set([...gone, ...aged]).size;
  return {
    ok:
      blockedSessionKeys.size === 0 &&
      gapSessions === 0 &&
      report.snapshot.done >= report.snapshot.total,
    generatedAt: new Date(nowMs).toISOString(),
    sync: {
      total: report.snapshot.total,
      done: report.snapshot.done,
      percent,
      totalBytes: report.snapshot.totalBytes,
    },
    blockedSessions: blockedSessionKeys.size,
    gaps: {
      sessions: gapSessions,
      localFileDeleted: gone.size,
      outsideScanWindow: aged.size,
    },
    blockers,
    ledger: report.ledger,
    roots: roots
      ? [
          ...roots.claude.map((r): DoctorRoot => ({ family: "claude", configDir: r.configDir, origin: r.origin, exists: r.exists })),
          ...roots.codex.map((r): DoctorRoot => ({ family: "codex", configDir: r.configDir, origin: r.origin, exists: r.exists })),
        ]
      : [],
    unwatchedSessions: report.unwatched,
    excluded: report.excluded,
    undiscovered: report.undiscovered,
    childLanes: report.childLanes,
  };
}

function shortDate(value: string, nowMs = Date.now()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const sameYear = date.getUTCFullYear() === new Date(nowMs).getUTCFullYear();
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" as const }),
    timeZone: "UTC",
  }).format(date);
}

/** Compact root cause used by the default `hx status` table. */
export function formatStatusBlocker(skipped: SyncSkippedEntry[], nowMs = Date.now()): string {
  const groups = groupSyncBlockers(skipped);
  const sessions = new Set(skipped.map((entry) => `${entry.family}:${entry.sessionId}`)).size;
  if (groups.length !== 1 || !groups[0]?.destination) {
    if (groups.length === 1) {
      return `${sessions} session${sessions === 1 ? "" : "s"} — destination store unavailable`;
    }
    return `${sessions} session${sessions === 1 ? "" : "s"} across ${groups.length} blocked destination${groups.length === 1 ? "" : "s"}`;
  }
  const d = groups[0].destination;
  const org = d.orgName ?? d.orgSlug ?? d.vaultOrgId;
  const heartbeat = d.lastSeenAt ? ` since ${shortDate(d.lastSeenAt, nowMs)}` : "";
  const repo = d.repoSlug ? ` · ${d.repoSlug}` : "";
  return `${sessions} session${sessions === 1 ? "" : "s"} — ${org} Fortress offline${heartbeat}${repo}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/** Right-align a count in a fixed gutter so the bucket column scans. */
function num(n: number, width = 6): string {
  return String(n).padStart(width);
}

/**
 * The session ledger, shown with its arithmetic. Printing the sum and the
 * formula makes the headline percentage auditable — a reader can check that
 * the buckets account for every session rather than trusting the number.
 */
export function formatLedgerSection(ledger: SyncLedger): string[] {
  const lines = [
    "",
    "SESSIONS",
    `  Delivered   ${num(ledger.delivered)}   reached every reachable destination`,
  ];
  if (ledger.uploading > 0) {
    lines.push(`  Uploading   ${num(ledger.uploading)}   bytes still going to a reachable store`);
  }
  if (ledger.live > 0) {
    lines.push(`  Live        ${num(ledger.live)}   actively working on this device (local)`);
  }
  if (ledger.waiting - ledger.waitingUnprotected > 0) {
    lines.push(
      `  Waiting     ${num(ledger.waiting - ledger.waitingUnprotected)}   an offline Fortress owes bytes (a complete copy is already safe)`,
    );
  }
  if (ledger.waitingUnprotected > 0) {
    lines.push(
      `  At risk     ${num(ledger.waitingUnprotected)}   only complete copy is on THIS DEVICE — Fortress offline`,
    );
  }
  lines.push(`              ${"─".repeat(6)}`);
  lines.push(`              ${num(ledger.total)}`);
  if (ledger.incomplete > 0) {
    // OUTSIDE the sum, and said plainly: this accumulates for as long as the
    // device is used, so a reader who meets a four-digit number here needs to
    // know immediately that it is a ledger, not a fault.
    const pad = " ".repeat(23);
    lines.push(
      `  Not on disk ${num(ledger.incomplete)}   removed locally before delivery could be confirmed.`,
    );
    lines.push(`${pad}Grows over time — Claude Code prunes at 30 days. Not a`);
    lines.push(`${pad}fault and not counted; kept for diagnostics.`);
  }
  if (ledger.oldestMs !== null && ledger.newestMs !== null) {
    const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
    const days = Math.max(1, Math.round((ledger.newestMs - ledger.oldestMs) / 86_400_000));
    lines.push(`  Range       ${iso(ledger.oldestMs)} → ${iso(ledger.newestMs)}  (${days} days on disk)`);
  }
  // Must mirror buildLedger exactly, or the printed arithmetic contradicts the
  // number beside it — the whole point of showing the formula.
  const sendable = ledger.delivered + ledger.uploading + ledger.waitingUnprotected;
  lines.push(
    `  Sync ${ledger.percent}% = ${ledger.delivered} delivered / ${sendable} sendable` +
      ` (live sessions, sessions already safe elsewhere, and sessions no longer on` +
      ` disk are excluded — nothing you can act on)`,
  );
  if (ledger.failing.length > 0) {
    lines.push("");
    lines.push("FAILING DESTINATIONS — reachable, but rejecting writes");
    for (const f of ledger.failing) {
      const since = f.failingHours === null ? "" : ` · for ${f.failingHours}h`;
      lines.push(`  ${f.label}  —  ${f.errorCode}${since}`);
    }
    lines.push("  Every retry is being refused; this does not self-heal. Check the");
    lines.push("  storage credentials/config on the server side, then: hx retry --all");
  }
  if (ledger.notDelivered.length > 0) {
    lines.push("");
    lines.push("SESSIONS STILL OWING BYTES — what each one is waiting on");
    for (const d of ledger.notDelivered.slice(0, MAX_LISTED_SESSIONS)) {
      lines.push(
        `  ${d.family}:${d.sessionId}  ${fmtBytes(d.owedBytes)} owed · ${d.ageDays}d old · ${d.bucket}`,
      );
      const last = d.lastUploadAt ? `last upload ${d.lastUploadAt}` : "NEVER uploaded";
      const attr = `repo ${d.repoSlug ?? "(none)"} · attributed ${d.attributed ?? "unknown"}`;
      lines.push(`      ${last} · ${attr}`);
      if (d.skipReason || d.consecutiveFailures > 0 || d.nextAttemptAt) {
        lines.push(
          `      held: ${d.skipReason ?? "none"} · ${d.consecutiveFailures} consecutive failures · next attempt ${d.nextAttemptAt ?? "immediately"}`,
        );
      }
      for (const dest of d.destinations) {
        if (dest.owed === 0) {
          lines.push(`      ${dest.label}: complete (${dest.offset.toLocaleString()} B)`);
          continue;
        }
        // An UNKNOWN destination is the actionable one — the client is billing
        // bytes to a store it has no record of, so nothing will ever drain it.
        const note =
          dest.state === "unknown"
            ? "  <-- NOT KNOWN to this device; nothing will ever send here"
            : dest.state === "offline"
              ? "  (offline)"
              : "";
        lines.push(
          `      ${dest.label}: ${dest.offset.toLocaleString()} / ${d.sizeBytes.toLocaleString()} B${note}`,
        );
      }
    }
    const rest = ledger.notDelivered.length - MAX_LISTED_SESSIONS;
    if (rest > 0) lines.push(`  …and ${rest} more (see --json)`);
    if (ledger.notDelivered.some((d) => d.destinations.some((x) => x.state === "unknown" && x.owed > 0))) {
      lines.push("");
      lines.push("  A destination marked NOT KNOWN was advertised to this device once and");
      lines.push("  never registered. Its bytes can never be delivered and the session will");
      lines.push("  sit here forever. This is a client bug — please report it.");
    }
  }
  if (ledger.lagging.length > 0) {
    lines.push("");
    lines.push("OFFLINE DESTINATIONS");
    for (const d of ledger.lagging) {
      const seen = d.lastSeenAt ? ` · last seen ${d.lastSeenAt}` : " · never seen";
      lines.push(`  ${d.label}  —  ${d.sessions} waiting · ${formatOutage(d.offlineDays)}${seen}`);
    }
    lines.push(
      "  Counts overlap where one session fans out to more than one Fortress.",
    );
  }
  return lines;
}

/** Session ids shown per destination before the list is summarised. A device
 *  fanning a whole history at an offline store lists hundreds otherwise, which
 *  buries the remediation links under an unreadable wall. Automation reads
 *  `--json`, which is never truncated. */
const MAX_LISTED_SESSIONS = 8;

function formatSessionList(sessions: DoctorSession[]): string {
  const shown = sessions.slice(0, MAX_LISTED_SESSIONS);
  const rest = sessions.length - shown.length;
  const list = shown.map((s) => `${s.family}:${s.sessionId}`).join(", ");
  return rest > 0 ? `${list} …and ${rest} more (see --json)` : list;
}

export function formatSyncDoctorText(report: SyncDoctorReport): string {
  // Lead with the ledger percentage, not report.sync — the latter is the
  // min-across-destinations count kept for the gateway wire format, and it
  // would contradict the number `hx status` just printed.
  const lines = ["HX sync — detailed", ...formatLedgerSection(report.ledger).slice(1)];
  if (report.roots.length > 0) {
    lines.push(
      `Watching: ${report.roots
        .map(
          (r) =>
            `${collapseHome(r.configDir)}${r.origin === "default" ? "" : ` [${r.origin}]`}${r.exists ? "" : " (missing)"}`,
        )
        .join(" · ")}`,
    );
  }
  if (report.blockedSessions === 0) {
    lines.push("Blocked: none");
  } else {
    lines.push(`Blocked: ${report.blockedSessions} session${report.blockedSessions === 1 ? "" : "s"}`);
    report.blockers.forEach((blocker, index) => {
      const d = blocker.destination;
      lines.push("");
      lines.push(`Destination ${index + 1}: ${d?.orgName ?? d?.orgSlug ?? d?.vaultOrgId ?? "unknown store"}`);
      if (d?.projectName || d?.projectSlug) lines.push(`  Project: ${d.projectName ?? d.projectSlug}`);
      if (d?.repoSlug) lines.push(`  Repo: ${d.repoSlug}`);
      lines.push(`  Reason: ${blocker.reason}`);
      lines.push(`  Fix: ${blocker.remediation.guidance}`);
      if (d?.lastSeenAt) lines.push(`  Fortress last heartbeat: ${d.lastSeenAt}`);
      if (blocker.nextRetryAt) lines.push(`  Next automatic retry: ${blocker.nextRetryAt}`);
      lines.push(`  Sessions: ${formatSessionList(blocker.sessions)}`);
      if (blocker.remediation.fortressSettingsUrl) {
        lines.push(`  Fortress settings: ${blocker.remediation.fortressSettingsUrl}`);
      }
      if (blocker.remediation.repositorySettingsUrl) {
        lines.push(`  Repository attachment: ${blocker.remediation.repositorySettingsUrl}`);
      }
    });
    lines.push("");
    lines.push("After fixing the destination or repository attachment:");
    lines.push("  hx retry --blocked");
    lines.push("  hx status");
  }
  if (report.excluded.length > 0) {
    lines.push("");
    lines.push(
      `EXCLUDED BY SETTINGS — ${report.excluded.length} session${report.excluded.length === 1 ? "" : "s"} dropped before any upload is attempted`,
    );
    for (const e of report.excluded.slice(0, MAX_LISTED_SESSIONS)) {
      lines.push(`  ${e.family}:${e.sessionId}  ${e.reason}`);
    }
    const rest = report.excluded.length - MAX_LISTED_SESSIONS;
    if (rest > 0) lines.push(`  …and ${rest} more (see --json)`);
  }
  if (report.undiscovered.onDiskButUndiscovered > 0) {
    lines.push("");
    lines.push(
      `WARNING: ${report.undiscovered.onDiskButUndiscovered} tracked file(s) exist on disk but discovery did not return them.`,
    );
    lines.push("This should never happen — discovery is unwindowed here. Please report it.");
  }
  if (report.childLanes.tracked > 0) {
    lines.push("");
    const c = report.childLanes;
    lines.push(
      `Child agent lanes: ${c.tracked} tracked · ${c.onDisk} on disk · ${c.gone} pruned` +
        (c.owing > 0 ? ` · ${c.owing} still owing ${fmtBytes(c.owedBytes)}` : " · all delivered"),
    );
    if (c.owing > 0) {
      lines.push("These upload on their own pass; a stall here is invisible in the session counts above.");
    }
  }
  if (report.undiscovered.fileGone > 0) {
    lines.push("");
    lines.push(
      `Tracked but no longer on disk: ${report.undiscovered.fileGone} file entr${report.undiscovered.fileGone === 1 ? "y" : "ies"} (normal — Claude Code prunes at 30 days).`,
    );
  }
  if (report.unwatchedSessions > 0) {
    lines.push("");
    lines.push(
      `Unwatched: ${report.unwatchedSessions} partially-synced session${report.unwatchedSessions === 1 ? "" : "s"} under locations no longer watched (removed data root)`,
    );
  }
  // Held is not lost. Say so explicitly: four warning paragraphs above read as
  // data loss without it, and the whole point of excluding waiting sessions
  // from the percentage is that they are safe on disk.
  const safeWaiting = report.ledger.waiting - report.ledger.waitingUnprotected;
  if (safeWaiting > 0) {
    lines.push("");
    lines.push(
      `Nothing is lost — ${safeWaiting} waiting session${safeWaiting === 1 ? " is" : "s are"} already complete on a reachable store and still retrying.`,
    );
  }
  if (report.ledger.waitingUnprotected > 0) {
    lines.push("");
    lines.push(
      `AT RISK — ${report.ledger.waitingUnprotected} session${report.ledger.waitingUnprotected === 1 ? "" : "s"} exist ONLY on this device: their Fortress is`,
    );
    lines.push("offline and there is no copy anywhere else. Claude Code deletes transcripts");
    lines.push("after 30 days; bring the Fortress online before then or they are gone.");
  }
  if (report.ok) lines.push("Result: healthy — 100% uploaded");
  return lines.join("\n");
}

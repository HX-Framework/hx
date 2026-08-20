import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  buildSyncDoctorReport,
  formatStatusBlocker,
  formatSyncDoctorText,
} from "./diagnostics.js";
import type { SyncReport } from "./watch.js";
import { buildLedger } from "./ledger.js";
import type { HxState } from "./state.js";

/** Real (empty) ledger — the doctor report reads only the blocker fields, so
 *  these fixtures exercise the same shape computeSyncReport produces. */
const noLedger = (): SyncReport["ledger"] =>
  buildLedger({ files: [], state: { files: {} }, incompleteSessions: 0, nowMs: 0 });

const blockedReport = (): SyncReport => ({
  snapshot: { total: 777, done: 775, totalBytes: 10 },
  behind: [],
  unwatched: 0,
  excluded: [],
  undiscovered: { fileGone: 0, onDiskButUndiscovered: 0 },
  childLanes: { tracked: 0, onDisk: 0, gone: 0, owing: 0, owedBytes: 0, held: 0, heldReasons: {} },
  ledger: noLedger(),
  skipped: ["s1", "s2"].map((sessionId, index) => ({
    path: `/private/${sessionId}.jsonl`,
    family: "claude-cli",
    sessionId,
    reason: "vault_offline" as const,
    nextAttemptAtMs: 1_721_000_000_000 + index,
    blocker: {
      reason: "vault_offline" as const,
      firstSeenAtMs: 1_720_000_000_000,
      lastSeenAtMs: 1_720_000_100_000,
      destinations: [{
        vaultOrgId: "orgA",
        reason: "vault_offline" as const,
        orgName: "Acme Dev",
        orgSlug: "acme-dev",
        projectId: "projA",
        projectName: "Acme Dev Project",
        projectSlug: "acme-fortress-test",
        repoSlug: "acme/example-repo",
        lastSeenAt: "2026-07-07T12:00:00.000Z",
      }],
    },
  })),
});

describe("sync diagnostics", () => {
  it("groups sessions by destination and emits exact remediation links", () => {
    const out = buildSyncDoctorReport(
      blockedReport(),
      "https://beta.let.ai/_api/hx-gateway",
      Date.UTC(2026, 6, 16),
    );
    assert.equal(out.ok, false);
    assert.equal(out.blockedSessions, 2);
    assert.equal(out.blockers.length, 1);
    assert.equal(out.blockers[0]?.sessionCount, 2);
    assert.equal(
      out.blockers[0]?.remediation.repositorySettingsUrl,
      "https://beta.let.ai/acme-dev/acme-fortress-test/settings#repositories",
    );
    assert.equal(
      out.blockers[0]?.remediation.fortressSettingsUrl,
      "https://beta.let.ai/acme-dev/settings#fortress",
    );
    assert.match(out.blockers[0]?.remediation.guidance ?? "", /detach\/move/);
    assert.equal(JSON.stringify(out).includes("/private/"), false);
  });

  it("puts the destination and repo in default status output", () => {
    assert.equal(
      formatStatusBlocker(blockedReport().skipped, Date.UTC(2026, 6, 16)),
      "2 sessions — Acme Dev Fortress offline since Jul 7 · acme/example-repo",
    );
  });

  it("renders a detailed recovery command without local paths", () => {
    const report = buildSyncDoctorReport(
      blockedReport(),
      "https://beta.let.ai/_api/hx-gateway",
      Date.UTC(2026, 6, 16),
    );
    const text = formatSyncDoctorText(report);
    assert.match(text, /Repo: acme\/example-repo/);
    assert.match(text, /hx retry --blocked/);
    assert.doesNotMatch(text, /\/private\//);
  });

  it("reports a fully caught-up client as healthy", () => {
    const out = buildSyncDoctorReport(
      {
        snapshot: { total: 12, done: 12, totalBytes: 50 },
        behind: [],
        skipped: [],
        unwatched: 0,
  excluded: [],
  undiscovered: { fileGone: 0, onDiskButUndiscovered: 0 },
  childLanes: { tracked: 0, onDisk: 0, gone: 0, owing: 0, owedBytes: 0, held: 0, heldReasons: {} },
        ledger: noLedger(),
      },
      "https://beta.let.ai/_api/hx-gateway",
      0,
    );
    assert.equal(out.ok, true);
    assert.match(formatSyncDoctorText(out), /healthy — 100% uploaded/);
  });
});

// A dead destination key is excluded from the percentage, so the ONE thing it
// must never be is silent — that combination is how a device carried 43 of
// them across two gateway migrations while reporting a clean bill of health.
describe("dead destination keys in the detailed report", () => {
  const withStranded = (): SyncReport => {
    const state: HxState = {
      files: {
        "/a.jsonl": {
          path: "/a.jsonl",
          family: "claude-desktop",
          sessionId: "sess-a",
          offsets: { letai: 1000, "org-phantom": 0 },
          lastMtimeMs: 0,
          lastUploadAtMs: 0,
        },
      },
      destinations: {
        letai: { vaultOrgId: null, status: "ready", orgName: null, orgSlug: null, lastSeenAt: null, observedAtMs: 0 },
      },
    };
    return {
      snapshot: { total: 1, done: 1, totalBytes: 1000 },
      behind: [],
      unwatched: 0,
      excluded: [],
      undiscovered: { fileGone: 0, onDiskButUndiscovered: 0 },
      childLanes: { tracked: 0, onDisk: 0, gone: 0, owing: 0, owedBytes: 0, held: 0, heldReasons: {} },
      skipped: [],
      ledger: buildLedger({
        files: [{ path: "/a.jsonl", size: 1000, mtimeMs: 0 }],
        state,
        incompleteSessions: 0,
        nowMs: 30 * 24 * 60 * 60 * 1000,
      }),
    };
  };

  it("names the dead key even though the session counts as delivered", () => {
    const text = formatSyncDoctorText(buildSyncDoctorReport(withStranded(), "https://let.ai/_api/hx-gateway", 0));
    assert.match(text, /DEAD DESTINATION KEYS/);
    assert.match(text, /org-phantom/);
  });

  it("says plainly that the debt is not counted", () => {
    const text = formatSyncDoctorText(buildSyncDoctorReport(withStranded(), "https://let.ai/_api/hx-gateway", 0));
    assert.match(text, /NOT counted/);
  });

  it("keeps the session out of the owing list entirely", () => {
    const r = withStranded();
    assert.equal(r.ledger.delivered, 1);
    assert.equal(r.ledger.percent, 100);
    assert.equal(r.ledger.notDelivered.length, 0);
  });
});

// A child lane's hold is stamped into state.json, but collectSkipped cannot see
// it: discovery walks projects/<slug>/*.jsonl and never the <sessionId>/
// subagents/ tree. A device whose every lane was quarantined therefore printed
// a clean report while nothing uploaded — the failure this whole change set
// exists to end.
describe("held child lanes are reported", () => {
  const withHeldLanes = (): SyncReport => ({
    snapshot: { total: 1, done: 1, totalBytes: 10 },
    behind: [],
    unwatched: 0,
    excluded: [],
    undiscovered: { fileGone: 0, onDiskButUndiscovered: 0 },
    childLanes: {
      tracked: 81,
      onDisk: 81,
      gone: 0,
      owing: 81,
      owedBytes: 1024,
      held: 81,
      heldReasons: { quarantine: 81 },
    },
    skipped: [],
    ledger: noLedger(),
  });

  it("names the count and the reason", () => {
    const text = formatSyncDoctorText(
      buildSyncDoctorReport(withHeldLanes(), "https://let.ai/_api/hx-gateway", 0),
    );
    assert.match(text, /81 of them are HELD/);
    assert.match(text, /81 quarantine/);
  });

  it("does not report a hold on a lane whose file is gone", () => {
    // Nothing removes entries from state.files and clearGenericBackoffs
    // preserves skipReason, so counting pruned lanes printed "81 HELD, release
    // with hx retry --blocked" forever — and opened the retry gate, which stops
    // the daemon and rewrites state to clear flags on files that do not exist.
    const r = withHeldLanes();
    r.childLanes = { ...r.childLanes, onDisk: 0, gone: 81, owing: 0, held: 0, heldReasons: {} };
    const text = formatSyncDoctorText(
      buildSyncDoctorReport(r, "https://let.ai/_api/hx-gateway", 0),
    );
    assert.doesNotMatch(text, /are HELD/);
    assert.doesNotMatch(text, /hx retry --blocked/);
  });

  it("never claims 'all delivered' while lanes are held", () => {
    // childLanes.owing is computed from the file on disk; a held lane can be
    // fully uploaded and still carry a stale skipReason, so owing can be 0 with
    // held > 0. The report printed "all delivered" directly above "706 of them
    // are HELD" for exactly that shape.
    const r = withHeldLanes();
    r.childLanes = { ...r.childLanes, owing: 0, owedBytes: 0 };
    const text = formatSyncDoctorText(
      buildSyncDoctorReport(r, "https://let.ai/_api/hx-gateway", 0),
    );
    assert.doesNotMatch(text, /all delivered/);
    assert.match(text, /81 held/);
    assert.match(text, /are HELD/);
  });

  it("says how to release them", () => {
    const text = formatSyncDoctorText(
      buildSyncDoctorReport(withHeldLanes(), "https://let.ai/_api/hx-gateway", 0),
    );
    assert.match(text, /hx retry --blocked/);
  });
});

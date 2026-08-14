import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  buildSyncDoctorReport,
  formatStatusBlocker,
  formatSyncDoctorText,
} from "./diagnostics.js";
import type { SyncReport } from "./watch.js";
import { buildLedger } from "./ledger.js";

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
  childLanes: { tracked: 0, onDisk: 0, gone: 0, owing: 0, owedBytes: 0 },
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
  childLanes: { tracked: 0, onDisk: 0, gone: 0, owing: 0, owedBytes: 0 },
        ledger: noLedger(),
      },
      "https://beta.let.ai/_api/hx-gateway",
      0,
    );
    assert.equal(out.ok, true);
    assert.match(formatSyncDoctorText(out), /healthy — 100% uploaded/);
  });
});

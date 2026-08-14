import { describe, it, beforeAll } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listTaskSessionIds, readTaskSet, readTeamConfigs } from "./artifacts.js";

let tasksA: string;
let tasksB: string;
let teamsA: string;
let teamsB: string;

const SID = "aaaa0000-1111-2222-3333-444444444444";
const ONLY_B = "bbbb0000-1111-2222-3333-444444444444";

function put(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "hx-artifacts-"));
  tasksA = join(base, "rootA", "tasks");
  tasksB = join(base, "rootB", "tasks");
  teamsA = join(base, "rootA", "teams");
  teamsB = join(base, "rootB", "teams");

  put(join(tasksA, SID, "1.json"), JSON.stringify({ id: "1", subject: "from A", status: "pending" }));
  put(join(tasksB, SID, "1.json"), JSON.stringify({ id: "1", subject: "from B", status: "pending" }));
  put(join(tasksB, ONLY_B, "1.json"), JSON.stringify({ id: "1", subject: "only B", status: "pending" }));

  // Same team name under both roots: B's config is NEWER and must win.
  put(join(teamsA, "alpha", "config.json"), JSON.stringify({ v: "old" }));
  put(join(teamsB, "alpha", "config.json"), JSON.stringify({ v: "new" }));
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(teamsA, "alpha", "config.json"), past, past);
  put(join(teamsA, "beta", "config.json"), JSON.stringify({ v: "beta" }));
});

describe("readTaskSet across roots", () => {
  it("probes tasks dirs in root order — first existing dir wins", async () => {
    const tasks = await readTaskSet(SID, [tasksA, tasksB]);
    assert.equal(tasks?.[0]?.subject, "from A");
    const flipped = await readTaskSet(SID, [tasksB, tasksA]);
    assert.equal(flipped?.[0]?.subject, "from B");
  });

  it("falls through to a later root when the first has no dir", async () => {
    const tasks = await readTaskSet(ONLY_B, [tasksA, tasksB]);
    assert.equal(tasks?.[0]?.subject, "only B");
  });

  it("returns null when no root has a tasks dir for the session", async () => {
    assert.equal(await readTaskSet("cccc0000-9999-8888-7777-666666666666", [tasksA, tasksB]), null);
  });
});

describe("listTaskSessionIds across roots", () => {
  it("unions and dedupes ids over every root", async () => {
    const ids = await listTaskSessionIds([tasksA, tasksB]);
    assert.deepEqual([...ids].sort(), [SID, ONLY_B].sort());
  });

  it("ignores missing tasks dirs", async () => {
    assert.deepEqual(await listTaskSessionIds([join(tasksA, "nope")]), []);
  });
});

describe("readTeamConfigs across roots", () => {
  it("unions teams, keeps the newest config per name, sorts by name", async () => {
    const teams = await readTeamConfigs([teamsA, teamsB]);
    assert.deepEqual(
      teams.map((t) => [t.name, (t.config as { v: string }).v]),
      [
        ["alpha", "new"], // B's newer config shadowed A's older one
        ["beta", "beta"],
      ],
    );
  });
});

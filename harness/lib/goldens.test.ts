import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRun } from "./compare.js";
import { goldenText } from "./goldens.js";
import type { RunMeta } from "./types.js";

describe("goldenText", () => {
  it("renders JSON stdout through the JSON normalizer, so epoch numbers and project-dir names do not pin a golden to one run", () => {
    const dir = mkdtempSync(join(tmpdir(), "hx-harness-goldens-"));
    try {
      const home = join(dir, "home");
      const started = Date.UTC(2026, 9, 15, 19, 0, 0);
      const meta: RunMeta = {
        scenario: "baseline",
        binary: "hx",
        name: "hx",
        version: "77.11.0",
        platform: "linux",
        arch: "x64",
        home,
        workDir: dir,
        gatewayUrl: "http://127.0.0.1:48621",
        fortressUrl: null,
        startedAtMs: started,
        endedAtMs: started + 60_000,
        steps: [{ index: 3, name: "doctor-json", kind: "run", seqFrom: 0, seqTo: 0, fortressSeqFrom: 0, fortressSeqTo: 0, startedAtMs: started, endedAtMs: started + 1_000, exitCode: 1 }],
        failures: [],
      };
      mkdirSync(join(dir, "steps"), { recursive: true });
      writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
      const slug = `${home}/work/acme-repo`.replace(/[/\\.]/g, "-");
      const stdout = {
        generatedAt: new Date(started + 5_000).toISOString(),
        ledger: { oldestMs: started - 40 * 24 * 3600 * 1000, newestMs: started - 3_600_000, totalBytes: 79113490 },
        notDelivered: [{ path: `${home}/.claude/projects/${slug}/58621588-9b3b-4c8f-a579-4c0de0e2ea97.jsonl`, offset: 67108864 }],
      };
      writeFileSync(join(dir, "steps", "03-doctor-json.stdout"), `${JSON.stringify(stdout, null, 2)}\n`);
      writeFileSync(join(dir, "steps", "03-doctor-json.stderr"), "");

      const text = goldenText(loadRun(dir), "doctor-json", "hx", ["77.11.0"]);
      expect(text).not.toBeNull();
      expect(text).toContain("exit 1");
      expect(text).toContain('"oldestMs": "<t>"');
      expect(text).toContain('"newestMs": "<t>"');
      expect(text).toContain('"generatedAt": "<t>"');
      expect(text).toContain('"path": "<HOME>/.claude/projects/<HOME>-work-acme-repo/58621588-9b3b-4c8f-a579-4c0de0e2ea97.jsonl"');
      expect(text).toContain('"offset": 67108864');
      expect(text).not.toMatch(/\b1[0-9]{12}\b/);
      expect(text).not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a step the run did not record", () => {
    const dir = mkdtempSync(join(tmpdir(), "hx-harness-goldens-"));
    try {
      const meta = { scenario: "baseline", steps: [], home: dir, workDir: dir, gatewayUrl: "http://127.0.0.1:1", fortressUrl: null, startedAtMs: 0, version: "0", name: "hx" };
      writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
      expect(goldenText(loadRun(dir), "status1", "hx", ["0"])).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

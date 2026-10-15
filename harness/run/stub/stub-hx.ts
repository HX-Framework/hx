// A stand-in for the hx binary, for the driver's own unit test: prints a
// version, talks to the gateway the driver names in HX_HARNESS_GATEWAY_URL
// the way hx does for one session (hx itself reads the gateway from
// ~/.let/hx/config.json; the stub takes it from the environment so no file
// contents flow into a request), and writes a state file.
// STUB_VARIANT=broken makes it store one byte less, so the comparators have
// something to catch.
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cmd = process.argv[2];
const hxDir = join(homedir(), ".let", "hx");
const say = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
if (cmd === "--version") {
  say("hx version: 0.0.1");
  process.exit(0);
}
const cfg = { gatewayBaseUrl: process.env.HX_HARNESS_GATEWAY_URL ?? "", accessToken: process.env.HX_HARNESS_ACCESS_TOKEN ?? "" };
if (!cfg.gatewayBaseUrl) {
  say("Not connected. Run `hx connect` first.");
  process.exit(2);
}
const auth = { authorization: `Bearer ${cfg.accessToken}`, "content-type": "application/json" };
if (cmd === "status") {
  const who = await fetch(`${cfg.gatewayBaseUrl}/whoami`, { headers: auth });
  say(`Logged in as: ${((await who.json()) as { email: string }).email}`);
  say(`Gateway: ${cfg.gatewayBaseUrl}`);
  say(`Checked at ${new Date().toISOString()}`);
  process.exit(0);
}
if (cmd === "watch") {
  const text = process.env.STUB_VARIANT === "broken" ? "line1\nline" : "line1\nline2\n";
  const append = (await (
    await fetch(`${cfg.gatewayBaseUrl}/sessions/append-url`, { method: "POST", headers: auth, body: JSON.stringify({ family: "claude-cli", sessionId: "stub-session", byteCount: text.length }) })
  ).json()) as { chunkId: string; uploadUrl: string };
  await fetch(append.uploadUrl, { method: "PUT", headers: { "content-type": "application/x-ndjson" }, body: text });
  await fetch(`${cfg.gatewayBaseUrl}/sessions/commit`, { method: "POST", headers: auth, body: JSON.stringify({ family: "claude-cli", sessionId: "stub-session", chunkId: append.chunkId, replace: true, vaultOrgId: null }) });
  await fetch(`${cfg.gatewayBaseUrl}/devices/heartbeat`, { method: "POST", headers: auth, body: "{}" });
  mkdirSync(hxDir, { recursive: true });
  writeFileSync(join(hxDir, "state.json"), JSON.stringify({ files: { "/x/stub.jsonl": { offsets: { letai: text.length }, lastUploadAtMs: Date.now() } } }));
  say(`  stub.jsonl (+${text.length}B → let.ai)`);
  say("[hx] tick uploaded=1 failed=0");
  process.exit(0);
}
say(`unknown command: ${cmd}`);
process.exit(64);

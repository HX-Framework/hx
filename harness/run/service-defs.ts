// The TypeScript client's service definitions, rendered for a fixed binary
// path, so hx2's test suite can check that its own renderings are
// byte-identical (hx2/src/service.rs, `definitions_match_the_typescript_client`).
// The service slot (`ai.let.hx-vision`) is shared by hx and hx2, so the
// files must differ in nothing but the binary's path.
//
//   bun harness/run/service-defs.ts --out <dir>
//
// HOME decides the log and state paths inside the definitions (src/hx-home.ts
// reads it when the module loads); hx2's tests run under the same HOME.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const i = process.argv.indexOf("--out");
const out = i >= 0 ? process.argv[i + 1] : undefined;
if (!out) {
  console.error("usage: bun harness/run/service-defs.ts --out <dir>");
  process.exit(64);
}

const { renderBootstrap, renderPlist, renderSystemdUnit, renderTaskXml } = await import("../../src/daemon.js");

const BIN = "/home/me/.let/bin/hx2";
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "plist"), renderPlist(BIN));
writeFileSync(join(out, "unit"), renderSystemdUnit(BIN));
writeFileSync(join(out, "bootstrap"), renderBootstrap(BIN));
writeFileSync(join(out, "task"), renderTaskXml("C:\\Users\\me\\.let\\bin\\hx2-svc.exe", "CORP\\me"));
console.log(`service definitions rendered into ${out} for ${BIN}`);

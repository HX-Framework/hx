// Friendly names for vault org ids, gleaned from gateway responses that carry
// them (held-destination blockers today; ready destinations once the gateway
// serves names there too). The daemon remembers every name it sees so the UI
// can label destinations even after the vault recovers. Best-effort cache —
// errors never affect uploads.

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HX_DIR } from "./hx-home.js";
import type { SyncBlockerDestination } from "./state.js";

export const ORG_NAMES_PATH = join(HX_DIR, "org-names.json");

export async function readOrgNames(path: string = ORG_NAMES_PATH): Promise<Record<string, string>> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed
    // path under ~/.let/hx (tests inject a tmp path), never request input.
    const parsed = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.trim()) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export async function rememberOrgNames(
  dests: Pick<SyncBlockerDestination, "vaultOrgId" | "orgName">[],
  path: string = ORG_NAMES_PATH,
): Promise<void> {
  try {
    const withNames = dests.filter((d) => d.orgName);
    if (withNames.length === 0) return;
    const current = await readOrgNames(path);
    let changed = false;
    for (const d of withNames) {
      if (current[d.vaultOrgId] !== d.orgName) {
        current[d.vaultOrgId] = d.orgName as string;
        changed = true;
      }
    }
    if (!changed) return;
    const tmp = `${path}.tmp`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see readOrgNames.
    await writeFile(tmp, JSON.stringify(current, null, 2), { mode: 0o600 });
    await rename(tmp, path);
  } catch {
    // best-effort
  }
}

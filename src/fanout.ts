import type { AppendUrlResponse } from "./uploader.js";
import { offsetFor, type FileState } from "./state.js";

/** One concrete upload to perform this pass: which store, the signed chunk to
 *  PUT, and whether this is a from-zero (replace) write for that store. */
export interface UploadStep {
  vaultOrgId: string | null;
  chunkId: string;
  uploadUrl: string;
  replace: boolean;
}

/**
 * Turn an append-url response into the set of uploads to run. A gateway that
 * predates fan-out (no `destinations`) yields a single legacy step. Otherwise we
 * emit one step per READY destination — held (offline-vault) destinations are
 * skipped this pass and retried next tick. `replace` is decided per destination
 * from that store's own offset, so a late-joining vault back-fills from zero
 * while the others append.
 */
export function planFanout(append: AppendUrlResponse, fState: FileState): UploadStep[] {
  if (!append.destinations) {
    const vaultOrgId = append.vaultOrgId ?? null;
    return [
      {
        vaultOrgId,
        chunkId: append.chunkId,
        uploadUrl: append.uploadUrl,
        replace: offsetFor(fState, vaultOrgId) === 0,
      },
    ];
  }
  const steps: UploadStep[] = [];
  for (const d of append.destinations) {
    if (d.status !== "ready") continue;
    steps.push({
      vaultOrgId: d.vaultOrgId,
      chunkId: d.chunkId,
      uploadUrl: d.uploadUrl,
      replace: offsetFor(fState, d.vaultOrgId) === 0,
    });
  }
  return steps;
}

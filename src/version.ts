// The one source of truth for "which build of hx is this" is the package
// version (semver X.Y.Z). `hx version` prints it as "hx version: <X.Y.Z>".
//
// Bumping: edit the `version` field in package.json (stable semver X.Y.Z).
import packageJson from "../package.json";

export interface StableSemver {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export const HX_VERSION: string = packageJson.version;

export function parseStableSemver(version: string): StableSemver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
    raw: version.trim(),
  };
}

export function compareStableSemver(a: StableSemver, b: StableSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

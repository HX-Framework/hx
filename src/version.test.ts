import { test, expect } from "bun:test";
import { HX_VERSION, parseStableSemver, compareStableSemver } from "./version.js";

test("HX_VERSION is a valid stable semver", () => {
  expect(parseStableSemver(HX_VERSION)).not.toBeNull();
});

test("parseStableSemver rejects non-semver", () => {
  expect(parseStableSemver("75")).toBeNull();
  expect(parseStableSemver("v1.2.3")).toBeNull();
});

test("compareStableSemver orders by major, minor, patch", () => {
  const a = parseStableSemver("76.0.0")!;
  const b = parseStableSemver("76.0.1")!;
  expect(compareStableSemver(b, a)).toBeGreaterThan(0);
});

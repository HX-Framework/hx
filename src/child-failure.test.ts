// Child agent lanes are the ONLY population a routing quarantine can affect: a
// lane is quarantined precisely when its parent row is missing. The quarantine
// classification originally lived only on the PARENT path
// (classifyUpstreamError), which child lanes never call — so every real
// quarantine fell through to a generic backoff with no skipReason. That is
// invisible by construction: collectSkipped gates on skipReason, so `hx status`
// showed nothing, `hx retry --blocked` could not release it, and
// clearGenericBackoffs wiped the streak on every restart. One device paid
// 798,704 silent retries for it.
//
// These tests pin the ORDER of the decision, which is what was actually wrong.
import { describe, expect, it } from "bun:test";
import { HxHttpError } from "./uploader.js";
import { classifyChildFailure } from "./watch.js";

const q = (): HxHttpError =>
  new HxHttpError(409, 'agent-append-url failed: 409 {"error":"quarantine"}');

describe("classifyChildFailure", () => {
  it("holds a 409 quarantine, with a reason that can be reported and released", () => {
    const a = classifyChildFailure(q());
    expect(a.kind).toBe("hold");
    expect(a.kind === "hold" && a.reason).toBe("quarantine");
  });

  it("does NOT fall through to the silent generic backoff", () => {
    // The whole defect in one assertion.
    expect(classifyChildFailure(q()).kind).not.toBe("backoff");
  });

  it("still treats a 410 session_deleted as terminal, ahead of everything", () => {
    const err = new HxHttpError(410, 'commit failed: 410 {"error":"session_deleted"}');
    expect(classifyChildFailure(err).kind).toBe("session-deleted");
  });

  it("still holds a 503 vault_offline and keeps its blocker", () => {
    const err = new HxHttpError(503, 'agent-append-url failed: 503 {"error":"vault_offline"}');
    const a = classifyChildFailure(err);
    expect(a.kind).toBe("hold");
    expect(a.kind === "hold" && a.reason).toBe("vault_offline");
  });

  it("still stops the whole child pass on a gateway-wide 5xx", () => {
    expect(classifyChildFailure(new HxHttpError(503, "boom")).kind).toBe("stop");
  });

  it("still stops on a 429", () => {
    expect(classifyChildFailure(new HxHttpError(429, "slow down")).kind).toBe("stop");
  });

  it("leaves an ordinary per-file fault on the generic backoff", () => {
    expect(classifyChildFailure(new HxHttpError(400, "bad request")).kind).toBe("backoff");
  });

  it("does not read a bare 409 as a quarantine", () => {
    expect(classifyChildFailure(new HxHttpError(409, "conflict")).kind).toBe("backoff");
  });

  it("treats a non-HTTP throw as an ordinary fault", () => {
    expect(classifyChildFailure(new Error("ECONNRESET")).kind).toBe("backoff");
  });
});

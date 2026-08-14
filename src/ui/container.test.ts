import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { containerAccessNote, containerFromSignals } from "./container.js";

describe("containerFromSignals", () => {
  const none = { dockerenv: false, containerenv: false, cgroup: null };

  it("detects Docker via /.dockerenv and Podman via /run/.containerenv", () => {
    assert.equal(containerFromSignals({ ...none, dockerenv: true }), true);
    assert.equal(containerFromSignals({ ...none, containerenv: true }), true);
  });

  it("detects known runtimes named in /proc/1/cgroup", () => {
    for (const marker of [
      "0::/docker/abc123",
      "12:cpuset:/kubepods/burstable/pod123",
      "0::/system.slice/containerd.service",
      "1:name=systemd:/lxc/webapp",
      "0::/machine.slice/libpod-deadbeef.scope",
    ]) {
      assert.equal(containerFromSignals({ ...none, cgroup: marker }), true, marker);
    }
  });

  it("returns false on a bare host with no container signals", () => {
    assert.equal(containerFromSignals(none), false);
    // A normal desktop/session cgroup line must not read as a container.
    assert.equal(
      containerFromSignals({ ...none, cgroup: "0::/user.slice/user-1000.slice/session-3.scope" }),
      false,
    );
  });
});

describe("containerAccessNote", () => {
  it("tells the user to open on the host and how to publish the exact port", () => {
    const lines = containerAccessNote(8000).join("\n");
    assert.match(lines, /HOST machine's browser/);
    assert.match(lines, /-p 8000:8000/); // the concrete fix, with hx's real port
    assert.match(lines, /running container can't have -p added/); // must recreate
  });

  it("reflects a non-default port after fallback", () => {
    assert.match(containerAccessNote(8003).join("\n"), /-p 8003:8003/);
  });
});

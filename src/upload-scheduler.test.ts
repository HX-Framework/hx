// Scheduler primitives (LETAIR-144 WS3): pool ordering/stop semantics and the
// byte semaphore's admission discipline.

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { ByteSemaphore, runPool } from "./upload-scheduler.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

describe("runPool", () => {
  it("bounds concurrency and processes every item", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await runPool([...Array(20).keys()], 4, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      seen.push(n);
      inFlight -= 1;
    });
    assert.equal(seen.length, 20);
    assert.ok(peak <= 4, `peak in-flight ${peak}`);
    assert.ok(peak >= 2, "actually ran concurrently");
  });

  it("dequeues in list order", async () => {
    const started: number[] = [];
    await runPool([...Array(10).keys()], 3, async (n) => {
      started.push(n);
      await tick();
    });
    assert.deepEqual(started, [...Array(10).keys()], "workers pull items in order");
  });

  it("stop() halts dequeueing while in-flight items settle (M4 bound)", async () => {
    let stopped = false;
    const started: number[] = [];
    const finished: number[] = [];
    await runPool(
      [...Array(12).keys()],
      4,
      async (n) => {
        started.push(n);
        await tick();
        if (n === 1) stopped = true; // latch mid-pass
        finished.push(n);
      },
      () => stopped,
    );
    assert.ok(started.length <= 4 + 1, `started ${started.length} — at most in-flight + the latcher`);
    assert.deepEqual([...finished].sort((a, b) => a - b), [...started].sort((a, b) => a - b), "in-flight settled");
  });

  it("a sequential pool (limit 1) is exactly the historical loop", async () => {
    const order: string[] = [];
    await runPool(["a", "b", "c"], 1, async (s) => {
      order.push(`start-${s}`);
      await tick();
      order.push(`end-${s}`);
    });
    assert.deepEqual(order, ["start-a", "end-a", "start-b", "end-b", "start-c", "end-c"]);
  });
});

describe("ByteSemaphore", () => {
  it("admits within the cap and blocks over it, FIFO", async () => {
    const sem = new ByteSemaphore(10);
    const r1 = await sem.acquire(6);
    const events: string[] = [];
    const p2 = sem.acquire(6).then((r) => {
      events.push("second");
      return r;
    });
    const p3 = sem.acquire(2).then((r) => {
      events.push("third");
      return r;
    });
    await tick();
    assert.deepEqual(events, [], "both queued behind the FIFO head");
    r1();
    const r2 = await p2;
    await tick();
    assert.deepEqual(events, ["second", "third"], "FIFO order; small late chunk never jumped the queue");
    assert.equal(sem.inUse(), 8);
    r2();
    (await p3)();
    assert.equal(sem.inUse(), 0);
  });

  it("never over-admits when one release frees room for multiple waiters", async () => {
    const sem = new ByteSemaphore(10);
    const rBig = await sem.acquire(10);
    const grants: Array<() => void> = [];
    const pA = sem.acquire(3).then((r) => grants.push(r));
    const pB = sem.acquire(3).then((r) => grants.push(r));
    const pC = sem.acquire(3).then((r) => grants.push(r));
    rBig();
    await Promise.all([pA, pB, pC]);
    assert.equal(sem.inUse(), 9, "all three admitted, charged exactly once each");
    assert.ok(sem.inUse() <= 10, "cap held at every admission");
    for (const g of grants) g();
    assert.equal(sem.inUse(), 0);
  });

  it("clamps an oversized request instead of deadlocking", async () => {
    const sem = new ByteSemaphore(8);
    const r = await sem.acquire(64);
    assert.equal(sem.inUse(), 8);
    r();
    assert.equal(sem.inUse(), 0);
  });

  it("release is idempotent", async () => {
    const sem = new ByteSemaphore(8);
    const r = await sem.acquire(4);
    r();
    r();
    assert.equal(sem.inUse(), 0);
  });
});

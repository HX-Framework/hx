// Upload scheduling primitives (LETAIR-144 WS3).
//
// The pass loop stays exactly as expressive as the sequential for-loop it
// replaces: workers dequeue from the SAME ordered list, every per-file gate
// runs at dequeue inside the worker, and a shared stop flag lets pass-level
// latches (the 2-distinct-file 5xx rule, the child-lane 404/401 latch) stop
// DEQUEUEING while already-launched work settles — the declared M4 bound of
// ≤ concurrency−1 extra in-flight items.
//
// The byte semaphore caps CONCURRENT CHUNK BUFFER MEMORY process-wide (both
// tee lanes share it — M8's RSS bound). It is not a throughput budget: the
// per-(file, destination) drain budget lives in the ingest loop.

/** Run `worker` over `items` with at most `limit` in flight. Returns a stop
 *  handle: after stop(), no NEW item is dequeued; in-flight workers settle.
 *  Worker errors are the worker's own business (the ingest loop catches per
 *  file, exactly as the sequential loop did) — a throw here is a bug, so it
 *  propagates. */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  isStopped?: () => boolean,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      if (isStopped?.()) return;
      const i = next;
      next += 1;
      await worker(items[i]!, i);
    }
  });
  await Promise.all(lanes);
}

/** FIFO byte semaphore: acquire(n) resolves when n bytes fit under the cap;
 *  the returned release() gives them back. n larger than the cap is clamped
 *  (a single oversized chunk must not deadlock — it just runs alone). Bytes
 *  are CHARGED AT ADMISSION (fast path, or inside drain when a waiter is
 *  admitted) — charging after the waiter's await resolves would let two
 *  waiters both pass the same headroom check and overshoot the cap. */
export class ByteSemaphore {
  private used = 0;
  private waiters: Array<{ n: number; resolve: () => void }> = [];

  constructor(private readonly capBytes: number) {}

  async acquire(nRaw: number): Promise<() => void> {
    const n = Math.min(nRaw, this.capBytes);
    // FIFO-strict: the fast path only applies when nobody is queued, so a
    // small late chunk can never starve a large early one.
    if (this.waiters.length === 0 && this.used + n <= this.capBytes) {
      this.used += n;
    } else {
      await new Promise<void>((resolve) => this.waiters.push({ n, resolve }));
      // drain() charged us at admission.
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= n;
      this.drain();
    };
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.used + this.waiters[0]!.n <= this.capBytes) {
      const w = this.waiters.shift()!;
      this.used += w.n; // admission = charge, atomically within this sync loop
      w.resolve();
    }
  }

  /** Test seam. */
  inUse(): number {
    return this.used;
  }
}

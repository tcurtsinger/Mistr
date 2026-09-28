/** Two-credit transfer pipeline. Downloads/parsing overlap the preceding upload,
 * but GPU writes and publication remain ordered. Every acquired lease is released,
 * including speculative responses arriving after cancellation or an upload failure. */
export async function consumePipelinedLeases<Item, Lease extends { release(): Promise<void> }>(
  items: readonly Item[],
  request: (item: Item) => Promise<Lease>,
  consume: (lease: Lease) => Promise<void>,
): Promise<void> {
  type Outcome = { ok: true; lease: Lease } | { ok: false; error: unknown };
  const pending: Promise<Outcome>[] = [];
  let next = 0;
  const enqueue = () => {
    if (next >= items.length) return;
    const item = items[next++];
    // Attach rejection handling immediately, not when the previous upload finishes.
    pending.push(Promise.resolve().then(() => request(item)).then(
      lease => ({ ok: true as const, lease }),
      error => ({ ok: false as const, error }),
    ));
  };
  enqueue();
  enqueue();
  let failed = false;
  try {
    while (pending.length > 0) {
      const outcome = await pending.shift()!;
      if (!outcome.ok) throw outcome.error;
      try {
        await consume(outcome.lease);
      } finally {
        await outcome.lease.release();
      }
      enqueue(); // only after acknowledgment returns the credit
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const drained = await Promise.allSettled(pending.map(async result => {
      const outcome = await result;
      if (outcome.ok) await outcome.lease.release();
    }));
    if (!failed) {
      const rejection = drained.find(result => result.status === "rejected");
      if (rejection?.status === "rejected") throw rejection.reason;
    }
  }
}

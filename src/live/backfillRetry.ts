/** Retry one predecessor without advancing its cursor or disturbing painted history. */
export async function retryBackfillStep(
  acquire: () => Promise<unknown>,
  isCurrent: () => boolean,
  wait: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3 && isCurrent(); attempt++) {
    try {
      await acquire();
      return isCurrent();
    } catch {
      if (!isCurrent() || attempt === 2) return false;
      await wait(500 * 2 ** attempt);
    }
  }
  return false;
}

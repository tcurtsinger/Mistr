import { describe, expect, it, vi } from "vitest";
import { finalizeNationalHistoryUntilSettled } from "./NationalFinalizeLoop";

describe("finalizeNationalHistoryUntilSettled", () => {
  it("keeps sealing beyond three failures until the journal resolves", async () => {
    const finalized = { mutationReversible: false };
    const finalize = vi
      .fn<() => Promise<typeof finalized>>()
      .mockRejectedValueOnce(new Error("IPC unavailable 1"))
      .mockRejectedValueOnce(new Error("IPC unavailable 2"))
      .mockRejectedValueOnce(new Error("IPC unavailable 3"))
      .mockResolvedValueOnce(finalized);
    const retries: number[] = [];

    const result = await finalizeNationalHistoryUntilSettled({
      shouldContinue: () => true,
      finalize,
      recoverFinalized: async () => null,
      isTerminal: () => false,
      onFailure: (_error, attempt) => retries.push(attempt),
      waitBeforeRetry: async () => {},
      cancellationError: () => new Error("cancelled"),
    });

    expect(result).toBe(finalized);
    expect(finalize).toHaveBeenCalledTimes(4);
    expect(retries).toEqual([1, 2, 3]);
  });

  it("accepts a sealed snapshot after the finalize response is lost", async () => {
    const finalized = { mutationReversible: false };
    const waitBeforeRetry = vi.fn<() => Promise<void>>();

    const result = await finalizeNationalHistoryUntilSettled({
      shouldContinue: () => true,
      finalize: async () => {
        throw new Error("finalize response lost");
      },
      recoverFinalized: async () => finalized,
      isTerminal: () => false,
      onFailure: () => {},
      waitBeforeRetry,
      cancellationError: () => new Error("cancelled"),
    });

    expect(result).toBe(finalized);
    expect(waitBeforeRetry).not.toHaveBeenCalled();
  });

  it("stops only when the backend proves the transaction was superseded", async () => {
    const terminal = new Error("generation reset removed the journal");
    const waitBeforeRetry = vi.fn<() => Promise<void>>();

    await expect(finalizeNationalHistoryUntilSettled({
      shouldContinue: () => true,
      finalize: async () => {
        throw terminal;
      },
      recoverFinalized: async () => null,
      isTerminal: (error) => error === terminal,
      onFailure: () => {},
      waitBeforeRetry,
      cancellationError: () => new Error("cancelled"),
    })).rejects.toBe(terminal);
    expect(waitBeforeRetry).not.toHaveBeenCalled();
  });
});

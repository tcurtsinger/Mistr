import { describe, expect, it, vi } from "vitest";
import type {
  NationalHistoryObservation,
  NationalHistorySnapshot,
} from "../packed-sweep/transferClient";
import {
  rollbackNationalHistoryUntilSettled,
  snapshotProvesNationalHistoryRollback,
} from "./NationalRollbackLoop";

describe("rollbackNationalHistoryUntilSettled", () => {
  it("keeps rolling back beyond three ambiguous IPC failures", async () => {
    const rolledBack = { mutationReversible: false };
    const rollback = vi
      .fn<() => Promise<typeof rolledBack>>()
      .mockRejectedValueOnce(new Error("IPC unavailable 1"))
      .mockRejectedValueOnce(new Error("IPC unavailable 2"))
      .mockRejectedValueOnce(new Error("IPC unavailable 3"))
      .mockResolvedValueOnce(rolledBack);

    const result = await rollbackNationalHistoryUntilSettled({
      shouldContinue: () => true,
      rollback,
      recoverRolledBack: async () => null,
      isTerminal: () => false,
      onFailure: () => {},
      waitBeforeRetry: async () => {},
      cancellationError: () => new Error("cancelled"),
    });

    expect(result).toBe(rolledBack);
    expect(rollback).toHaveBeenCalledTimes(4);
  });

  it("accepts an identity-matching snapshot after the rollback response is lost", async () => {
    const observation = historyObservation();
    const snapshot = rolledBackSnapshot(observation);
    const waitBeforeRetry = vi.fn<() => Promise<void>>();

    const result = await rollbackNationalHistoryUntilSettled({
      shouldContinue: () => true,
      rollback: async () => {
        throw new Error("rollback response lost");
      },
      recoverRolledBack: async () => (
        snapshotProvesNationalHistoryRollback(snapshot, observation) ? snapshot : null
      ),
      isTerminal: () => false,
      onFailure: () => {},
      waitBeforeRetry,
      cancellationError: () => new Error("cancelled"),
    });

    expect(result).toBe(snapshot);
    expect(waitBeforeRetry).not.toHaveBeenCalled();
  });

  it("does not mistake a retained or still-provisional observation for rollback", () => {
    const observation = historyObservation();
    const snapshot = rolledBackSnapshot(observation);

    expect(snapshotProvesNationalHistoryRollback(snapshot, observation)).toBe(true);
    expect(snapshotProvesNationalHistoryRollback({
      ...snapshot,
      retained: [observation],
    }, observation)).toBe(false);
    expect(snapshotProvesNationalHistoryRollback({
      ...snapshot,
      staged: observation,
      stagedBackendBytes: 1,
    }, observation)).toBe(false);
    expect(snapshotProvesNationalHistoryRollback({
      ...snapshot,
      mutationReversible: true,
    }, observation)).toBe(false);
  });
});

function historyObservation(): NationalHistoryObservation {
  return {
    generation: 9,
    objectKey: "CONUS/MergedBaseReflectivityQC_00.50/object.grib2.gz",
    observationTimeUnixMs: 1_800_000,
    contentSha256: "a".repeat(64),
    compressedBytes: 1_000,
    overviewChunkCount: 28,
    overviewGpuBytes: 3_100_000,
  };
}

function rolledBackSnapshot(
  observation: NationalHistoryObservation,
): NationalHistorySnapshot {
  return {
    generation: observation.generation,
    historyLimit: 20,
    retained: [],
    staged: null,
    mutationReversible: false,
    pendingBackfillCount: 0,
    retainedBackendBytes: 0,
    stagedBackendBytes: 0,
    detailedCacheBytes: 0,
    reversibleCommitBytes: 0,
    totalBackendBytes: 0,
    backendTargetBytes: 180 * 1024 * 1024,
  };
}

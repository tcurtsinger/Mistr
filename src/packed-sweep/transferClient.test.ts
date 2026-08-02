import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PackedSweepTransferClient,
  TransferClientError,
  type InvokeFunction,
  type TransferSnapshot,
} from "./transferClient";

const GOLDEN_PATH = new URL(
  "../../fixtures/expected/phase-2/packed-sweep-v1.bin",
  import.meta.url,
);

function goldenBuffer(): ArrayBuffer {
  return Uint8Array.from(readFileSync(GOLDEN_PATH)).buffer;
}

function snapshot(generation: number, heldCredits = 0, session = 1): TransferSnapshot {
  return {
    session,
    generation,
    active: generation !== 0,
    availableCredits: generation === 0 ? 0 : 2 - heldCredits,
    heldCredits,
    inFlightCredits: 0,
    creditLimit: 2,
  };
}

describe("PackedSweepTransferClient", () => {
  it("passes only bounded canonical inputs to the Phase 5 live command", async () => {
    const requests: Array<Record<string, unknown> | undefined> = [];
    const invoke: InvokeFunction = async <T>(command: string, arguments_?: Record<string, unknown>) => {
      if (command === "open_phase2_transfer_session") return snapshot(0) as T;
      if (command === "begin_phase2_generation") return snapshot(7) as T;
      if (command === "request_phase5_live_sweep") {
        requests.push(arguments_);
        return goldenBuffer() as T;
      }
      if (command === "release_phase2_transfer_credit") return snapshot(7) as T;
      throw new Error(`unexpected command ${command}`);
    };
    const client = new PackedSweepTransferClient(invoke);
    await client.open();
    await client.begin(7);
    const lease = await client.requestPhase5Live("KTLX", true, 120);
    expect(requests).toEqual([{
      session: 1,
      generation: 7,
      site: "KTLX",
      freshOnly: true,
      timeoutSeconds: 120,
    }]);
    await lease.release();
    const nextLease = await client.requestPhase5Live("KTLX", true, 900, {
      volumeIndex: 999,
      volumeStartedAtUnixMs: 1_800_000_000_000,
    });
    expect(requests[1]).toEqual({
      session: 1,
      generation: 7,
      site: "KTLX",
      freshOnly: true,
      timeoutSeconds: 900,
      historyCursor: {
        volumeIndex: 999,
        volumeStartedAtUnixMs: 1_800_000_000_000,
        direction: "after",
      },
    });
    await nextLease.release();
    const previousLease = await client.requestPhase5Live("KTLX", true, 120, {
      volumeIndex: 1,
      volumeStartedAtUnixMs: 1_799_999_000_000,
    }, "before");
    expect(requests[2]).toEqual({
      session: 1,
      generation: 7,
      site: "KTLX",
      freshOnly: true,
      timeoutSeconds: 120,
      historyCursor: {
        volumeIndex: 1,
        volumeStartedAtUnixMs: 1_799_999_000_000,
        direction: "before",
      },
    });
    await previousLease.release();
    await expect(client.requestPhase5Live("ktlx")).rejects.toThrow("four uppercase");
    await expect(client.requestPhase5Live("KTLX", false, 901)).rejects.toThrow("10 and 900");
    await expect(client.requestPhase5Live("KTLX", false, 120, {
      volumeIndex: 7,
      volumeStartedAtUnixMs: 1,
    })).rejects.toThrow("fresh-only mode");
    await expect(client.requestPhase5Live("KTLX", true, 120, undefined, "before"))
      .rejects.toThrow("requires a live history cursor");
    await expect(client.requestPhase5Live(
      "KTLX",
      true,
      120,
      { volumeIndex: 7, volumeStartedAtUnixMs: 1 },
      "sideways" as never,
    )).rejects.toThrow("either after or before");
  });

  it("requests the Phase 3 fixture through the same leased binary path", async () => {
    const requests: Array<Record<string, unknown> | undefined> = [];
    const invoke: InvokeFunction = async <T>(command: string, arguments_?: Record<string, unknown>) => {
      if (command === "open_phase2_transfer_session") return snapshot(0) as T;
      if (command === "begin_phase2_generation") return snapshot(7) as T;
      if (command === "request_phase3_fixture_sweep") {
        requests.push(arguments_);
        return goldenBuffer() as T;
      }
      if (command === "release_phase2_transfer_credit") return snapshot(7) as T;
      throw new Error(`unexpected command ${command}`);
    };
    const client = new PackedSweepTransferClient(invoke);
    await client.open();
    await client.begin(7);
    const lease = await client.requestPhase3Fixture();
    expect(requests).toEqual([{ session: 1, generation: 7 }]);
    await lease.release();
  });

  it("passes only a pinned fixture slug to the Phase 4 binary command", async () => {
    const requests: Array<Record<string, unknown> | undefined> = [];
    const invoke: InvokeFunction = async <T>(command: string, arguments_?: Record<string, unknown>) => {
      if (command === "open_phase2_transfer_session") return snapshot(0) as T;
      if (command === "begin_phase2_generation") return snapshot(7) as T;
      if (command === "request_phase4_fixture_sweep") {
        requests.push(arguments_);
        return goldenBuffer() as T;
      }
      if (command === "release_phase2_transfer_credit") return snapshot(7) as T;
      throw new Error(`unexpected command ${command}`);
    };
    const client = new PackedSweepTransferClient(invoke);
    await client.open();
    await client.begin(7);
    const lease = await client.requestPhase4Fixture("ktlx-2024-05-20-230512-v06");
    expect(requests).toEqual([{
      session: 1,
      generation: 7,
      fixtureId: "ktlx-2024-05-20-230512-v06",
    }]);
    await lease.release();
    await expect(client.requestPhase4Fixture("../private-file"))
      .rejects.toThrow("lowercase slug");
  });

  it("holds a backend credit until the caller releases the parsed sweep", async () => {
    const calls: string[] = [];
    const releasedGenerations: number[] = [];
    const invoke: InvokeFunction = async <T>(command: string, arguments_?: Record<string, unknown>) => {
      calls.push(command);
      if (command === "open_phase2_transfer_session") return snapshot(0) as T;
      if (command === "begin_phase2_generation") {
        return snapshot(arguments_?.generation as number) as T;
      }
      if (command === "request_phase2_benchmark_sweep") return goldenBuffer() as T;
      if (command === "release_phase2_transfer_credit") {
        releasedGenerations.push(arguments_?.generation as number);
        return snapshot(arguments_?.generation as number) as T;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const client = new PackedSweepTransferClient(invoke);
    await client.open();
    await client.begin(7);
    const lease = await client.request();
    expect(lease.packed.metadata.generation).toBe(7n);
    expect(calls).not.toContain("release_phase2_transfer_credit");
    await client.begin(8);
    await lease.release();
    await lease.release();
    expect(calls.filter((call) => call === "release_phase2_transfer_credit")).toHaveLength(1);
    expect(releasedGenerations).toEqual([7]);
  });

  it("drops a response whose generation was superseded while invoke was pending", async () => {
    let resolveRequest: ((value: ArrayBuffer) => void) | undefined;
    const releasedGenerations: number[] = [];
    const request = new Promise<ArrayBuffer>((resolve) => {
      resolveRequest = resolve;
    });
    const invoke: InvokeFunction = async <T>(command: string, arguments_?: Record<string, unknown>) => {
      if (command === "open_phase2_transfer_session") return snapshot(0) as T;
      if (command === "begin_phase2_generation") {
        return snapshot(arguments_?.generation as number) as T;
      }
      if (command === "request_phase2_benchmark_sweep") return request as T;
      if (command === "release_phase2_transfer_credit") {
        releasedGenerations.push(arguments_?.generation as number);
        return snapshot(arguments_?.generation as number) as T;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const client = new PackedSweepTransferClient(invoke);
    await client.open();
    await client.begin(7);
    const pending = client.request();
    await client.begin(8);
    resolveRequest?.(goldenBuffer());
    await expect(pending).rejects.toMatchObject({ code: "stale_response" });
    expect(releasedGenerations).toEqual([7]);
  });

  it("does not deactivate a newer generation when an older begin fails late", async () => {
    let rejectOlder: ((reason: Error) => void) | undefined;
    const olderBackendBegin = new Promise<TransferSnapshot>((_, reject) => {
      rejectOlder = reject;
    });
    const invoke: InvokeFunction = async <T>(command: string, arguments_?: Record<string, unknown>) => {
      const generation = arguments_?.generation as number;
      if (command === "open_phase2_transfer_session") return snapshot(0) as T;
      if (command === "begin_phase2_generation" && generation === 7) {
        return olderBackendBegin as T;
      }
      if (command === "begin_phase2_generation" && generation === 8) {
        return snapshot(8) as T;
      }
      if (command === "cancel_phase2_generation" && generation === 8) {
        return { ...snapshot(8), active: false, availableCredits: 0 } as T;
      }
      throw new Error(`unexpected command ${command}`);
    };

    const client = new PackedSweepTransferClient(invoke);
    await client.open();
    const older = client.begin(7);
    const olderAssertion = expect(older).rejects.toThrow("older begin failed");
    await client.begin(8);
    rejectOlder?.(new Error("older begin failed"));
    await olderAssertion;
    await expect(client.cancel()).resolves.toMatchObject({ generation: 8 });
  });

  it("requires a real raw ArrayBuffer response", async () => {
    const invoke: InvokeFunction = async <T>(command: string) => {
      if (command === "open_phase2_transfer_session") return snapshot(0) as T;
      if (command === "begin_phase2_generation") return snapshot(7) as T;
      if (command === "request_phase2_benchmark_sweep") return [1, 2, 3] as T;
      if (command === "release_phase2_transfer_credit") return snapshot(7) as T;
      throw new Error(`unexpected command ${command}`);
    };
    const client = new PackedSweepTransferClient(invoke);
    await client.open();
    await client.begin(7);
    await expect(client.request()).rejects.toMatchObject({ code: "invalid_raw_response" });
  });

  it("preserves structured backend credit errors", async () => {
    const invoke: InvokeFunction = async <T>(command: string) => {
      if (command === "open_phase2_transfer_session") return snapshot(0) as T;
      if (command === "begin_phase2_generation") return snapshot(7) as T;
      throw { code: "credit_exhausted", message: "both credits held" };
    };
    const client = new PackedSweepTransferClient(invoke);
    await client.open();
    await client.begin(7);
    await expect(client.request()).rejects.toMatchObject({
      code: "credit_exhausted",
      message: "both credits held",
    });
  });

  it("keeps a lease release retryable until the backend acknowledges it", async () => {
    let releaseAttempts = 0;
    const invoke: InvokeFunction = async <T>(command: string, arguments_?: Record<string, unknown>) => {
      if (command === "open_phase2_transfer_session") return snapshot(0) as T;
      if (command === "begin_phase2_generation") return snapshot(7) as T;
      if (command === "request_phase2_benchmark_sweep") return goldenBuffer() as T;
      if (command === "release_phase2_transfer_credit") {
        releaseAttempts += 1;
        if (releaseAttempts <= 3) {
          throw new Error("temporary acknowledgement failure");
        }
        expect(arguments_?.releaseId).toEqual(expect.any(String));
        return snapshot(7) as T;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const client = new PackedSweepTransferClient(invoke);
    await client.open();
    await client.begin(7);
    const lease = await client.request();
    await expect(lease.release()).rejects.toThrow("temporary acknowledgement failure");
    await expect(lease.release()).resolves.toBeUndefined();
    await lease.release();
    expect(releaseAttempts).toBe(4);
  });

  it("flushes a failed stale-response acknowledgement before more work", async () => {
    let releaseAttempts = 0;
    const invoke: InvokeFunction = async <T>(command: string, arguments_?: Record<string, unknown>) => {
      if (command === "open_phase2_transfer_session") return snapshot(0) as T;
      if (command === "begin_phase2_generation") {
        return snapshot(arguments_?.generation as number) as T;
      }
      if (command === "request_phase2_benchmark_sweep") return [1, 2, 3] as T;
      if (command === "release_phase2_transfer_credit") {
        releaseAttempts += 1;
        if (releaseAttempts <= 3) {
          throw new Error("temporary acknowledgement failure");
        }
        return snapshot(arguments_?.generation as number) as T;
      }
      throw new Error(`unexpected command ${command}`);
    };
    const client = new PackedSweepTransferClient(invoke);
    await client.open();
    await client.begin(7);
    await expect(client.request()).rejects.toMatchObject({ code: "invalid_raw_response" });
    await client.begin(8);
    expect(releaseAttempts).toBe(4);
  });

  it("rejects non-monotonic local generations", async () => {
    const invoke: InvokeFunction = async <T>(command: string) =>
      (command === "open_phase2_transfer_session" ? snapshot(0) : snapshot(7)) as T;
    const client = new PackedSweepTransferClient(invoke);
    await client.open();
    await client.begin(7);
    await expect(client.begin(7)).rejects.toBeInstanceOf(TransferClientError);
  });
});

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

function snapshot(generation: number, heldCredits = 0): TransferSnapshot {
  return {
    generation,
    active: true,
    availableCredits: 2 - heldCredits,
    heldCredits,
    creditLimit: 2,
  };
}

describe("PackedSweepTransferClient", () => {
  it("holds a backend credit until the caller releases the parsed sweep", async () => {
    const calls: string[] = [];
    const invoke: InvokeFunction = async <T>(command: string) => {
      calls.push(command);
      if (command === "begin_phase2_generation") return snapshot(7) as T;
      if (command === "request_phase2_benchmark_sweep") return goldenBuffer() as T;
      if (command === "release_phase2_transfer_credit") return snapshot(7) as T;
      throw new Error(`unexpected command ${command}`);
    };
    const client = new PackedSweepTransferClient(invoke);
    await client.begin(7);
    const lease = await client.request();
    expect(lease.packed.metadata.generation).toBe(7n);
    expect(calls).not.toContain("release_phase2_transfer_credit");
    await lease.release();
    await lease.release();
    expect(calls.filter((call) => call === "release_phase2_transfer_credit")).toHaveLength(1);
  });

  it("drops a response whose generation was superseded while invoke was pending", async () => {
    let resolveRequest: ((value: ArrayBuffer) => void) | undefined;
    const request = new Promise<ArrayBuffer>((resolve) => {
      resolveRequest = resolve;
    });
    const invoke: InvokeFunction = async <T>(command: string, arguments_?: Record<string, unknown>) => {
      if (command === "begin_phase2_generation") {
        return snapshot(arguments_?.generation as number) as T;
      }
      if (command === "request_phase2_benchmark_sweep") return request as T;
      throw new Error(`unexpected command ${command}`);
    };
    const client = new PackedSweepTransferClient(invoke);
    await client.begin(7);
    const pending = client.request();
    await client.begin(8);
    resolveRequest?.(goldenBuffer());
    await expect(pending).rejects.toMatchObject({ code: "stale_response" });
  });

  it("requires a real raw ArrayBuffer response", async () => {
    const invoke: InvokeFunction = async <T>(command: string) => {
      if (command === "begin_phase2_generation") return snapshot(7) as T;
      if (command === "request_phase2_benchmark_sweep") return [1, 2, 3] as T;
      if (command === "release_phase2_transfer_credit") return snapshot(7) as T;
      throw new Error(`unexpected command ${command}`);
    };
    const client = new PackedSweepTransferClient(invoke);
    await client.begin(7);
    await expect(client.request()).rejects.toMatchObject({ code: "invalid_raw_response" });
  });

  it("preserves structured backend credit errors", async () => {
    const invoke: InvokeFunction = async <T>(command: string) => {
      if (command === "begin_phase2_generation") return snapshot(7) as T;
      throw { code: "credit_exhausted", message: "both credits held" };
    };
    const client = new PackedSweepTransferClient(invoke);
    await client.begin(7);
    await expect(client.request()).rejects.toMatchObject({
      code: "credit_exhausted",
      message: "both credits held",
    });
  });

  it("rejects non-monotonic local generations", async () => {
    const invoke: InvokeFunction = async <T>() => snapshot(7) as T;
    const client = new PackedSweepTransferClient(invoke);
    await client.begin(7);
    await expect(client.begin(7)).rejects.toBeInstanceOf(TransferClientError);
  });
});


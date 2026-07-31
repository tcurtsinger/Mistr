import { parsePackedSweep, type PackedSweep } from "./packedSweep";

export interface TransferSnapshot {
  generation: number;
  active: boolean;
  availableCredits: number;
  heldCredits: number;
  inFlightCredits: number;
  creditLimit: number;
}

export interface TimingDistribution {
  min: number;
  p50: number;
  p95: number;
  max: number;
}

export interface EncoderBenchmarkReport {
  mode: string;
  buildProfile: string;
  iterations: number;
  payload: {
    totalBytes: number;
    radialCount: number;
    gateCount: number;
    cellCount: number;
    wireSha256: string;
  };
  encodeMs: TimingDistribution;
  validateMs: TimingDistribution;
}

export interface TransferTiming {
  invokeMs: number;
  parseMs: number;
  totalMs: number;
}

export interface PackedSweepLease {
  packed: PackedSweep;
  timing: TransferTiming;
  release(): Promise<void>;
}

export type TransferClientErrorCode =
  | "invalid_generation"
  | "generation_not_active"
  | "stale_response"
  | "invalid_raw_response"
  | "credit_exhausted"
  | "stale_generation"
  | "generation_cancelled"
  | "invoke_failed";

export class TransferClientError extends Error {
  readonly code: TransferClientErrorCode | string;

  constructor(code: TransferClientErrorCode | string, message: string) {
    super(message);
    this.name = "TransferClientError";
    this.code = code;
  }
}

export type InvokeFunction = <T>(
  command: string,
  arguments_?: Record<string, unknown>,
) => Promise<T>;

export class PackedSweepTransferClient {
  private readonly invoke: InvokeFunction;
  private generation = 0;
  private active = false;

  constructor(invoke: InvokeFunction) {
    this.invoke = invoke;
  }

  async begin(generation: number): Promise<TransferSnapshot> {
    assertGeneration(generation);
    if (generation <= this.generation) {
      throw new TransferClientError(
        "invalid_generation",
        `generation ${generation} is not newer than ${this.generation}`,
      );
    }
    // Invalidate local pending responses before waiting for the backend control call.
    this.generation = generation;
    this.active = false;
    try {
      const snapshot = await this.invoke<TransferSnapshot>("begin_phase2_generation", {
        generation,
      });
      if (this.generation !== generation) {
        throw new TransferClientError(
          "stale_response",
          `generation ${generation} begin completed after it was superseded`,
        );
      }
      if (snapshot.generation !== generation || !snapshot.active) {
        throw new TransferClientError(
          "invoke_failed",
          "backend returned an inconsistent generation snapshot",
        );
      }
      this.active = true;
      return snapshot;
    } catch (error) {
      if (this.generation === generation) {
        this.active = false;
      }
      throw normalizeInvokeError(error);
    }
  }

  async cancel(): Promise<TransferSnapshot> {
    const generation = this.generation;
    if (!this.active || generation === 0) {
      throw new TransferClientError("generation_not_active", "no generation is active");
    }
    this.active = false;
    try {
      return await this.invoke<TransferSnapshot>("cancel_phase2_generation", {
        generation,
      });
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  async request(holdMs = 0): Promise<PackedSweepLease> {
    const generation = this.generation;
    if (!this.active || generation === 0) {
      throw new TransferClientError("generation_not_active", "no generation is active");
    }
    if (!Number.isInteger(holdMs) || holdMs < 0 || holdMs > 2_000) {
      throw new RangeError("holdMs must be an integer between 0 and 2000");
    }

    const totalStarted = performance.now();
    let response: ArrayBuffer;
    try {
      const invokeStarted = performance.now();
      response = await this.invoke<ArrayBuffer>("request_phase2_benchmark_sweep", {
        generation,
        holdMs,
      });
      const invokeMs = performance.now() - invokeStarted;
      if (!this.active || this.generation !== generation) {
        throw new TransferClientError(
          "stale_response",
          `generation ${generation} completed after it was superseded`,
        );
      }
      if (!(response instanceof ArrayBuffer)) {
        await this.releaseAfterFailure(generation);
        throw new TransferClientError(
          "invalid_raw_response",
          "Tauri command did not return an ArrayBuffer",
        );
      }

      const parseStarted = performance.now();
      let packed: PackedSweep;
      try {
        packed = await parsePackedSweep(response);
      } catch (error) {
        await this.releaseAfterFailure(generation);
        throw error;
      }
      const parseMs = performance.now() - parseStarted;
      if (!this.active || this.generation !== generation) {
        throw new TransferClientError(
          "stale_response",
          `generation ${generation} was superseded during parsing`,
        );
      }
      if (packed.metadata.generation !== BigInt(generation)) {
        await this.releaseAfterFailure(generation);
        throw new TransferClientError(
          "stale_response",
          `wire generation ${packed.metadata.generation} does not match ${generation}`,
        );
      }

      let released = false;
      return {
        packed,
        timing: {
          invokeMs,
          parseMs,
          totalMs: performance.now() - totalStarted,
        },
        release: async () => {
          if (released) {
            return;
          }
          released = true;
          if (this.active && this.generation === generation) {
            try {
              await this.invoke<TransferSnapshot>("release_phase2_transfer_credit", {
                generation,
              });
            } catch (error) {
              throw normalizeInvokeError(error);
            }
          }
        },
      };
    } catch (error) {
      throw normalizeInvokeError(error);
    }
  }

  private async releaseAfterFailure(generation: number) {
    if (this.active && this.generation === generation) {
      try {
        await this.invoke("release_phase2_transfer_credit", { generation });
      } catch {
        // Preserve the original parse/response error. The backend still bounds
        // the held credit, and a new generation resets the ledger.
      }
    }
  }
}

export interface PackagedPhase2Benchmark {
  status: "PASS" | "FAIL";
  rawResponseKind: "ArrayBuffer";
  payloadBytes: number;
  transferIterations: number;
  encoder: EncoderBenchmarkReport;
  invokeMs: TimingDistribution;
  parseMs: TimingDistribution;
  totalMs: TimingDistribution;
  backpressure: {
    fulfilled: number;
    rejected: number;
    rejectedCodes: string[];
  };
  cancellation: {
    staleRequestRejected: boolean;
    rejectionCode: string;
  };
  finalTransferState: TransferSnapshot;
  heapBeforeBytes: number | null;
  heapAfterBytes: number | null;
  gates: {
    payloadWithin16MiB: boolean;
    releaseBuild: boolean;
    encoderP95Within100Ms: boolean;
    invokeP95Within250Ms: boolean;
    parseP95Within100Ms: boolean;
    creditLimitIsTwo: boolean;
    cancellationPassed: boolean;
  };
}

export async function runPackagedPhase2Benchmark(
  invoke: InvokeFunction,
  iterations = 10,
): Promise<PackagedPhase2Benchmark> {
  if (!Number.isInteger(iterations) || iterations < 3 || iterations > 20) {
    throw new RangeError("iterations must be an integer between 3 and 20");
  }
  const heapBeforeBytes = readHeapBytes();
  const encoder = await invoke<EncoderBenchmarkReport>("benchmark_phase2_encoder", {
    iterations,
  });
  const client = new PackedSweepTransferClient(invoke);
  await client.begin(1);

  const timings: TransferTiming[] = [];
  let payloadBytes = 0;
  for (let index = 0; index < iterations; index += 1) {
    const lease = await client.request();
    payloadBytes = lease.packed.metadata.totalBytes;
    timings.push(lease.timing);
    await lease.release();
  }

  await client.begin(2);
  const concurrent = await Promise.allSettled([
    client.request(),
    client.request(),
    client.request(),
  ]);
  const successfulLeases = concurrent
    .filter((result): result is PromiseFulfilledResult<PackedSweepLease> => result.status === "fulfilled")
    .map((result) => result.value);
  const rejectedCodes = concurrent
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => errorCode(result.reason));
  await Promise.all(successfulLeases.map((lease) => lease.release()));

  await client.begin(3);
  const staleRequest = client.request(250);
  await delay(25);
  await client.begin(4);
  let cancellationCode = "none";
  let staleRequestRejected = false;
  try {
    const lease = await staleRequest;
    await lease.release();
  } catch (error) {
    staleRequestRejected = true;
    cancellationCode = errorCode(error);
  }
  const finalTransferState = await invoke<TransferSnapshot>("phase2_transfer_snapshot");
  const heapAfterBytes = readHeapBytes();

  const invokeMs = distribution(timings.map((timing) => timing.invokeMs));
  const parseMs = distribution(timings.map((timing) => timing.parseMs));
  const totalMs = distribution(timings.map((timing) => timing.totalMs));
  const gates = {
    payloadWithin16MiB: payloadBytes <= 16 * 1024 * 1024,
    releaseBuild: encoder.buildProfile === "release",
    encoderP95Within100Ms: encoder.encodeMs.p95 <= 100,
    invokeP95Within250Ms: invokeMs.p95 <= 250,
    parseP95Within100Ms: parseMs.p95 <= 100,
    creditLimitIsTwo:
      successfulLeases.length === 2
      && rejectedCodes.length === 1
      && rejectedCodes[0] === "credit_exhausted"
      && finalTransferState.creditLimit === 2
      && finalTransferState.availableCredits === 2
      && finalTransferState.heldCredits === 0
      && finalTransferState.inFlightCredits === 0,
    cancellationPassed:
      staleRequestRejected
      && (cancellationCode === "stale_generation" || cancellationCode === "stale_response"),
  };
  return {
    status: Object.values(gates).every(Boolean) ? "PASS" : "FAIL",
    rawResponseKind: "ArrayBuffer",
    payloadBytes,
    transferIterations: iterations,
    encoder,
    invokeMs,
    parseMs,
    totalMs,
    backpressure: {
      fulfilled: successfulLeases.length,
      rejected: rejectedCodes.length,
      rejectedCodes,
    },
    cancellation: {
      staleRequestRejected,
      rejectionCode: cancellationCode,
    },
    finalTransferState,
    heapBeforeBytes,
    heapAfterBytes,
    gates,
  };
}

export async function tauriInvokeFunction(): Promise<InvokeFunction> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke as InvokeFunction;
}

function normalizeInvokeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "invoke_failed";
    const message = "message" in error && typeof error.message === "string"
      ? error.message
      : JSON.stringify(error);
    return new TransferClientError(code, message);
  }
  return new TransferClientError("invoke_failed", String(error));
}

function assertGeneration(generation: number) {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new TransferClientError(
      "invalid_generation",
      "generation must be a positive safe integer",
    );
  }
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "unknown";
}

function distribution(samples: number[]): TimingDistribution {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? sorted[0],
  };
}

function percentile(sorted: number[], fraction: number): number {
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function readHeapBytes(): number | null {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  }).memory;
  return typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null;
}

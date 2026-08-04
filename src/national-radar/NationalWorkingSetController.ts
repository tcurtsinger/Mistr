import { assertChunkMatchesManifest, type PackedGridManifest } from "../packed-grid/packedGrid";
import type { PackedSweepTransferClient } from "../packed-sweep/transferClient";
import {
  assertCoverageMatchesManifest,
  completeDomainCoverage,
  viewportCoverage,
  type GeographicBounds,
  type NationalViewportCoverage,
} from "./coverage";
import {
  NationalGridLayer,
  type NationalPaintReceipt,
} from "./NationalGridLayer";

export const NATIONAL_GPU_TARGET_BYTES = 200 * 1024 * 1024;
export const NATIONAL_GPU_HARD_CEILING_BYTES = 256 * 1024 * 1024;

export interface NationalWorkingSetResult {
  manifest: PackedGridManifest;
  coverage: NationalViewportCoverage;
  receipt: NationalPaintReceipt;
  manifestWireBytes: number;
  chunkWireBytes: number;
  chunkCount: number;
}

export class NationalWorkingSetController {
  private coverageVersion = 0;
  private operation: Promise<NationalWorkingSetResult> | null = null;

  constructor(
    private readonly client: Pick<
      PackedSweepTransferClient,
      "requestNationalManifest" | "requestNationalChunk"
    >,
    private readonly layer: Pick<
      NationalGridLayer,
      "beginStaging" | "commitStaging" | "rollbackStaging" | "uploadStagedChunk"
    >,
  ) {}

  stageCompleteOverview(
    ownershipCheck: () => void,
    beforeCommit?: () => void,
  ): Promise<NationalWorkingSetResult> {
    return this.run(4, (manifest, version) => (
      completeDomainCoverage(manifest, version)
    ), ownershipCheck, beforeCommit);
  }

  stageDetailedViewport(
    bounds: GeographicBounds,
    ownershipCheck: () => void,
    beforeCommit?: () => void,
  ): Promise<NationalWorkingSetResult> {
    return this.run(1, (manifest, version) => (
      viewportCoverage(manifest, bounds, version)
    ), ownershipCheck, beforeCommit);
  }

  cancel(): void {
    this.layer.rollbackStaging();
  }

  private run(
    presentationFactor: 1 | 4,
    coverageForManifest: (
      manifest: PackedGridManifest,
      coverageVersion: number,
    ) => NationalViewportCoverage,
    ownershipCheck: () => void,
    beforeCommit?: () => void,
  ): Promise<NationalWorkingSetResult> {
    if (this.operation) {
      return Promise.reject(new Error("a National working-set mutation is already active"));
    }
    const operation = this.stage(
      presentationFactor,
      coverageForManifest,
      ownershipCheck,
      beforeCommit,
    );
    this.operation = operation;
    void operation.finally(() => {
      if (this.operation === operation) this.operation = null;
    }).catch(() => {});
    return operation;
  }

  private async stage(
    presentationFactor: 1 | 4,
    coverageForManifest: (
      manifest: PackedGridManifest,
      coverageVersion: number,
    ) => NationalViewportCoverage,
    ownershipCheck: () => void,
    beforeCommit?: () => void,
  ): Promise<NationalWorkingSetResult> {
    ownershipCheck();
    const manifestLease = await this.client.requestNationalManifest(presentationFactor);
    const manifestWireBytes = manifestLease.wireBytes;
    const manifest = manifestLease.packed;
    try {
      ownershipCheck();
    } finally {
      await manifestLease.release();
    }
    this.coverageVersion += 1;
    const coverage = coverageForManifest(manifest, this.coverageVersion);
    const descriptors = assertCoverageMatchesManifest(manifest, coverage);
    const projectedGpuBytes = descriptors.reduce(
      (total, descriptor) => total + descriptor.haloWidth * descriptor.haloHeight * 2,
      0,
    );
    if (projectedGpuBytes > NATIONAL_GPU_HARD_CEILING_BYTES) {
      throw new Error(
        `National presentation requires ${projectedGpuBytes} GPU bytes, exceeding the hard ceiling`,
      );
    }
    this.layer.beginStaging(manifest, coverage);
    let chunkWireBytes = 0;
    try {
      for (const descriptor of descriptors) {
        ownershipCheck();
        const lease = await this.client.requestNationalChunk(
          descriptor.index,
          presentationFactor,
        );
        try {
          assertChunkMatchesManifest(manifest, lease.packed);
          ownershipCheck();
          await this.layer.uploadStagedChunk(lease.packed);
          chunkWireBytes += lease.wireBytes;
          ownershipCheck();
        } finally {
          await lease.release();
        }
      }
      ownershipCheck();
      beforeCommit?.();
      const receipt = await this.layer.commitStaging();
      ownershipCheck();
      if (
        receipt.generation !== Number(manifest.generation)
        || receipt.observationTimeUnixMs !== Number(manifest.observationTimeUnixMs)
        || receipt.contentSha256 !== manifest.contentSha256
        || receipt.presentationFactor !== presentationFactor
        || receipt.coverageVersion !== coverage.version
        || receipt.requiredChunkCount !== descriptors.length
      ) {
        throw new Error("National paint receipt does not match the complete staged presentation");
      }
      return {
        manifest,
        coverage,
        receipt,
        manifestWireBytes,
        chunkWireBytes,
        chunkCount: descriptors.length,
      };
    } catch (error) {
      this.layer.rollbackStaging();
      throw error;
    }
  }
}

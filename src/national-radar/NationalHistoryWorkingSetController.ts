import { assertChunkMatchesManifest, type PackedGridManifest } from "../packed-grid/packedGrid";
import type {
  NationalHistoryObservation,
  PackedSweepTransferClient,
} from "../packed-sweep/transferClient";
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

export interface NationalHistoryWorkingSetResult {
  observation: NationalHistoryObservation;
  manifest: PackedGridManifest;
  coverage: NationalViewportCoverage;
  receipt?: NationalPaintReceipt;
  manifestWireBytes: number;
  chunkWireBytes: number;
  chunkCount: number;
  projectedGpuBytes: number;
}

export type NationalDetailPresentationFactor = 1 | 2;

type HistoryTransferClient = Pick<
  PackedSweepTransferClient,
  | "prepareNationalHistoryPresentation"
  | "requestNationalHistoryManifest"
  | "requestNationalHistoryChunk"
>;

type HistoryGridLayer = Pick<
  NationalGridLayer,
  | "beginStaging"
  | "commitInitialHistoryStaging"
  | "commitHistoryStaging"
  | "commitPrefetchedStaging"
  | "rollbackHistoryMutation"
  | "rollbackStaging"
  | "uploadStagedChunk"
>;

export class NationalHistoryWorkingSetController {
  private coverageVersion = 0;
  private operation: Promise<NationalHistoryWorkingSetResult> | null = null;

  constructor(
    private readonly client: HistoryTransferClient,
    private readonly layer: HistoryGridLayer,
  ) {}

  stageInitialOverview(
    observation: NationalHistoryObservation,
    ownershipCheck: () => void,
    beforeCommit?: () => void | Promise<void>,
  ): Promise<NationalHistoryWorkingSetResult> {
    return this.run(
      observation,
      4,
      (manifest, version) => completeDomainCoverage(manifest, version),
      ownershipCheck,
      async () => this.layer.commitInitialHistoryStaging(),
      beforeCommit,
      true,
      true,
    );
  }

  /**
   * `selectedPresentationFactor` preserves an already-resident finer selected
   * presentation across an unrelated observation's overview commit, so
   * backfill and polling appends never degrade the visible frame to the
   * coarse overview.
   */
  stageHistoryOverview(
    observation: NationalHistoryObservation,
    timelineObservationIds: readonly string[],
    selectedObservationId: string,
    ownershipCheck: () => void,
    beforeCommit?: () => void | Promise<void>,
    selectedPresentationFactor: NationalDetailPresentationFactor | 4 = 4,
  ): Promise<NationalHistoryWorkingSetResult> {
    return this.run(
      observation,
      4,
      (manifest, version) => completeDomainCoverage(manifest, version),
      ownershipCheck,
      async () => this.layer.commitHistoryStaging(
        timelineObservationIds,
        selectedObservationId,
        selectedPresentationFactor,
        true,
      ),
      beforeCommit,
      false,
      true,
    );
  }

  /**
   * Stage detail for the selected observation. `bounds: null` stages the
   * complete domain, making the resulting presentation camera-independent:
   * later pan and zoom need no restaging, no readiness inference, and no
   * quality fallback for the paused view.
   */
  stageSelectedDetail(
    observation: NationalHistoryObservation,
    bounds: GeographicBounds | null,
    timelineObservationIds: readonly string[],
    ownershipCheck: () => void,
    beforeCommit?: () => void | Promise<void>,
    presentationFactor: NationalDetailPresentationFactor = 1,
  ): Promise<NationalHistoryWorkingSetResult> {
    return this.run(
      observation,
      presentationFactor,
      (manifest, version) => (bounds === null
        ? completeDomainCoverage(manifest, version)
        : viewportCoverage(manifest, bounds, version)),
      ownershipCheck,
      async () => this.layer.commitHistoryStaging(
        timelineObservationIds,
        observationId(observation),
        presentationFactor,
      ),
      beforeCommit,
      true,
      false,
    );
  }

  prefetchDetail(
    observation: NationalHistoryObservation,
    bounds: GeographicBounds,
    timelineObservationIds: readonly string[],
    ownershipCheck: () => void,
    presentationFactor: NationalDetailPresentationFactor = 1,
  ): Promise<NationalHistoryWorkingSetResult> {
    return this.run(
      observation,
      presentationFactor,
      (manifest, version) => viewportCoverage(manifest, bounds, version),
      ownershipCheck,
      async () => {
        this.layer.commitPrefetchedStaging(timelineObservationIds);
        return undefined;
      },
      undefined,
      false,
      false,
    );
  }

  cancel(): void {
    this.layer.rollbackStaging();
  }

  async waitForIdle(): Promise<void> {
    const operation = this.operation;
    if (operation) await operation.catch(() => {});
  }

  private run(
    observation: NationalHistoryObservation,
    presentationFactor: NationalDetailPresentationFactor | 4,
    coverageForManifest: (
      manifest: PackedGridManifest,
      coverageVersion: number,
    ) => NationalViewportCoverage,
    ownershipCheck: () => void,
    commit: () => Promise<NationalPaintReceipt | undefined>,
    beforeCommit?: () => void | Promise<void>,
    receiptMustMatchStaged = true,
    deferExternalCommit = false,
  ): Promise<NationalHistoryWorkingSetResult> {
    if (this.operation) {
      return Promise.reject(new Error("a National history working-set mutation is already active"));
    }
    const operation = this.stage(
      observation,
      presentationFactor,
      coverageForManifest,
      ownershipCheck,
      commit,
      beforeCommit,
      receiptMustMatchStaged,
      deferExternalCommit,
    );
    this.operation = operation;
    void operation.finally(() => {
      if (this.operation === operation) this.operation = null;
    }).catch(() => {});
    return operation;
  }

  private async stage(
    observation: NationalHistoryObservation,
    presentationFactor: NationalDetailPresentationFactor | 4,
    coverageForManifest: (
      manifest: PackedGridManifest,
      coverageVersion: number,
    ) => NationalViewportCoverage,
    ownershipCheck: () => void,
    commit: () => Promise<NationalPaintReceipt | undefined>,
    beforeCommit?: () => void | Promise<void>,
    receiptMustMatchStaged = true,
    deferExternalCommit = false,
  ): Promise<NationalHistoryWorkingSetResult> {
    ownershipCheck();
    if (presentationFactor !== 4) {
      await this.client.prepareNationalHistoryPresentation(observation, presentationFactor);
      ownershipCheck();
    }
    const manifestLease = await this.client.requestNationalHistoryManifest(
      observation,
      presentationFactor,
    );
    const manifestWireBytes = manifestLease.wireBytes;
    const manifest = manifestLease.packed;
    try {
      assertManifestIdentity(manifest, observation, presentationFactor);
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
    if (projectedGpuBytes > 256 * 1024 * 1024) {
      throw new Error("National presentation exceeds the 256 MiB hard ceiling");
    }
    this.layer.beginStaging(manifest, coverage);
    let chunkWireBytes = 0;
    let receipt: NationalPaintReceipt | undefined;
    try {
      for (const descriptor of descriptors) {
        ownershipCheck();
        const lease = await this.client.requestNationalHistoryChunk(
          observation,
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
      await beforeCommit?.();
      ownershipCheck();
      receipt = await commit();
      ownershipCheck();
      if (receiptMustMatchStaged && receipt) {
        assertReceipt(receipt, manifest, coverage, descriptors.length);
      } else if (receipt && receipt.generation !== observation.generation) {
        throw new Error("National history mutation receipt has a stale generation");
      }
      return {
        observation,
        manifest,
        coverage,
        receipt,
        manifestWireBytes,
        chunkWireBytes,
        chunkCount: descriptors.length,
        projectedGpuBytes,
      };
    } catch (error) {
      if (deferExternalCommit && receipt) {
        try {
          await this.layer.rollbackHistoryMutation(receipt);
        } catch {
          // Preserve the ownership/paint error that invalidated the mutation.
        }
      } else {
        this.layer.rollbackStaging();
      }
      throw error;
    }
  }
}

export function observationId(observation: NationalHistoryObservation): string {
  return `${observation.observationTimeUnixMs}:${observation.contentSha256}`;
}

function assertManifestIdentity(
  manifest: PackedGridManifest,
  observation: NationalHistoryObservation,
  presentationFactor: number,
) {
  if (
    Number(manifest.generation) !== observation.generation
    || Number(manifest.observationTimeUnixMs) !== observation.observationTimeUnixMs
    || manifest.contentSha256 !== observation.contentSha256
    || manifest.objectKey !== observation.objectKey
    || manifest.presentationFactor !== presentationFactor
  ) {
    throw new Error("National history manifest does not match its retained observation");
  }
}

function assertReceipt(
  receipt: NationalPaintReceipt,
  manifest: PackedGridManifest,
  coverage: NationalViewportCoverage,
  requiredChunkCount: number,
) {
  if (
    receipt.generation !== Number(manifest.generation)
    || receipt.observationTimeUnixMs !== Number(manifest.observationTimeUnixMs)
    || receipt.contentSha256 !== manifest.contentSha256
    || receipt.presentationFactor !== manifest.presentationFactor
    || receipt.coverageVersion !== coverage.version
    || receipt.requiredChunkCount !== requiredChunkCount
  ) {
    throw new Error("National history paint receipt does not match the complete presentation");
  }
}

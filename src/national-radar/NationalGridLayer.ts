import * as maplibregl from "maplibre-gl";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import type {
  PackedGridChunk,
  PackedGridManifest,
} from "../packed-grid/packedGrid";
import type { RadarDisplayMode } from "../radar-renderer/RadarCustomLayer";
import { colorForReflectivity } from "../radar-renderer/palette";
import {
  assertCoverageMatchesManifest,
  type NationalViewportCoverage,
} from "./coverage";
import { nationalObservationIdentity } from "./model";

const PALETTE_WIDTH = 1_024;
// Native-residency owner decision (2026-08-04): all retained observations
// stay GPU-resident at the exact full-resolution grid (~49 MiB per frame,
// ~1 GiB for the 20-frame loop plus one staged replacement). Sized for the
// supported desktop floor — a discrete GPU with several GiB of memory — not
// a minimal device.
export const NATIONAL_GPU_TARGET_BYTES = 1280 * 1024 * 1024;
export const NATIONAL_GPU_HARD_CEILING_BYTES = 1536 * 1024 * 1024;
const PALETTE_MIN_DBZ = -25;
const PALETTE_MAX_DBZ = 70;
const DEFAULT_UPLOAD_BUDGET_MS = 4;
const PAINT_TIMEOUT_MS = 15_000;
const RECOVERY_PAINT_TIMEOUT_MS = 30_000;

const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
uniform mat4 u_matrix;
uniform vec4 u_mercator_bounds;
out vec2 v_mercator;
void main() {
  vec2 mercator = mix(u_mercator_bounds.xy, u_mercator_bounds.zw, a_corner);
  v_mercator = mercator;
  gl_Position = u_matrix * vec4(mercator, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp usampler2D;
in vec2 v_mercator;
uniform usampler2D u_raw_codes;
uniform sampler2D u_palette;
uniform vec2 u_first_lon_lat;
uniform vec2 u_step_lon_lat;
uniform vec2 u_halo_origin;
uniform vec4 u_interior_bounds;
uniform uint u_missing_raw;
uniform uint u_no_coverage_raw;
uniform bool u_smooth;
uniform bool u_exclude_coverage;
uniform vec4 u_exclusion_bounds;
out vec4 frag_color;

float mercator_latitude(float y) {
  return degrees(2.0 * atan(exp((0.5 - y) * 6.283185307179586)) - 1.5707963267948966);
}

bool valid_code(uint raw) {
  return raw != u_missing_raw && raw != u_no_coverage_raw;
}

vec4 palette_color(float raw) {
  float dbz = (-9990.0 + raw) / 10.0;
  float unit = clamp((dbz - ${PALETTE_MIN_DBZ.toFixed(1)}) / ${(PALETTE_MAX_DBZ - PALETTE_MIN_DBZ).toFixed(1)}, 0.0, 1.0);
  return texture(u_palette, vec2(unit, 0.5));
}

void main() {
  float longitude = v_mercator.x * 360.0 - 180.0;
  float latitude = mercator_latitude(v_mercator.y);
  if (
    u_exclude_coverage
    && longitude >= u_exclusion_bounds.x
    && latitude >= u_exclusion_bounds.y
    && longitude <= u_exclusion_bounds.z
    && latitude <= u_exclusion_bounds.w
  ) discard;
  vec2 grid = vec2(
    (longitude - u_first_lon_lat.x) / u_step_lon_lat.x,
    (u_first_lon_lat.y - latitude) / u_step_lon_lat.y
  );
  if (
    grid.x < u_interior_bounds.x - 0.5
    || grid.y < u_interior_bounds.y - 0.5
    || grid.x > u_interior_bounds.z + 0.5
    || grid.y > u_interior_bounds.w + 0.5
  ) discard;
  vec2 local = grid - u_halo_origin;
  ivec2 nearest_cell = ivec2(floor(local + 0.5));
  uint nearest_raw = texelFetch(u_raw_codes, nearest_cell, 0).r;
  if (!valid_code(nearest_raw)) discard;
  if (!u_smooth) {
    frag_color = palette_color(float(nearest_raw));
    return;
  }
  ivec2 lower = ivec2(floor(local));
  ivec2 upper_limit = textureSize(u_raw_codes, 0) - ivec2(1);
  lower = clamp(lower, ivec2(0), upper_limit);
  ivec2 upper = min(lower + ivec2(1), upper_limit);
  uint c00 = texelFetch(u_raw_codes, lower, 0).r;
  uint c10 = texelFetch(u_raw_codes, ivec2(upper.x, lower.y), 0).r;
  uint c01 = texelFetch(u_raw_codes, ivec2(lower.x, upper.y), 0).r;
  uint c11 = texelFetch(u_raw_codes, upper, 0).r;
  if (!valid_code(c00) || !valid_code(c10) || !valid_code(c01) || !valid_code(c11)) {
    frag_color = palette_color(float(nearest_raw));
    return;
  }
  vec2 fraction = clamp(fract(local), 0.0, 1.0);
  float top = mix(float(c00), float(c10), fraction.x);
  float bottom = mix(float(c01), float(c11), fraction.x);
  frag_color = palette_color(mix(top, bottom, fraction.y));
}`;

export interface NationalPaintReceipt {
  generation: number;
  observationId: string;
  observationTimeUnixMs: number;
  contentSha256: string;
  presentationFactor: number;
  coverageVersion: number;
  coverageKind: NationalViewportCoverage["kind"];
  requiredChunkCount: number;
  contextEpoch: number;
  drawSequence: number;
  completedAtUnixMs: number;
  stagingDurationMs: number;
  maximumUploadSliceMs: number;
  uploadedBytes: number;
  framebufferWidth: number;
  framebufferHeight: number;
}

export interface NationalGridRendererSnapshot {
  status: "initializing" | "ready" | "staging" | "painted" | "recovering" | "error" | "removed";
  displayMode: RadarDisplayMode;
  presentationEnabled: boolean;
  contextEpoch: number;
  generation?: number;
  observationId?: string;
  observationTimeUnixMs?: number;
  presentationFactor?: number;
  fallbackPresentationFactor?: number;
  fallbackChunkCount: number;
  coverageVersion?: number;
  coverageComplete: boolean;
  residentChunkCount: number;
  residentObservationIds: readonly string[];
  commonResidentObservationIds: readonly string[];
  detailedObservationIds: readonly string[];
  selectedObservationId?: string;
  playbackQualityFactor?: number;
  mutationAwaitingCommit: boolean;
  stagedChunkCount: number;
  gpuResourceBytes: number;
  peakGpuResourceBytes: number;
  uploadCount: number;
  uploadBytes: number;
  maximumUploadSliceMs: number;
  paintReceipt?: NationalPaintReceipt;
  error?: string;
}

export interface NationalGridLayerOptions {
  displayMode?: RadarDisplayMode;
  recoveryBeforeLayerId?: string;
  uploadBudgetMs?: number;
  onSnapshot?(snapshot: NationalGridRendererSnapshot): void;
}

interface CpuChunk {
  packed: PackedGridChunk;
  gpuBytes: number;
}

interface GpuChunk extends CpuChunk {
  texture: WebGLTexture | null;
}

interface PresentationResources {
  manifest: PackedGridManifest;
  coverage: NationalViewportCoverage;
  chunks: Map<number, GpuChunk>;
  stagingStartedAt: number;
  stagingDurationMs: number;
  maximumUploadSliceMs: number;
  uploadedBytes: number;
}

interface ResidentObservation {
  common: PresentationResources | null;
  detail: PresentationResources | null;
}

interface RendererResidencyState {
  residents: Map<string, ResidentObservation>;
  timelineObservationIds: string[];
  active: PresentationResources | null;
  fallback: PresentationResources | null;
  playbackQualityFactor: number | undefined;
}

interface PendingResidencyMutation {
  previous: RendererResidencyState;
  added: PresentationResources[];
  retireOnSuccess: PresentationResources[];
  deferExternalCommit: boolean;
}

interface AwaitingExternalCommit {
  mutation: PendingResidencyMutation;
  receipt: NationalPaintReceipt;
}

interface PendingPaint {
  sync: WebGLSync;
  resources: PresentationResources;
  mutation: PendingResidencyMutation | null;
  drawSequence: number;
}

interface PaintWaiter {
  resolve(receipt: NationalPaintReceipt): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof globalThis.setTimeout>;
}

interface Uniforms {
  matrix: WebGLUniformLocation;
  mercatorBounds: WebGLUniformLocation;
  rawCodes: WebGLUniformLocation;
  palette: WebGLUniformLocation;
  firstLonLat: WebGLUniformLocation;
  stepLonLat: WebGLUniformLocation;
  haloOrigin: WebGLUniformLocation;
  interiorBounds: WebGLUniformLocation;
  missingRaw: WebGLUniformLocation;
  noCoverageRaw: WebGLUniformLocation;
  smooth: WebGLUniformLocation;
  excludeCoverage: WebGLUniformLocation;
  exclusionBounds: WebGLUniformLocation;
}

export class NationalGridLayer implements CustomLayerInterface {
  readonly id = "mistr-national-radar";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private paletteTexture: WebGLTexture | null = null;
  private uniforms: Uniforms | null = null;
  private active: PresentationResources | null = null;
  private fallback: PresentationResources | null = null;
  private residents = new Map<string, ResidentObservation>();
  private timelineObservationIds: string[] = [];
  private playbackQualityFactor: number | undefined;
  private staging: PresentationResources | null = null;
  private pendingPaint: PendingPaint | null = null;
  private pendingResidencyMutation: PendingResidencyMutation | null = null;
  private awaitingExternalCommit: AwaitingExternalCommit | null = null;
  private paintWaiter: PaintWaiter | null = null;
  private displayMode: RadarDisplayMode;
  private presentationEnabled = true;
  private contextEpoch = 1;
  private drawSequence = 0;
  private status: NationalGridRendererSnapshot["status"] = "initializing";
  private runtimeError: string | undefined;
  private peakGpuResourceBytes = 0;
  private uploadCount = 0;
  private uploadBytes = 0;
  private maximumUploadSliceMs = 0;
  private paintReceipt: NationalPaintReceipt | undefined;
  private contextListenersAttached = false;
  private styleListenerAttached = false;
  private recovering = false;
  private rehydrationToken = 0;
  private readonly uploadBudgetMs: number;
  private readonly uploadFrameBudget: UploadFrameBudget;

  constructor(private readonly options: NationalGridLayerOptions = {}) {
    this.displayMode = options.displayMode ?? "smooth";
    this.uploadBudgetMs = options.uploadBudgetMs ?? DEFAULT_UPLOAD_BUDGET_MS;
    if (this.displayMode !== "smooth" && this.displayMode !== "native") {
      throw new Error("National display mode must be Smooth or Native");
    }
    if (!Number.isFinite(this.uploadBudgetMs) || this.uploadBudgetMs <= 0 || this.uploadBudgetMs > 4) {
      throw new Error("National upload budget must be greater than zero and no more than 4 ms");
    }
    this.uploadFrameBudget = new UploadFrameBudget(this.uploadBudgetMs);
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    this.attachContextListeners(map);
    if (this.styleListenerAttached) {
      map.off("styledata", this.tryReaddAfterContextRestore);
      this.styleListenerAttached = false;
    }
    try {
      this.createSharedResources(gl);
      this.status = this.active ? "recovering" : "ready";
      this.runtimeError = undefined;
      this.emit();
      if (this.active) this.startTimeSlicedRehydration(gl);
      map.triggerRepaint();
    } catch (error) {
      this.fail(error);
      this.deleteSharedResources(gl);
      throw error;
    }
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    try {
      this.completePendingFence(gl);
      if (
        !this.presentationEnabled
        || !this.active
        || !this.program
        || !this.vao
        || !this.paletteTexture
        || !this.uniforms
      ) return;
      if (!presentationIsResident(this.active)) {
        this.map?.triggerRepaint();
        return;
      }
      const state = captureGlState(gl);
      try {
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(this.program);
        gl.bindVertexArray(this.vao);
        gl.uniformMatrix4fv(this.uniforms.matrix, false, options.defaultProjectionData.mainMatrix);
        gl.uniform1i(this.uniforms.rawCodes, 0);
        gl.uniform1i(this.uniforms.palette, 1);
        gl.uniform1i(this.uniforms.smooth, this.displayMode === "smooth" ? 1 : 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.paletteTexture);
        if (
          this.fallback
          && presentationUsesCommonFallback(this.active.manifest.presentationFactor)
        ) {
          this.drawPresentation(gl, this.fallback, this.active.coverage);
        }
        this.drawPresentation(gl, this.active, null);
        this.drawSequence += 1;
        if (this.fallback && !presentationIsResident(this.fallback)) {
          this.map?.triggerRepaint();
          return;
        }
        if (!this.pendingPaint && !receiptMatches(this.paintReceipt, this.active, this.contextEpoch)) {
          const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
          if (!sync) throw new Error("National renderer could not allocate a GPU completion fence");
          this.pendingPaint = {
            sync,
            resources: this.active,
            mutation: this.pendingResidencyMutation,
            drawSequence: this.drawSequence,
          };
          gl.flush();
          this.map?.triggerRepaint();
        }
      } finally {
        restoreGlState(gl, state);
      }
    } catch (error) {
      if (this.pendingPaint) this.rollbackPendingCommit(error);
      else if (this.pendingResidencyMutation) {
        this.rollbackResidencyMutation(this.pendingResidencyMutation, error);
      }
      this.fail(error);
    }
  }

  onRemove(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    const contextLost = gl.isContextLost();
    if (contextLost) {
      this.beginRecovery();
      this.dropGpuHandlesForLostContext();
      this.gl = null;
      this.emit();
      return;
    }
    this.rehydrationToken += 1;
    this.rollbackStaging();
    const waiter = this.paintWaiter;
    this.paintWaiter = null;
    if (waiter) {
      globalThis.clearTimeout(waiter.timeout);
      waiter.reject(new Error("National renderer was removed before paint completed"));
    }
    this.pendingResidencyMutation = null;
    const uncommitted = this.awaitingExternalCommit?.mutation;
    if (uncommitted) {
      this.restoreResidencyState(uncommitted.previous);
      for (const added of uniquePresentations(uncommitted.added)) {
        if (!this.presentationIsReferenced(added)) this.deletePresentation(gl, added);
      }
      this.awaitingExternalCommit = null;
    }
    for (const presentation of this.allResidentPresentations()) {
      this.deletePresentation(gl, presentation);
    }
    this.active = null;
    this.fallback = null;
    this.residents.clear();
    this.timelineObservationIds = [];
    this.playbackQualityFactor = undefined;
    this.deleteSharedResources(gl);
    this.detachContextListeners(map);
    this.gl = null;
    this.map = null;
    this.status = "removed";
    this.emit();
  }

  beginStaging(
    manifest: PackedGridManifest,
    coverage: NationalViewportCoverage,
  ): void {
    if (!this.gl || !this.program) throw new Error("National renderer is not ready for staging");
    if (
      this.recovering
      || this.paintWaiter
      || this.staging
      || this.pendingPaint
      || this.pendingResidencyMutation
      || this.awaitingExternalCommit
    ) {
      throw new Error("National renderer already owns an uncommitted presentation");
    }
    assertCoverageMatchesManifest(manifest, coverage);
    this.staging = {
      manifest,
      coverage,
      chunks: new Map(),
      stagingStartedAt: performance.now(),
      stagingDurationMs: 0,
      maximumUploadSliceMs: 0,
      uploadedBytes: 0,
    };
    this.status = "staging";
    this.runtimeError = undefined;
    this.emit();
  }

  async uploadStagedChunk(chunk: PackedGridChunk): Promise<void> {
    const staging = this.requireStagingForChunk(chunk);
    if (staging.chunks.has(chunk.descriptor.index)) {
      throw new Error(`National chunk ${chunk.descriptor.index} was staged twice`);
    }
    const gl = this.gl;
    if (!gl || gl.isContextLost()) throw new Error("National renderer lost its WebGL context during upload");
    const { texture, maximumSliceMs } = await uploadRawTextureTimeSliced(
      gl,
      chunk,
      this.uploadFrameBudget,
      () => this.staging === staging && this.gl === gl && !gl.isContextLost(),
      "National chunk upload",
    );
    if (this.staging !== staging) {
      gl.deleteTexture(texture);
      throw new Error("National staging was cancelled before upload");
    }
    const resource: GpuChunk = {
      packed: chunk,
      texture,
      gpuBytes: chunk.rawCodes.byteLength,
    };
    staging.chunks.set(chunk.descriptor.index, resource);
    staging.maximumUploadSliceMs = Math.max(staging.maximumUploadSliceMs, maximumSliceMs);
    staging.uploadedBytes += resource.gpuBytes;
    this.maximumUploadSliceMs = Math.max(this.maximumUploadSliceMs, maximumSliceMs);
    this.uploadCount += 1;
    this.uploadBytes += resource.gpuBytes;
    this.peakGpuResourceBytes = Math.max(this.peakGpuResourceBytes, this.currentGpuBytes());
    this.emit();
  }

  commitStaging(): Promise<NationalPaintReceipt> {
    const staging = this.requireCompleteStaging();
    const identity = nationalObservationIdentity(staging.manifest);
    const alreadyResident = this.residents.has(identity.observationId);
    const timeline = alreadyResident
      ? [...this.timelineObservationIds]
      : [identity.observationId];
    // Staged frames commit into the common slot, so the selection must use
    // the common-slot selector (4) regardless of the manifest's native
    // presentation factor.
    return this.commitStagedResidency(
      timeline,
      identity.observationId,
      4,
      !alreadyResident,
      false,
    );
  }

  commitInitialHistoryStaging(): Promise<NationalPaintReceipt> {
    const staging = this.requireCompleteStaging();
    const identity = nationalObservationIdentity(staging.manifest);
    return this.commitStagedResidency(
      [identity.observationId],
      identity.observationId,
      4,
      true,
      true,
    );
  }

  commitHistoryStaging(
    timelineObservationIds: readonly string[],
    selectedObservationId: string,
    selectedPresentationFactor = 4,
    deferExternalCommit = false,
  ): Promise<NationalPaintReceipt> {
    this.requireCompleteStaging();
    return this.commitStagedResidency(
      timelineObservationIds,
      selectedObservationId,
      selectedPresentationFactor,
      false,
      deferExternalCommit,
    );
  }

  finalizeHistoryMutation(receipt: NationalPaintReceipt): void {
    const pending = this.requireExternalMutation(receipt);
    if (this.gl && !this.gl.isContextLost()) {
      for (const retired of uniquePresentations(pending.mutation.retireOnSuccess)) {
        if (!this.presentationIsReferenced(retired)) this.deletePresentation(this.gl, retired);
      }
    }
    this.awaitingExternalCommit = null;
    this.emit();
  }

  rollbackHistoryMutation(
    receipt: NationalPaintReceipt,
  ): Promise<NationalPaintReceipt | undefined> {
    const pending = this.requireExternalMutation(receipt);
    this.restoreResidencyState(pending.mutation.previous);
    if (this.gl && !this.gl.isContextLost()) {
      for (const added of uniquePresentations(pending.mutation.added)) {
        if (!this.presentationIsReferenced(added)) this.deletePresentation(this.gl, added);
      }
    }
    this.awaitingExternalCommit = null;
    this.paintReceipt = undefined;
    this.status = "ready";
    this.map?.triggerRepaint();
    this.emit();
    if (!this.active) return Promise.resolve(undefined);
    return this.waitForCommittedPaint(PAINT_TIMEOUT_MS, "National rollback paint receipt timed out");
  }

  commitPrefetchedStaging(timelineObservationIds: readonly string[]): void {
    const staging = this.requireCompleteStaging();
    const identity = nationalObservationIdentity(staging.manifest);
    // Prefetch is additive residency: it must never retire the presentation
    // that is currently painting. The selected observation may prefetch new
    // detail while its complete common level is active (motion-first playback
    // paints the upgrade later, with a receipt, through frame selection), but
    // replacing an active detail presentation without a paint is forbidden.
    if (
      identity.observationId === this.getSnapshot().selectedObservationId
      && this.active
      && this.active.manifest.presentationFactor !== 4
    ) {
      throw new Error("selected National detail requires an authoritative paint receipt");
    }
    const previous = this.captureResidencyState();
    const { residents, retireOnSuccess } = this.residentsWithStaging(
      previous.residents,
      staging,
      timelineObservationIds,
      false,
      "detail",
    );
    this.residents = residents;
    this.timelineObservationIds = [...timelineObservationIds];
    this.staging = null;
    const transientGpuBytes = this.currentGpuBytes(retireOnSuccess);
    if (transientGpuBytes > NATIONAL_GPU_HARD_CEILING_BYTES) {
      this.restoreResidencyState(previous);
      this.staging = staging;
      throw new Error("National prefetched detail exceeds the 256 MiB hard ceiling");
    }
    if (this.gl && !this.gl.isContextLost()) {
      for (const retired of uniquePresentations(retireOnSuccess)) {
        if (!this.presentationIsReferenced(retired)) this.deletePresentation(this.gl, retired);
      }
    }
    this.peakGpuResourceBytes = Math.max(this.peakGpuResourceBytes, transientGpuBytes);
    this.status = this.active ? "painted" : "ready";
    this.emit();
  }

  selectResidentAndWait(
    observationId: string,
    presentationFactor = this.playbackQualityFactor ?? 4,
  ): Promise<NationalPaintReceipt> {
    if (
      this.recovering
      || this.paintWaiter
      || this.pendingPaint
      || this.pendingResidencyMutation
      || this.awaitingExternalCommit
    ) {
      return Promise.reject(new Error("National renderer already owns an uncommitted paint"));
    }
    const selected = this.presentationFor(observationId, presentationFactor);
    if (
      selected === this.active
      && receiptMatches(this.paintReceipt, selected, this.contextEpoch)
    ) {
      return Promise.resolve(this.paintReceipt!);
    }
    const previous = this.captureResidencyState();
    this.active = selected;
    this.fallback = presentationFactor === 4
      ? null
      : this.presentationFor(observationId, 4);
    this.paintReceipt = undefined;
    this.status = "ready";
    this.pendingResidencyMutation = {
      previous,
      added: [],
      retireOnSuccess: [],
      deferExternalCommit: false,
    };
    this.map?.triggerRepaint();
    return this.waitForCommittedPaint(PAINT_TIMEOUT_MS, "National paint receipt timed out");
  }

  setPlaybackQualityLock(presentationFactor: number | undefined): void {
    if (
      presentationFactor !== undefined
      && presentationFactor !== 4
      && presentationFactor !== this.finestCompletePlaybackFactor()
    ) {
      throw new Error(`National playback factor ${presentationFactor} is not complete for every observation`);
    }
    this.playbackQualityFactor = presentationFactor;
    this.emit();
  }

  finestCompletePlaybackFactor(): 1 | 2 | 4 {
    return commonPlaybackDetailFactor(this.residents, this.timelineObservationIds) ?? 4;
  }

  projectedUniformDetailGpuBytes(
    observationId: string,
    presentationFactor: 1 | 2,
  ): number {
    const resident = this.residents.get(observationId);
    const detail = resident?.detail;
    if (
      !detail
      || detail.manifest.presentationFactor !== presentationFactor
      || !presentationIsResident(detail)
    ) {
      throw new Error(
        `National observation ${observationId} lacks resident factor-${presentationFactor} detail`,
      );
    }
    const commonBytes = this.timelineObservationIds.reduce((total, timelineId) => {
      const common = this.residents.get(timelineId)?.common;
      if (!common || !presentationIsResident(common)) {
        throw new Error(`National observation ${timelineId} lacks complete common residency`);
      }
      return total + residentGpuBytes(common);
    }, 0);
    const sharedBytes = (this.paletteTexture ? PALETTE_WIDTH * 4 : 0)
      + (this.quadBuffer ? 12 * 4 : 0);
    return commonBytes
      + residentGpuBytes(detail) * this.timelineObservationIds.length
      + sharedBytes;
  }

  /**
   * Wait until no frame paint or paint waiter is in flight. Residency
   * mutations that bypass the paint path (prefetch commits) call this so a
   * concurrent motion paint's captured rollback state can never be made
   * stale by a mid-fence residency change.
   */
  async waitForPaintQuiescence(timeoutMs = 10_000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new RangeError("National paint quiescence wait must be between 100 and 120000 ms");
    }
    const started = performance.now();
    while (this.pendingPaint || this.paintWaiter) {
      if (performance.now() - started > timeoutMs) {
        throw new Error("National paint quiescence wait timed out");
      }
      await nextAnimationFrame();
    }
  }

  async waitForCommonResidency(timeoutMs = 60_000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new RangeError("National residency wait must be between 100 and 120000 ms");
    }
    const started = performance.now();
    while (true) {
      const snapshot = this.getSnapshot();
      if (commonResidencyReadyForSelection(snapshot)) return;
      if (snapshot.status === "error" || snapshot.status === "removed") {
        throw new Error(snapshot.error ?? "National renderer cannot restore common residency");
      }
      if (performance.now() - started > timeoutMs) {
        throw new Error("National common residency recovery timed out");
      }
      await nextAnimationFrame();
    }
  }

  async waitForAuthoritativeReceipt(
    expected: NationalPaintReceipt,
    timeoutMs = 60_000,
  ): Promise<NationalPaintReceipt> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new RangeError("National receipt wait must be between 100 and 120000 ms");
    }
    const started = performance.now();
    while (true) {
      const snapshot = this.getSnapshot();
      const receipt = snapshot.paintReceipt;
      if (
        snapshot.status === "painted"
        && !snapshot.mutationAwaitingCommit
        && receipt
        && sameNationalPresentationReceipt(receipt, expected)
      ) return receipt;
      if (snapshot.status === "error" || snapshot.status === "removed") {
        throw new Error(snapshot.error ?? "National renderer cannot produce an authoritative receipt");
      }
      if (performance.now() - started > timeoutMs) {
        throw new Error("National authoritative receipt recovery timed out");
      }
      await nextAnimationFrame();
    }
  }

  pruneDetailResidency(keepObservationIds: readonly string[]): void {
    const keep = new Set(keepObservationIds);
    const selected = this.getSnapshot().selectedObservationId;
    for (const [observationId, resident] of this.residents) {
      if (!resident.detail || keep.has(observationId)) continue;
      if (observationId === selected && this.active === resident.detail) {
        throw new Error("cannot prune the selected detailed National presentation");
      }
      const detail = resident.detail;
      this.residents.set(observationId, { ...resident, detail: null });
      if (this.gl && !this.gl.isContextLost()) this.deletePresentation(this.gl, detail);
    }
    this.emit();
  }

  rollbackStaging(): void {
    const staging = this.staging;
    this.staging = null;
    if (staging && this.gl && !this.gl.isContextLost()) this.deletePresentation(this.gl, staging);
    if (this.status === "staging") this.status = this.active ? "painted" : "ready";
    this.emit();
  }

  setDisplayMode(mode: RadarDisplayMode): void {
    if (mode !== "smooth" && mode !== "native") throw new Error("unsupported radar display mode");
    if (mode === this.displayMode) return;
    this.displayMode = mode;
    this.map?.triggerRepaint();
    this.emit();
  }

  setPresentationEnabled(enabled: boolean): void {
    if (enabled === this.presentationEnabled) return;
    this.presentationEnabled = enabled;
    this.map?.triggerRepaint();
    this.emit();
  }

  getSnapshot(): NationalGridRendererSnapshot {
    const identity = this.active ? nationalObservationIdentity(this.active.manifest) : undefined;
    const residentObservationIds = this.timelineObservationIds.filter((observationId) => (
      this.residents.has(observationId)
    ));
    const commonResidentObservationIds = residentObservationIds.filter((observationId) => {
      const common = this.residents.get(observationId)?.common;
      return Boolean(common && presentationIsResident(common));
    });
    const detailedObservationIds = residentObservationIds.filter((observationId) => {
      const detail = this.residents.get(observationId)?.detail;
      return Boolean(detail && presentationIsResident(detail));
    });
    const residentPresentations = this.allResidentPresentations();
    return {
      status: this.status,
      displayMode: this.displayMode,
      presentationEnabled: this.presentationEnabled,
      contextEpoch: this.contextEpoch,
      generation: identity?.generation,
      observationId: identity?.observationId,
      observationTimeUnixMs: identity?.observationTimeUnixMs,
      presentationFactor: this.active?.manifest.presentationFactor,
      fallbackPresentationFactor: this.fallback?.manifest.presentationFactor,
      fallbackChunkCount: this.fallback && this.fallback !== this.active
        ? residentChunkCount(this.fallback)
        : 0,
      coverageVersion: this.active?.coverage.version,
      coverageComplete: Boolean(this.active) && presentationIsResident(this.active!),
      residentChunkCount: residentPresentations.reduce(
        (total, presentation) => total + residentChunkCount(presentation),
        0,
      ),
      residentObservationIds,
      commonResidentObservationIds,
      detailedObservationIds,
      selectedObservationId: identity?.observationId,
      playbackQualityFactor: this.playbackQualityFactor,
      mutationAwaitingCommit: this.awaitingExternalCommit !== null,
      stagedChunkCount: this.staging?.chunks.size ?? 0,
      gpuResourceBytes: this.currentGpuBytes(),
      peakGpuResourceBytes: this.peakGpuResourceBytes,
      uploadCount: this.uploadCount,
      uploadBytes: this.uploadBytes,
      maximumUploadSliceMs: this.maximumUploadSliceMs,
      paintReceipt: this.paintReceipt,
      error: this.runtimeError,
    };
  }

  async simulateContextResetForTest(holdMs = 100): Promise<NationalPaintReceipt> {
    if (!Number.isSafeInteger(holdMs) || holdMs < 50 || holdMs > 5_000) {
      throw new Error("context reset hold must be an integer from 50 to 5000 ms");
    }
    const gl = this.gl;
    if (!gl) throw new Error("National renderer has no active WebGL context");
    const extension = gl.getExtension("WEBGL_lose_context");
    if (!extension) throw new Error("WEBGL_lose_context is unavailable");
    const receipt = this.waitForNextPaint();
    extension.loseContext();
    this.beginRecovery();
    globalThis.setTimeout(() => extension.restoreContext(), holdMs);
    return receipt;
  }

  private waitForNextPaint(): Promise<NationalPaintReceipt> {
    if (this.paintWaiter) throw new Error("a National paint waiter is already active");
    this.paintReceipt = undefined;
    return new Promise((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        if (this.paintWaiter?.timeout === timeout) this.paintWaiter = null;
        reject(new Error("National recovery paint receipt timed out"));
      }, RECOVERY_PAINT_TIMEOUT_MS);
      this.paintWaiter = { resolve, reject, timeout };
    });
  }

  private drawPresentation(
    gl: WebGL2RenderingContext,
    presentation: PresentationResources,
    exclusion: NationalViewportCoverage | null,
  ) {
    if (!this.uniforms) return;
    gl.uniform2f(
      this.uniforms.firstLonLat,
      presentation.manifest.firstLongitudeDegrees,
      presentation.manifest.firstLatitudeDegrees,
    );
    gl.uniform2f(
      this.uniforms.stepLonLat,
      presentation.manifest.longitudeStepDegrees,
      presentation.manifest.latitudeStepDegrees,
    );
    gl.uniform1ui(this.uniforms.missingRaw, presentation.manifest.missingRaw);
    gl.uniform1ui(this.uniforms.noCoverageRaw, presentation.manifest.noCoverageRaw);
    gl.uniform1i(this.uniforms.excludeCoverage, exclusion ? 1 : 0);
    gl.uniform4f(
      this.uniforms.exclusionBounds,
      exclusion?.west ?? 0,
      exclusion?.south ?? 0,
      exclusion?.east ?? 0,
      exclusion?.north ?? 0,
    );
    for (const resource of presentation.chunks.values()) {
      this.drawChunk(gl, presentation, resource);
    }
  }

  private drawChunk(
    gl: WebGL2RenderingContext,
    presentation: PresentationResources,
    resource: GpuChunk,
  ) {
    if (!this.uniforms) return;
    const descriptor = resource.packed.descriptor;
    const manifest = presentation.manifest;
    const halfLongitudeStep = manifest.longitudeStepDegrees / 2;
    const halfLatitudeStep = manifest.latitudeStepDegrees / 2;
    const west = manifest.firstLongitudeDegrees
      + descriptor.interiorX * manifest.longitudeStepDegrees
      - halfLongitudeStep;
    const east = manifest.firstLongitudeDegrees
      + (descriptor.interiorX + descriptor.interiorWidth - 1) * manifest.longitudeStepDegrees
      + halfLongitudeStep;
    const north = manifest.firstLatitudeDegrees
      - descriptor.interiorY * manifest.latitudeStepDegrees
      + halfLatitudeStep;
    const south = manifest.firstLatitudeDegrees
      - (descriptor.interiorY + descriptor.interiorHeight - 1) * manifest.latitudeStepDegrees
      - halfLatitudeStep;
    const northwest = maplibregl.MercatorCoordinate.fromLngLat([west, north]);
    const southeast = maplibregl.MercatorCoordinate.fromLngLat([east, south]);
    gl.uniform4f(
      this.uniforms.mercatorBounds,
      northwest.x,
      northwest.y,
      southeast.x,
      southeast.y,
    );
    gl.uniform2f(this.uniforms.haloOrigin, descriptor.haloX, descriptor.haloY);
    gl.uniform4f(
      this.uniforms.interiorBounds,
      descriptor.interiorX,
      descriptor.interiorY,
      descriptor.interiorX + descriptor.interiorWidth - 1,
      descriptor.interiorY + descriptor.interiorHeight - 1,
    );
    gl.activeTexture(gl.TEXTURE0);
    if (!resource.texture) return;
    gl.bindTexture(gl.TEXTURE_2D, resource.texture);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private completePendingFence(gl: WebGL2RenderingContext) {
    const pending = this.pendingPaint;
    if (!pending) return;
    const result = gl.clientWaitSync(pending.sync, 0, 0);
    if (result === gl.TIMEOUT_EXPIRED) {
      this.map?.triggerRepaint();
      return;
    }
    gl.deleteSync(pending.sync);
    this.pendingPaint = null;
    if (result === gl.WAIT_FAILED) {
      throw new Error("National GPU completion fence failed");
    }
    if (this.active !== pending.resources) return;
    const identity = nationalObservationIdentity(pending.resources.manifest);
    const receipt: NationalPaintReceipt = {
      generation: identity.generation,
      observationId: identity.observationId,
      observationTimeUnixMs: identity.observationTimeUnixMs,
      contentSha256: identity.contentSha256,
      presentationFactor: pending.resources.manifest.presentationFactor,
      coverageVersion: pending.resources.coverage.version,
      coverageKind: pending.resources.coverage.kind,
      requiredChunkCount: pending.resources.coverage.requiredChunkIndices.length,
      contextEpoch: this.contextEpoch,
      drawSequence: pending.drawSequence,
      completedAtUnixMs: Date.now(),
      stagingDurationMs: pending.resources.stagingDurationMs,
      maximumUploadSliceMs: pending.resources.maximumUploadSliceMs,
      uploadedBytes: pending.resources.uploadedBytes,
      framebufferWidth: gl.drawingBufferWidth,
      framebufferHeight: gl.drawingBufferHeight,
    };
    this.paintReceipt = receipt;
    this.status = "painted";
    this.recovering = false;
    if (pending.mutation) {
      if (pending.mutation.deferExternalCommit) {
        this.awaitingExternalCommit = { mutation: pending.mutation, receipt };
      } else {
        for (const retired of uniquePresentations(pending.mutation.retireOnSuccess)) {
          if (!this.presentationIsReferenced(retired)) this.deletePresentation(gl, retired);
        }
      }
    }
    this.pendingResidencyMutation = null;
    const waiter = this.paintWaiter;
    this.paintWaiter = null;
    if (waiter) {
      globalThis.clearTimeout(waiter.timeout);
      waiter.resolve(receipt);
    }
    this.emit();
  }

  private requireStagingForChunk(chunk: PackedGridChunk): PresentationResources {
    const staging = this.staging;
    if (!staging) throw new Error("National renderer has no active staging transaction");
    const expected = staging.manifest.chunks[chunk.descriptor.index];
    if (
      !expected
      || !staging.coverage.requiredChunkIndices.includes(chunk.descriptor.index)
      || chunk.generation !== staging.manifest.generation
      || chunk.observationTimeUnixMs !== staging.manifest.observationTimeUnixMs
      || chunk.contentSha256 !== staging.manifest.contentSha256
      || chunk.presentationFactor !== staging.manifest.presentationFactor
      || JSON.stringify(chunk.descriptor) !== JSON.stringify(expected)
    ) {
      throw new Error("National chunk does not match the staged presentation identity");
    }
    return staging;
  }

  private requireCompleteStaging(): PresentationResources {
    const staging = this.staging;
    if (!staging || !this.gl) throw new Error("National renderer has no staged presentation");
    const required = assertCoverageMatchesManifest(staging.manifest, staging.coverage);
    if (required.some((descriptor) => !staging.chunks.has(descriptor.index))) {
      throw new Error("National renderer cannot commit incomplete viewport coverage");
    }
    staging.stagingDurationMs = performance.now() - staging.stagingStartedAt;
    return staging;
  }

  private commitStagedResidency(
    timelineObservationIds: readonly string[],
    selectedObservationId: string,
    selectedPresentationFactor: number,
    replaceAll: boolean,
    deferExternalCommit: boolean,
  ): Promise<NationalPaintReceipt> {
    if (
      this.paintWaiter
      || this.pendingPaint
      || this.pendingResidencyMutation
      || this.awaitingExternalCommit
    ) {
      throw new Error("National renderer cannot commit residency during an unfinished paint");
    }
    const staging = this.requireCompleteStaging();
    validateResidentTimeline(timelineObservationIds, selectedObservationId);
    const previous = this.captureResidencyState();
    const { residents, retireOnSuccess } = this.residentsWithStaging(
      previous.residents,
      staging,
      timelineObservationIds,
      replaceAll,
      "common",
    );
    this.residents = residents;
    this.timelineObservationIds = [...timelineObservationIds];
    this.active = presentationFromResidents(
      residents,
      selectedObservationId,
      selectedPresentationFactor,
    );
    this.fallback = selectedPresentationFactor === 4
      ? null
      : presentationFromResidents(residents, selectedObservationId, 4);
    this.staging = null;
    this.paintReceipt = undefined;
    this.status = "ready";
    this.pendingPaint = null;
    this.pendingResidencyMutation = {
      previous,
      added: [staging],
      retireOnSuccess,
      deferExternalCommit,
    };
    if (this.currentGpuBytes() > NATIONAL_GPU_HARD_CEILING_BYTES) {
      this.restoreResidencyState(previous);
      this.pendingResidencyMutation = null;
      this.staging = staging;
      throw new Error("National resident working set exceeds the 256 MiB hard ceiling");
    }
    this.peakGpuResourceBytes = Math.max(this.peakGpuResourceBytes, this.currentGpuBytes());
    this.map?.triggerRepaint();
    return this.waitForCommittedPaint(PAINT_TIMEOUT_MS, "National paint receipt timed out");
  }

  private residentsWithStaging(
    priorResidents: Map<string, ResidentObservation>,
    staging: PresentationResources,
    timelineObservationIds: readonly string[],
    replaceAll: boolean,
    slot: "common" | "detail",
  ): { residents: Map<string, ResidentObservation>; retireOnSuccess: PresentationResources[] } {
    const residents = replaceAll
      ? new Map<string, ResidentObservation>()
      : cloneResidents(priorResidents);
    const retireOnSuccess: PresentationResources[] = [];
    if (replaceAll) {
      retireOnSuccess.push(...presentationsFromResidents(priorResidents));
    }
    const identity = nationalObservationIdentity(staging.manifest);
    const prior = residents.get(identity.observationId) ?? { common: null, detail: null };
    if (slot === "common") {
      if (prior.common && prior.common !== staging) retireOnSuccess.push(prior.common);
      if (prior.detail) retireOnSuccess.push(prior.detail);
      residents.set(identity.observationId, { common: staging, detail: null });
    } else {
      if (prior.detail && prior.detail !== staging) retireOnSuccess.push(prior.detail);
      residents.set(identity.observationId, { ...prior, detail: staging });
    }
    const keep = new Set(timelineObservationIds);
    for (const [observationId, resident] of [...residents]) {
      if (keep.has(observationId)) continue;
      if (resident.common) retireOnSuccess.push(resident.common);
      if (resident.detail) retireOnSuccess.push(resident.detail);
      residents.delete(observationId);
    }
    for (const observationId of timelineObservationIds) {
      if (!residents.get(observationId)?.common) {
        throw new Error(`National timeline observation ${observationId} lacks a complete common level`);
      }
    }
    return { residents, retireOnSuccess };
  }

  private presentationFor(
    observationId: string,
    presentationFactor: number,
  ): PresentationResources {
    return presentationFromResidents(this.residents, observationId, presentationFactor);
  }

  private captureResidencyState(): RendererResidencyState {
    return {
      residents: cloneResidents(this.residents),
      timelineObservationIds: [...this.timelineObservationIds],
      active: this.active,
      fallback: this.fallback,
      playbackQualityFactor: this.playbackQualityFactor,
    };
  }

  private restoreResidencyState(state: RendererResidencyState): void {
    this.residents = cloneResidents(state.residents);
    this.timelineObservationIds = [...state.timelineObservationIds];
    this.active = state.active;
    this.fallback = state.fallback;
    this.playbackQualityFactor = state.playbackQualityFactor;
  }

  private requireExternalMutation(receipt: NationalPaintReceipt): AwaitingExternalCommit {
    const pending = this.awaitingExternalCommit;
    if (!pending || !sameReceiptIdentity(pending.receipt, receipt)) {
      throw new Error("National history mutation receipt is not awaiting backend commit");
    }
    return pending;
  }

  private waitForCommittedPaint(timeoutMs: number, message: string): Promise<NationalPaintReceipt> {
    return new Promise((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        if (this.paintWaiter?.timeout !== timeout) return;
        this.paintWaiter = null;
        if (this.pendingPaint && this.gl && !this.gl.isContextLost()) {
          this.gl.deleteSync(this.pendingPaint.sync);
          this.pendingPaint = null;
        }
        this.rollbackResidencyMutation(this.pendingResidencyMutation, new Error(message));
        reject(new Error(message));
      }, timeoutMs);
      this.paintWaiter = { resolve, reject, timeout };
    });
  }

  private allResidentPresentations(): PresentationResources[] {
    return presentationsFromResidents(this.residents);
  }

  private presentationIsReferenced(presentation: PresentationResources): boolean {
    return this.allResidentPresentations().includes(presentation)
      || this.staging === presentation;
  }

  private createSharedResources(gl: WebGL2RenderingContext) {
    this.program = createProgram(gl);
    this.uniforms = resolveUniforms(gl, this.program);
    this.vao = gl.createVertexArray();
    this.quadBuffer = gl.createBuffer();
    if (!this.vao || !this.quadBuffer) throw new Error("National renderer could not allocate quad geometry");
    const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const previousBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0, 1, 0, 0, 1,
      0, 1, 1, 0, 1, 1,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(previousVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, previousBuffer);
    this.paletteTexture = uploadPalette(gl);
  }

  private startTimeSlicedRehydration(gl: WebGL2RenderingContext) {
    const token = this.rehydrationToken + 1;
    this.rehydrationToken = token;
    const presentations = uniquePresentations([
      ...(this.active ? [this.active] : []),
      ...(this.fallback ? [this.fallback] : []),
      ...this.allResidentPresentations(),
    ]);
    this.paintReceipt = undefined;
    void (async () => {
      for (const presentation of presentations) {
        for (const resource of presentation.chunks.values()) {
          if (resource.texture) continue;
          if (
            token !== this.rehydrationToken
            || this.gl !== gl
            || gl.isContextLost()
          ) return;
          const { texture, maximumSliceMs } = await uploadRawTextureTimeSliced(
            gl,
            resource.packed,
            this.uploadFrameBudget,
            () => token === this.rehydrationToken && this.gl === gl && !gl.isContextLost(),
            "National recovery chunk upload",
          );
          resource.texture = texture;
          this.maximumUploadSliceMs = Math.max(this.maximumUploadSliceMs, maximumSliceMs);
          this.uploadCount += 1;
          this.uploadBytes += resource.gpuBytes;
          this.peakGpuResourceBytes = Math.max(this.peakGpuResourceBytes, this.currentGpuBytes());
          this.emit();
          this.map?.triggerRepaint();
        }
      }
      if (token === this.rehydrationToken) this.map?.triggerRepaint();
    })().catch((error) => {
      if (token === this.rehydrationToken) this.fail(error);
    });
  }

  private deletePresentation(gl: WebGL2RenderingContext, resources: PresentationResources | null) {
    if (!resources) return;
    for (const chunk of resources.chunks.values()) {
      if (chunk.texture) gl.deleteTexture(chunk.texture);
    }
    resources.chunks.clear();
  }

  private deleteSharedResources(gl: WebGL2RenderingContext) {
    if (this.pendingPaint) gl.deleteSync(this.pendingPaint.sync);
    this.pendingPaint = null;
    if (this.paletteTexture) gl.deleteTexture(this.paletteTexture);
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.paletteTexture = null;
    this.quadBuffer = null;
    this.vao = null;
    this.program = null;
    this.uniforms = null;
  }

  private rollbackPendingCommit(error: unknown) {
    const pending = this.pendingPaint;
    if (!pending) return;
    if (this.gl && !this.gl.isContextLost()) this.gl.deleteSync(pending.sync);
    this.pendingPaint = null;
    this.rollbackResidencyMutation(pending.mutation, error);
  }

  private rollbackResidencyMutation(
    mutation: PendingResidencyMutation | null,
    error: unknown,
  ) {
    if (mutation) {
      const failedPresentations = uniquePresentations(mutation.added);
      this.restoreResidencyState(mutation.previous);
      if (this.gl && !this.gl.isContextLost()) {
        for (const failed of failedPresentations) {
          if (!this.presentationIsReferenced(failed)) this.deletePresentation(this.gl, failed);
        }
      }
    }
    this.pendingResidencyMutation = null;
    this.paintReceipt = undefined;
    const waiter = this.paintWaiter;
    this.paintWaiter = null;
    if (waiter) {
      globalThis.clearTimeout(waiter.timeout);
      waiter.reject(asError(error));
    }
    this.map?.triggerRepaint();
  }

  private beginRecovery() {
    if (this.recovering) return;
    this.recovering = true;
    const interruptedMutation = this.pendingPaint?.mutation
      ?? this.pendingResidencyMutation
      ?? this.awaitingExternalCommit?.mutation;
    if (interruptedMutation) {
      this.restoreResidencyState(interruptedMutation.previous);
      const waiter = this.paintWaiter;
      this.paintWaiter = null;
      if (waiter) {
        globalThis.clearTimeout(waiter.timeout);
        waiter.reject(new Error("National working-set mutation was cancelled by context loss"));
      }
    }
    this.pendingPaint = null;
    this.pendingResidencyMutation = null;
    this.awaitingExternalCommit = null;
    this.contextEpoch += 1;
    this.status = "recovering";
    this.paintReceipt = undefined;
    this.rollbackStaging();
    this.runtimeError = undefined;
  }

  private dropGpuHandlesForLostContext() {
    this.rehydrationToken += 1;
    for (const presentation of uniquePresentations([
      ...this.allResidentPresentations(),
      ...(this.staging ? [this.staging] : []),
    ])) {
      if (!presentation) continue;
      for (const chunk of presentation.chunks.values()) chunk.texture = null;
    }
    if (this.pendingPaint) this.pendingPaint = null;
    this.program = null;
    this.vao = null;
    this.quadBuffer = null;
    this.paletteTexture = null;
    this.uniforms = null;
  }

  private readonly handleContextLost = () => {
    this.beginRecovery();
    this.emit();
  };

  private readonly handleContextRestored = () => {
    if (!this.map || !this.recovering) return;
    if (!this.styleListenerAttached) {
      this.map.on("styledata", this.tryReaddAfterContextRestore);
      this.styleListenerAttached = true;
    }
    this.tryReaddAfterContextRestore();
  };

  private readonly tryReaddAfterContextRestore = () => {
    const map = this.map;
    if (!map || !this.recovering) return;
    try {
      if (!map.getLayer(this.id)) {
        const preferred = this.options.recoveryBeforeLayerId;
        const beforeId = preferred && map.getLayer(preferred)
          ? preferred
          : map.getStyle().layers?.find((layer) => layer.type === "symbol")?.id;
        map.addLayer(this, beforeId);
      }
    } catch {
      // MapLibre rebuilds its style asynchronously after context restoration.
    }
  };

  private attachContextListeners(map: MapLibreMap) {
    if (this.contextListenersAttached) return;
    map.on("webglcontextlost", this.handleContextLost);
    map.on("webglcontextrestored", this.handleContextRestored);
    this.contextListenersAttached = true;
  }

  private detachContextListeners(map: MapLibreMap) {
    if (this.styleListenerAttached) {
      map.off("styledata", this.tryReaddAfterContextRestore);
      this.styleListenerAttached = false;
    }
    if (!this.contextListenersAttached) return;
    map.off("webglcontextlost", this.handleContextLost);
    map.off("webglcontextrestored", this.handleContextRestored);
    this.contextListenersAttached = false;
  }

  private currentGpuBytes(extraPresentations: readonly PresentationResources[] = []) {
    const owned = uniquePresentations([
      ...this.allResidentPresentations(),
      ...(this.staging ? [this.staging] : []),
      ...(this.pendingResidencyMutation?.retireOnSuccess ?? []),
      ...(this.awaitingExternalCommit?.mutation.retireOnSuccess ?? []),
      ...extraPresentations,
    ]);
    const resident = owned.reduce(
      (total, presentation) => total + residentGpuBytes(presentation),
      0,
    );
    const shared = (this.paletteTexture ? PALETTE_WIDTH * 4 : 0)
      + (this.quadBuffer ? 12 * 4 : 0);
    return resident + shared;
  }

  private fail(error: unknown) {
    const failure = asError(error);
    this.runtimeError = failure.message;
    this.status = "error";
    const waiter = this.paintWaiter;
    this.paintWaiter = null;
    if (waiter) {
      globalThis.clearTimeout(waiter.timeout);
      waiter.reject(failure);
    }
    this.emit();
  }

  private emit() {
    this.options.onSnapshot?.(this.getSnapshot());
  }
}

export function commonResidencyReadyForSelection(
  snapshot: Pick<
    NationalGridRendererSnapshot,
    | "status"
    | "mutationAwaitingCommit"
    | "paintReceipt"
    | "residentObservationIds"
    | "commonResidentObservationIds"
  >,
): boolean {
  return snapshot.status === "painted"
    && !snapshot.mutationAwaitingCommit
    && snapshot.paintReceipt !== undefined
    && snapshot.residentObservationIds.length > 0
    && snapshot.commonResidentObservationIds.length === snapshot.residentObservationIds.length;
}

export function presentationUsesCommonFallback(presentationFactor: number): boolean {
  return presentationFactor === 1 || presentationFactor === 2;
}

export function commonResidencyReadyForInteraction(
  snapshot: Pick<
    NationalGridRendererSnapshot,
    | "status"
    | "mutationAwaitingCommit"
    | "paintReceipt"
    | "commonResidentObservationIds"
  >,
  retainedObservationCount: number,
): boolean {
  return retainedObservationCount > 0
    && (snapshot.status === "painted" || snapshot.status === "staging")
    && !snapshot.mutationAwaitingCommit
    && snapshot.paintReceipt !== undefined
    && snapshot.commonResidentObservationIds.length === retainedObservationCount;
}

export interface NationalPlaybackDetailResidency {
  observationId: string;
  presentationFactor: number;
  coverage: NationalViewportCoverage;
  complete: boolean;
}

export function completePlaybackDetailFactor(
  timelineObservationIds: readonly string[],
  details: readonly NationalPlaybackDetailResidency[],
): 1 | 2 | undefined {
  if (timelineObservationIds.length < 1) return undefined;
  const byObservation = new Map(details.map((detail) => [detail.observationId, detail]));
  const first = byObservation.get(timelineObservationIds[0]);
  if (
    !first?.complete
    || (first.presentationFactor !== 1 && first.presentationFactor !== 2)
    || first.coverage.kind !== "viewport"
  ) return undefined;
  for (const observationId of timelineObservationIds.slice(1)) {
    const detail = byObservation.get(observationId);
    if (
      !detail?.complete
      || detail.presentationFactor !== first.presentationFactor
      || !samePlaybackCoverage(detail.coverage, first.coverage)
    ) return undefined;
  }
  return first.presentationFactor;
}

function commonPlaybackDetailFactor(
  residents: Map<string, ResidentObservation>,
  timelineObservationIds: readonly string[],
): 1 | 2 | undefined {
  return completePlaybackDetailFactor(
    timelineObservationIds,
    timelineObservationIds.flatMap((observationId) => {
      const detail = residents.get(observationId)?.detail;
      return detail
        ? [{
            observationId,
            presentationFactor: detail.manifest.presentationFactor,
            coverage: detail.coverage,
            complete: presentationIsResident(detail),
          }]
        : [];
    }),
  );
}

function samePlaybackCoverage(
  left: NationalViewportCoverage,
  right: NationalViewportCoverage,
): boolean {
  return left.kind === "viewport"
    && right.kind === "viewport"
    && left.requiredChunkIndices.length === right.requiredChunkIndices.length
    && left.requiredChunkIndices.every((index, position) => (
      index === right.requiredChunkIndices[position]
    ));
}

function cloneResidents(
  residents: Map<string, ResidentObservation>,
): Map<string, ResidentObservation> {
  return new Map(
    [...residents].map(([observationId, resident]) => [
      observationId,
      { ...resident },
    ]),
  );
}

function presentationsFromResidents(
  residents: Map<string, ResidentObservation>,
): PresentationResources[] {
  const presentations: PresentationResources[] = [];
  for (const resident of residents.values()) {
    if (resident.common) presentations.push(resident.common);
    if (resident.detail) presentations.push(resident.detail);
  }
  return uniquePresentations(presentations);
}

function uniquePresentations(
  presentations: readonly PresentationResources[],
): PresentationResources[] {
  return presentations.filter((presentation, index) => presentations.indexOf(presentation) === index);
}

// The numeric selector keeps its historical convention: 4 selects the common
// slot regardless of the common presentation's native manifest factor (which
// is 1 under native residency); 1/2 select a matching detail presentation.
function presentationFromResidents(
  residents: Map<string, ResidentObservation>,
  observationId: string,
  presentationFactor: number,
): PresentationResources {
  const resident = residents.get(observationId);
  const presentation = presentationFactor === 4
    ? resident?.common
    : resident?.detail?.manifest.presentationFactor === presentationFactor
      ? resident.detail
      : null;
  if (!presentation || !presentationIsResident(presentation)) {
    throw new Error(
      `National observation ${observationId} is not complete at factor ${presentationFactor}`,
    );
  }
  return presentation;
}

function validateResidentTimeline(
  timelineObservationIds: readonly string[],
  selectedObservationId: string,
) {
  if (timelineObservationIds.length < 1 || timelineObservationIds.length > 20) {
    throw new Error("National resident timeline must contain 1 to 20 observations");
  }
  const unique = new Set(timelineObservationIds);
  if (unique.size !== timelineObservationIds.length || !unique.has(selectedObservationId)) {
    throw new Error("National resident timeline and selection must be unique and consistent");
  }
}

function presentationIsResident(presentation: PresentationResources): boolean {
  return presentation.coverage.requiredChunkIndices.every(
    (index) => Boolean(presentation.chunks.get(index)?.texture),
  );
}

function residentChunkCount(presentation: PresentationResources): number {
  let count = 0;
  for (const chunk of presentation.chunks.values()) {
    if (chunk.texture) count += 1;
  }
  return count;
}

function residentGpuBytes(presentation: PresentationResources): number {
  let bytes = 0;
  for (const chunk of presentation.chunks.values()) {
    if (chunk.texture) bytes += chunk.gpuBytes;
  }
  return bytes;
}

// Chunk textures are filled in row bands sized from measured upload
// throughput. Bands and whole chunks share one animation frame until the
// measured budget is spent, then the budget yields; the fixed 32-row band and
// its one-band-per-frame yield made a 392-chunk whole-domain presentation cost
// thousands of vsync waits on real 60 Hz displays.
const MINIMUM_UPLOAD_ROWS_PER_SLICE = 32;
// A single non-preemptible upload call must never become a long task even if
// the throughput estimate is badly wrong.
const UPLOAD_SLICE_LONG_TASK_CEILING_MS = 50;

export class UploadFrameBudget {
  private spentMs: number;
  private estimatedMsPerRow: number;

  constructor(private readonly budgetMs: number) {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
      throw new Error("National upload frame budget must be positive");
    }
    // Force a yield before the first slice and start from the conservative
    // legacy assumption of one 32-row band per whole budget.
    this.spentMs = Number.POSITIVE_INFINITY;
    this.estimatedMsPerRow = budgetMs / MINIMUM_UPLOAD_ROWS_PER_SLICE;
  }

  /** Yield to the next animation frame when the current one cannot fit a minimum slice. */
  async yieldIfSpent(): Promise<void> {
    const minimumSliceMs = this.estimatedMsPerRow * MINIMUM_UPLOAD_ROWS_PER_SLICE;
    if (this.spentMs + minimumSliceMs <= this.budgetMs) return;
    await nextAnimationFrame();
    this.spentMs = 0;
  }

  rowsForSlice(remainingRows: number): number {
    const affordable = Math.floor((this.budgetMs - this.spentMs) / this.estimatedMsPerRow);
    // Clamp to the remaining rows last: a tail band shorter than the minimum
    // must upload exactly the rows that exist, never a padded 32-row band.
    return Math.min(remainingRows, Math.max(MINIMUM_UPLOAD_ROWS_PER_SLICE, affordable));
  }

  recordSlice(rowCount: number, elapsedMs: number): void {
    this.spentMs += elapsedMs;
    const measured = elapsedMs / Math.max(1, rowCount);
    // Blend toward the measurement so one scheduler hiccup cannot permanently
    // collapse the band size, while sustained slowness still shrinks it.
    this.estimatedMsPerRow = Math.max(
      0.000_5,
      this.estimatedMsPerRow * 0.5 + measured * 0.5,
    );
  }

  recordFixedCost(elapsedMs: number): void {
    this.spentMs += elapsedMs;
  }
}

async function uploadRawTextureTimeSliced(
  gl: WebGL2RenderingContext,
  chunk: PackedGridChunk,
  budget: UploadFrameBudget,
  shouldContinue: () => boolean,
  diagnosticLabel: string,
): Promise<{ texture: WebGLTexture; maximumSliceMs: number }> {
  await budget.yieldIfSpent();
  if (!shouldContinue()) throw new Error(`${diagnosticLabel} was cancelled`);
  const allocationStarted = performance.now();
  const texture = gl.createTexture();
  if (!texture) throw new Error("National renderer could not allocate a chunk texture");
  let maximumSliceMs = 0;
  let nextRow = 0;
  try {
    withBoundRawTexture(gl, texture, () => {
      clearPriorWebGlErrors(gl);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R16UI,
        chunk.descriptor.haloWidth,
        chunk.descriptor.haloHeight,
        0,
        gl.RED_INTEGER,
        gl.UNSIGNED_SHORT,
        null,
      );
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`National chunk texture allocation failed (GL ${error})`);
    });
    const allocationElapsed = performance.now() - allocationStarted;
    assertSliceUnderLongTaskCeiling(allocationElapsed, `${diagnosticLabel} allocation`);
    budget.recordFixedCost(allocationElapsed);
    maximumSliceMs = allocationElapsed;
    while (nextRow < chunk.descriptor.haloHeight) {
      await budget.yieldIfSpent();
      if (!shouldContinue()) throw new Error(`${diagnosticLabel} was cancelled`);
      const rowCount = budget.rowsForSlice(chunk.descriptor.haloHeight - nextRow);
      const started = performance.now();
      const sliceFirstRow = nextRow;
      withBoundRawTexture(gl, texture, () => {
        clearPriorWebGlErrors(gl);
        const firstValue = sliceFirstRow * chunk.descriptor.haloWidth;
        const values = chunk.rawCodes.subarray(
          firstValue,
          firstValue + rowCount * chunk.descriptor.haloWidth,
        );
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          sliceFirstRow,
          chunk.descriptor.haloWidth,
          rowCount,
          gl.RED_INTEGER,
          gl.UNSIGNED_SHORT,
          values,
        );
        const error = gl.getError();
        if (error !== gl.NO_ERROR) throw new Error(`National chunk texture upload failed (GL ${error})`);
      });
      const elapsed = performance.now() - started;
      assertSliceUnderLongTaskCeiling(elapsed, diagnosticLabel);
      budget.recordSlice(rowCount, elapsed);
      maximumSliceMs = Math.max(maximumSliceMs, elapsed);
      nextRow += rowCount;
    }
    return { texture, maximumSliceMs };
  } catch (error) {
    gl.deleteTexture(texture);
    throw error;
  }
}

function assertSliceUnderLongTaskCeiling(elapsedMs: number, diagnosticLabel: string): void {
  if (elapsedMs <= UPLOAD_SLICE_LONG_TASK_CEILING_MS) return;
  throw new Error(
    `${diagnosticLabel} used ${elapsedMs.toFixed(3)} ms in one non-preemptible slice, exceeding the ${UPLOAD_SLICE_LONG_TASK_CEILING_MS} ms long-task ceiling`,
  );
}

function withBoundRawTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  operation: () => void,
): void {
  const previousActive = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  const previousUnpack = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
  gl.activeTexture(gl.TEXTURE0);
  const previousTexture0 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    operation();
  } finally {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousUnpack);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, previousTexture0);
    gl.activeTexture(previousActive);
  }
}

export function clearPriorWebGlErrors(
  gl: Pick<WebGL2RenderingContext, "getError" | "NO_ERROR">,
): void {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    if (gl.getError() === gl.NO_ERROR) return;
  }
  throw new Error("National renderer could not clear the prior WebGL error state");
}

function uploadPalette(gl: WebGL2RenderingContext): WebGLTexture {
  const bytes = new Uint8Array(PALETTE_WIDTH * 4);
  for (let index = 0; index < PALETTE_WIDTH; index += 1) {
    const value = PALETTE_MIN_DBZ
      + (index / (PALETTE_WIDTH - 1)) * (PALETTE_MAX_DBZ - PALETTE_MIN_DBZ);
    const color = colorForReflectivity(value);
    const alpha = color[3] / 255;
    bytes[index * 4] = Math.round(color[0] * alpha);
    bytes[index * 4 + 1] = Math.round(color[1] * alpha);
    bytes[index * 4 + 2] = Math.round(color[2] * alpha);
    bytes[index * 4 + 3] = color[3];
  }
  const texture = gl.createTexture();
  if (!texture) throw new Error("National renderer could not allocate its palette");
  const previousActive = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  gl.activeTexture(gl.TEXTURE1);
  const previousTexture1 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PALETTE_WIDTH, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return texture;
  } finally {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, previousTexture1);
    gl.activeTexture(previousActive);
  }
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) throw new Error("National renderer could not allocate its shader program");
  try {
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`National shader link failed: ${gl.getProgramInfoLog(program) ?? "unknown"}`);
    }
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("National renderer could not allocate a shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown";
    gl.deleteShader(shader);
    throw new Error(`National shader compile failed: ${log}`);
  }
  return shader;
}

function resolveUniforms(gl: WebGL2RenderingContext, program: WebGLProgram): Uniforms {
  return {
    matrix: requireUniform(gl, program, "u_matrix"),
    mercatorBounds: requireUniform(gl, program, "u_mercator_bounds"),
    rawCodes: requireUniform(gl, program, "u_raw_codes"),
    palette: requireUniform(gl, program, "u_palette"),
    firstLonLat: requireUniform(gl, program, "u_first_lon_lat"),
    stepLonLat: requireUniform(gl, program, "u_step_lon_lat"),
    haloOrigin: requireUniform(gl, program, "u_halo_origin"),
    interiorBounds: requireUniform(gl, program, "u_interior_bounds"),
    missingRaw: requireUniform(gl, program, "u_missing_raw"),
    noCoverageRaw: requireUniform(gl, program, "u_no_coverage_raw"),
    smooth: requireUniform(gl, program, "u_smooth"),
    excludeCoverage: requireUniform(gl, program, "u_exclude_coverage"),
    exclusionBounds: requireUniform(gl, program, "u_exclusion_bounds"),
  };
}

function requireUniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (!location) throw new Error(`National shader is missing uniform ${name}`);
  return location;
}

interface GlState {
  activeTexture: number;
  texture0: WebGLTexture | null;
  texture1: WebGLTexture | null;
  program: WebGLProgram | null;
  vao: WebGLVertexArrayObject | null;
  blend: boolean;
  depth: boolean;
  stencil: boolean;
  cull: boolean;
  blendSrcRgb: number;
  blendDstRgb: number;
  blendSrcAlpha: number;
  blendDstAlpha: number;
  blendEquationRgb: number;
  blendEquationAlpha: number;
}

function captureGlState(gl: WebGL2RenderingContext): GlState {
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  gl.activeTexture(gl.TEXTURE0);
  const texture0 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  gl.activeTexture(gl.TEXTURE1);
  const texture1 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  gl.activeTexture(activeTexture);
  return {
    activeTexture,
    texture0,
    texture1,
    program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
    vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null,
    blend: gl.isEnabled(gl.BLEND),
    depth: gl.isEnabled(gl.DEPTH_TEST),
    stencil: gl.isEnabled(gl.STENCIL_TEST),
    cull: gl.isEnabled(gl.CULL_FACE),
    blendSrcRgb: gl.getParameter(gl.BLEND_SRC_RGB) as number,
    blendDstRgb: gl.getParameter(gl.BLEND_DST_RGB) as number,
    blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA) as number,
    blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA) as number,
    blendEquationRgb: gl.getParameter(gl.BLEND_EQUATION_RGB) as number,
    blendEquationAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA) as number,
  };
}

function restoreGlState(gl: WebGL2RenderingContext, state: GlState) {
  setCapability(gl, gl.BLEND, state.blend);
  setCapability(gl, gl.DEPTH_TEST, state.depth);
  setCapability(gl, gl.STENCIL_TEST, state.stencil);
  setCapability(gl, gl.CULL_FACE, state.cull);
  gl.blendEquationSeparate(state.blendEquationRgb, state.blendEquationAlpha);
  gl.blendFuncSeparate(
    state.blendSrcRgb,
    state.blendDstRgb,
    state.blendSrcAlpha,
    state.blendDstAlpha,
  );
  gl.useProgram(state.program);
  gl.bindVertexArray(state.vao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.texture0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, state.texture1);
  gl.activeTexture(state.activeTexture);
}

function setCapability(gl: WebGL2RenderingContext, capability: number, enabled: boolean) {
  if (enabled) gl.enable(capability);
  else gl.disable(capability);
}

function receiptMatches(
  receipt: NationalPaintReceipt | undefined,
  resources: PresentationResources,
  contextEpoch: number,
) {
  const identity = nationalObservationIdentity(resources.manifest);
  return receipt?.generation === identity.generation
    && receipt.observationId === identity.observationId
    && receipt.presentationFactor === resources.manifest.presentationFactor
    && receipt.coverageVersion === resources.coverage.version
    && receipt.contextEpoch === contextEpoch;
}

function sameReceiptIdentity(
  left: NationalPaintReceipt,
  right: NationalPaintReceipt,
): boolean {
  return left.generation === right.generation
    && left.observationId === right.observationId
    && left.observationTimeUnixMs === right.observationTimeUnixMs
    && left.contentSha256 === right.contentSha256
    && left.presentationFactor === right.presentationFactor
    && left.coverageVersion === right.coverageVersion
    && left.contextEpoch === right.contextEpoch
    && left.drawSequence === right.drawSequence;
}

export function sameNationalPresentationReceipt(
  left: NationalPaintReceipt,
  right: NationalPaintReceipt,
): boolean {
  return left.generation === right.generation
    && left.observationId === right.observationId
    && left.observationTimeUnixMs === right.observationTimeUnixMs
    && left.contentSha256 === right.contentSha256
    && left.presentationFactor === right.presentationFactor
    && left.coverageVersion === right.coverageVersion
    && left.coverageKind === right.coverageKind
    && left.requiredChunkCount === right.requiredChunkCount;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => globalThis.requestAnimationFrame(() => resolve()));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

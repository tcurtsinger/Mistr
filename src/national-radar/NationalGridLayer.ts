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

interface PendingPaint {
  sync: WebGLSync;
  resources: PresentationResources;
  previous: PresentationResources | null;
  previousFallback: PresentationResources | null;
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
  private staging: PresentationResources | null = null;
  private pendingPaint: PendingPaint | null = null;
  private commitPrevious: PresentationResources | null | undefined;
  private commitFallback: PresentationResources | null | undefined;
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

  constructor(private readonly options: NationalGridLayerOptions = {}) {
    this.displayMode = options.displayMode ?? "smooth";
    this.uploadBudgetMs = options.uploadBudgetMs ?? DEFAULT_UPLOAD_BUDGET_MS;
    if (this.displayMode !== "smooth" && this.displayMode !== "native") {
      throw new Error("National display mode must be Smooth or Native");
    }
    if (!Number.isFinite(this.uploadBudgetMs) || this.uploadBudgetMs <= 0 || this.uploadBudgetMs > 4) {
      throw new Error("National upload budget must be greater than zero and no more than 4 ms");
    }
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
        if (this.fallback && this.active.manifest.presentationFactor === 1) {
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
            previous: this.commitPrevious ?? null,
            previousFallback: this.commitFallback ?? null,
            drawSequence: this.drawSequence,
          };
          this.commitPrevious = undefined;
          this.commitFallback = undefined;
          gl.flush();
          this.map?.triggerRepaint();
        }
      } finally {
        restoreGlState(gl, state);
      }
    } catch (error) {
      this.rollbackPendingCommit(error);
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
    this.deletePresentation(gl, this.active);
    if (this.fallback !== this.active) this.deletePresentation(gl, this.fallback);
    this.active = null;
    this.fallback = null;
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
    if (this.recovering || this.paintWaiter || this.staging || this.pendingPaint) {
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
    await nextAnimationFrame();
    if (this.staging !== staging) throw new Error("National staging was cancelled before upload");
    const gl = this.gl;
    if (!gl || gl.isContextLost()) throw new Error("National renderer lost its WebGL context during upload");
    const started = performance.now();
    const texture = uploadRawTexture(gl, chunk);
    const elapsed = performance.now() - started;
    if (elapsed > this.uploadBudgetMs) {
      gl.deleteTexture(texture);
      throw new Error(
        `National chunk upload used ${elapsed.toFixed(3)} ms, exceeding the ${this.uploadBudgetMs} ms frame budget`,
      );
    }
    const resource: GpuChunk = {
      packed: chunk,
      texture,
      gpuBytes: chunk.rawCodes.byteLength,
    };
    staging.chunks.set(chunk.descriptor.index, resource);
    staging.maximumUploadSliceMs = Math.max(staging.maximumUploadSliceMs, elapsed);
    staging.uploadedBytes += resource.gpuBytes;
    this.maximumUploadSliceMs = Math.max(this.maximumUploadSliceMs, elapsed);
    this.uploadCount += 1;
    this.uploadBytes += resource.gpuBytes;
    this.peakGpuResourceBytes = Math.max(this.peakGpuResourceBytes, this.currentGpuBytes());
    this.emit();
  }

  commitStaging(): Promise<NationalPaintReceipt> {
    const staging = this.staging;
    if (!staging || !this.gl) throw new Error("National renderer has no staged presentation");
    const required = assertCoverageMatchesManifest(staging.manifest, staging.coverage);
    if (required.some((descriptor) => !staging.chunks.has(descriptor.index))) {
      throw new Error("National renderer cannot commit incomplete viewport coverage");
    }
    staging.stagingDurationMs = performance.now() - staging.stagingStartedAt;
    const previous = this.active;
    const previousFallback = this.fallback;
    if (
      staging.manifest.presentationFactor === 1
      && previous?.manifest.presentationFactor === 4
      && previous.coverage.kind === "complete_domain"
    ) {
      this.fallback = previous;
    }
    this.active = staging;
    this.staging = null;
    this.paintReceipt = undefined;
    this.status = "ready";
    this.pendingPaint = null;
    this.commitPrevious = previous;
    this.commitFallback = previousFallback;
    this.map?.triggerRepaint();
    return new Promise((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        if (this.paintWaiter?.timeout === timeout) this.paintWaiter = null;
        this.rollbackCommittedPresentation(
          previous,
          previousFallback,
          new Error("National paint receipt timed out"),
        );
        reject(new Error("National paint receipt timed out"));
      }, PAINT_TIMEOUT_MS);
      this.paintWaiter = { resolve, reject, timeout };
    });
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
      residentChunkCount: (this.active ? residentChunkCount(this.active) : 0)
        + (this.fallback && this.fallback !== this.active ? residentChunkCount(this.fallback) : 0),
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
    this.commitPrevious = undefined;
    this.commitFallback = undefined;
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
    if (
      pending.previous
      && pending.previous !== pending.resources
      && pending.previous !== this.fallback
    ) {
      this.deletePresentation(gl, pending.previous);
    }
    if (pending.resources.manifest.presentationFactor === 4) {
      if (this.fallback && this.fallback !== pending.resources) {
        this.deletePresentation(gl, this.fallback);
      }
      this.fallback = null;
    }
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
    const presentations = [this.active, this.fallback]
      .filter((presentation, index, values): presentation is PresentationResources => (
        Boolean(presentation) && values.indexOf(presentation) === index
      ));
    this.paintReceipt = undefined;
    void (async () => {
      for (const presentation of presentations) {
        for (const resource of presentation.chunks.values()) {
          if (resource.texture) continue;
          await nextAnimationFrame();
          if (
            token !== this.rehydrationToken
            || this.gl !== gl
            || gl.isContextLost()
          ) return;
          const started = performance.now();
          const texture = uploadRawTexture(gl, resource.packed);
          const elapsed = performance.now() - started;
          if (elapsed > this.uploadBudgetMs) {
            gl.deleteTexture(texture);
            throw new Error(
              `National recovery chunk upload used ${elapsed.toFixed(3)} ms, exceeding the ${this.uploadBudgetMs} ms frame budget`,
            );
          }
          resource.texture = texture;
          this.maximumUploadSliceMs = Math.max(this.maximumUploadSliceMs, elapsed);
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
    this.rollbackCommittedPresentation(pending.previous, pending.previousFallback, error);
  }

  private rollbackCommittedPresentation(
    previous: PresentationResources | null,
    previousFallback: PresentationResources | null,
    error: unknown,
  ) {
    this.commitPrevious = undefined;
    this.commitFallback = undefined;
    const failed = this.active;
    if (failed && failed !== previous && this.gl && !this.gl.isContextLost()) {
      this.deletePresentation(this.gl, failed);
    }
    this.active = previous;
    this.fallback = previousFallback;
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
    const interruptedPrevious = this.pendingPaint?.previous ?? this.commitPrevious;
    const interruptedFallback = this.pendingPaint?.previousFallback ?? this.commitFallback;
    if (interruptedPrevious) {
      this.active = interruptedPrevious;
      this.fallback = interruptedFallback ?? null;
      const waiter = this.paintWaiter;
      this.paintWaiter = null;
      if (waiter) {
        globalThis.clearTimeout(waiter.timeout);
        waiter.reject(new Error("National working-set mutation was cancelled by context loss"));
      }
    }
    this.pendingPaint = null;
    this.commitPrevious = undefined;
    this.commitFallback = undefined;
    this.contextEpoch += 1;
    this.status = "recovering";
    this.paintReceipt = undefined;
    this.rollbackStaging();
    this.runtimeError = undefined;
  }

  private dropGpuHandlesForLostContext() {
    this.rehydrationToken += 1;
    for (const presentation of [this.active, this.fallback, this.staging]) {
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

  private currentGpuBytes() {
    const active = this.active
      ? residentGpuBytes(this.active)
      : 0;
    const fallback = this.fallback && this.fallback !== this.active
      ? residentGpuBytes(this.fallback)
      : 0;
    const staging = this.staging
      ? residentGpuBytes(this.staging)
      : 0;
    const shared = (this.paletteTexture ? PALETTE_WIDTH * 4 : 0)
      + (this.quadBuffer ? 12 * 4 : 0);
    return active + fallback + staging + shared;
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

function uploadRawTexture(gl: WebGL2RenderingContext, chunk: PackedGridChunk): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("National renderer could not allocate a chunk texture");
  const previousActive = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  const previousUnpack = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
  gl.activeTexture(gl.TEXTURE0);
  const previousTexture0 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
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
      chunk.rawCodes,
    );
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`National chunk texture upload failed (GL ${error})`);
    return texture;
  } catch (error) {
    gl.deleteTexture(texture);
    throw error;
  } finally {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousUnpack);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, previousTexture0);
    gl.activeTexture(previousActive);
  }
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

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => globalThis.requestAnimationFrame(() => resolve()));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import { buildMercatorBounds } from "./geo";
import type { RadarSweepCpuModel } from "./cpuModel";
import { buildReflectivityPalette, RANGE_FOLDED_COLOR } from "./palette";

const VERTEX_SHADER = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
in vec2 a_mercator;
out vec2 v_mercator;
void main() {
  v_mercator = a_mercator;
  gl_Position = u_matrix * vec4(a_mercator, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
const float PI = 3.141592653589793;
const float TWO_PI = 6.283185307179586;
const float EARTH_RADIUS_M = 6371008.8;
const float EFFECTIVE_EARTH_RADIUS_M = 8494666.666666666;
uniform usampler2D u_raw_codes;
uniform usampler2D u_statuses;
uniform usampler2D u_azimuth_lookup;
uniform sampler2D u_palette;
uniform sampler2D u_radial_metadata;
uniform vec2 u_radar_lon_lat_radians;
uniform float u_first_gate_center_m;
uniform float u_gate_spacing_m;
uniform int u_gate_count;
uniform int u_azimuth_lookup_size;
uniform vec4 u_range_folded_color;
in vec2 v_mercator;
out vec4 frag_color;

float wrapLongitude(float value) {
  return mod(value + PI, TWO_PI) - PI;
}

void main() {
  float wrappedX = v_mercator.x - floor(v_mercator.x);
  float longitude = wrappedX * TWO_PI - PI;
  float latitude = atan(sinh(PI * (1.0 - 2.0 * v_mercator.y)));
  float radarLongitude = u_radar_lon_lat_radians.x;
  float radarLatitude = u_radar_lon_lat_radians.y;
  float deltaLatitude = latitude - radarLatitude;
  float deltaLongitude = wrapLongitude(longitude - radarLongitude);
  float sinHalfLatitude = sin(deltaLatitude * 0.5);
  float sinHalfLongitude = sin(deltaLongitude * 0.5);
  float haversine = sinHalfLatitude * sinHalfLatitude
    + cos(radarLatitude) * cos(latitude) * sinHalfLongitude * sinHalfLongitude;
  float groundRangeM = 2.0 * EARTH_RADIUS_M * asin(
    min(1.0, sqrt(max(0.0, haversine)))
  );
  float bearingY = sin(deltaLongitude) * cos(latitude);
  float bearingX = cos(radarLatitude) * sin(latitude)
    - sin(radarLatitude) * cos(latitude) * cos(deltaLongitude);
  float bearing = atan(bearingY, bearingX);
  if (bearing < 0.0) bearing += TWO_PI;
  int lookupIndex = clamp(
    int(floor(bearing / TWO_PI * float(u_azimuth_lookup_size))),
    0,
    u_azimuth_lookup_size - 1
  );
  uint encodedRadial = texelFetch(u_azimuth_lookup, ivec2(lookupIndex, 0), 0).r;
  if (encodedRadial == uint(0)) discard;
  int radialIndex = int(encodedRadial - uint(1));
  vec3 radialMetadata = texelFetch(u_radial_metadata, ivec2(radialIndex, 0), 0).rgb;
  float bearingDifference = abs(bearing - radialMetadata.r);
  bearingDifference = min(bearingDifference, TWO_PI - bearingDifference);
  if (bearingDifference > radialMetadata.g) discard;
  float elevation = radialMetadata.b;
  float groundAngle = groundRangeM / EFFECTIVE_EARTH_RADIUS_M;
  float beamDenominator = cos(elevation + groundAngle);
  if (beamDenominator <= 0.0) discard;
  float slantRangeM = EFFECTIVE_EARTH_RADIUS_M * sin(groundAngle)
    / beamDenominator;
  float gateCoordinate = (slantRangeM - u_first_gate_center_m) / u_gate_spacing_m;
  if (gateCoordinate < -0.5 || gateCoordinate > float(u_gate_count) - 0.5) {
    discard;
  }
  int gateIndex = clamp(int(floor(gateCoordinate + 0.5)), 0, u_gate_count - 1);
  uint status = texelFetch(u_statuses, ivec2(gateIndex, radialIndex), 0).r;
  if (status == uint(1)) discard;
  if (status == uint(2)) {
    frag_color = u_range_folded_color;
    return;
  }
  uint rawCode = texelFetch(u_raw_codes, ivec2(gateIndex, radialIndex), 0).r;
  frag_color = texelFetch(u_palette, ivec2(int(rawCode), 0), 0);
  if (frag_color.a <= 0.0) discard;
}`;

export interface RadarRendererCapabilities {
  webglVersion: string;
  shadingLanguageVersion: string;
  vendor: string;
  renderer: string;
  unmaskedRendererAvailable: boolean;
  hardwareAcceleration: boolean;
  maxTextureSize: number;
  maxArrayTextureLayers: number;
  maxVertexTextureImageUnits: number;
  maxFragmentTextureImageUnits: number;
  maxCombinedTextureImageUnits: number;
  framebufferWidth: number;
  framebufferHeight: number;
  devicePixelRatio: number;
}

export interface RadarPaintReceipt {
  generation: number;
  observationId: string;
  contextEpoch: number;
  selectionSequence: number;
  drawSequence: number;
  completedAtUnixMs: number;
  firstPaintLatencyMs: number;
  residentSwitchLatencyMs: number;
  framebufferWidth: number;
  framebufferHeight: number;
}

export interface RadarSelectionRequest {
  generation: number;
  observationId: string;
  selectionSequence: number;
  requestedAtUnixMs: number;
}

export interface RadarRendererMetrics {
  shaderCompileLinkMs: number;
  uploadMs: number;
  gpuResourceBytes: number;
  peakGpuResourceBytes: number;
  cpuResourceBytes: number;
  residentFrameCount: number;
  frameUploadCount: number;
  frameUploadBytes: number;
  drawCpuP95Ms: number;
  drawCount: number;
  residentSwitchP50Ms: number;
  residentSwitchP95Ms: number;
  residentSwitchP99Ms: number;
}

export interface RadarTextureValidation {
  cellIndex: number;
  expectedRawCode: number;
  actualRawCode: number;
  expectedStatus: number;
  actualStatus: number;
  lookupIndex: number;
  expectedEncodedRadial: number;
  actualEncodedRadial: number;
  expectedPremultipliedRgba: number[];
  actualPremultipliedRgba: number[];
  allPassed: boolean;
}

export interface RadarRendererSnapshot {
  status: "initializing" | "ready" | "painted" | "removed" | "error";
  observationId: string;
  selectedObservationId: string;
  lastPaintedObservationId?: string;
  generation: number;
  selectionSequence: number;
  residentObservationIds: string[];
  contextEpoch: number;
  capabilities?: RadarRendererCapabilities;
  metrics?: RadarRendererMetrics;
  textureValidation?: RadarTextureValidation;
  textureValidationsPassed: number;
  paintReceipt?: RadarPaintReceipt;
  shaderLog: string[];
  error?: string;
}

export interface RadarCustomLayerOptions {
  onSnapshot(snapshot: RadarRendererSnapshot): void;
}

interface Uniforms {
  matrix: WebGLUniformLocation;
  rawCodes: WebGLUniformLocation;
  statuses: WebGLUniformLocation;
  azimuthLookup: WebGLUniformLocation;
  palette: WebGLUniformLocation;
  radarLonLat: WebGLUniformLocation;
  firstGateCenter: WebGLUniformLocation;
  gateSpacing: WebGLUniformLocation;
  gateCount: WebGLUniformLocation;
  lookupSize: WebGLUniformLocation;
  radialMetadata: WebGLUniformLocation;
  rangeFoldedColor: WebGLUniformLocation;
}

interface RadarFrameResources {
  model: RadarSweepCpuModel;
  rawTexture: WebGLTexture;
  statusTexture: WebGLTexture;
  lookupTexture: WebGLTexture;
  radialMetadataTexture: WebGLTexture;
  textureValidation: RadarTextureValidation;
  gpuBytes: number;
}

interface PendingPaint {
  sync: WebGLSync;
  generation: number;
  observationId: string;
  selectionSequence: number;
  drawSequence: number;
  selectedAt: number;
}

interface PaintWaiter {
  resolve(receipt: RadarPaintReceipt): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof globalThis.setTimeout>;
}

export class RadarCustomLayer implements CustomLayerInterface {
  readonly id = "mistr-resident-radar";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private map: MapLibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private paletteTexture: WebGLTexture | null = null;
  private frameResources = new Map<string, RadarFrameResources>();
  private uniforms: Uniforms | null = null;
  private pendingPaint: PendingPaint | null = null;
  private readonly paintWaiters = new Map<number, PaintWaiter>();
  private contextEpoch = 1;
  private drawCount = 0;
  private drawCpuSamples: number[] = [];
  private uploadCompletedAt = 0;
  private paintReceipt: RadarPaintReceipt | undefined;
  private paintReceipts: RadarPaintReceipt[] = [];
  private switchLatencySamples: number[] = [];
  private selectedObservationId: string;
  private selectionSequence = 1;
  private selectedAt = 0;
  private peakGpuResourceBytes = 0;
  private frameUploadCount = 0;
  private frameUploadBytes = 0;
  private shaderCompileLinkMs = 0;
  private uploadMs = 0;
  private capabilities: RadarRendererCapabilities | undefined;
  private textureValidation: RadarTextureValidation | undefined;
  private shaderLog: string[] = [];
  private runtimeError: string | undefined;

  constructor(
    modelOrModels: RadarSweepCpuModel | readonly RadarSweepCpuModel[],
    private readonly options: RadarCustomLayerOptions,
  ) {
    const models = Array.isArray(modelOrModels) ? [...modelOrModels] : [modelOrModels];
    validateResidentModels(models);
    this.models = models;
    this.selectedObservationId = models[0].observationId;
  }

  private models: RadarSweepCpuModel[];

  get model(): RadarSweepCpuModel {
    const model = this.models.find(
      (candidate) => candidate.observationId === this.selectedObservationId,
    );
    if (!model) {
      throw new RadarRendererError(`selected observation ${this.selectedObservationId} is unknown`);
    }
    return model;
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    try {
      this.capabilities = queryCapabilities(gl);
      for (const model of this.models) validateCapabilities(this.capabilities, model);
      const compileStarted = performance.now();
      this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER, this.shaderLog);
      this.shaderCompileLinkMs = performance.now() - compileStarted;
      this.uniforms = resolveUniforms(gl, this.program);
      const uploadStarted = performance.now();
      this.createResources(gl);
      this.uploadMs = performance.now() - uploadStarted;
      this.uploadCompletedAt = performance.now();
      this.selectedAt = this.uploadCompletedAt;
      this.emit("ready");
      map.triggerRepaint();
    } catch (error) {
      this.runtimeError = error instanceof Error ? error.message : String(error);
      this.emit("error", this.runtimeError);
      this.deleteResources(gl);
      throw error;
    }
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.program || !this.vao || !this.uniforms) {
      return;
    }
    this.completePendingFence(gl);
    if (this.runtimeError) return;
    const frame = this.requireSelectedFrame();
    const model = frame.model;
    const started = performance.now();
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
      bindTexture(gl, 0, frame.rawTexture);
      bindTexture(gl, 1, frame.statusTexture);
      bindTexture(gl, 2, frame.lookupTexture);
      bindTexture(gl, 3, this.paletteTexture);
      bindTexture(gl, 4, frame.radialMetadataTexture);
      gl.uniformMatrix4fv(this.uniforms.matrix, false, options.defaultProjectionData.mainMatrix);
      gl.uniform1i(this.uniforms.rawCodes, 0);
      gl.uniform1i(this.uniforms.statuses, 1);
      gl.uniform1i(this.uniforms.azimuthLookup, 2);
      gl.uniform1i(this.uniforms.palette, 3);
      gl.uniform1i(this.uniforms.radialMetadata, 4);
      gl.uniform2f(
        this.uniforms.radarLonLat,
        degreesToRadians(model.center.longitude),
        degreesToRadians(model.center.latitude),
      );
      gl.uniform1f(this.uniforms.firstGateCenter, model.firstGateCenterM);
      gl.uniform1f(this.uniforms.gateSpacing, model.gateSpacingM);
      gl.uniform1i(this.uniforms.gateCount, model.gateCount);
      gl.uniform1i(this.uniforms.lookupSize, model.azimuthLookup.length);
      const alpha = RANGE_FOLDED_COLOR[3] / 255;
      gl.uniform4f(
        this.uniforms.rangeFoldedColor,
        RANGE_FOLDED_COLOR[0] / 255 * alpha,
        RANGE_FOLDED_COLOR[1] / 255 * alpha,
        RANGE_FOLDED_COLOR[2] / 255 * alpha,
        alpha,
      );
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.drawCount += 1;
      if (
        this.paintReceipt?.selectionSequence !== this.selectionSequence
        && !this.pendingPaint
      ) {
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!sync) {
          throw new RadarRendererError("failed to allocate GPU completion fence");
        }
        this.pendingPaint = {
          sync,
          generation: generationNumber(model),
          observationId: model.observationId,
          selectionSequence: this.selectionSequence,
          drawSequence: this.drawCount,
          selectedAt: this.selectedAt,
        };
        gl.flush();
        this.map?.triggerRepaint();
      }
    } catch (error) {
      this.runtimeError = error instanceof Error ? error.message : String(error);
      this.rejectPaintWaiter(this.selectionSequence, this.runtimeError);
      this.emit("error", this.runtimeError);
      throw error;
    } finally {
      restoreGlState(gl, state);
      const elapsed = performance.now() - started;
      this.drawCpuSamples.push(elapsed);
      if (this.drawCpuSamples.length > 120) this.drawCpuSamples.shift();
    }
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.deleteResources(gl);
    this.map = null;
    this.gl = null;
    this.emit("removed");
  }

  getSnapshot(): RadarRendererSnapshot {
    return this.buildSnapshot(
      this.runtimeError
        ? "error"
        : this.paintReceipt
          ? "painted"
          : this.program
            ? "ready"
            : "initializing",
      this.runtimeError,
    );
  }

  selectFrame(observationId: string): RadarSelectionRequest {
    if (!this.frameResources.has(observationId)) {
      throw new RadarRendererError(`observation ${observationId} is not resident`);
    }
    if (this.pendingPaint || this.paintReceipt?.selectionSequence !== this.selectionSequence) {
      throw new RadarRendererError("the prior frame selection has not produced a paint receipt");
    }
    if (observationId === this.selectedObservationId) {
      return {
        generation: generationNumber(this.model),
        observationId,
        selectionSequence: this.selectionSequence,
        requestedAtUnixMs: Date.now(),
      };
    }
    this.selectedObservationId = observationId;
    this.selectionSequence += 1;
    this.selectedAt = performance.now();
    this.map?.triggerRepaint();
    const request = {
      generation: generationNumber(this.model),
      observationId,
      selectionSequence: this.selectionSequence,
      requestedAtUnixMs: Date.now(),
    };
    this.emit("ready");
    return request;
  }

  waitForPaint(selectionSequence: number, timeoutMs = 2_000): Promise<RadarPaintReceipt> {
    if (!Number.isSafeInteger(selectionSequence) || selectionSequence < 1) {
      return Promise.reject(new RangeError("selectionSequence must be a positive safe integer"));
    }
    if (this.paintReceipt?.selectionSequence === selectionSequence) {
      return Promise.resolve(this.paintReceipt);
    }
    if (selectionSequence !== this.selectionSequence || this.paintWaiters.has(selectionSequence)) {
      return Promise.reject(new RadarRendererError("selection is stale or already has a waiter"));
    }
    return new Promise((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        this.paintWaiters.delete(selectionSequence);
        reject(new RadarRendererError(`selection ${selectionSequence} did not paint within ${timeoutMs} ms`));
      }, timeoutMs);
      this.paintWaiters.set(selectionSequence, { resolve, reject, timeout });
    });
  }

  async selectAndWait(observationId: string, timeoutMs = 2_000): Promise<RadarPaintReceipt> {
    const request = this.selectFrame(observationId);
    return this.waitForPaint(request.selectionSequence, timeoutMs);
  }

  getPaintReceipts(): RadarPaintReceipt[] {
    return this.paintReceipts.map((receipt) => ({ ...receipt }));
  }

  replaceResidentFrames(models: readonly RadarSweepCpuModel[]): void {
    validateResidentModels(models);
    if (!this.gl || !this.paletteTexture) {
      throw new RadarRendererError("renderer is not ready for loop replacement");
    }
    if (this.pendingPaint || this.paintReceipt?.selectionSequence !== this.selectionSequence) {
      throw new RadarRendererError("cannot replace a loop while a selection is awaiting paint");
    }
    const currentKey = this.models[0];
    const replacementKey = models[0];
    validateReplacementGeneration(generationNumber(currentKey), generationNumber(replacementKey));
    if (
      currentKey.siteIcao !== replacementKey.siteIcao
      || currentKey.product !== replacementKey.product
      || currentKey.sourceKind !== replacementKey.sourceKind
      || currentKey.scale !== replacementKey.scale
      || currentKey.offset !== replacementKey.offset
      || currentKey.center.longitude !== replacementKey.center.longitude
      || currentKey.center.latitude !== replacementKey.center.latitude
      || Math.max(...models.map((model) => model.maxRangeM))
        > Math.max(...this.models.map((model) => model.maxRangeM))
    ) {
      throw new RadarRendererError("replacement changes the allocated radar render key or bounds");
    }

    const gl = this.gl;
    const palette = buildReflectivityPalette(replacementKey.scale, replacementKey.offset);
    const pendingFrames = new Map<string, RadarFrameResources>();
    const previousUnpack = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
    const previousActive = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    try {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      for (const model of models) {
        const frame = createFrameResources(gl, model, this.paletteTexture, palette);
        pendingFrames.set(model.observationId, frame);
        this.frameUploadCount += 1;
        this.frameUploadBytes += frame.gpuBytes;
      }
      const pendingBytes = [...pendingFrames.values()]
        .reduce((total, frame) => total + frame.gpuBytes, 0);
      this.peakGpuResourceBytes = Math.max(
        this.peakGpuResourceBytes,
        this.currentGpuResourceBytes() + pendingBytes,
      );
    } catch (error) {
      deleteFrameResources(gl, pendingFrames.values());
      throw error;
    } finally {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousUnpack);
      gl.activeTexture(previousActive);
      gl.bindTexture(gl.TEXTURE_2D, previousTexture);
    }

    const previousFrames = this.frameResources;
    this.frameResources = pendingFrames;
    this.models = [...models];
    this.selectedObservationId = models[0].observationId;
    this.selectionSequence += 1;
    this.selectedAt = performance.now();
    this.textureValidation = pendingFrames.get(this.selectedObservationId)?.textureValidation;
    deleteFrameResources(gl, previousFrames.values());
    previousFrames.clear();
    this.map?.triggerRepaint();
    this.emit("ready");
  }

  private createResources(gl: WebGL2RenderingContext) {
    if (!this.program) throw new RadarRendererError("renderer program is unavailable");
    const primary = this.models[0];
    const bounds = buildMercatorBounds(
      primary.center,
      Math.max(...this.models.map((model) => model.maxRangeM)),
    );
    const vertices = new Float32Array([
      bounds.west, bounds.north,
      bounds.east, bounds.north,
      bounds.west, bounds.south,
      bounds.west, bounds.south,
      bounds.east, bounds.north,
      bounds.east, bounds.south,
    ]);
    const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const previousArrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    try {
      this.vao = requireResource(gl.createVertexArray(), "vertex array");
      this.quadBuffer = requireResource(gl.createBuffer(), "quad buffer");
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
      const position = gl.getAttribLocation(this.program, "a_mercator");
      if (position < 0) throw new RadarRendererError("a_mercator attribute is unavailable");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    } finally {
      gl.bindVertexArray(previousVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, previousArrayBuffer);
    }

    const previousUnpack = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
    const previousActive = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
    const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const pendingFrames = new Map<string, RadarFrameResources>();
    try {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const palette = buildReflectivityPalette(primary.scale, primary.offset);
      this.paletteTexture = createTexture2d(
        gl,
        256,
        1,
        gl.RGBA8,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        palette,
      );
      for (const model of this.models) {
        const frame = createFrameResources(gl, model, this.paletteTexture, palette);
        pendingFrames.set(model.observationId, frame);
        this.frameUploadCount += 1;
        this.frameUploadBytes += frame.gpuBytes;
      }
      this.frameResources = pendingFrames;
      this.textureValidation = pendingFrames.get(this.selectedObservationId)?.textureValidation;
      this.peakGpuResourceBytes = Math.max(
        this.peakGpuResourceBytes,
        this.currentGpuResourceBytes(),
      );
    } catch (error) {
      deleteFrameResources(gl, pendingFrames.values());
      if (this.paletteTexture) gl.deleteTexture(this.paletteTexture);
      this.paletteTexture = null;
      throw error;
    } finally {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, previousUnpack);
      gl.activeTexture(previousActive);
      gl.bindTexture(gl.TEXTURE_2D, previousTexture);
    }
  }

  private completePendingFence(gl: WebGL2RenderingContext) {
    const pending = this.pendingPaint;
    if (!pending) return;
    const result = gl.clientWaitSync(pending.sync, 0, 0);
    if (result === gl.TIMEOUT_EXPIRED) {
      this.map?.triggerRepaint();
      return;
    }
    if (result === gl.WAIT_FAILED) {
      this.runtimeError = "GPU completion fence failed";
      this.emit("error", this.runtimeError);
      gl.deleteSync(pending.sync);
      this.pendingPaint = null;
      this.rejectPaintWaiter(pending.selectionSequence, this.runtimeError);
      return;
    }
    gl.deleteSync(pending.sync);
    this.pendingPaint = null;
    const completedAt = performance.now();
    this.paintReceipt = {
      generation: pending.generation,
      observationId: pending.observationId,
      contextEpoch: this.contextEpoch,
      selectionSequence: pending.selectionSequence,
      drawSequence: pending.drawSequence,
      completedAtUnixMs: Date.now(),
      firstPaintLatencyMs: this.paintReceipts.length === 0
        ? completedAt - this.uploadCompletedAt
        : this.paintReceipts[0].firstPaintLatencyMs,
      residentSwitchLatencyMs: completedAt - pending.selectedAt,
      framebufferWidth: gl.drawingBufferWidth,
      framebufferHeight: gl.drawingBufferHeight,
    };
    this.paintReceipts.push(this.paintReceipt);
    if (this.paintReceipts.length > 64) this.paintReceipts.shift();
    this.switchLatencySamples.push(this.paintReceipt.residentSwitchLatencyMs);
    if (this.switchLatencySamples.length > 240) this.switchLatencySamples.shift();
    const waiter = this.paintWaiters.get(pending.selectionSequence);
    if (waiter) {
      globalThis.clearTimeout(waiter.timeout);
      this.paintWaiters.delete(pending.selectionSequence);
      waiter.resolve(this.paintReceipt);
    }
    this.emit("painted");
  }

  private deleteResources(gl: WebGL2RenderingContext) {
    if (this.pendingPaint) gl.deleteSync(this.pendingPaint.sync);
    deleteFrameResources(gl, this.frameResources.values());
    if (this.paletteTexture) gl.deleteTexture(this.paletteTexture);
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.pendingPaint = null;
    this.frameResources.clear();
    this.paletteTexture = null;
    this.quadBuffer = null;
    this.vao = null;
    this.program = null;
    this.uniforms = null;
    for (const [sequence, waiter] of this.paintWaiters) {
      globalThis.clearTimeout(waiter.timeout);
      waiter.reject(new RadarRendererError(`renderer removed before selection ${sequence} painted`));
    }
    this.paintWaiters.clear();
  }

  private emit(status: RadarRendererSnapshot["status"], error?: string) {
    this.options.onSnapshot(this.buildSnapshot(status, error));
  }

  private requireSelectedFrame(): RadarFrameResources {
    const frame = this.frameResources.get(this.selectedObservationId);
    if (!frame) {
      throw new RadarRendererError(
        `selected observation ${this.selectedObservationId} has no current-context resources`,
      );
    }
    return frame;
  }

  private currentGpuResourceBytes(): number {
    let total = this.paletteTexture ? 256 * 4 : 0;
    total += this.quadBuffer ? 6 * 2 * Float32Array.BYTES_PER_ELEMENT : 0;
    for (const frame of this.frameResources.values()) total += frame.gpuBytes;
    return total;
  }

  private rejectPaintWaiter(selectionSequence: number, message: string) {
    const waiter = this.paintWaiters.get(selectionSequence);
    if (!waiter) return;
    globalThis.clearTimeout(waiter.timeout);
    this.paintWaiters.delete(selectionSequence);
    waiter.reject(new RadarRendererError(message));
  }

  private buildSnapshot(
    status: RadarRendererSnapshot["status"],
    error?: string,
  ): RadarRendererSnapshot {
    return {
      status,
      observationId: this.selectedObservationId,
      selectedObservationId: this.selectedObservationId,
      lastPaintedObservationId: this.paintReceipt?.observationId,
      generation: generationNumber(this.model),
      selectionSequence: this.selectionSequence,
      residentObservationIds: [...this.frameResources.keys()],
      contextEpoch: this.contextEpoch,
      capabilities: this.capabilities,
      metrics: this.capabilities
        ? {
            shaderCompileLinkMs: this.shaderCompileLinkMs,
            uploadMs: this.uploadMs,
            gpuResourceBytes: this.currentGpuResourceBytes(),
            peakGpuResourceBytes: this.peakGpuResourceBytes,
            cpuResourceBytes: this.models.reduce((total, model) => total + model.cpuBytes, 0),
            residentFrameCount: this.frameResources.size,
            frameUploadCount: this.frameUploadCount,
            frameUploadBytes: this.frameUploadBytes,
            drawCpuP95Ms: percentile(this.drawCpuSamples, 0.95),
            drawCount: this.drawCount,
            residentSwitchP50Ms: percentile(this.switchLatencySamples, 0.5),
            residentSwitchP95Ms: percentile(this.switchLatencySamples, 0.95),
            residentSwitchP99Ms: percentile(this.switchLatencySamples, 0.99),
          }
        : undefined,
      textureValidation: this.textureValidation,
      textureValidationsPassed: [...this.frameResources.values()]
        .filter((frame) => frame.textureValidation.allPassed).length,
      paintReceipt: this.paintReceipt,
      shaderLog: [...this.shaderLog],
      error: error ?? this.runtimeError,
    };
  }
}

interface RadarTextures {
  raw: WebGLTexture | null;
  status: WebGLTexture | null;
  lookup: WebGLTexture | null;
  palette: WebGLTexture | null;
}

function createFrameResources(
  gl: WebGL2RenderingContext,
  model: RadarSweepCpuModel,
  paletteTexture: WebGLTexture,
  palette: Uint8Array,
): RadarFrameResources {
  let rawTexture: WebGLTexture | null = null;
  let statusTexture: WebGLTexture | null = null;
  let lookupTexture: WebGLTexture | null = null;
  let radialMetadataTexture: WebGLTexture | null = null;
  try {
    rawTexture = createTexture2d(
      gl,
      model.gateCount,
      model.radialCount,
      gl.R8UI,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      model.rawCodes,
    );
    statusTexture = createTexture2d(
      gl,
      model.gateCount,
      model.radialCount,
      gl.R8UI,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      model.statuses,
    );
    lookupTexture = createTexture2d(
      gl,
      model.azimuthLookup.length,
      1,
      gl.R16UI,
      gl.RED_INTEGER,
      gl.UNSIGNED_SHORT,
      model.azimuthLookup,
    );
    const radialMetadata = new Float32Array(model.radialCount * 3);
    for (let radialIndex = 0; radialIndex < model.radialCount; radialIndex += 1) {
      const destination = radialIndex * 3;
      radialMetadata[destination] = degreesToRadians(model.azimuths[radialIndex]);
      radialMetadata[destination + 1] = degreesToRadians(
        model.beamWidths[radialIndex] / 2,
      );
      radialMetadata[destination + 2] = degreesToRadians(model.elevations[radialIndex]);
    }
    radialMetadataTexture = createTexture2d(
      gl,
      model.radialCount,
      1,
      gl.RGB32F,
      gl.RGB,
      gl.FLOAT,
      radialMetadata,
    );
    const textureValidation = validateTextureUploads(gl, model, {
      raw: rawTexture,
      status: statusTexture,
      lookup: lookupTexture,
      palette: paletteTexture,
    }, palette);
    if (!textureValidation.allPassed) {
      throw new RadarRendererError(
        `GPU texture readback disagrees with CPU bytes for ${model.observationId}`,
      );
    }
    return {
      model,
      rawTexture,
      statusTexture,
      lookupTexture,
      radialMetadataTexture,
      textureValidation,
      gpuBytes: model.rawCodes.byteLength
        + model.statuses.byteLength
        + model.azimuthLookup.byteLength
        + radialMetadata.byteLength,
    };
  } catch (error) {
    if (rawTexture) gl.deleteTexture(rawTexture);
    if (statusTexture) gl.deleteTexture(statusTexture);
    if (lookupTexture) gl.deleteTexture(lookupTexture);
    if (radialMetadataTexture) gl.deleteTexture(radialMetadataTexture);
    throw error;
  }
}

function deleteFrameResources(
  gl: WebGL2RenderingContext,
  frames: Iterable<RadarFrameResources>,
) {
  for (const frame of frames) {
    gl.deleteTexture(frame.rawTexture);
    gl.deleteTexture(frame.statusTexture);
    gl.deleteTexture(frame.lookupTexture);
    gl.deleteTexture(frame.radialMetadataTexture);
  }
}

export function validateResidentModels(models: readonly RadarSweepCpuModel[]): void {
  if (models.length < 1 || models.length > 20) {
    throw new RadarRendererError("a resident loop must contain between 1 and 20 frames");
  }
  const primary = models[0];
  const generation = generationNumber(primary);
  const observations = new Set<string>();
  let priorObservedAt = -Infinity;
  for (const model of models) {
    if (observations.has(model.observationId)) {
      throw new RadarRendererError(`duplicate resident observation ${model.observationId}`);
    }
    observations.add(model.observationId);
    if (generationNumber(model) !== generation) {
      throw new RadarRendererError("all resident frames must belong to one generation");
    }
    if (
      model.siteIcao !== primary.siteIcao
      || model.product !== primary.product
      || model.sourceKind !== primary.sourceKind
      || model.scale !== primary.scale
      || model.offset !== primary.offset
      || model.center.longitude !== primary.center.longitude
      || model.center.latitude !== primary.center.latitude
    ) {
      throw new RadarRendererError("resident frames must share one site/product/render key");
    }
    if (!Number.isSafeInteger(model.observedAtUnixMs) || model.observedAtUnixMs <= priorObservedAt) {
      throw new RadarRendererError("resident frames must have strictly increasing measurement times");
    }
    priorObservedAt = model.observedAtUnixMs;
  }
}

export function validateReplacementGeneration(current: number, replacement: number): void {
  if (
    !Number.isSafeInteger(current)
    || !Number.isSafeInteger(replacement)
    || current < 1
    || replacement <= current
  ) {
    throw new RadarRendererError("replacement generation must advance monotonically");
  }
}

function generationNumber(model: RadarSweepCpuModel): number {
  const value = Number(model.generation);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RadarRendererError("generation must be a positive safe integer");
  }
  return value;
}

function validateTextureUploads(
  gl: WebGL2RenderingContext,
  model: RadarSweepCpuModel,
  textures: RadarTextures,
  palette: Uint8Array,
): RadarTextureValidation {
  const cellIndex = model.statuses.findIndex(
    (status, index) => status === 0 && model.rawCodes[index] >= 2,
  );
  const lookupIndex = model.azimuthLookup.findIndex((encoded) => encoded !== 0);
  if (cellIndex < 0 || lookupIndex < 0) {
    throw new RadarRendererError("sweep has no valid gate or measured radial for GPU validation");
  }
  const gateIndex = cellIndex % model.gateCount;
  const radialIndex = Math.floor(cellIndex / model.gateCount);
  const rawCode = model.rawCodes[cellIndex];
  const framebuffer = requireResource(gl.createFramebuffer(), "validation framebuffer");
  const previousReadFramebuffer = gl.getParameter(
    gl.READ_FRAMEBUFFER_BINDING,
  ) as WebGLFramebuffer | null;
  try {
    const actualRawCode = readIntegerTextureU8(
      gl,
      framebuffer,
      textures.raw,
      gateIndex,
      radialIndex,
    );
    const actualStatus = readIntegerTextureU8(
      gl,
      framebuffer,
      textures.status,
      gateIndex,
      radialIndex,
    );
    const actualEncodedRadial = readIntegerTextureU16(
      gl,
      framebuffer,
      textures.lookup,
      lookupIndex,
      0,
    );
    const actualPremultipliedRgba = readRgbaTexture(
      gl,
      framebuffer,
      textures.palette,
      rawCode,
      0,
    );
    const expectedPremultipliedRgba = [
      ...palette.slice(rawCode * 4, rawCode * 4 + 4),
    ];
    const expectedEncodedRadial = model.azimuthLookup[lookupIndex];
    const allPassed = actualRawCode === rawCode
      && actualStatus === model.statuses[cellIndex]
      && actualEncodedRadial === expectedEncodedRadial
      && actualPremultipliedRgba.every(
        (channel, index) => channel === expectedPremultipliedRgba[index],
      );
    return {
      cellIndex,
      expectedRawCode: rawCode,
      actualRawCode,
      expectedStatus: model.statuses[cellIndex],
      actualStatus,
      lookupIndex,
      expectedEncodedRadial,
      actualEncodedRadial,
      expectedPremultipliedRgba,
      actualPremultipliedRgba,
      allPassed,
    };
  } finally {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previousReadFramebuffer);
    gl.deleteFramebuffer(framebuffer);
  }
}

function attachForRead(
  gl: WebGL2RenderingContext,
  framebuffer: WebGLFramebuffer,
  texture: WebGLTexture | null,
) {
  if (!texture) throw new RadarRendererError("validation texture is unavailable");
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.READ_FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
  );
  if (gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new RadarRendererError("GPU validation framebuffer is incomplete");
  }
}

function readIntegerTextureU8(
  gl: WebGL2RenderingContext,
  framebuffer: WebGLFramebuffer,
  texture: WebGLTexture | null,
  x: number,
  y: number,
): number {
  attachForRead(gl, framebuffer, texture);
  const output = new Uint8Array(1);
  gl.readPixels(x, y, 1, 1, gl.RED_INTEGER, gl.UNSIGNED_BYTE, output);
  return output[0];
}

function readIntegerTextureU16(
  gl: WebGL2RenderingContext,
  framebuffer: WebGLFramebuffer,
  texture: WebGLTexture | null,
  x: number,
  y: number,
): number {
  attachForRead(gl, framebuffer, texture);
  const output = new Uint16Array(1);
  gl.readPixels(x, y, 1, 1, gl.RED_INTEGER, gl.UNSIGNED_SHORT, output);
  return output[0];
}

function readRgbaTexture(
  gl: WebGL2RenderingContext,
  framebuffer: WebGLFramebuffer,
  texture: WebGLTexture | null,
  x: number,
  y: number,
): number[] {
  attachForRead(gl, framebuffer, texture);
  const output = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, output);
  return [...output];
}

export class RadarRendererError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RadarRendererError";
  }
}

interface CapturedGlState {
  activeTexture: number;
  textureBindings: Array<WebGLTexture | null>;
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

function captureGlState(gl: WebGL2RenderingContext): CapturedGlState {
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  const textureBindings: Array<WebGLTexture | null> = [];
  for (let unit = 0; unit < 5; unit += 1) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    textureBindings.push(gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null);
  }
  gl.activeTexture(activeTexture);
  return {
    activeTexture,
    textureBindings,
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

function restoreGlState(gl: WebGL2RenderingContext, state: CapturedGlState) {
  for (let unit = 0; unit < state.textureBindings.length; unit += 1) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, state.textureBindings[unit]);
  }
  gl.activeTexture(state.activeTexture);
  gl.bindVertexArray(state.vao);
  gl.useProgram(state.program);
  gl.blendEquationSeparate(state.blendEquationRgb, state.blendEquationAlpha);
  gl.blendFuncSeparate(
    state.blendSrcRgb,
    state.blendDstRgb,
    state.blendSrcAlpha,
    state.blendDstAlpha,
  );
  restoreCapability(gl, gl.BLEND, state.blend);
  restoreCapability(gl, gl.DEPTH_TEST, state.depth);
  restoreCapability(gl, gl.STENCIL_TEST, state.stencil);
  restoreCapability(gl, gl.CULL_FACE, state.cull);
}

function restoreCapability(gl: WebGL2RenderingContext, capability: number, enabled: boolean) {
  if (enabled) gl.enable(capability);
  else gl.disable(capability);
}

function bindTexture(
  gl: WebGL2RenderingContext,
  unit: number,
  texture: WebGLTexture | null,
) {
  if (!texture) throw new RadarRendererError(`texture unit ${unit} is unavailable`);
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
}

function createTexture2d(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  internalFormat: number,
  format: number,
  type: number,
  data: ArrayBufferView,
): WebGLTexture {
  const texture = requireResource(gl.createTexture(), "texture");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    internalFormat,
    width,
    height,
    0,
    format,
    type,
    data,
  );
  return texture;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  logs: string[],
): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource, "vertex", logs);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, "fragment", logs);
  const program = requireResource(gl.createProgram(), "shader program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  const linkLog = gl.getProgramInfoLog(program)?.trim();
  if (linkLog) logs.push(`link: ${linkLog}`);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    throw new RadarRendererError(`shader link failed: ${linkLog || "no driver log"}`);
  }
  return program;
}

function compileShader(
  gl: WebGL2RenderingContext,
  kind: number,
  source: string,
  label: string,
  logs: string[],
): WebGLShader {
  const shader = requireResource(gl.createShader(kind), `${label} shader`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const log = gl.getShaderInfoLog(shader)?.trim();
  if (log) logs.push(`${label}: ${log}`);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    throw new RadarRendererError(`${label} shader compile failed: ${log || "no driver log"}`);
  }
  return shader;
}

function resolveUniforms(gl: WebGL2RenderingContext, program: WebGLProgram): Uniforms {
  return {
    matrix: requireUniform(gl, program, "u_matrix"),
    rawCodes: requireUniform(gl, program, "u_raw_codes"),
    statuses: requireUniform(gl, program, "u_statuses"),
    azimuthLookup: requireUniform(gl, program, "u_azimuth_lookup"),
    palette: requireUniform(gl, program, "u_palette"),
    radarLonLat: requireUniform(gl, program, "u_radar_lon_lat_radians"),
    firstGateCenter: requireUniform(gl, program, "u_first_gate_center_m"),
    gateSpacing: requireUniform(gl, program, "u_gate_spacing_m"),
    gateCount: requireUniform(gl, program, "u_gate_count"),
    lookupSize: requireUniform(gl, program, "u_azimuth_lookup_size"),
    radialMetadata: requireUniform(gl, program, "u_radial_metadata"),
    rangeFoldedColor: requireUniform(gl, program, "u_range_folded_color"),
  };
}

function requireUniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (!location) throw new RadarRendererError(`${name} uniform is unavailable`);
  return location;
}

function requireResource<T>(resource: T | null, name: string): T {
  if (resource === null) throw new RadarRendererError(`failed to allocate ${name}`);
  return resource;
}

function queryCapabilities(gl: WebGL2RenderingContext): RadarRendererCapabilities {
  const debug = gl.getExtension("WEBGL_debug_renderer_info") as {
    UNMASKED_VENDOR_WEBGL: number;
    UNMASKED_RENDERER_WEBGL: number;
  } | null;
  const renderer = String(gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
  return {
    webglVersion: String(gl.getParameter(gl.VERSION)),
    shadingLanguageVersion: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
    vendor: String(gl.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR)),
    renderer,
    unmaskedRendererAvailable: debug !== null,
    hardwareAcceleration: hasVerifiedHardwareAcceleration(debug !== null, renderer),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxArrayTextureLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number,
    maxVertexTextureImageUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) as number,
    maxFragmentTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number,
    maxCombinedTextureImageUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number,
    framebufferWidth: gl.drawingBufferWidth,
    framebufferHeight: gl.drawingBufferHeight,
    devicePixelRatio: globalThis.devicePixelRatio,
  };
}

function validateCapabilities(
  capabilities: RadarRendererCapabilities,
  model: RadarSweepCpuModel,
) {
  if (!capabilities.hardwareAcceleration) {
    throw new RadarRendererError(
      `hardware WebGL renderer could not be verified: ${capabilities.renderer}`,
    );
  }
  const requiredTextureSize = Math.max(
    model.gateCount,
    model.radialCount,
    model.azimuthLookup.length,
  );
  if (capabilities.maxTextureSize < requiredTextureSize) {
    throw new RadarRendererError(
      `MAX_TEXTURE_SIZE ${capabilities.maxTextureSize} is below required ${requiredTextureSize}`,
    );
  }
  if (capabilities.maxFragmentTextureImageUnits < 5) {
    throw new RadarRendererError("at least five fragment texture units are required");
  }
}

export function hasVerifiedHardwareAcceleration(
  unmaskedRendererAvailable: boolean,
  renderer: string,
): boolean {
  if (!unmaskedRendererAvailable) return false;
  const normalizedRenderer = renderer.trim().toLowerCase();
  if (
    normalizedRenderer.length === 0
    || normalizedRenderer === "null"
    || normalizedRenderer === "undefined"
  ) {
    return false;
  }
  const softwareMarkers = [
    "swiftshader",
    "llvmpipe",
    "lavapipe",
    "softpipe",
    "software",
    "basic render driver",
    "warp",
  ];
  return !softwareMarkers.some((marker) => normalizedRenderer.includes(marker));
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

export const radarShaderSources = {
  vertex: VERTEX_SHADER,
  fragment: FRAGMENT_SHADER,
};

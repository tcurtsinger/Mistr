import { MERCATOR_LATITUDE_GLSL } from "../national-radar/NationalGridLayer";
import { SITE_GEOMETRY_GLSL, radarUnitFrame } from "./RadarCustomLayer";

// Runs the shipped Site range/bearing and National latitude shader code on
// this machine's GPU and measures it against double-precision math. A GPU
// whose transcendental functions are coarse misplaces radar on the map while
// CPU inspection stays exact; this is the check that sees it.

const EARTH_RADIUS_M = 6_371_008.8;
const PROBE_RADARS = [
  { latitude: 25.611, longitude: -80.413 },
  { latitude: 35.333, longitude: -97.278 },
  { latitude: 37.761, longitude: -99.969 },
  { latitude: 46.771, longitude: -100.761 },
  { latitude: 64.512, longitude: -147.501 },
] as const;
// Gates start near 2 km; Level II reflectivity ends at 460 km.
const PROBE_RANGES_M = [2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 250_000, 460_000];
const PROBE_BEARINGS_DEGREES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
const PROBE_LATITUDES_DEGREES = [20, 25, 30, 35, 37.5, 40, 42.5, 45, 50, 55];
const SITE_POINTS_PER_RADAR = PROBE_RANGES_M.length * PROBE_BEARINGS_DEGREES.length;

export interface SiteProbePoint {
  radarIndex: number;
  /** The float32 Mercator coordinates the shader receives. */
  mercatorX: number;
  mercatorY: number;
  /** Exact range and bearing of that float32 point, in double precision. */
  groundRangeM: number;
  bearingRadians: number;
}

export interface NationalProbePoint {
  mercatorY: number;
  latitudeDegrees: number;
}

export interface RadarGeometryProbeReport {
  renderer: string;
  siteSamples: number;
  maxSiteRangeErrorM: number;
  maxSiteBearingErrorDegrees: number;
  /** Bearing error as the distance it moves a point on the map. */
  maxSiteCrossRangeErrorM: number;
  nationalSamples: number;
  maxNationalLatitudeErrorM: number;
}

function toRadians(degrees: number) {
  return degrees * Math.PI / 180;
}

function mercatorLatitude(y: number) {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y)));
}

export function radarGeometryProbePoints(): { site: SiteProbePoint[]; national: NationalProbePoint[] } {
  const site: SiteProbePoint[] = [];
  PROBE_RADARS.forEach((radar, radarIndex) => {
    const radarLatitude = toRadians(radar.latitude);
    const radarLongitude = toRadians(radar.longitude);
    for (const rangeM of PROBE_RANGES_M) {
      for (const bearingDegrees of PROBE_BEARINGS_DEGREES) {
        const angle = rangeM / EARTH_RADIUS_M;
        const heading = toRadians(bearingDegrees);
        const latitude = Math.asin(
          Math.sin(radarLatitude) * Math.cos(angle)
          + Math.cos(radarLatitude) * Math.sin(angle) * Math.cos(heading),
        );
        const longitude = radarLongitude + Math.atan2(
          Math.sin(heading) * Math.sin(angle) * Math.cos(radarLatitude),
          Math.cos(angle) - Math.sin(radarLatitude) * Math.sin(latitude),
        );
        const mercatorX = Math.fround((longitude + Math.PI) / (2 * Math.PI));
        const mercatorY = Math.fround(
          (1 - Math.log(Math.tan(Math.PI / 4 + latitude / 2)) / Math.PI) / 2,
        );
        // The truth belongs to the point the GPU actually receives.
        const pointLatitude = mercatorLatitude(mercatorY);
        const pointLongitude = mercatorX * 2 * Math.PI - Math.PI;
        const deltaLongitude = pointLongitude - radarLongitude;
        const haversine = Math.sin((pointLatitude - radarLatitude) / 2) ** 2
          + Math.cos(radarLatitude) * Math.cos(pointLatitude) * Math.sin(deltaLongitude / 2) ** 2;
        let bearingRadians = Math.atan2(
          Math.sin(deltaLongitude) * Math.cos(pointLatitude),
          Math.cos(radarLatitude) * Math.sin(pointLatitude)
            - Math.sin(radarLatitude) * Math.cos(pointLatitude) * Math.cos(deltaLongitude),
        );
        if (bearingRadians < 0) bearingRadians += 2 * Math.PI;
        site.push({
          radarIndex,
          mercatorX,
          mercatorY,
          groundRangeM: 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(haversine)),
          bearingRadians,
        });
      }
    }
  });
  const national = PROBE_LATITUDES_DEGREES.map((degrees) => {
    const mercatorY = Math.fround(
      (1 - Math.log(Math.tan(Math.PI / 4 + toRadians(degrees) / 2)) / Math.PI) / 2,
    );
    return { mercatorY, latitudeDegrees: mercatorLatitude(mercatorY) * 180 / Math.PI };
  });
  return { site, national };
}

/**
 * Worst errors of GPU results against the probe truth. `siteValues` holds a
 * range and a bearing per Site point; `nationalValues` a latitude per point.
 */
export function evaluateRadarGeometry(
  points: { site: SiteProbePoint[]; national: NationalProbePoint[] },
  siteValues: ArrayLike<number>,
  nationalValues: ArrayLike<number>,
  renderer = "",
): RadarGeometryProbeReport {
  let maxSiteRangeErrorM = 0;
  let maxSiteBearingErrorDegrees = 0;
  let maxSiteCrossRangeErrorM = 0;
  points.site.forEach((point, index) => {
    const rangeM = siteValues[index * 2];
    const bearing = siteValues[index * 2 + 1];
    const bearingError = Math.abs(
      ((bearing - point.bearingRadians + 3 * Math.PI) % (2 * Math.PI)) - Math.PI,
    );
    maxSiteRangeErrorM = Math.max(maxSiteRangeErrorM, Math.abs(rangeM - point.groundRangeM));
    maxSiteBearingErrorDegrees = Math.max(maxSiteBearingErrorDegrees, bearingError * 180 / Math.PI);
    maxSiteCrossRangeErrorM = Math.max(maxSiteCrossRangeErrorM, bearingError * point.groundRangeM);
  });
  let maxNationalLatitudeErrorM = 0;
  points.national.forEach((point, index) => {
    const errorM = Math.abs(nationalValues[index] - point.latitudeDegrees) * Math.PI / 180 * EARTH_RADIUS_M;
    maxNationalLatitudeErrorM = Math.max(maxNationalLatitudeErrorM, errorM);
  });
  // A non-finite result is a failure, never a pass.
  const worst = (value: number) => (Number.isFinite(value) ? value : Infinity);
  return {
    renderer,
    siteSamples: points.site.length,
    maxSiteRangeErrorM: worst(maxSiteRangeErrorM),
    maxSiteBearingErrorDegrees: worst(maxSiteBearingErrorDegrees),
    maxSiteCrossRangeErrorM: worst(maxSiteCrossRangeErrorM),
    nationalSamples: points.national.length,
    maxNationalLatitudeErrorM: worst(maxNationalLatitudeErrorM),
  };
}

const PROBE_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }`;

// One pixel per output value, carried out as the float's own bits in an
// integer target, which is never dithered, blended, or colour-converted.
const PROBE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
${SITE_GEOMETRY_GLSL}
${MERCATOR_LATITUDE_GLSL}
uniform int u_mode;
uniform vec2 u_points[${SITE_POINTS_PER_RADAR}];
uniform float u_latitudes[${PROBE_LATITUDES_DEGREES.length}];
uniform vec3 u_radar_unit;
uniform vec3 u_radar_east;
uniform vec3 u_radar_north;
out uvec4 frag_bits;
void main() {
  int column = int(gl_FragCoord.x);
  float value;
  if (u_mode == 0) {
    float groundRangeM;
    float bearing;
    siteGeometry(u_points[column / 2], u_radar_unit, u_radar_east, u_radar_north, groundRangeM, bearing);
    value = column % 2 == 0 ? groundRangeM : bearing;
  } else {
    value = mercator_latitude(u_latitudes[column]);
  }
  frag_bits = uvec4(floatBitsToUint(value), 0u, 0u, 1u);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("geometry probe could not create a shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`geometry probe shader failed: ${gl.getShaderInfoLog(shader) ?? "no log"}`);
  }
  return shader;
}

/** Measures the shipped radar geometry shaders on this GPU in a throwaway context. */
export function probeRadarGeometry(
  createCanvas: () => HTMLCanvasElement = () => document.createElement("canvas"),
): RadarGeometryProbeReport {
  const points = radarGeometryProbePoints();
  const width = Math.max(SITE_POINTS_PER_RADAR * 2, PROBE_LATITUDES_DEGREES.length);
  const canvas = createCanvas();
  canvas.width = width;
  canvas.height = 1;
  const gl = canvas.getContext("webgl2", { antialias: false });
  if (!gl) throw new Error("geometry probe requires WebGL2");
  try {
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    const program = gl.createProgram();
    if (!program) throw new Error("geometry probe could not create a program");
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, PROBE_VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, PROBE_FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`geometry probe link failed: ${gl.getProgramInfoLog(program) ?? "no log"}`);
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, width, 1);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("geometry probe could not attach its integer target");
    }
    gl.viewport(0, 0, width, 1);
    const pixels = new Uint32Array(width * 4);
    const bits = new Uint32Array(width);
    const readValues = (count: number) => {
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.readPixels(0, 0, width, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, pixels);
      for (let column = 0; column < count; column += 1) bits[column] = pixels[column * 4];
      return Array.from(new Float32Array(bits.buffer, 0, count));
    };
    const uniform = (name: string) => gl.getUniformLocation(program, name);

    gl.uniform1i(uniform("u_mode"), 0);
    const siteValues: number[] = [];
    PROBE_RADARS.forEach((radar, radarIndex) => {
      const frame = radarUnitFrame(radar.latitude, radar.longitude);
      gl.uniform3f(uniform("u_radar_unit"), ...frame.unit);
      gl.uniform3f(uniform("u_radar_east"), ...frame.east);
      gl.uniform3f(uniform("u_radar_north"), ...frame.north);
      const radarPoints = points.site.filter((point) => point.radarIndex === radarIndex);
      gl.uniform2fv(
        uniform("u_points"),
        new Float32Array(radarPoints.flatMap((point) => [point.mercatorX, point.mercatorY])),
      );
      siteValues.push(...readValues(radarPoints.length * 2));
    });

    gl.uniform1i(uniform("u_mode"), 1);
    gl.uniform1fv(uniform("u_latitudes"), new Float32Array(points.national.map((point) => point.mercatorY)));
    const nationalValues = readValues(points.national.length);
    return evaluateRadarGeometry(points, siteValues, nationalValues, renderer);
  } finally {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

export interface RendererCandidateBenchmark {
  sharedGeometry: {
    buildMs: number;
    cpuBytes: number;
    vertices: number;
    indices: number;
    triangles: number;
    checksum: number;
  };
  polarSampling: {
    buildMs: number;
    geometryBytes: number;
    vertices: number;
    triangles: number;
  };
  selected: "polar_sampling_quad";
  rationale: string[];
}

/**
 * Materialize the full shared-grid geometry once so the Phase 3 decision uses
 * measured construction cost and byte counts rather than a spreadsheet alone.
 * The candidate is immediately discarded; only the selected quad is uploaded.
 */
export function benchmarkRendererCandidates(
  radialCount: number,
  gateCount: number,
): RendererCandidateBenchmark {
  assertDimension("radialCount", radialCount);
  assertDimension("gateCount", gateCount);

  const sharedStarted = performance.now();
  const rowWidth = gateCount + 1;
  const vertexCount = (radialCount + 1) * rowWidth;
  const positions = new Float32Array(vertexCount * 2);
  for (let radial = 0; radial <= radialCount; radial += 1) {
    const normalizedRadial = radial / radialCount;
    const rowOffset = radial * rowWidth * 2;
    for (let gate = 0; gate <= gateCount; gate += 1) {
      const offset = rowOffset + gate * 2;
      positions[offset] = normalizedRadial;
      positions[offset + 1] = gate / gateCount;
    }
  }
  const indexCount = radialCount * gateCount * 6;
  const indices = new Uint32Array(indexCount);
  let target = 0;
  for (let radial = 0; radial < radialCount; radial += 1) {
    const row = radial * rowWidth;
    const nextRow = row + rowWidth;
    for (let gate = 0; gate < gateCount; gate += 1) {
      const topLeft = row + gate;
      const bottomLeft = nextRow + gate;
      indices[target] = topLeft;
      indices[target + 1] = bottomLeft;
      indices[target + 2] = topLeft + 1;
      indices[target + 3] = topLeft + 1;
      indices[target + 4] = bottomLeft;
      indices[target + 5] = bottomLeft + 1;
      target += 6;
    }
  }
  const sharedBuildMs = performance.now() - sharedStarted;
  const checksum = positions[positions.length - 1] + indices[indices.length - 1];

  const polarStarted = performance.now();
  const polarVertices = new Float32Array([
    0, 0,
    1, 0,
    0, 1,
    0, 1,
    1, 0,
    1, 1,
  ]);
  const polarBuildMs = performance.now() - polarStarted;

  return {
    sharedGeometry: {
      buildMs: sharedBuildMs,
      cpuBytes: positions.byteLength + indices.byteLength,
      vertices: vertexCount,
      indices: indexCount,
      triangles: radialCount * gateCount * 2,
      checksum,
    },
    polarSampling: {
      buildMs: polarBuildMs,
      geometryBytes: polarVertices.byteLength,
      vertices: 6,
      triangles: 2,
    },
    selected: "polar_sampling_quad",
    rationale: [
      "six reusable vertices instead of a materialized million-vertex grid",
      "raw and status textures preserve native gate semantics without per-gate geometry",
      "geodesic inversion and irregular-azimuth lookup are independently testable on CPU",
      "GPU resource size remains dominated by two compact per-gate integer textures",
    ],
  };
}

function assertDimension(name: string, value: number) {
  if (!Number.isInteger(value) || value <= 0 || value > 4096) {
    throw new RangeError(`${name} must be an integer between 1 and 4096`);
  }
}

import { describe, expect, it } from "vitest";
import { radarShaderSources } from "./RadarCustomLayer";

describe("Radar custom-layer shader contract", () => {
  it("uses public matrix input and compact texture fetches without per-gate geometry", () => {
    expect(radarShaderSources.vertex).toContain("uniform mat4 u_matrix");
    expect(radarShaderSources.fragment).toContain("usampler2D u_raw_codes");
    expect(radarShaderSources.fragment).toContain("usampler2D u_statuses");
    expect(radarShaderSources.fragment).toContain("usampler2D u_azimuth_lookup");
    expect(radarShaderSources.fragment).toContain("sampler2D u_elevations");
    expect(radarShaderSources.fragment).toContain("texelFetch(u_raw_codes");
    expect(radarShaderSources.fragment).toContain("texelFetch(u_palette");
  });

  it("matches CPU half-gate, missing-radial, and status semantics", () => {
    const fragment = radarShaderSources.fragment;
    expect(fragment).toContain("gateCoordinate < -0.5");
    expect(fragment).toContain("float(u_gate_count) - 0.5");
    expect(fragment).toContain("encodedRadial == uint(0)");
    expect(fragment).toContain("float slantRangeM = EFFECTIVE_EARTH_RADIUS_M");
    expect(fragment).toContain("slantRangeM - u_first_gate_center_m");
    expect(fragment).toContain("status == uint(1)");
    expect(fragment).toContain("status == uint(2)");
  });
});

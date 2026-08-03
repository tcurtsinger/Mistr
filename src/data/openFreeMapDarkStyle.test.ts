import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { StyleSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { RADAR_CONTEXT_ANCHOR_LAYER_ID } from "./radarMapContext";
import styleJson from "./openFreeMapDarkStyle.json";

const style = styleJson as StyleSpecification;
const layers = style.layers;

function layer(id: string) {
  const match = layers.find((candidate) => candidate.id === id);
  if (!match) throw new Error(`missing map style layer ${id}`);
  return match;
}

function paint(id: string): Record<string, unknown> {
  return (layer(id).paint ?? {}) as Record<string, unknown>;
}

function layout(id: string): Record<string, unknown> {
  return (layer(id).layout ?? {}) as Record<string, unknown>;
}

function filter(id: string): unknown {
  return (layer(id) as { filter?: unknown }).filter;
}

const lineGeometry = [
  "match",
  ["geometry-type"],
  ["LineString", "MultiLineString"],
  true,
  false,
];

function lineClassFilter(classes: string[]) {
  return [
    "all",
    lineGeometry,
    ["match", ["get", "class"], classes, true, false],
  ];
}

describe("quiet operational radar map context", () => {
  it("remains a valid bundled MapLibre style with unique layers and no new provider", () => {
    expect(validateStyleMin(style)).toEqual([]);
    expect(new Set(layers.map((candidate) => candidate.id)).size).toBe(layers.length);
    expect(Object.keys(style.sources).sort()).toEqual(["ne2_shaded", "openmaptiles"]);
  });

  it("keeps only essential geographic context above the explicit radar anchor", () => {
    const anchorIndex = layers.findIndex(
      (candidate) => candidate.id === RADAR_CONTEXT_ANCHOR_LAYER_ID,
    );
    expect(anchorIndex).toBe(33);
    expect(layers.slice(anchorIndex).map((candidate) => candidate.id)).toEqual([
      "mistr-coastline-context",
      "highway_motorway_subtle",
      "highway_major_subtle",
      "highway_major_casing",
      "highway_major_inner",
      "highway_motorway_casing",
      "highway_motorway_inner",
      "highway_name_other",
      "highway_name_motorway",
      "boundary_state",
      "boundary_country_z0-4",
      "boundary_country_z5-",
      "place_city",
      "place_city_large",
      "place_state",
      "place_country_other",
      "place_country_minor",
      "place_country_major",
    ]);

    const belowRadar = [
      "building",
      "highway_path",
      "highway_minor",
      "highway_secondary_casing",
      "highway_secondary_inner",
      "railway",
      "highway_name_local",
      "water_name",
      "place_town",
    ];
    for (const id of belowRadar) {
      expect(layers.findIndex((candidate) => candidate.id === id)).toBeLessThan(anchorIndex);
    }
  });

  it("draws restrained coastline context from the existing water source", () => {
    expect(layer("mistr-coastline-context")).toMatchObject({
      type: "line",
      source: "openmaptiles",
      "source-layer": "water",
      filter: [
        "all",
        ["match", ["geometry-type"], ["MultiPolygon", "Polygon"], true, false],
        ["!=", ["get", "brunnel"], "tunnel"],
      ],
      paint: {
        "line-color": "rgb(184,194,204)",
        "line-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          4,
          0.3,
          8,
          0.34,
          12,
          0.38,
          16,
          0.42,
        ],
      },
    });
  });

  it("delays regional road density and keeps local streets below radar", () => {
    expect(layer("highway_motorway_subtle")).toMatchObject({ maxzoom: 9 });
    expect(paint("highway_motorway_subtle")["line-color"])
      .toBe("rgba(178,188,198,0.30)");
    expect(layer("highway_major_subtle")).toMatchObject({ minzoom: 8, maxzoom: 11 });
    expect(filter("highway_major_subtle"))
      .toEqual(lineClassFilter(["primary", "trunk"]));
    expect(paint("highway_major_subtle")["line-color"])
      .toBe("rgba(174,184,194,0.26)");

    expect(filter("highway_major_casing"))
      .toEqual(lineClassFilter(["primary", "trunk"]));
    expect(paint("highway_major_casing")["line-color"])
      .toBe("rgba(184,194,204,0.32)");
    expect(filter("highway_secondary_casing"))
      .toEqual(lineClassFilter(["secondary", "tertiary"]));
    expect(paint("highway_secondary_casing")["line-color"])
      .toBe("rgba(132,142,152,0.26)");
    expect(paint("highway_minor")["line-color"])
      .toBe("rgba(124,134,144,0.22)");
    expect(paint("highway_path")["line-color"])
      .toBe("rgba(118,128,138,0.16)");
  });

  it("restricts bright road labels to major classes and subdues local labels below radar", () => {
    expect(layer("highway_name_other")).toMatchObject({ minzoom: 10 });
    expect(filter("highway_name_other"))
      .toEqual(lineClassFilter(["primary", "trunk"]));
    expect(paint("highway_name_other")).toMatchObject({
      "text-color": "rgba(210,218,226,0.62)",
      "text-halo-color": "rgba(5,5,6,0.94)",
      "text-halo-width": 1.1,
    });
    expect(layout("highway_name_other")).not.toHaveProperty("text-transform");

    expect(layer("highway_name_local")).toMatchObject({ minzoom: 13 });
    expect(filter("highway_name_local")).toEqual(lineClassFilter([
      "secondary",
      "tertiary",
      "minor",
      "service",
      "track",
      "path",
    ]));
    expect(paint("highway_name_local")).toMatchObject({
      "text-color": "rgba(150,160,170,0.40)",
      "text-halo-width": 0.9,
    });
  });

  it("uses title-case city labels without missing sprite dependencies", () => {
    const expected = {
      place_city_large: ["rgba(232,236,240,0.86)", 14, 1.3],
      place_city: ["rgba(218,226,234,0.76)", 11, 1.15],
      place_town: ["rgba(170,180,190,0.50)", 10, 1],
    } as const;

    for (const [id, [textColor, textSize, haloWidth]] of Object.entries(expected)) {
      expect(paint(id)).toMatchObject({
        "text-color": textColor,
        "text-halo-color": "rgba(5,5,6,0.94)",
        "text-halo-width": haloWidth,
      });
      expect(layout(id)).toMatchObject({
        "text-anchor": "center",
        "text-justify": "center",
        "text-offset": [0, 0],
        "text-size": textSize,
      });
      expect(layout(id)).not.toHaveProperty("icon-image");
      expect(layout(id)).not.toHaveProperty("text-transform");
    }
  });
});

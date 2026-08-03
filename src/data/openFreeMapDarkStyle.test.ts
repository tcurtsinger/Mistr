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

  it("uses close matte tones for the land-water base plane", () => {
    expect(paint("background")["background-color"]).toBe("rgb(12,12,12)");
    expect(paint("water")["fill-color"]).toBe("rgb(18,20,24)");
    expect(paint("waterway")["line-color"]).toBe("rgb(18,20,24)");
    expect(paint("landcover_wood")["fill-color"]).toBe("rgb(20,21,22)");
    expect(paint("landuse_park")["fill-color"]).toBe("rgb(20,21,22)");
  });

  it("keeps only essential geographic context above the explicit radar anchor", () => {
    const anchorIndex = layers.findIndex(
      (candidate) => candidate.id === RADAR_CONTEXT_ANCHOR_LAYER_ID,
    );
    expect(anchorIndex).toBe(30);
    expect(layers.slice(anchorIndex).map((candidate) => candidate.id)).toEqual([
      "highway_major_context_casing",
      "highway_major_context",
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
      "highway_local_context",
      "railway",
      "highway_name_local",
      "water_name",
      "place_town",
    ];
    for (const id of belowRadar) {
      expect(layers.findIndex((candidate) => candidate.id === id)).toBeLessThan(anchorIndex);
    }
  });

  it("never outlines split water polygons as persistent context", () => {
    expect(layers.filter((candidate) => (
      candidate.type === "line"
      && "source-layer" in candidate
      && candidate["source-layer"] === "water"
    ))).toEqual([]);
    expect(layer(RADAR_CONTEXT_ANCHOR_LAYER_ID).id)
      .toBe("highway_major_context_casing");
  });

  it("uses continuous road treatments instead of hard zoom-band swaps", () => {
    const majorClasses = ["motorway", "trunk", "primary"];
    const localClasses = [
      "secondary",
      "tertiary",
      "minor",
      "service",
      "track",
      "path",
    ];

    for (const id of ["highway_major_context_casing", "highway_major_context"]) {
      expect(layer(id)).not.toHaveProperty("minzoom");
      expect(layer(id)).not.toHaveProperty("maxzoom");
      expect(filter(id)).toEqual(lineClassFilter(majorClasses));
    }
    expect(paint("highway_major_context_casing")).toMatchObject({
      "line-color": "rgba(4,5,6,0.72)",
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        4,
        1.1,
        6,
        1.25,
        8,
        1.45,
        10,
        1.75,
        12,
        2.2,
        16,
        3.6,
        20,
        6,
      ],
    });
    expect(paint("highway_major_context")["line-color"])
      .toBe("rgba(190,200,210,0.34)");

    expect(layer("highway_local_context")).not.toHaveProperty("minzoom");
    expect(layer("highway_local_context")).not.toHaveProperty("maxzoom");
    expect(filter("highway_local_context")).toEqual(lineClassFilter(localClasses));
    expect(paint("highway_local_context")).toMatchObject({
      "line-color": "rgba(124,134,144,0.22)",
      "line-opacity": [
        "interpolate",
        ["linear"],
        ["zoom"],
        6,
        0,
        8,
        0.35,
        10,
        0.65,
        12,
        1,
      ],
    });

    for (const retiredId of [
      "highway_motorway_subtle",
      "highway_major_subtle",
      "highway_major_casing",
      "highway_major_inner",
      "highway_motorway_casing",
      "highway_motorway_inner",
      "highway_path",
      "highway_minor",
      "highway_secondary_casing",
      "highway_secondary_inner",
    ]) {
      expect(layers.map((candidate) => candidate.id)).not.toContain(retiredId);
    }
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
      place_city_large: ["rgba(226,232,238,0.82)", 14, 1.2],
      place_city: ["rgba(208,216,224,0.68)", 11, 1],
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

  it("keeps administrative labels natural-case and subordinate to cities", () => {
    expect(layout("place_state")).not.toHaveProperty("text-transform");
    expect(paint("place_state")["text-color"]).toBe("rgba(182,192,202,0.46)");

    for (const id of ["place_country_other", "place_country_minor", "place_country_major"]) {
      expect(paint(id)["text-color"]).toBe("rgba(180,190,200,0.44)");
    }
  });
});

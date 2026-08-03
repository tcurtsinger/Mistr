import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { StyleSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";
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

describe("operational radar map context", () => {
  it("remains a valid bundled MapLibre style with unique layers and no new provider", () => {
    expect(validateStyleMin(style)).toEqual([]);
    expect(new Set(layers.map((candidate) => candidate.id)).size).toBe(layers.length);
    expect(Object.keys(style.sources).sort()).toEqual(["ne2_shaded", "openmaptiles"]);
  });

  it("keeps coastline, major transport, boundaries, and labels above radar", () => {
    const firstSymbolIndex = layers.findIndex((candidate) => candidate.type === "symbol");
    expect(layers[firstSymbolIndex]?.id).toBe("water_name");

    const aboveRadar = [
      "mistr-coastline-context",
      "highway_major_casing",
      "highway_major_inner",
      "highway_motorway_casing",
      "highway_motorway_inner",
      "boundary_state",
      "place_city_large",
    ];
    for (const id of aboveRadar) {
      expect(layers.findIndex((candidate) => candidate.id === id)).toBeGreaterThan(firstSymbolIndex);
    }

    expect(layers.findIndex((candidate) => candidate.id === "highway_major_casing"))
      .toBeLessThan(layers.findIndex((candidate) => candidate.id === "highway_major_inner"));
    expect(layers.findIndex((candidate) => candidate.id === "highway_motorway_casing"))
      .toBeLessThan(layers.findIndex((candidate) => candidate.id === "highway_motorway_inner"));
  });

  it("draws neutral coastline context from the existing water source", () => {
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
        "line-color": "rgba(244,247,250,0.56)",
      },
    });
  });

  it("uses dual-contrast major roads without brightening the entire street graph", () => {
    expect(paint("highway_major_casing")["line-color"])
      .toBe("rgba(244,247,250,0.54)");
    expect(paint("highway_major_inner")["line-color"])
      .toBe("rgba(5,5,6,0.88)");
    expect(paint("highway_motorway_casing")["line-color"])
      .toBe("rgba(244,247,250,0.64)");
    expect(paint("highway_motorway_inner")["line-color"])
      .toBe("rgba(5,5,6,0.90)");
    expect(paint("highway_minor")["line-color"]).toBe("#181818");
    expect(paint("highway_path")["line-color"]).toBe("rgb(27 ,27 ,29)");
  });

  it("gives operational labels a pale face and near-black halo", () => {
    const expected = {
      place_city_large: ["rgba(244,247,250,0.96)", 1.5],
      place_city: ["rgba(244,247,250,0.90)", 1.4],
      place_town: ["rgba(244,247,250,0.84)", 1.3],
      place_state: ["rgba(244,247,250,0.72)", 1.3],
      highway_name_motorway: ["rgba(244,247,250,0.88)", 1.3],
      highway_name_other: ["rgba(244,247,250,0.78)", 1.25],
      water_name: ["rgba(218,229,238,0.76)", 1.25],
    } as const;

    for (const [id, [textColor, haloWidth]] of Object.entries(expected)) {
      expect(paint(id)).toMatchObject({
        "text-color": textColor,
        "text-halo-color": "rgba(5,5,6,0.96)",
        "text-halo-blur": 0.35,
        "text-halo-width": haloWidth,
      });
    }
  });
});

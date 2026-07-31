import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";
import { getRuntimeSnapshot, type RuntimeSnapshot } from "./runtime";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/dark";

export function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [runtime, setRuntime] = useState<RuntimeSnapshot>({
    shell: "browser",
    appVersion: "development",
  });
  const [mapState, setMapState] = useState("INITIALIZING");

  useEffect(() => {
    void getRuntimeSnapshot().then(setRuntime);
  }, []);

  useEffect(() => {
    if (!mapContainer.current || map.current) {
      return;
    }

    const instance = new maplibregl.Map({
      container: mapContainer.current,
      style: MAP_STYLE,
      center: [-97.5, 35.4],
      zoom: 5.2,
      attributionControl: false,
      maxPitch: 0,
    });

    instance.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      "bottom-right",
    );
    instance.once("load", () => setMapState("BASEMAP READY"));
    instance.once("error", () => setMapState("BASEMAP UNAVAILABLE"));
    map.current = instance;

    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  return (
    <main className="app-shell">
      <div ref={mapContainer} className="map-surface" aria-label="Mistr map" />
      <header className="top-rail">
        <div>
          <p className="eyebrow">NEXRAD RENDERING EXPERIMENT</p>
          <h1>MISTR <span>PHASE 0</span></h1>
        </div>
        <div className="status-cluster" aria-label="Prototype status">
          <Status label="SHELL" value={runtime.shell.toUpperCase()} />
          <Status label="VERSION" value={runtime.appVersion} />
          <Status label="MAP" value={mapState} />
        </div>
      </header>
      <section className="checkpoint" aria-labelledby="checkpoint-title">
        <p className="eyebrow">CURRENT CHECKPOINT</p>
        <h2 id="checkpoint-title">Baseline &amp; harness</h2>
        <p>
          Desktop shell, fixture provenance, environment capture, and public-repository
          controls. No decoder or custom radar layer is claimed yet.
        </p>
        <dl>
          <div><dt>RADAR SOURCE</dt><dd>NOT CONNECTED</dd></div>
          <div><dt>DECODE PATH</dt><dd>PHASE 1</dd></div>
          <div><dt>GPU RESIDENCY</dt><dd>PHASE 4</dd></div>
        </dl>
      </section>
      <footer className="bottom-rail">
        <span>KTLX / OKLAHOMA TEST AREA</span>
        <span className="truth-label">PROTOTYPE — NOT OPERATIONAL</span>
      </footer>
    </main>
  );
}

function Status({ label, value }: { label: string; value: string }) {
  return (
    <div className="status">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

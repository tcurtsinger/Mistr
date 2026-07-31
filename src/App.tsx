import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";
import { updateMapReadiness, type MapReadiness } from "./mapReadiness";
import {
  runPackagedPhase2Benchmark,
  tauriInvokeFunction,
  type PackagedPhase2Benchmark,
} from "./packed-sweep/transferClient";
import { getRuntimeSnapshot, type RuntimeSnapshot } from "./runtime";

const MAP_STYLE = "https://tiles.openfreemap.org/styles/dark";

export function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const benchmarkStarted = useRef(false);
  const [runtime, setRuntime] = useState<RuntimeSnapshot>({
    shell: "browser",
    appVersion: "development",
  });
  const [mapState, setMapState] = useState<MapReadiness>("INITIALIZING");
  const [benchmark, setBenchmark] = useState<BenchmarkState>({ kind: "idle" });

  useEffect(() => {
    void getRuntimeSnapshot().then(setRuntime);
  }, []);

  useEffect(() => {
    if (runtime.shell !== "tauri" || benchmarkStarted.current) {
      return;
    }
    benchmarkStarted.current = true;
    setBenchmark({ kind: "running" });
    void tauriInvokeFunction()
      .then((invoke) => runPackagedPhase2Benchmark(invoke, 10))
      .then((report) => setBenchmark({ kind: "complete", report }))
      .catch((error: unknown) => {
        setBenchmark({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, [runtime.shell]);

  useEffect(() => {
    if (!mapContainer.current || map.current) {
      return;
    }

    let instance: MapLibreMap | undefined;
    try {
      instance = new maplibregl.Map({
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
      instance.once("load", () => {
        setMapState((current) => updateMapReadiness(current, "load"));
      });
      instance.on("error", () => {
        setMapState((current) => updateMapReadiness(current, "error"));
      });
      map.current = instance;
    } catch {
      instance?.remove();
      setMapState((current) => updateMapReadiness(current, "error"));
      return;
    }

    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  const ipcStatus = benchmark.kind === "complete"
    ? benchmark.report.status
    : benchmark.kind === "error"
      ? "ERROR"
      : benchmark.kind === "running"
        ? "RUNNING"
        : "TAURI ONLY";

  return (
    <main className="app-shell">
      <div ref={mapContainer} className="map-surface" aria-label="Mistr map" />
      <header className="top-rail">
        <div>
          <p className="eyebrow">NEXRAD RENDERING EXPERIMENT</p>
          <h1>MISTR <span>PHASE 2</span></h1>
        </div>
        <div className="status-cluster" aria-label="Prototype status">
          <Status label="SHELL" value={runtime.shell.toUpperCase()} />
          <Status label="VERSION" value={runtime.appVersion} />
          <Status label="MAP" value={mapState} />
          <Status label="BINARY IPC" value={ipcStatus} />
        </div>
      </header>
      <section className="checkpoint" aria-labelledby="checkpoint-title">
        <p className="eyebrow">CURRENT CHECKPOINT</p>
        <h2 id="checkpoint-title">Packed wire &amp; binary IPC</h2>
        <p>
          A strict Rust-encoded sweep crosses Tauri as one raw ArrayBuffer, is
          independently validated in TypeScript, and remains behind two explicit
          transfer credits. This checkpoint does not claim GPU rendering yet.
        </p>
        <BenchmarkReadout state={benchmark} />
      </section>
      <footer className="bottom-rail">
        <span>KTLX / OKLAHOMA TEST AREA</span>
        <span className="truth-label">PROTOTYPE — NOT OPERATIONAL</span>
      </footer>
    </main>
  );
}

type BenchmarkState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "complete"; report: PackagedPhase2Benchmark }
  | { kind: "error"; message: string };

function BenchmarkReadout({ state }: { state: BenchmarkState }) {
  if (state.kind === "error") {
    return <p className="benchmark-error" role="alert">{state.message}</p>;
  }
  if (state.kind !== "complete") {
    return (
      <dl>
        <div><dt>PACKAGED PROBE</dt><dd>{state.kind === "running" ? "RUNNING" : "TAURI REQUIRED"}</dd></div>
        <div><dt>WIRE SCHEMA</dt><dd>PACKEDSWEEP V1</dd></div>
        <div><dt>GPU RESIDENCY</dt><dd>PHASE 4</dd></div>
      </dl>
    );
  }
  const report = state.report;
  return (
    <dl aria-label="Packaged Phase 2 benchmark">
      <div><dt>RESULT</dt><dd>{report.status}</dd></div>
      <div><dt>PAYLOAD</dt><dd>{formatMiB(report.payloadBytes)} MiB</dd></div>
      <div><dt>ENCODE P95</dt><dd>{formatMs(report.encoder.encodeMs.p95)} ms</dd></div>
      <div><dt>RAW INVOKE P95</dt><dd>{formatMs(report.invokeMs.p95)} ms</dd></div>
      <div><dt>PARSE P95</dt><dd>{formatMs(report.parseMs.p95)} ms</dd></div>
      <div><dt>BACKPRESSURE</dt><dd>{report.backpressure.fulfilled}/2 + {report.backpressure.rejected} REJECTED</dd></div>
      <div><dt>CANCELLATION</dt><dd>{report.cancellation.staleRequestRejected ? "STALE BLOCKED" : "FAILED"}</dd></div>
      <div><dt>CREDITS</dt><dd>{report.finalTransferState.availableCredits}/{report.finalTransferState.creditLimit} AVAILABLE</dd></div>
    </dl>
  );
}

function formatMiB(bytes: number) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function formatMs(milliseconds: number) {
  return milliseconds.toFixed(1);
}

function Status({ label, value }: { label: string; value: string }) {
  return (
    <div className="status">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

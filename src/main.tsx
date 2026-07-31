import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import { App } from "./App";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Mistr root element was not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

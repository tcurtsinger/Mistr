export interface RuntimeSnapshot {
  shell: "tauri" | "browser";
  appVersion: string;
}

export async function getRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return { shell: "browser", appVersion: "development" };
  }

  const { getVersion } = await import("@tauri-apps/api/app");
  return { shell: "tauri", appVersion: await getVersion() };
}

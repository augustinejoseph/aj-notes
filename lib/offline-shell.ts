"use client";
export async function prepareOfflineShell() {
  if (!("serviceWorker" in navigator))
    throw new Error("Offline reopening requires service worker support");
  const existing = await navigator.serviceWorker.getRegistration();
  if (!existing) await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const cache = await caches.open("aj-notes-shell-v1");
  // Production precaches every emitted chunk, including lazy diagram implementations.
  const manifest = await fetch("/offline-assets.json", {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  }).catch(() => cache.match("/offline-assets.json"));
  let assets: string[];
  if (manifest?.ok) {
    assets = (await manifest.clone().json()).assets;
  } else {
    // Development-only fallback; production build always emits the complete manifest.
    await Promise.all([import("../components/editor"), import("mermaid")]);
    assets = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter(
        (url) =>
          new URL(url).origin === location.origin &&
          new URL(url).pathname.startsWith("/_next/static/"),
      );
  }
  await Promise.all(
    assets.map(async (url) => {
      if (!(await cache.match(url))) {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error("Offline editor download failed");
        await cache.put(url, response);
      }
    }),
  );
  const shell = await fetch("/", {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  }).catch(() => cache.match("/"));
  if (!shell?.ok) throw new Error("Offline shell download failed");
  await cache.put("/", shell);
  if (manifest?.ok) await cache.put("/offline-assets.json", manifest);
}

// local: wallpaper image storage. The picked file is downscaled once and kept
// as a Blob in IndexedDB (per browser); tuning lives in localStorage.

const DB_NAME = "pi-web-local";
const STORE = "wallpaper";
const KEY = "image";
const MAX_EDGE = 2560;
const TUNING_KEY = "pi-wallpaper-tuning";

/** Fired when the image itself changes (reload the Blob). */
export const WALLPAPER_CHANGED_EVENT = "local:wallpaper-changed";
/** Fired when only tuning changes (update CSS variables, keep the image). */
export const WALLPAPER_TUNING_EVENT = "local:wallpaper-tuning";

export interface WallpaperTuning {
  /** Main surface opacity (chat area, whole app base), %. */
  surface: number;
  /** Extra tint on sidebar, top bar and panels, drawn over the main surface, %. */
  panel: number;
  /** Image brightness, %. */
  brightness: number;
  /** Image saturation, %. */
  saturation: number;
}

export const TUNING_RANGES: Record<keyof WallpaperTuning, { min: number; max: number; step: number; default: number }> = {
  surface: { min: 0, max: 100, step: 5, default: 80 },
  panel: { min: 0, max: 80, step: 5, default: 20 },
  brightness: { min: 20, max: 130, step: 5, default: 100 },
  saturation: { min: 0, max: 200, step: 10, default: 100 },
};

export const DEFAULT_TUNING: WallpaperTuning = {
  surface: TUNING_RANGES.surface.default,
  panel: TUNING_RANGES.panel.default,
  brightness: TUNING_RANGES.brightness.default,
  saturation: TUNING_RANGES.saturation.default,
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function loadWallpaper(): Promise<Blob | null> {
  const blob = await withStore<Blob | undefined>("readonly", (store) => store.get(KEY));
  return blob ?? null;
}

/** Downscale to MAX_EDGE (never upscale) so the browser never decodes an 8K image per paint. */
async function downscale(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1) {
    bitmap.close();
    return file;
  }
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is not available");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
}

export async function saveWallpaper(file: Blob): Promise<void> {
  const blob = await downscale(file);
  await withStore("readwrite", (store) => store.put(blob, KEY));
  window.dispatchEvent(new Event(WALLPAPER_CHANGED_EVENT));
}

export async function clearWallpaper(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(KEY));
  window.dispatchEvent(new Event(WALLPAPER_CHANGED_EVENT));
}

export function loadTuning(): WallpaperTuning {
  let stored: Partial<WallpaperTuning> = {};
  try {
    stored = JSON.parse(localStorage.getItem(TUNING_KEY) ?? "{}") as Partial<WallpaperTuning>;
  } catch {
    // Corrupt value → defaults.
  }
  const tuning = { ...DEFAULT_TUNING };
  for (const key of Object.keys(TUNING_RANGES) as (keyof WallpaperTuning)[]) {
    const value = stored[key];
    const range = TUNING_RANGES[key];
    if (typeof value === "number" && value >= range.min && value <= range.max) tuning[key] = value;
  }
  return tuning;
}

export function saveTuning(tuning: WallpaperTuning): void {
  localStorage.setItem(TUNING_KEY, JSON.stringify(tuning));
  window.dispatchEvent(new Event(WALLPAPER_TUNING_EVENT));
}

export function applyTuning(tuning: WallpaperTuning): void {
  const style = document.documentElement.style;
  style.setProperty("--wp-surface", `${tuning.surface}%`);
  style.setProperty("--wp-panel-tint", `${tuning.panel}%`);
  style.setProperty("--wp-brightness", String(tuning.brightness / 100));
  style.setProperty("--wp-saturation", String(tuning.saturation / 100));
}

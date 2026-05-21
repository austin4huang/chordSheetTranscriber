// App-wide user preferences. Persisted in the existing IndexedDB `kv` store
// under a single key, then mirrored in an in-memory cache so callers can read
// values synchronously (the cache is hydrated on startup via `loadPrefs()`).
//
// To add a new preference: extend the `Prefs` type, add a default to
// `DEFAULTS`, and read/write it through `getPrefs()` / `updatePrefs()`.
// The Settings modal in src/components/Settings.tsx is where most new prefs
// will surface to users.

import { getDb } from "./storage";

export interface Prefs {
  /** Pen color last selected in the annotation toolbar. */
  penColor: string;
  /** Text-annotation default font size (px). */
  penFontSize: number;
  /** Whether new song views open in Numbers mode by default. */
  defaultNumberMode: boolean;
  /** Sheet body font scale, applied as a CSS variable on <html>. */
  fontScale: "sm" | "md" | "lg";
  /** Annotation toolbar collapsed-by-default. */
  annoToolbarCollapsed: boolean;
  /** Editor/preview split as a 0–100 percentage of the body width. */
  editorSplit: number;
  /** Whether the editor pane is hidden (preview-only) by default. */
  editorHidden: boolean;
  /** When true, force single-column sheet rendering regardless of width. */
  singleColumn: boolean;
  /** How an import conflict is resolved when none is sticky:
   *   - "ask": always show the comparison modal (default)
   *   - "replace": silently replace the existing song
   *   - "rename": silently keep both (incoming gets a unique title) */
  conflictDefault: "ask" | "replace" | "rename";
}

export const DEFAULTS: Prefs = {
  penColor: "#e23b2e",
  penFontSize: 16,
  defaultNumberMode: false,
  fontScale: "md",
  annoToolbarCollapsed: false,
  editorSplit: 50,
  editorHidden: false,
  singleColumn: false,
  conflictDefault: "ask",
};

const KEY = "prefs.v1";

let cache: Prefs = { ...DEFAULTS };
let loaded = false;
const subs = new Set<(p: Prefs) => void>();

/** Read prefs synchronously. Returns defaults until `loadPrefs()` finishes. */
export function getPrefs(): Prefs {
  return cache;
}

/** Merge a patch into the prefs cache and persist asynchronously. Returns
 *  the new prefs so callers can immediately use the updated value. */
export function updatePrefs(patch: Partial<Prefs>): Prefs {
  cache = { ...cache, ...patch };
  for (const cb of subs) cb(cache);
  if (loaded) void persist(cache);
  return cache;
}

/** Subscribe to pref changes — fires synchronously on every update. */
export function onPrefsChange(cb: (p: Prefs) => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

/** Hydrate the in-memory cache from IndexedDB. Idempotent; safe to call
 *  multiple times. Resolves once the cache reflects persisted values. */
export async function loadPrefs(): Promise<void> {
  if (loaded) return;
  try {
    const db = await getDb();
    const v = await new Promise<Partial<Prefs> | undefined>((resolve, reject) => {
      const r = db.transaction("kv").objectStore("kv").get(KEY);
      r.onsuccess = () => resolve(r.result as Partial<Prefs> | undefined);
      r.onerror = () => reject(r.error);
    });
    if (v && typeof v === "object") {
      // Merge over defaults so newly-added prefs get sensible values even
      // when the stored object pre-dates them.
      cache = { ...DEFAULTS, ...v };
      for (const cb of subs) cb(cache);
    }
  } catch {
    // If IDB fails, keep using defaults — better than blocking the app.
  }
  loaded = true;
}

async function persist(p: Prefs): Promise<void> {
  try {
    const db = await getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(p, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Swallow — preferences not persisting is annoying but not fatal.
  }
}

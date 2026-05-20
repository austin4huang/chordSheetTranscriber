import type { ChordSheet, SheetLine } from "./types";
import { parseChord } from "./nashville";

// The library lives in IndexedDB (object stores `sheets` and `sets`, keyed
// by `id`). At startup we hydrate everything into an in-memory cache; all
// public read APIs serve that cache synchronously, and writes update the
// cache plus persist the single changed record back to IDB in the
// background. localStorage is still read once on first run to migrate any
// pre-IDB library into IDB, then removed.

const DB_NAME = "chordsheets";
const DB_VERSION = 2;
const LEGACY_LS_KEY = "musicApp.sheets.v1";

// A Set is just an ordered list of references into the global sheet database;
// the sheets themselves stay shared, so editing one updates it everywhere.
export interface SongSet {
  id: string;
  name: string;
  sheetIds: string[];
  createdAt?: number;   // unset on legacy sets — fall back to updatedAt
  updatedAt: number;
}

export interface Stored {
  sheets: ChordSheet[];
  sets?: SongSet[];
}

// --- Shared IndexedDB handle ----------------------------------------------

let _db: Promise<IDBDatabase> | null = null;

/** Shared connection to the app's IndexedDB. Other modules (persist.ts)
 *  also open through here so the schema upgrade happens once. */
export function getDb(): Promise<IDBDatabase> {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1: introduced by the durable-storage layer for the folder handle.
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      // v2: per-record library storage.
      if (!db.objectStoreNames.contains("sheets"))
        db.createObjectStore("sheets", { keyPath: "id" });
      if (!db.objectStoreNames.contains("sets"))
        db.createObjectStore("sets", { keyPath: "id" });
    };
    // Fires when another connection (e.g. an older HMR module instance,
    // or a different tab on an older version) is preventing the upgrade.
    // Without this the open request hangs silently forever.
    req.onblocked = () => {
      console.warn(
        "IndexedDB upgrade blocked — close other tabs of this app and reload.",
      );
    };
    req.onsuccess = () => {
      const db = req.result;
      // If another tab later opens an even newer version, close so they can
      // upgrade instead of getting blocked by us.
      db.onversionchange = () => {
        db.close();
        _db = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return _db;
}

function readAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result as T[]);
    r.onerror = () => reject(r.error);
  });
}

function idbPut(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbBulkPut(
  db: IDBDatabase,
  store: string,
  values: unknown[],
): Promise<void> {
  if (!values.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    for (const v of values) os.put(v);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbReplaceAll(
  db: IDBDatabase,
  store: string,
  values: unknown[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    os.clear();
    for (const v of values) os.put(v);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Cache + hydration ----------------------------------------------------

interface Cache {
  sheets: ChordSheet[];
  sets: SongSet[];
}
const cache: Cache = { sheets: [], sets: [] };
let writeListener: ((s: Stored) => void) | null = null;
let _readyPromise: Promise<void> | null = null;

function readLegacyLocalStorage(): Stored | null {
  try {
    const raw = localStorage.getItem(LEGACY_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored;
    if (!parsed || !Array.isArray(parsed.sheets)) return null;
    return { sheets: parsed.sheets, sets: parsed.sets ?? [] };
  } catch {
    return null;
  }
}

async function hydrate(): Promise<void> {
  try {
    const db = await getDb();
    const sheets = await readAll<ChordSheet>(db, "sheets");
    const sets = await readAll<SongSet>(db, "sets");
    if (sheets.length === 0 && sets.length === 0) {
      // First run, or empty IDB: migrate from the legacy localStorage blob
      // if one exists. Otherwise start empty.
      const legacy = readLegacyLocalStorage();
      if (legacy && (legacy.sheets.length || (legacy.sets ?? []).length)) {
        cache.sheets = legacy.sheets;
        cache.sets = legacy.sets ?? [];
        await idbBulkPut(db, "sheets", cache.sheets);
        await idbBulkPut(db, "sets", cache.sets);
        try {
          localStorage.removeItem(LEGACY_LS_KEY);
        } catch {
          /* clearing the legacy blob is best-effort */
        }
      }
    } else {
      cache.sheets = sheets;
      cache.sets = sets;
    }
  } catch (e) {
    console.error("Failed to hydrate storage from IndexedDB:", e);
    // Fall back to whatever's in the cache (empty by default).
  }
}

/** Resolves once the in-memory cache has been hydrated from IDB. Render
 *  blocking on this avoids flashing an empty library on startup. */
export function whenStorageReady(): Promise<void> {
  if (!_readyPromise) _readyPromise = hydrate();
  return _readyPromise;
}

// During development, close the IDB connection when the module is replaced
// so a schema bump on the next reload doesn't get blocked by this tab's
// lingering older connection.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void _db?.then((db) => db.close()).catch(() => {});
    _db = null;
    _readyPromise = null;
  });
}

// --- Write listener (persist.ts mirrors snapshots to a linked folder) ------

export function onStoreWrite(cb: ((s: Stored) => void) | null) {
  writeListener = cb;
}

function snapshot(): Stored {
  return { sheets: cache.sheets.slice(), sets: cache.sets.slice() };
}

function notifyWrite() {
  try {
    writeListener?.(snapshot());
  } catch {
    /* persistence is best-effort; never block a local save */
  }
}

// --- Public APIs (synchronous over the in-memory cache) -------------------

/** Whole-library snapshot (for backup/export and folder sync). */
export function readStore(): Stored {
  return snapshot();
}

/** Replace the entire library (restore from backup / linked folder).
 *  `notify` writes through the persistence layer too (default); pass false
 *  when applying data that *came from* that layer to avoid an echo. */
export function replaceStore(s: Stored, notify = true) {
  cache.sheets = (s.sheets ?? []).slice();
  cache.sets = (s.sets ?? []).slice();
  void getDb()
    .then(async (db) => {
      await idbReplaceAll(db, "sheets", cache.sheets);
      await idbReplaceAll(db, "sets", cache.sets);
    })
    .catch((e) => console.error("replaceStore failed:", e));
  if (notify) notifyWrite();
}

export function listSheets(): ChordSheet[] {
  return cache.sheets.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSheet(id: string): ChordSheet | undefined {
  return cache.sheets.find((s) => s.id === id);
}

export function saveSheet(sheet: ChordSheet) {
  const updated = { ...sheet, updatedAt: Date.now() };
  const idx = cache.sheets.findIndex((s) => s.id === sheet.id);
  if (idx >= 0) cache.sheets[idx] = updated;
  else cache.sheets.push(updated);
  void getDb()
    .then((db) => idbPut(db, "sheets", updated))
    .catch((e) => console.error("saveSheet failed:", e));
  notifyWrite();
}

/** Patch a stored sheet's fields without touching the rest (used for the
 *  per-song display-key persistence so we don't have to write through the
 *  editor's full Save). */
export function updateSheet(id: string, patch: Partial<ChordSheet>) {
  const idx = cache.sheets.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const updated = { ...cache.sheets[idx], ...patch, updatedAt: Date.now() };
  cache.sheets[idx] = updated;
  void getDb()
    .then((db) => idbPut(db, "sheets", updated))
    .catch((e) => console.error("updateSheet failed:", e));
  notifyWrite();
}

export function deleteSheet(id: string) {
  cache.sheets = cache.sheets.filter((s) => s.id !== id);
  // Drop the sheet from any sets that referenced it.
  const touched: SongSet[] = [];
  cache.sets = cache.sets.map((set) => {
    if (!set.sheetIds.includes(id)) return set;
    const next = { ...set, sheetIds: set.sheetIds.filter((sid) => sid !== id) };
    touched.push(next);
    return next;
  });
  void getDb()
    .then(async (db) => {
      await idbDelete(db, "sheets", id);
      for (const set of touched) await idbPut(db, "sets", set);
    })
    .catch((e) => console.error("deleteSheet failed:", e));
  notifyWrite();
}

/** Replace the sheet at `oldId` with `newSheet`: removes `oldId`, saves
 *  `newSheet` (insert or update), and re-points any set references from
 *  `oldId` to `newSheet.id`. Used by the duplicate-title "Replace" flow,
 *  where the user merges their current edits into an existing sheet. */
export function replaceSheet(oldId: string, newSheet: ChordSheet) {
  cache.sheets = cache.sheets.filter((x) => x.id !== oldId);
  const idx = cache.sheets.findIndex((x) => x.id === newSheet.id);
  const updated = { ...newSheet, updatedAt: Date.now() };
  if (idx >= 0) cache.sheets[idx] = updated;
  else cache.sheets.push(updated);
  const touched: SongSet[] = [];
  cache.sets = cache.sets.map((set) => {
    if (!set.sheetIds.some((sid) => sid === oldId || sid === newSheet.id))
      return set;
    // Re-point references, then dedup in case the set already had both ids.
    const mapped = set.sheetIds.map((sid) =>
      sid === oldId ? newSheet.id : sid,
    );
    const seen = new Set<string>();
    const deduped = mapped.filter((sid) => {
      if (seen.has(sid)) return false;
      seen.add(sid);
      return true;
    });
    const next = { ...set, sheetIds: deduped };
    touched.push(next);
    return next;
  });
  void getDb()
    .then(async (db) => {
      await idbDelete(db, "sheets", oldId);
      await idbPut(db, "sheets", updated);
      for (const set of touched) await idbPut(db, "sets", set);
    })
    .catch((e) => console.error("replaceSheet failed:", e));
  notifyWrite();
}

export function listSets(): SongSet[] {
  return cache.sets.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSet(id: string): SongSet | undefined {
  return cache.sets.find((s) => s.id === id);
}

export function saveSet(set: SongSet) {
  const updated = { ...set, updatedAt: Date.now() };
  const idx = cache.sets.findIndex((x) => x.id === set.id);
  if (idx >= 0) cache.sets[idx] = updated;
  else cache.sets.push(updated);
  void getDb()
    .then((db) => idbPut(db, "sets", updated))
    .catch((e) => console.error("saveSet failed:", e));
  notifyWrite();
}

export function deleteSet(id: string) {
  cache.sets = cache.sets.filter((x) => x.id !== id);
  void getDb()
    .then((db) => idbDelete(db, "sets", id))
    .catch((e) => console.error("deleteSet failed:", e));
  notifyWrite();
}

// ChordPro <-> SheetLine[] serialization for the textarea editor.
// Format:
//   {title: ...}
//   {key: D}
//   [section: VERSE 1]
//   | D | G | D | G |        <- chord-only line is preserved verbatim
//   [D]Are you [G]hurting...
//   (blank line)
export function linesToText(sheet: ChordSheet): string {
  const out: string[] = [];
  out.push(`{title: ${sheet.title}}`);
  if (sheet.artist) out.push(`{artist: ${sheet.artist}}`);
  out.push(`{key: ${sheet.key}${sheet.mode === "minor" ? "m" : ""}}`);
  if (sheet.tempo) out.push(`{tempo: ${sheet.tempo}}`);
  if (sheet.time) out.push(`{time: ${sheet.time}}`);
  out.push("");
  for (const line of sheet.lines) {
    if (line.kind === "section") out.push(`[section: ${line.text}]`);
    else if (line.kind === "blank") out.push("");
    else out.push(line.text);
  }
  return out.join("\n");
}

export function textToSheet(text: string, base: ChordSheet): ChordSheet {
  const lines = text.split(/\r?\n/);
  const result: ChordSheet = { ...base, lines: [] };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      result.lines.push({ kind: "blank", text: "" });
      continue;
    }
    const directive = line.match(/^\{(\w+):\s*(.*)\}$/);
    if (directive) {
      const [, k, v] = directive;
      if (k === "title") result.title = v.trim();
      else if (k === "artist") result.artist = v.trim();
      else if (k === "key") {
        const m = v.trim().match(/^([A-G](?:#|b)?)(m)?$/);
        if (m) {
          result.key = m[1];
          result.mode = m[2] ? "minor" : "major";
        }
      } else if (k === "tempo") result.tempo = Number(v) || undefined;
      else if (k === "time") result.time = v.trim();
      continue;
    }
    const sec = line.match(/^\[section:\s*(.*)\]$/);
    if (sec) {
      result.lines.push({ kind: "section", text: sec[1].trim() });
      continue;
    }
    if (looksLikeChordOnly(line)) {
      result.lines.push({ kind: "chord-only", text: line });
    } else {
      result.lines.push({ kind: "chordpro", text: line });
    }
  }
  // Trim leading/trailing blank lines
  while (result.lines.length && result.lines[0].kind === "blank") result.lines.shift();
  while (result.lines.length && result.lines.at(-1)!.kind === "blank") result.lines.pop();
  return result;
}

const CHORD_TOKEN_RE =
  /^[A-G](?:#|b)?(?:maj7|maj9|maj|min|m|M|°|o|dim|aug|\+|sus2|sus4|sus|5)?[0-9a-zA-Z()#b+\-]*?(?:\/[A-G](?:#|b)?)?$/;

function isChordToken(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  return CHORD_TOKEN_RE.test(t) && parseChord(t) !== null;
}

function looksLikeChordOnly(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // Inline bracketed chords mean it's a chordpro lyric line, not chord-only.
  if (/\[[^\]]+\]/.test(t)) return false;
  if (t.includes("|")) {
    const tokens = t.split(/\s+/).filter(Boolean);
    return tokens.every((tok) => /^[|:]+$/.test(tok) || /^[A-G]/.test(tok));
  }
  // No bar-lines: still a chord line if, ignoring parenthetical performance
  // annotations like "(1st Ending)" / "(To Chorus)", every token is a chord.
  // Require >=2 chords (or a paren annotation) so a lone word like "A" or a
  // one-word lyric isn't mistaken for a chord line.
  const hadParen = /\([^)]*\)/.test(t);
  const rest = t.replace(/\([^)]*\)/g, " ").trim().split(/\s+/).filter(Boolean);
  if (rest.length === 0 || !rest.every(isChordToken)) return false;
  return rest.length >= 2 || hadParen;
}

// Discard helper for new-sheet bootstrapping
export function emptySheetWithDefaults(): ChordSheet {
  return {
    id: crypto.randomUUID(),
    title: "Untitled",
    key: "C",
    mode: "major",
    lines: [
      { kind: "section", text: "VERSE 1" },
      { kind: "chordpro", text: "[C]Type your [G]lyrics here" },
    ] as SheetLine[],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** createdAt with a legacy fallback (older sheets have no createdAt). */
export function createdAtOf(s: ChordSheet): number {
  return s.createdAt ?? s.updatedAt;
}

export function createdAtOfSet(s: SongSet): number {
  return s.createdAt ?? s.updatedAt;
}

/** Return a title that doesn't collide (case-insensitively) with `taken`.
 *  Appends " (2)", " (3)", … Strips an existing trailing "(N)" first so a
 *  re-conflict renumbers ("Foo (2)" → "Foo (3)") rather than nesting
 *  ("Foo (2) (2)"). */
export function nextUniqueTitle(base: string, taken: Set<string>): string {
  const norm = (s: string) => s.toLowerCase();
  const stripped = base.replace(/\s*\(\d+\)\s*$/, "").trim();
  const root = stripped || base;
  if (!taken.has(norm(root))) return root;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${root} (${n})`;
    if (!taken.has(norm(candidate))) return candidate;
  }
  return `${root} (${Date.now()})`;
}

// Durable storage layer on top of the synchronous localStorage store.
//
//  • Requests persistent storage so the browser is far less likely to evict
//    the library under storage pressure.
//  • Optionally links a real device folder (File System Access API) and
//    auto-saves the whole library there as one JSON file, so it survives
//    clearing browser data and rides along with iCloud/Dropbox/etc.
//  • Manual Backup / Restore as a universal safety net.
//
// localStorage stays the synchronous source of truth the UI reads; this
// layer mirrors every write outward and can replace the store on load.

import {
  getDb,
  onStoreWrite,
  readStore,
  replaceStore,
  whenStorageReady,
  type Stored,
} from "./storage";

const LIBRARY_FILENAME = "chordsheets-library.json";
const LIBRARY_CHANGED_EVENT = "cs-library-changed";
// Fires when folder link/unlink/reconnect or persistent-storage grant
// changes the StorageStatus. Library content might also have changed
// (e.g. linkFolder adopting an existing folder); that case still fires
// LIBRARY_CHANGED_EVENT separately.
const STORAGE_CHANGED_EVENT = "cs-storage-changed";

// --- tiny IndexedDB key/value (just for the folder handle) -----------------
// Uses the shared connection from storage.ts so the schema upgrade is
// coordinated in one place.

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction("kv").objectStore("kv").get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}
async function idbSet(key: string, val: unknown): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDel(key: string): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- File System Access (typed loosely; not in older TS DOM libs) ----------

type DirHandle = {
  name: string;
  queryPermission(o: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(o: { mode: "readwrite" }): Promise<PermissionState>;
  getFileHandle(name: string, o?: { create?: boolean }): Promise<FileHandle>;
};
type FileHandle = {
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(data: string): Promise<void>;
    close(): Promise<void>;
  }>;
};

export function folderApiSupported(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown })
    .showDirectoryPicker === "function";
}

let dirHandle: DirHandle | null = null;

async function loadHandle(): Promise<DirHandle | null> {
  if (dirHandle) return dirHandle;
  dirHandle = (await idbGet<DirHandle>("folderHandle")) ?? null;
  return dirHandle;
}

async function hasPermission(h: DirHandle, prompt: boolean): Promise<boolean> {
  if ((await h.queryPermission({ mode: "readwrite" })) === "granted") return true;
  if (!prompt) return false;
  return (await h.requestPermission({ mode: "readwrite" })) === "granted";
}

function isStored(v: unknown): v is Stored {
  return (
    !!v &&
    typeof v === "object" &&
    Array.isArray((v as Stored).sheets)
  );
}

async function readFolderLibrary(h: DirHandle): Promise<Stored | null> {
  try {
    const fh = await h.getFileHandle(LIBRARY_FILENAME);
    const text = await (await fh.getFile()).text();
    const parsed = JSON.parse(text);
    return isStored(parsed) ? parsed : null;
  } catch {
    return null; // file not created yet, or unreadable
  }
}

async function writeFolderLibrary(h: DirHandle, s: Stored): Promise<void> {
  const fh = await h.getFileHandle(LIBRARY_FILENAME, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(s, null, 2));
  await w.close();
}

function emitLibraryChanged() {
  window.dispatchEvent(new Event(LIBRARY_CHANGED_EVENT));
}
export function onLibraryChanged(cb: () => void): () => void {
  window.addEventListener(LIBRARY_CHANGED_EVENT, cb);
  return () => window.removeEventListener(LIBRARY_CHANGED_EVENT, cb);
}
function emitStorageChanged() {
  window.dispatchEvent(new Event(STORAGE_CHANGED_EVENT));
}
export function onStorageChanged(cb: () => void): () => void {
  window.addEventListener(STORAGE_CHANGED_EVENT, cb);
  return () => window.removeEventListener(STORAGE_CHANGED_EVENT, cb);
}

// --- public status / actions ----------------------------------------------

export interface StorageStatus {
  persistent: boolean;
  folderSupported: boolean;
  folderName: string | null;
  folderConnected: boolean; // linked AND permission currently granted
}

export async function getStorageStatus(): Promise<StorageStatus> {
  const persistent =
    (await navigator.storage?.persisted?.()) ?? false;
  const h = await loadHandle();
  return {
    persistent,
    folderSupported: folderApiSupported(),
    folderName: h?.name ?? null,
    folderConnected: h
      ? (await h.queryPermission({ mode: "readwrite" })) === "granted"
      : false,
  };
}

/** Ask the browser not to evict our storage. Safe to call repeatedly. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted()))
      return true;
    const granted = (await navigator.storage?.persist?.()) ?? false;
    if (granted) emitStorageChanged();
    return granted;
  } catch {
    return false;
  }
}

/** Pick a device folder; from now on the library auto-saves there. */
export async function linkFolder(): Promise<string> {
  const picker = (
    window as unknown as {
      showDirectoryPicker: (o: {
        mode: "readwrite";
      }) => Promise<DirHandle>;
    }
  ).showDirectoryPicker;
  const h = await picker({ mode: "readwrite" });
  await hasPermission(h, true);
  dirHandle = h;
  await idbSet("folderHandle", h);

  // Merge direction on first link: if the folder already has a library,
  // adopt it (the user is likely reconnecting on a fresh browser);
  // otherwise seed the folder from what's here.
  const fromFolder = await readFolderLibrary(h);
  if (fromFolder && (fromFolder.sheets.length || fromFolder.sets?.length)) {
    replaceStore(fromFolder, false);
    emitLibraryChanged();
  } else {
    await writeFolderLibrary(h, readStore());
  }
  emitStorageChanged();
  return h.name;
}

export async function unlinkFolder(): Promise<void> {
  dirHandle = null;
  await idbDel("folderHandle");
  emitStorageChanged();
}

/** Re-grant permission to a previously linked folder (needs a user gesture)
 *  and pull its contents in. Returns true if the library was loaded. */
export async function reconnectFolder(): Promise<boolean> {
  const h = await loadHandle();
  if (!h) return false;
  if (!(await hasPermission(h, true))) return false;
  emitStorageChanged();
  const fromFolder = await readFolderLibrary(h);
  if (fromFolder) {
    replaceStore(fromFolder, false);
    emitLibraryChanged();
    return true;
  }
  // Folder linked but no file yet — write current library to it.
  await writeFolderLibrary(h, readStore());
  return false;
}

// --- backup / restore ------------------------------------------------------

export function downloadBackup(): void {
  const blob = new Blob([JSON.stringify(readStore(), null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `chordsheets-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function restoreBackup(file: File): Promise<void> {
  const parsed = JSON.parse(await file.text());
  if (!isStored(parsed)) {
    throw new Error("That file isn't a Chord Sheets backup.");
  }
  replaceStore(parsed, true); // write-through also mirrors to the folder
  emitLibraryChanged();
}

/** Wipe the library — every song and set deleted. Folder mirror (if any)
 *  is updated too so the next open doesn't re-hydrate from a stale file.
 *  Preferences in the `kv` store are NOT touched; those persist a user's
 *  Settings choices and clearing them would be confusing. */
export function clearLibrary(): void {
  replaceStore({ sheets: [], sets: [] }, true);
  emitLibraryChanged();
}

// --- init: request persistence + auto-mirror every write -------------------

let flushTimer: number | null = null;

export async function initPersistence(): Promise<void> {
  await whenStorageReady();
  await requestPersistentStorage();

  onStoreWrite((s) => {
    // Debounced mirror to the linked folder (best-effort).
    if (flushTimer) window.clearTimeout(flushTimer);
    flushTimer = window.setTimeout(async () => {
      const h = await loadHandle();
      if (h && (await hasPermission(h, false))) {
        try {
          await writeFolderLibrary(h, s);
        } catch {
          /* lost access; user can Reconnect from the Storage panel */
        }
      }
    }, 600);
  });

  // If a folder is linked and we still silently hold permission, adopt its
  // contents on startup so a cleared browser recovers automatically.
  const h = await loadHandle();
  if (h && (await hasPermission(h, false))) {
    const fromFolder = await readFolderLibrary(h);
    if (fromFolder) {
      replaceStore(fromFolder, false);
      emitLibraryChanged();
    }
  }
}

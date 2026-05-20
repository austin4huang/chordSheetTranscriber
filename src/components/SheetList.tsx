import { useEffect, useMemo, useRef, useState } from "react";
import type { ChordSheet } from "../lib/types";
import type { SongSet } from "../lib/storage";
import type { AskConflict, ConflictAnswer } from "../App";
import {
  listSheets, deleteSheet, saveSheet, emptySheetWithDefaults,
  listSets, saveSet, deleteSet, createdAtOf, createdAtOfSet,
  nextUniqueTitle,
} from "../lib/storage";
import { parsePdfToSheets, extractEmbeddedPayload } from "../lib/pdfParser";
import {
  exportSongRenderedPdf, exportSetRenderedPdf,
} from "../lib/pdfExport";
import { importChords, toChordSheet } from "../lib/chordImport";
import {
  DownloadIcon, EditIcon, TrashIcon, PlusIcon, FileImportIcon, LinkIcon,
  TextImportIcon, PlayIcon, CheckIcon, XIcon, UploadIcon,
} from "./icons";
import {
  getStorageStatus, downloadBackup, restoreBackup, linkFolder,
  reconnectFolder, unlinkFolder, onLibraryChanged, type StorageStatus,
} from "../lib/persist";
import "./SheetList.css";

interface Props {
  onOpen: (sheetId: string, setId?: string | null) => void;
  askConflict: AskConflict;
}

export function SheetList({ onOpen, askConflict }: Props) {
  const [sheets, setSheets] = useState<ChordSheet[]>(() => listSheets());
  const [sets, setSets] = useState<SongSet[]>(() => listSets());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creatingSet, setCreatingSet] = useState(false);
  const [newSetName, setNewSetName] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<"url" | "text" | null>(null);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [urlText, setUrlText] = useState("");
  const importMenuRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<
    { kind: "song" | "set"; id: string } | null
  >(null);
  const [renameText, setRenameText] = useState("");
  const [sortBy, setSortBy] = useState<"modified" | "title" | "created">(
    "modified",
  );
  const [setsSortBy, setSetsSortBy] = useState<"created" | "title">("created");
  const [storageOpen, setStorageOpen] = useState(false);
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [storageMsg, setStorageMsg] = useState<string | null>(null);
  const [drag, setDrag] = useState<
    { setId: string; from: number; over: number | null } | null
  >(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLInputElement>(null);
  // Bulk-selection of songs in the "All songs" list, for batch add-to-set
  // or delete. `selectionAnchor` is the last id the user clicked without
  // shift, so a subsequent shift+click can extend the range from there.
  const [selectedSheets, setSelectedSheets] = useState<Set<string>>(
    () => new Set(),
  );
  const selectionAnchor = useRef<string | null>(null);

  const refresh = () => {
    setSheets(listSheets());
    setSets(listSets());
  };

  const refreshStorage = () =>
    getStorageStatus().then(setStorageStatus).catch(() => {});

  // Load storage status for the header badge, and keep it (and the list) in
  // sync when the library is replaced externally (folder load / restore).
  useEffect(() => {
    refreshStorage();
    return onLibraryChanged(() => {
      refresh();
      refreshStorage();
    });
  }, []);

  // Close the Import menu on outside click / Escape.
  useEffect(() => {
    if (!importMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!importMenuRef.current?.contains(e.target as Node)) {
        setImportMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setImportMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [importMenuOpen]);

  const storageAction = async (fn: () => Promise<unknown>, ok: string) => {
    setStorageMsg(null);
    try {
      await fn();
      refresh();
      await refreshStorage();
      setStorageMsg(ok);
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return; // user cancelled
      setStorageMsg(e instanceof Error ? e.message : "Something went wrong.");
    }
  };

  const beginRename = (kind: "song" | "set", id: string, current: string) => {
    setRenaming({ kind, id });
    setRenameText(current);
  };
  const cancelRename = () => {
    setRenaming(null);
    setRenameText("");
  };
  const commitRename = () => {
    if (!renaming) return;
    const name = renameText.trim();
    if (name) {
      if (renaming.kind === "set") {
        const set = sets.find((s) => s.id === renaming.id);
        if (set && name !== set.name) saveSet({ ...set, name });
      } else {
        const sh = sheets.find((s) => s.id === renaming.id);
        if (sh && name !== sh.title) saveSheet({ ...sh, title: name });
      }
    }
    setRenaming(null);
    setRenameText("");
    refresh();
  };

  const onNew = () => {
    const sheet = emptySheetWithDefaults();
    saveSheet(sheet);
    onOpen(sheet.id);
  };

  /** Save a batch of incoming sheets, prompting on duplicate titles. Returns
   *  the saved sheet ids in input order (skipped songs absent), or null if
   *  the user cancelled. Two-new-songs-share-a-title cases auto-suffix
   *  silently — the conflict is created by this import itself. */
  const importMany = async (
    incoming: ChordSheet[],
  ): Promise<ChordSheet[] | null> => {
    const existing = listSheets();
    const taken = new Set(existing.map((s) => s.title.toLowerCase()));
    let sticky: ConflictAnswer["choice"] | null = null;
    const saved: ChordSheet[] = [];

    const remainingConflicts = (fromIdx: number) =>
      incoming
        .slice(fromIdx)
        .filter((s) => taken.has(s.title.toLowerCase())).length;

    for (let i = 0; i < incoming.length; i++) {
      const candidate = incoming[i];
      const titleKey = candidate.title.toLowerCase();
      const match = existing.find((s) => s.title.toLowerCase() === titleKey);

      if (match) {
        let choice = sticky;
        if (!choice) {
          const ans = await askConflict({
            title: candidate.title,
            remaining: Math.max(0, remainingConflicts(i + 1)),
          });
          if (!ans) return null;
          choice = ans.choice;
          if (ans.applyToAll) sticky = ans.choice;
        }
        if (choice === "replace") {
          // Preserve id + createdAt so existing set references still resolve.
          const replaced: ChordSheet = {
            ...candidate,
            id: match.id,
            createdAt: match.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          };
          saveSheet(replaced);
          saved.push(replaced);
          // Local mirror so later iterations see the new state.
          const idx = existing.findIndex((s) => s.id === match.id);
          existing[idx] = replaced;
          continue;
        }
        // rename
        const fresh = nextUniqueTitle(candidate.title, taken);
        const renamed: ChordSheet = {
          ...candidate,
          id: crypto.randomUUID(),
          title: fresh,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        saveSheet(renamed);
        saved.push(renamed);
        taken.add(renamed.title.toLowerCase());
        existing.push(renamed);
        continue;
      }

      // No library conflict; auto-suffix if a sibling in this same batch
      // already claimed the title.
      const finalTitle = taken.has(titleKey)
        ? nextUniqueTitle(candidate.title, taken)
        : candidate.title;
      const fresh: ChordSheet = {
        ...candidate,
        id: crypto.randomUUID(),
        title: finalTitle,
        createdAt: candidate.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      saveSheet(fresh);
      saved.push(fresh);
      taken.add(fresh.title.toLowerCase());
      existing.push(fresh);
    }

    return saved;
  };

  const onImport = async (file: File) => {
    setImporting(true);
    setImportError(null);
    try {
      // Lossless path: a PDF this app exported carries its source data.
      const payload = await extractEmbeddedPayload(file);
      if (payload?.kind === "song") {
        const saved = await importMany([payload.sheet as ChordSheet]);
        if (!saved || saved.length === 0) return;
        onOpen(saved[0].id);
        return;
      }
      if (payload?.kind === "set") {
        const saved = await importMany(payload.sheets as ChordSheet[]);
        if (!saved) return;
        const newSet: SongSet = {
          id: crypto.randomUUID(),
          name: payload.name || file.name.replace(/\.pdf$/i, ""),
          sheetIds: saved.map((s) => s.id),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        saveSet(newSet);
        refresh();
        setExpanded(newSet.id);
        return;
      }

      const parsed = await parsePdfToSheets(file);
      const songs = parsed.filter((p) =>
        (p.lines || []).some((l) => l.kind !== "blank" && l.text.trim()),
      );
      if (songs.length === 0) {
        setImportError(
          "No text found in this PDF. Scanned or image-based PDFs aren't supported — " +
            "use an electronic chord sheet (e.g. SongSelect).",
        );
        return;
      }

      const fallbackName = file.name.replace(/\.pdf$/i, "");
      const incoming: ChordSheet[] = songs.map((p, i) => ({
        id: crypto.randomUUID(),
        title: p.title || `${fallbackName}${songs.length > 1 ? ` (${i + 1})` : ""}`,
        key: p.key || "C",
        mode: p.mode || "major",
        lines: p.lines || [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));
      const saved = await importMany(incoming);
      if (!saved || saved.length === 0) return;

      if (saved.length === 1) {
        onOpen(saved[0].id);
        return;
      }

      // Multiple songs in one PDF → bundle them into a new set.
      const newSet: SongSet = {
        id: crypto.randomUUID(),
        name: fallbackName,
        sheetIds: saved.map((s) => s.id),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      saveSet(newSet);
      refresh();
      setExpanded(newSet.id);
      onOpen(saved[0].id, newSet.id);
    } catch (e) {
      console.error(e);
      setImportError(
        `Couldn't read "${file.name}". It may be corrupted or not a valid PDF.`,
      );
    } finally {
      setImporting(false);
    }
  };

  const onImportUrl = async () => {
    setImporting(true);
    setImportError(null);
    try {
      const imported = await importChords(urlText);
      const sheet = toChordSheet(imported);
      const saved = await importMany([sheet]);
      if (!saved || saved.length === 0) return;
      setUrlText("");
      setImportMode(null);
      onOpen(saved[0].id);
    } catch (e) {
      setImportError(
        e instanceof Error ? e.message : "Couldn't import from that input.",
      );
    } finally {
      setImporting(false);
    }
  };

  const onDelete = (id: string) => {
    if (!confirm("Delete this chord sheet? It will also be removed from any sets.")) return;
    deleteSheet(id);
    refresh();
  };

  // --- Bulk selection ------------------------------------------------------

  const clearSelection = () => {
    setSelectedSheets(new Set());
    selectionAnchor.current = null;
  };

  const handleCheckboxClick = (id: string, shift: boolean) => {
    const willCheck = !selectedSheets.has(id);
    if (shift && selectionAnchor.current && selectionAnchor.current !== id) {
      // Range select: every visible sheet from anchor to id becomes
      // `willCheck` (matches the just-clicked checkbox's new state).
      const ids = visibleSheets.map((s) => s.id);
      const aIdx = ids.indexOf(selectionAnchor.current);
      const bIdx = ids.indexOf(id);
      if (aIdx >= 0 && bIdx >= 0) {
        const [lo, hi] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
        const next = new Set(selectedSheets);
        for (let i = lo; i <= hi; i++) {
          if (willCheck) next.add(ids[i]);
          else next.delete(ids[i]);
        }
        setSelectedSheets(next);
        return;
      }
    }
    // Plain toggle.
    const next = new Set(selectedSheets);
    if (willCheck) next.add(id);
    else next.delete(id);
    setSelectedSheets(next);
    selectionAnchor.current = id;
  };

  const selectAllVisible = () => {
    setSelectedSheets(new Set(visibleSheets.map((s) => s.id)));
  };

  const addSelectedToSet = (setId: string) => {
    const set = sets.find((s) => s.id === setId);
    if (!set || selectedSheets.size === 0) return;
    // Preserve current order; append the not-yet-present selected ids.
    const present = new Set(set.sheetIds);
    const toAdd = [...selectedSheets].filter((id) => !present.has(id));
    if (toAdd.length === 0) return;
    saveSet({ ...set, sheetIds: [...set.sheetIds, ...toAdd] });
    setSets(listSets());
  };

  const deleteSelected = () => {
    const n = selectedSheets.size;
    if (n === 0) return;
    if (
      !confirm(
        `Delete ${n} chord sheet${n === 1 ? "" : "s"}? ` +
          "They will also be removed from any sets.",
      )
    )
      return;
    for (const id of selectedSheets) deleteSheet(id);
    clearSelection();
    refresh();
  };

  const submitNewSet = () => {
    const name = newSetName.trim();
    if (!name) return; // mandatory
    const set: SongSet = {
      id: crypto.randomUUID(),
      name,
      sheetIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    saveSet(set);
    setSets(listSets());
    setExpanded(set.id);
    setNewSetName("");
    setCreatingSet(false);
  };
  const cancelNewSet = () => {
    setNewSetName("");
    setCreatingSet(false);
  };

  const removeSet = (id: string) => {
    if (!confirm("Delete this set? The songs themselves are kept.")) return;
    deleteSet(id);
    setSets(listSets());
  };

  const addToSet = (setId: string, sheetId: string) => {
    const set = sets.find((s) => s.id === setId);
    if (!set || set.sheetIds.includes(sheetId)) return;
    saveSet({ ...set, sheetIds: [...set.sheetIds, sheetId] });
    setSets(listSets());
  };

  const updateSetSheets = (set: SongSet, sheetIds: string[]) => {
    saveSet({ ...set, sheetIds });
    setSets(listSets());
  };

  const reorderInSet = (set: SongSet, from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= set.sheetIds.length) return;
    const ids = [...set.sheetIds];
    const [moved] = ids.splice(from, 1);
    const insertAt = to > from ? to - 1 : to;
    ids.splice(insertAt, 0, moved);
    updateSetSheets(set, ids);
  };

  const titleOf = (id: string) =>
    sheets.find((s) => s.id === id)?.title ?? "(missing — deleted)";

  const q = query.trim().toLowerCase();

  // Memoize filter+sort so the lists don't re-walk every render — they only
  // change when their actual inputs do (sheets/sets, sort choice, or query).
  // Helpful even at moderate library sizes since this component re-renders
  // on every keystroke in the search box.
  const visibleSheets = useMemo(() => {
    const matches = (t?: string) => !!t && t.toLowerCase().includes(q);
    const filtered = q
      ? sheets.filter((s) => matches(s.title) || matches(s.artist))
      : sheets;
    const arr = [...filtered];
    if (sortBy === "title") {
      arr.sort((a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
      );
    } else if (sortBy === "created") {
      arr.sort((a, b) => createdAtOf(b) - createdAtOf(a));
    } else {
      arr.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return arr;
  }, [sheets, sortBy, q]);

  const visibleSets = useMemo(() => {
    const matches = (t?: string) => !!t && t.toLowerCase().includes(q);
    const titleById = new Map(sheets.map((s) => [s.id, s.title]));
    const filtered = q
      ? sets.filter(
          (set) =>
            matches(set.name) ||
            set.sheetIds.some((id) => matches(titleById.get(id))),
        )
      : sets;
    const arr = [...filtered];
    if (setsSortBy === "title") {
      arr.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
    } else {
      arr.sort((a, b) => createdAtOfSet(b) - createdAtOfSet(a));
    }
    return arr;
  }, [sets, sheets, setsSortBy, q]);

  return (
    <div className="list-page">
      <header className="app-header">
        <div className="app-header-inner">
        <h1>Chord Sheets</h1>
        <div className="list-actions">
          <button
            className="btn-primary"
            onClick={onNew}
            title="New sheet"
          >
            <PlusIcon />
            <span className="btn-label">New sheet</span>
          </button>
          <div className="import-menu" ref={importMenuRef}>
            <button
              className="btn-soft"
              onClick={() => setImportMenuOpen((o) => !o)}
              disabled={importing}
              title="Import a chord sheet"
              aria-haspopup="menu"
              aria-expanded={importMenuOpen}
            >
              <FileImportIcon />
              <span className="btn-label">
                {importing ? "Importing…" : "Import"}
              </span>
              <span className="import-caret" aria-hidden="true">▾</span>
            </button>
            {importMenuOpen && (
              <div className="import-dropdown" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setImportMenuOpen(false);
                    fileRef.current?.click();
                  }}
                >
                  <FileImportIcon />
                  PDF…
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setImportError(null);
                    setImportMenuOpen(false);
                    setImportMode("url");
                  }}
                >
                  <LinkIcon />
                  From URL…
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setImportError(null);
                    setImportMenuOpen(false);
                    setImportMode("text");
                  }}
                >
                  <TextImportIcon />
                  Paste text…
                </button>
              </div>
            )}
          </div>
          {(() => {
            const fs = storageStatus;
            let dot = "gray";
            let text = "Storage";
            if (fs) {
              const name =
                fs.folderName && fs.folderName.length > 16
                  ? fs.folderName.slice(0, 15) + "…"
                  : fs.folderName;
              if (fs.folderName && fs.folderConnected) {
                dot = "green";
                text = `Saving to ${name}`;
              } else if (fs.folderName) {
                dot = "amber";
                text = "Folder — reconnect";
              } else if (fs.folderSupported) {
                dot = "gray";
                text = fs.persistent ? "Local (persistent)" : "Local only";
              } else {
                dot = "gray";
                text = "Backup only";
              }
            }
            return (
              <button
                className="btn-soft storage-badge"
                onClick={() => setStorageOpen((o) => !o)}
                title="Storage & backup"
              >
                <span className={`storage-dot is-${dot}`} aria-hidden="true" />
                <span className="btn-label">{text}</span>
              </button>
            );
          })()}
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImport(f);
              e.target.value = "";
            }}
          />
          <input
            ref={restoreRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) storageAction(() => restoreBackup(f), "Library restored.");
              e.target.value = "";
            }}
          />
        </div>
        </div>
      </header>

      <div className="list-root">
      {storageOpen && (
        <div className="storage-panel">
          <div className="storage-row">
            <strong>Storage &amp; backup</strong>
            <span className="spacer" />
            <button
              className="icon-btn"
              onClick={() => setStorageOpen(false)}
              title="Close"
              aria-label="Close storage panel"
            >
              <XIcon />
            </button>
          </div>
          <p className="storage-status">
            {storageStatus?.persistent
              ? "✓ Persistent storage granted (the browser won't auto-evict your library)."
              : "Using best-effort browser storage — link a folder below for real durability."}
          </p>

          <div className="storage-row">
            <button
              className="ghost-btn"
              onClick={downloadBackup}
              title="Save a .json backup of your library"
            >
              <DownloadIcon />Backup
            </button>
            <button
              className="ghost-btn"
              onClick={() => restoreRef.current?.click()}
              title="Restore library from a .json backup"
            >
              <UploadIcon />Restore
            </button>
          </div>

          {storageStatus?.folderSupported ? (
            <div className="storage-row">
              {storageStatus.folderName ? (
                <>
                  <span className="storage-status">
                    Folder: <strong>{storageStatus.folderName}</strong>{" "}
                    {storageStatus.folderConnected
                      ? "· connected (auto-saving)"
                      : "· not connected"}
                  </span>
                  <span className="spacer" />
                  {!storageStatus.folderConnected && (
                    <button
                      className="ghost-btn"
                      onClick={() =>
                        storageAction(reconnectFolder, "Folder reconnected.")
                      }
                    >
                      Reconnect
                    </button>
                  )}
                  <button
                    className="ghost-btn"
                    onClick={() =>
                      storageAction(unlinkFolder, "Folder unlinked.")
                    }
                  >
                    Unlink
                  </button>
                </>
              ) : (
                <button
                  className="ghost-btn"
                  onClick={() =>
                    storageAction(linkFolder, "Folder linked — auto-saving here.")
                  }
                >
                  Link a device folder (auto-save)
                </button>
              )}
            </div>
          ) : (
            <p className="storage-status">
              This browser can't save to a device folder (Chromium only). Use
              Save/Restore backup instead.
            </p>
          )}

          {storageMsg && <p className="storage-msg">{storageMsg}</p>}
        </div>
      )}

      {importMode && (
        <form
          className="url-import"
          onSubmit={(e) => {
            e.preventDefault();
            if (!importing && urlText.trim()) onImportUrl();
          }}
        >
          <textarea
            autoFocus
            rows={importMode === "text" ? 8 : 4}
            placeholder={
              importMode === "url"
                ? "Paste an Ultimate-Guitar URL (or its page source if fetching is blocked)."
                : "Paste chord text — ChordPro, Ultimate-Guitar tab text, or a " +
                  "worship-site copy with chords on their own lines."
            }
            value={urlText}
            onChange={(e) => setUrlText(e.target.value)}
          />
          <div className="url-import-actions">
            <span className="url-import-hint">
              Copyrighted — for personal/licensed use; verify accuracy.
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="icon-btn"
              title="Cancel"
              aria-label="Cancel import"
              onClick={() => {
                setImportMode(null);
                setUrlText("");
              }}
            >
              <XIcon />
            </button>
            <button
              type="submit"
              className="primary"
              disabled={importing || !urlText.trim()}
            >
              {importing ? "Importing…" : "Import"}
            </button>
          </div>
        </form>
      )}

      <div className="search-bar">
        <span className="search-icon" aria-hidden="true">⌕</span>
        <input
          type="search"
          placeholder="Search sets and songs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search sets and songs"
        />
        {query && (
          <button className="search-clear" onClick={() => setQuery("")} aria-label="Clear search">
            ×
          </button>
        )}
      </div>

      {importing && (
        <div className="banner banner-info" role="status">
          <span className="spinner" aria-hidden="true" />
          Reading PDF…
        </div>
      )}
      {importError && (
        <div className="banner banner-error" role="alert">
          <span className="banner-text">{importError}</span>
          <button className="banner-dismiss" onClick={() => setImportError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className="list-scrollarea">
      <section className="sets-section">
        <div className="section-head">
          <h2>Sets</h2>
          {!creatingSet && (
            <button
              className="ghost-btn new-set-btn"
              onClick={() => setCreatingSet(true)}
              title="New set"
            >
              <PlusIcon />New set
            </button>
          )}
          <label className="sort-control">
            Sort:
            <select
              value={setsSortBy}
              onChange={(e) =>
                setSetsSortBy(e.target.value as "created" | "title")
              }
              aria-label="Sort sets"
            >
              <option value="created">Date created</option>
              <option value="title">Alphabetical</option>
            </select>
          </label>
        </div>
        {creatingSet && (
          <form
            className="new-set-form"
            onSubmit={(e) => {
              e.preventDefault();
              submitNewSet();
            }}
          >
            <input
              autoFocus
              type="text"
              required
              placeholder="Set name (e.g. “Sunday AM”)"
              value={newSetName}
              onChange={(e) => setNewSetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") cancelNewSet();
              }}
            />
            <button
              type="submit"
              className="primary"
              disabled={!newSetName.trim()}
              title="Create set"
            >
              <CheckIcon />Create
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={cancelNewSet}
              title="Cancel"
              aria-label="Cancel"
            >
              <XIcon />
            </button>
          </form>
        )}
        {sets.length === 0 ? (
          <p className="sets-hint">
            Create a set to group songs (e.g. a service order). Songs stay in the
            global list and can be in multiple sets.
          </p>
        ) : visibleSets.length === 0 ? (
          <p className="sets-hint">No sets match “{query}”.</p>
        ) : (
          <ul className="sets">
            {visibleSets.map((set) => {
              const open = expanded === set.id || q.length > 0;
              return (
                <li key={set.id} className="set-item">
                  <div className="set-head">
                    {renaming?.kind === "set" && renaming.id === set.id ? (
                      <form
                        className="rename-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          commitRename();
                        }}
                      >
                        <input
                          autoFocus
                          value={renameText}
                          onChange={(e) => setRenameText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") cancelRename();
                          }}
                          aria-label="Set name"
                        />
                        <button
                          type="submit"
                          className="primary"
                          disabled={!renameText.trim()}
                          title="Save"
                          aria-label="Save"
                        >
                          <CheckIcon />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={cancelRename}
                          title="Cancel"
                          aria-label="Cancel"
                        >
                          <XIcon />
                        </button>
                      </form>
                    ) : (
                      <button
                        className="set-toggle"
                        onClick={() => setExpanded(open ? null : set.id)}
                      >
                        <span className="set-caret">{open ? "▾" : "▸"}</span>
                        <span className="set-name">{set.name}</span>
                      </button>
                    )}
                    {!(renaming?.kind === "set" && renaming.id === set.id) && (
                      <>
                        <button
                          className="icon-btn title-edit"
                          title="Rename set"
                          aria-label="Rename set"
                          onClick={() => beginRename("set", set.id, set.name)}
                        >
                          <EditIcon size={16} />
                        </button>
                        <span className="set-count">
                          {set.sheetIds.length} songs
                        </span>
                        <span className="row-spacer" />
                      </>
                    )}
                    {set.sheetIds.length > 0 && (
                      <button
                        className="ghost-btn set-open-btn"
                        onClick={() => onOpen(set.sheetIds[0], set.id)}
                        title="Open set"
                        aria-label="Open set"
                      >
                        <PlayIcon />
                      </button>
                    )}
                    {set.sheetIds.length > 0 && (
                      <button
                        className="ghost-btn"
                        title="Download this set as a PDF (re-importable)"
                        onClick={() =>
                          exportSetRenderedPdf(
                            set.name,
                            set.sheetIds
                              .map((id) => sheets.find((s) => s.id === id))
                              .filter((s): s is ChordSheet => !!s),
                          )
                        }
                      >
                        <DownloadIcon /><span className="btn-pdf-label">PDF</span>
                      </button>
                    )}
                    <button
                      className="set-del"
                      title="Delete set"
                      aria-label="Delete set"
                      onClick={() => removeSet(set.id)}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                  {open && (
                    <ol className="set-songs">
                      {set.sheetIds.length === 0 && (
                        <li className="set-empty">
                          Empty — add a song below.
                        </li>
                      )}
                      {set.sheetIds.map((sid, i) => {
                        const isDragging =
                          drag?.setId === set.id && drag.from === i;
                        const isOver =
                          drag?.setId === set.id &&
                          drag.over === i &&
                          drag.from !== i;
                        const dropBefore =
                          isOver && (drag!.from > i);
                        const dropAfter =
                          isOver && (drag!.from < i);
                        return (
                          <li
                            key={sid + i}
                            className={
                              "set-song" +
                              (isDragging ? " set-song-dragging" : "") +
                              (dropBefore ? " set-song-drop-before" : "") +
                              (dropAfter ? " set-song-drop-after" : "")
                            }
                            draggable
                            onDragStart={(e) => {
                              setDrag({ setId: set.id, from: i, over: i });
                              e.dataTransfer.effectAllowed = "move";
                              try {
                                e.dataTransfer.setData("text/plain", sid);
                              } catch {
                                // Safari can throw on certain MIME types — safe to ignore.
                              }
                            }}
                            onDragOver={(e) => {
                              if (!drag || drag.setId !== set.id) return;
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "move";
                              if (drag.over !== i) {
                                setDrag({ ...drag, over: i });
                              }
                            }}
                            onDrop={(e) => {
                              if (!drag || drag.setId !== set.id) return;
                              e.preventDefault();
                              const from = drag.from;
                              const to = from < i ? i + 1 : i;
                              reorderInSet(set, from, to);
                              setDrag(null);
                            }}
                            onDragEnd={() => setDrag(null)}
                          >
                            <span
                              className="set-song-grip"
                              aria-hidden="true"
                              title="Drag to reorder"
                            >
                              ⋮⋮
                            </span>
                            <button className="set-song-open" onClick={() => onOpen(sid, set.id)}>
                              {i + 1}. {titleOf(sid)}
                            </button>
                            <span className="set-song-actions">
                              <button
                                onClick={() => updateSetSheets(set, set.sheetIds.filter((_, k) => k !== i))}
                                aria-label="Remove from set"
                              >
                                ✕
                              </button>
                            </span>
                          </li>
                        );
                      })}
                      <li className="set-add">
                        <AddSongPicker
                          sheets={sheets.filter(
                            (sh) => !set.sheetIds.includes(sh.id),
                          )}
                          onAdd={(sheetId) => addToSet(set.id, sheetId)}
                        />
                      </li>
                    </ol>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="songs-section">
        <div className="section-head">
          <h2>All songs</h2>
          <label className="sort-control">
            Sort:
            <select
              value={sortBy}
              onChange={(e) =>
                setSortBy(e.target.value as "modified" | "title" | "created")
              }
              aria-label="Sort songs"
            >
              <option value="modified">Last modified</option>
              <option value="created">Date created</option>
              <option value="title">Alphabetical</option>
            </select>
          </label>
        </div>
        {selectedSheets.size > 0 && (
          <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
            <span className="bulk-count">
              {selectedSheets.size} selected
            </span>
            {sets.length > 0 && (
              <select
                className="bulk-add-to-set"
                value=""
                onChange={(e) => {
                  if (e.target.value) addSelectedToSet(e.target.value);
                  e.target.value = "";
                }}
                title="Add selected songs to a set"
              >
                <option value="">+ Add to set…</option>
                {sets.map((set) => (
                  <option key={set.id} value={set.id}>
                    {set.name}
                  </option>
                ))}
              </select>
            )}
            <button
              className="ghost-btn bulk-select-all"
              onClick={selectAllVisible}
              disabled={
                visibleSheets.length > 0 &&
                visibleSheets.every((s) => selectedSheets.has(s.id))
              }
              title="Select every song currently shown"
            >
              Select all
            </button>
            <button
              className="ghost-btn bulk-delete"
              onClick={deleteSelected}
              title="Delete the selected songs"
            >
              <TrashIcon /> Delete
            </button>
            <button
              className="ghost-btn"
              onClick={clearSelection}
              title="Clear the selection"
            >
              Cancel
            </button>
          </div>
        )}
        {sheets.length === 0 ? (
          <div className="empty">
            <div className="empty-icon" aria-hidden="true">🎵</div>
            <h2>No chord sheets yet</h2>
            <p>
              Import an electronic chord-sheet PDF (e.g. SongSelect), or start a
              blank sheet and type in ChordPro.
            </p>
            <div className="empty-actions">
              <button className="primary" onClick={onNew}>+ New sheet</button>
              <button onClick={() => fileRef.current?.click()} disabled={importing}>
                Import PDF
              </button>
            </div>
          </div>
        ) : visibleSheets.length === 0 ? (
          <p className="sets-hint">No songs match “{query}”.</p>
        ) : (
          <ul className="sheets">
            {visibleSheets.map((s) => (
              <li
                key={s.id}
                className={`sheet-item${selectedSheets.has(s.id) ? " is-selected" : ""}`}
              >
                <input
                  type="checkbox"
                  className="sheet-checkbox"
                  checked={selectedSheets.has(s.id)}
                  onClick={(e) => {
                    // Don't preventDefault: a preventDefault on a click event
                    // for a controlled checkbox leaves React's reconciler
                    // out of sync with the visual state (the box appears to
                    // lag one click behind). The browser's default toggle
                    // matches the new state we compute below, so they stay
                    // in lockstep.
                    e.stopPropagation();
                    handleCheckboxClick(s.id, e.shiftKey);
                  }}
                  onChange={() => {
                    /* state is driven by onClick so we can read shiftKey */
                  }}
                  aria-label={`Select ${s.title}`}
                />
                {renaming?.kind === "song" && renaming.id === s.id ? (
                  <form
                    className="rename-form sheet-rename"
                    onSubmit={(e) => {
                      e.preventDefault();
                      commitRename();
                    }}
                  >
                    <input
                      autoFocus
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") cancelRename();
                      }}
                      aria-label="Song title"
                    />
                    <button
                      type="submit"
                      className="primary"
                      disabled={!renameText.trim()}
                      title="Save"
                      aria-label="Save"
                    >
                      <CheckIcon />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={cancelRename}
                      title="Cancel"
                      aria-label="Cancel"
                    >
                      <XIcon />
                    </button>
                  </form>
                ) : (
                  <div
                    className="open"
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpen(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpen(s.id);
                      }
                    }}
                  >
                    <div className="title-row">
                      <span className="title">{s.title}</span>
                      <button
                        className="icon-btn title-edit"
                        title="Rename song title"
                        aria-label="Rename song title"
                        onClick={(e) => {
                          e.stopPropagation();
                          beginRename("song", s.id, s.title);
                        }}
                      >
                        <EditIcon size={16} />
                      </button>
                    </div>
                    <div className="meta">
                      Key {s.key}{s.mode === "minor" ? "m" : ""}
                      {s.artist ? ` · ${s.artist}` : ""}
                      {" · "}
                      {new Date(s.updatedAt).toLocaleDateString()}
                    </div>
                  </div>
                )}
                {sets.length > 0 && (
                  <select
                    className="add-to-set"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) addToSet(e.target.value, s.id);
                      e.target.value = "";
                    }}
                    title="Add to set"
                  >
                    <option value="">+ Set</option>
                    {sets.map((set) => (
                      <option key={set.id} value={set.id}>{set.name}</option>
                    ))}
                  </select>
                )}
                <button
                  className="ghost-btn sheet-export"
                  title="Download as PDF (re-importable)"
                  onClick={() => exportSongRenderedPdf(s)}
                >
                  <DownloadIcon /><span className="btn-pdf-label">PDF</span>
                </button>
                <button
                  className="delete"
                  title="Delete song"
                  aria-label="Delete song"
                  onClick={() => onDelete(s.id)}
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      </div>
      </div>
    </div>
  );
}

/** Searchable dropdown for adding a song to a set: a text input that filters
 *  the available songs and a list you can click or keyboard-navigate. */
function AddSongPicker({
  sheets,
  onAdd,
}: {
  sheets: ChordSheet[];
  onAdd: (sheetId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<number | null>(null);

  const q = query.trim().toLowerCase();
  const results = sheets.filter(
    (s) =>
      !q ||
      s.title.toLowerCase().includes(q) ||
      (s.artist?.toLowerCase().includes(q) ?? false),
  );

  const choose = (sheetId: string) => {
    onAdd(sheetId);
    setQuery("");
    setOpen(false);
    setActive(0);
  };

  if (sheets.length === 0) {
    return <div className="add-song-empty">All songs already in this set.</div>;
  }

  return (
    <div className="add-song">
      <input
        type="text"
        className="add-song-input"
        placeholder="+ Add song… (type to search)"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Delay so a click on a result registers before we close.
          blurTimer.current = window.setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (results[active]) choose(results[active].id);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        aria-label="Add a song to this set"
      />
      {open && (
        <ul
          className="add-song-results"
          onMouseDown={() => {
            // Keep the input from blurring before the click handler runs.
            if (blurTimer.current) window.clearTimeout(blurTimer.current);
          }}
        >
          {results.length === 0 ? (
            <li className="add-song-none">No matching songs</li>
          ) : (
            results.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`add-song-opt${i === active ? " is-active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(s.id)}
                >
                  <span className="add-song-title">{s.title}</span>
                  {s.artist && (
                    <span className="add-song-artist">{s.artist}</span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

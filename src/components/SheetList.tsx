import { useEffect, useRef, useState } from "react";
import type { ChordSheet } from "../lib/types";
import type { SongSet } from "../lib/storage";
import {
  listSheets, deleteSheet, saveSheet, emptySheetWithDefaults,
  listSets, saveSet, deleteSet, createdAtOf,
} from "../lib/storage";
import { parsePdfToSheets, extractEmbeddedPayload } from "../lib/pdfParser";
import { exportSongPdf, exportSetPdf } from "../lib/pdfExport";
import { importChords, toChordSheet } from "../lib/chordImport";
import {
  DownloadIcon, EditIcon, TrashIcon, PlusIcon, FileImportIcon, LinkIcon,
  TextImportIcon,
} from "./icons";
import {
  getStorageStatus, downloadBackup, restoreBackup, linkFolder,
  reconnectFolder, unlinkFolder, onLibraryChanged, type StorageStatus,
} from "../lib/persist";
import "./SheetList.css";

interface Props {
  onOpen: (sheetId: string, setId?: string | null) => void;
}

export function SheetList({ onOpen }: Props) {
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
  const [storageOpen, setStorageOpen] = useState(false);
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [storageMsg, setStorageMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLInputElement>(null);

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

  const onImport = async (file: File) => {
    setImporting(true);
    setImportError(null);
    try {
      // Lossless path: a PDF this app exported carries its source data.
      const payload = await extractEmbeddedPayload(file);
      if (payload?.kind === "song") {
        const sheet: ChordSheet = {
          ...payload.sheet,
          id: crypto.randomUUID(),
          createdAt: payload.sheet.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        };
        saveSheet(sheet);
        onOpen(sheet.id);
        return;
      }
      if (payload?.kind === "set") {
        const ids: string[] = [];
        for (const s of payload.sheets) {
          const sheet: ChordSheet = {
            ...s,
            id: crypto.randomUUID(),
            createdAt: s.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          };
          saveSheet(sheet);
          ids.push(sheet.id);
        }
        const newSet: SongSet = {
          id: crypto.randomUUID(),
          name: payload.name || file.name.replace(/\.pdf$/i, ""),
          sheetIds: ids,
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
      const made = songs.map((p, i) => {
        const sheet: ChordSheet = {
          id: crypto.randomUUID(),
          title: p.title || `${fallbackName}${songs.length > 1 ? ` (${i + 1})` : ""}`,
          key: p.key || "C",
          mode: p.mode || "major",
          lines: p.lines || [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        saveSheet(sheet);
        return sheet;
      });

      if (made.length === 1) {
        onOpen(made[0].id);
        return;
      }

      // Multiple songs in one PDF → bundle them into a new set.
      const newSet: SongSet = {
        id: crypto.randomUUID(),
        name: fallbackName,
        sheetIds: made.map((s) => s.id),
        updatedAt: Date.now(),
      };
      saveSet(newSet);
      refresh();
      setExpanded(newSet.id);
      onOpen(made[0].id, newSet.id);
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
      saveSheet(sheet);
      setUrlText("");
      setImportMode(null);
      onOpen(sheet.id);
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

  const submitNewSet = () => {
    const name = newSetName.trim();
    if (!name) return; // mandatory
    const set: SongSet = {
      id: crypto.randomUUID(),
      name,
      sheetIds: [],
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

  const moveInSet = (set: SongSet, i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= set.sheetIds.length) return;
    const ids = [...set.sheetIds];
    [ids[i], ids[j]] = [ids[j], ids[i]];
    updateSetSheets(set, ids);
  };

  const titleOf = (id: string) =>
    sheets.find((s) => s.id === id)?.title ?? "(missing — deleted)";

  const q = query.trim().toLowerCase();
  const matches = (t?: string) => !!t && t.toLowerCase().includes(q);
  const sortSheets = (list: ChordSheet[]) => {
    const arr = [...list];
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
  };
  const visibleSheets = sortSheets(
    q ? sheets.filter((s) => matches(s.title) || matches(s.artist)) : sheets,
  );
  const visibleSets = q
    ? sets.filter(
        (set) => matches(set.name) || set.sheetIds.some((id) => matches(titleOf(id))),
      )
    : sets;

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
            <button className="ghost-btn" onClick={() => setStorageOpen(false)}>
              Close
            </button>
          </div>
          <p className="storage-status">
            {storageStatus?.persistent
              ? "✓ Persistent storage granted (the browser won't auto-evict your library)."
              : "Using best-effort browser storage — link a folder below for real durability."}
          </p>

          <div className="storage-row">
            <button className="ghost-btn" onClick={downloadBackup}>
              ⭳ Save backup (.json)
            </button>
            <button
              className="ghost-btn"
              onClick={() => restoreRef.current?.click()}
            >
              Restore from backup…
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
              className="ghost-btn"
              onClick={() => {
                setImportMode(null);
                setUrlText("");
              }}
            >
              Cancel
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
            <button className="ghost-btn" onClick={() => setCreatingSet(true)}>
              + New set
            </button>
          )}
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
            <button type="submit" className="primary" disabled={!newSetName.trim()}>
              Create
            </button>
            <button type="button" className="ghost-btn" onClick={cancelNewSet}>
              Cancel
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
                        <button type="submit" className="primary" disabled={!renameText.trim()}>
                          Save
                        </button>
                        <button type="button" className="ghost-btn" onClick={cancelRename}>
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <button
                        className="set-toggle"
                        onClick={() => setExpanded(open ? null : set.id)}
                      >
                        <span className="set-caret">{open ? "▾" : "▸"}</span>
                        <span className="set-name">{set.name}</span>
                        <span className="set-count">{set.sheetIds.length} songs</span>
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
                        <span className="row-spacer" />
                      </>
                    )}
                    {set.sheetIds.length > 0 && (
                      <button
                        className="ghost-btn"
                        onClick={() => onOpen(set.sheetIds[0], set.id)}
                      >
                        ▶ Open set
                      </button>
                    )}
                    {set.sheetIds.length > 0 && (
                      <button
                        className="ghost-btn"
                        title="Download this set as a PDF (re-importable)"
                        onClick={() =>
                          exportSetPdf(
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
                      {set.sheetIds.map((sid, i) => (
                        <li key={sid + i} className="set-song">
                          <button className="set-song-open" onClick={() => onOpen(sid, set.id)}>
                            {i + 1}. {titleOf(sid)}
                          </button>
                          <span className="set-song-actions">
                            <button onClick={() => moveInSet(set, i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                            <button onClick={() => moveInSet(set, i, 1)} disabled={i === set.sheetIds.length - 1} aria-label="Move down">↓</button>
                            <button
                              onClick={() => updateSetSheets(set, set.sheetIds.filter((_, k) => k !== i))}
                              aria-label="Remove from set"
                            >
                              ✕
                            </button>
                          </span>
                        </li>
                      ))}
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
              <li key={s.id} className="sheet-item">
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
                    <button type="submit" className="primary" disabled={!renameText.trim()}>
                      Save
                    </button>
                    <button type="button" className="ghost-btn" onClick={cancelRename}>
                      Cancel
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
                    <option value="">+ Set…</option>
                    {sets.map((set) => (
                      <option key={set.id} value={set.id}>{set.name}</option>
                    ))}
                  </select>
                )}
                <button
                  className="ghost-btn sheet-export"
                  title="Download as PDF (re-importable)"
                  onClick={() => exportSongPdf(s)}
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

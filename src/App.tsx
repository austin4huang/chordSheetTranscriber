import { useCallback, useEffect, useState } from "react";
import { SheetList } from "./components/SheetList";
import { SheetEditor } from "./components/SheetEditor";
import { SheetRenderer } from "./components/SheetRenderer";
import { Settings } from "./components/Settings";
import { getSheet, getSet, whenStorageReady } from "./lib/storage";
import { initPersistence } from "./lib/persist";
import { loadPrefs, getPrefs, updatePrefs, onPrefsChange } from "./lib/prefs";
import { useModal } from "./lib/useModal";
import type { ChordSheet } from "./lib/types";
import "./App.css";

// Map the fontScale pref to a numeric CSS variable on <html> so the sheet
// renderer's `font-size: calc(... * var(--font-scale))` rules pick it up.
const FONT_SCALE_PX: Record<"sm" | "md" | "lg", number> = {
  sm: 0.88,
  md: 1,
  lg: 1.15,
};
function applyFontScale(scale: "sm" | "md" | "lg") {
  document.documentElement.style.setProperty(
    "--font-scale",
    String(FONT_SCALE_PX[scale]),
  );
}
// Flip a class on <html> so SheetRenderer.css can force single-column
// rendering when the user prefers it, regardless of viewport width.
function applySingleColumn(single: boolean) {
  document.documentElement.classList.toggle("pref-single-column", single);
}

type View =
  | { kind: "list" }
  | { kind: "edit"; sheetId: string; setId: string | null };

export type ConflictChoice = "replace" | "rename";
export type ConflictAnswer = { choice: ConflictChoice; applyToAll: boolean };
export type AskConflict = (info: {
  existing: ChordSheet;
  incoming: ChordSheet;
  remaining: number;
}) => Promise<ConflictAnswer | null>;

/** Ask the user to review the parsed import(s) before any are added to the
 *  library. Resolves true if they accept, false (or null) if they cancel. */
export type AskImportConfirm = (incoming: ChordSheet[]) => Promise<boolean>;

/** Build a short, human-readable diff between two sheets to orient the
 *  user above the side-by-side previews. Returns the *changes* only — fields
 *  that match are omitted, so the list is empty when the two sheets are
 *  metadata-identical (the previews still tell the rest of the story). */
function summarizeDiff(existing: ChordSheet, incoming: ChordSheet): string[] {
  const out: string[] = [];
  if (existing.title !== incoming.title)
    out.push(`Title: "${existing.title}" → "${incoming.title}"`);
  if ((existing.artist ?? "") !== (incoming.artist ?? ""))
    out.push(`Artist: ${existing.artist || "—"} → ${incoming.artist || "—"}`);
  const exKey = existing.key + (existing.mode === "minor" ? "m" : "");
  const inKey = incoming.key + (incoming.mode === "minor" ? "m" : "");
  if (exKey !== inKey) out.push(`Key: ${exKey} → ${inKey}`);
  if ((existing.tempo ?? null) !== (incoming.tempo ?? null))
    out.push(`Tempo: ${existing.tempo ?? "—"} → ${incoming.tempo ?? "—"}`);
  if ((existing.time ?? "") !== (incoming.time ?? ""))
    out.push(`Time: ${existing.time || "—"} → ${incoming.time || "—"}`);
  const exLines = existing.lines.length;
  const inLines = incoming.lines.length;
  if (exLines !== inLines) {
    const delta = inLines - exLines;
    out.push(`Lines: ${exLines} → ${inLines} (${delta > 0 ? "+" : ""}${delta})`);
  }
  // Final catch-all: line content changed even if counts match.
  const norm = (s: ChordSheet) =>
    s.lines.map((l) => `${l.kind}\t${l.text}`).join("\n");
  if (exLines === inLines && norm(existing) !== norm(incoming))
    out.push("Lines differ in content");
  return out;
}

export default function App() {
  const [view, setView] = useState<View>({ kind: "list" });
  // Owned here so these view modes survive navigating between songs in a
  // set (SheetEditor is remounted per song via its `key`). `numberMode` and
  // `annoToolbarCollapsed` are seeded from persisted prefs once hydration
  // finishes — see the `whenStorageReady`/`loadPrefs` effect below.
  const [numberMode, setNumberModeRaw] = useState(false);
  const [editorHidden, setEditorHiddenRaw] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [split, setSplitRaw] = useState(50);
  const [annoToolbarCollapsed, setAnnoToolbarCollapsedRaw] = useState(false);
  // Wrapped setters: every change to a persisted view-state also writes
  // through to prefs so the next reload picks up where the user left off.
  const setNumberMode: typeof setNumberModeRaw = (v) => {
    setNumberModeRaw((prev) => {
      const next = typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v;
      updatePrefs({ defaultNumberMode: next });
      return next;
    });
  };
  const setEditorHidden: typeof setEditorHiddenRaw = (v) => {
    setEditorHiddenRaw((prev) => {
      const next = typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v;
      updatePrefs({ editorHidden: next });
      return next;
    });
  };
  const setSplit: typeof setSplitRaw = (v) => {
    setSplitRaw((prev) => {
      const next = typeof v === "function" ? (v as (p: number) => number)(prev) : v;
      updatePrefs({ editorSplit: next });
      return next;
    });
  };
  const setAnnoToolbarCollapsed: typeof setAnnoToolbarCollapsedRaw = (v) => {
    setAnnoToolbarCollapsedRaw((prev) => {
      const next = typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v;
      updatePrefs({ annoToolbarCollapsed: next });
      return next;
    });
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Library is loaded asynchronously from IndexedDB on first paint; gate the
  // app on hydration so we never render an "empty library" flash.
  const [storageReady, setStorageReady] = useState(false);

  // Conflict modal lives here so both the list (import) and the editor
  // (save) can prompt through the same UI. The modal renders both sheets
  // side-by-side so the user can compare before choosing.
  const [conflict, setConflict] = useState<{
    existing: ChordSheet;
    incoming: ChordSheet;
    remaining: number;
    resolve: (r: ConflictAnswer | null) => void;
  } | null>(null);
  const [conflictApplyAll, setConflictApplyAll] = useState(false);

  // Import-confirm modal — fires once per importMany batch so the user can
  // review the parsed sheet(s) (titles, key, line counts, visual preview)
  // before anything is committed. Distinct from the conflict modal, which
  // only fires per-sheet when there's a duplicate title.
  const [importPreview, setImportPreview] = useState<{
    sheets: ChordSheet[];
    resolve: (accept: boolean) => void;
  } | null>(null);

  const askImportConfirm: AskImportConfirm = (sheets) =>
    new Promise<boolean>((resolve) => {
      if (sheets.length === 0) {
        resolve(false);
        return;
      }
      setImportPreview({ sheets, resolve });
    });

  const resolveImport = (accept: boolean) => {
    importPreview?.resolve(accept);
    setImportPreview(null);
  };

  const askConflict: AskConflict = (info) =>
    new Promise<ConflictAnswer | null>((resolve) => {
      // Honor the user's "always do X on conflict" preference — bypass the
      // modal entirely when set. `applyToAll: false` because the pref is the
      // sticky thing; we don't want a single import session to override it.
      const def = getPrefs().conflictDefault;
      if (def !== "ask") {
        resolve({ choice: def, applyToAll: false });
        return;
      }
      setConflictApplyAll(false);
      setConflict({ ...info, resolve });
    });

  const resolveConflict = (r: ConflictAnswer | null) => {
    conflict?.resolve(r);
    setConflict(null);
  };

  // Hydrate the in-memory library from IndexedDB, load saved preferences,
  // request persistent storage, and adopt a linked device folder (if any) —
  // all once per app load. Prefs are seeded into the relevant state slots
  // after load; live changes flow through `onPrefsChange` below.
  useEffect(() => {
    void whenStorageReady()
      .then(() => loadPrefs())
      .then(() => {
        const p = getPrefs();
        // Use the *raw* setters to seed, so this initial hydration doesn't
        // immediately write the same values back to prefs.
        setNumberModeRaw(p.defaultNumberMode);
        setAnnoToolbarCollapsedRaw(p.annoToolbarCollapsed);
        setEditorHiddenRaw(p.editorHidden);
        setSplitRaw(p.editorSplit);
        applyFontScale(p.fontScale);
        applySingleColumn(p.singleColumn);
        setStorageReady(true);
      });
    void initPersistence();
  }, []);

  // Live-sync the things prefs control globally (font scale on <html>).
  // Per-component prefs (pen color, toolbar collapsed default) read via
  // `getPrefs()` on mount, so this listener only handles app-wide ones.
  useEffect(() => {
    return onPrefsChange((p) => {
      applyFontScale(p.fontScale);
      applySingleColumn(p.singleColumn);
    });
  }, []);

  if (!storageReady) {
    return <div className="app-loading">Loading your library…</div>;
  }

  let main;
  if (view.kind === "list") {
    main = (
      <SheetList
        onOpen={(sheetId, setId = null) => setView({ kind: "edit", sheetId, setId })}
        askConflict={askConflict}
        askImportConfirm={askImportConfirm}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    );
  } else {
    const sheet = getSheet(view.sheetId);
    if (!sheet) {
      // Sheet was deleted out from under us — fall back to the list.
      setView({ kind: "list" });
      return null;
    }

    const set = view.setId ? getSet(view.setId) : undefined;
    const ids = set?.sheetIds ?? [];
    const idx = ids.indexOf(view.sheetId);
    const setNav =
      set && idx >= 0
        ? {
            name: set.name,
            index: idx,
            total: ids.length,
            onPrev:
              idx > 0
                ? () => setView({ kind: "edit", sheetId: ids[idx - 1], setId: set.id })
                : undefined,
            onNext:
              idx < ids.length - 1
                ? () => setView({ kind: "edit", sheetId: ids[idx + 1], setId: set.id })
                : undefined,
          }
        : undefined;

    main = (
      <SheetEditor
        key={view.sheetId}
        initial={sheet}
        setNav={setNav}
        numberMode={numberMode}
        onNumberModeChange={setNumberMode}
        editorHidden={editorHidden}
        onEditorHiddenChange={setEditorHidden}
        presenting={presenting}
        onPresentingChange={setPresenting}
        split={split}
        onSplitChange={setSplit}
        annoToolbarCollapsed={annoToolbarCollapsed}
        onAnnoToolbarCollapsedChange={setAnnoToolbarCollapsed}
        onBack={() => setView({ kind: "list" })}
        onSaved={(s) => setView({ kind: "edit", sheetId: s.id, setId: view.setId })}
        askConflict={askConflict}
      />
    );
  }

  return (
    <>
      {main}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
      {importPreview && (
        <ImportPreviewModal
          sheets={importPreview.sheets}
          onResolve={resolveImport}
        />
      )}
      {conflict && (
        <ConflictModal
          existing={conflict.existing}
          incoming={conflict.incoming}
          remaining={conflict.remaining}
          applyAll={conflictApplyAll}
          onApplyAllChange={setConflictApplyAll}
          onResolve={resolveConflict}
        />
      )}
    </>
  );
}

function ImportPreviewModal({
  sheets,
  onResolve,
}: {
  sheets: ChordSheet[];
  onResolve: (accept: boolean) => void;
}) {
  const cancel = useCallback(() => onResolve(false), [onResolve]);
  const ref = useModal(cancel);
  return (
    <div className="modal-backdrop" onClick={cancel}>
      <div
        ref={ref}
        className="modal modal-compare modal-import-preview"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-preview-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="import-preview-title" className="modal-title">
          Import {sheets.length} song{sheets.length === 1 ? "" : "s"}?
        </h3>
        <p className="modal-body">
          Review the parsed {sheets.length === 1 ? "song" : "songs"} below.
          Duplicate-title prompts (if any) will follow once you click Import.
        </p>
        <div className="import-preview-list">
          {sheets.map((s, i) => (
            <div key={i} className="compare-pane">
              <header className="compare-pane-head">
                {s.title}
                {s.artist ? <span className="ip-artist"> · {s.artist}</span> : null}
                <span className="ip-meta">
                  {" · "}{s.key}{s.mode === "minor" ? "m" : ""}
                  {" · "}{s.lines.length} lines
                </span>
              </header>
              <div className="compare-pane-body">
                <SheetRenderer
                  sheet={s}
                  numberMode={false}
                  displayKey={s.displayKey ?? s.key}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="modal-btn" onClick={cancel}>
            Cancel
          </button>
          <button
            className="modal-btn primary"
            data-autofocus
            onClick={() => onResolve(true)}
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}

function ConflictModal({
  existing,
  incoming,
  remaining,
  applyAll,
  onApplyAllChange,
  onResolve,
}: {
  existing: ChordSheet;
  incoming: ChordSheet;
  remaining: number;
  applyAll: boolean;
  onApplyAllChange: (v: boolean) => void;
  onResolve: (r: ConflictAnswer | null) => void;
}) {
  const cancel = useCallback(() => onResolve(null), [onResolve]);
  const ref = useModal(cancel);
  const diff = summarizeDiff(existing, incoming);
  return (
    <div className="modal-backdrop" onClick={cancel}>
      <div
        ref={ref}
        className="modal modal-compare"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="conflict-title" className="modal-title">
          A song titled "{incoming.title}" already exists
        </h3>
        <p className="modal-body">
          Compare the two versions below, then choose to replace the
          existing song or keep both (the incoming one is renamed
          automatically).
        </p>
        {diff.length === 0 ? (
          <p className="compare-diff compare-diff-empty">
            No metadata differences — the versions may still have
            different annotations or formatting (see previews).
          </p>
        ) : (
          <ul className="compare-diff">
            {diff.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
        <div className="compare-grid">
          <div className="compare-pane">
            <header className="compare-pane-head">Existing</header>
            <div className="compare-pane-body">
              <SheetRenderer
                sheet={existing}
                numberMode={false}
                displayKey={existing.displayKey ?? existing.key}
              />
            </div>
          </div>
          <div className="compare-pane">
            <header className="compare-pane-head">Incoming</header>
            <div className="compare-pane-body">
              <SheetRenderer
                sheet={incoming}
                numberMode={false}
                displayKey={incoming.displayKey ?? incoming.key}
              />
            </div>
          </div>
        </div>
        {remaining > 0 && (
          <label className="modal-applyall">
            <input
              type="checkbox"
              checked={applyAll}
              onChange={(e) => onApplyAllChange(e.target.checked)}
            />
            <span>
              Apply this choice to the remaining {remaining}
              {" "}duplicate{remaining === 1 ? "" : "s"} in this import
            </span>
          </label>
        )}
        <div className="modal-actions">
          <button className="modal-btn" onClick={cancel}>
            Cancel
          </button>
          <button
            className="modal-btn primary"
            data-autofocus
            onClick={() =>
              onResolve({ choice: "rename", applyToAll: applyAll })
            }
          >
            Keep both
          </button>
          <button
            className="modal-btn danger"
            onClick={() =>
              onResolve({ choice: "replace", applyToAll: applyAll })
            }
          >
            Replace existing
          </button>
        </div>
      </div>
    </div>
  );
}

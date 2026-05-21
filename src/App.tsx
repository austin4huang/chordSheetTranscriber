import { useEffect, useState } from "react";
import { SheetList } from "./components/SheetList";
import { SheetEditor } from "./components/SheetEditor";
import { SheetRenderer } from "./components/SheetRenderer";
import { getSheet, getSet, whenStorageReady } from "./lib/storage";
import { initPersistence } from "./lib/persist";
import type { ChordSheet } from "./lib/types";
import "./App.css";

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
  // set (SheetEditor is remounted per song via its `key`).
  const [numberMode, setNumberMode] = useState(false);
  const [editorHidden, setEditorHidden] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [split, setSplit] = useState(50);
  const [annoToolbarCollapsed, setAnnoToolbarCollapsed] = useState(false);
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

  const askConflict: AskConflict = (info) =>
    new Promise<ConflictAnswer | null>((resolve) => {
      setConflictApplyAll(false);
      setConflict({ ...info, resolve });
    });

  const resolveConflict = (r: ConflictAnswer | null) => {
    conflict?.resolve(r);
    setConflict(null);
  };

  // Hydrate the in-memory library from IndexedDB, request persistent storage,
  // and adopt a linked device folder (if any) — all once per app load.
  useEffect(() => {
    void whenStorageReady().then(() => setStorageReady(true));
    void initPersistence();
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
      {conflict && (
        <div
          className="modal-backdrop"
          onClick={() => resolveConflict(null)}
        >
          <div
            className="modal modal-compare"
            role="dialog"
            aria-modal="true"
            aria-labelledby="conflict-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="conflict-title" className="modal-title">
              A song titled "{conflict.incoming.title}" already exists
            </h3>
            <p className="modal-body">
              Compare the two versions below, then choose to replace the
              existing song or keep both (the incoming one is renamed
              automatically).
            </p>
            {(() => {
              const diff = summarizeDiff(conflict.existing, conflict.incoming);
              if (diff.length === 0) {
                return (
                  <p className="compare-diff compare-diff-empty">
                    No metadata differences — the versions may still have
                    different annotations or formatting (see previews).
                  </p>
                );
              }
              return (
                <ul className="compare-diff">
                  {diff.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              );
            })()}
            <div className="compare-grid">
              <div className="compare-pane">
                <header className="compare-pane-head">Existing</header>
                <div className="compare-pane-body">
                  <SheetRenderer
                    sheet={conflict.existing}
                    numberMode={false}
                    displayKey={conflict.existing.displayKey ?? conflict.existing.key}
                  />
                </div>
              </div>
              <div className="compare-pane">
                <header className="compare-pane-head">Incoming</header>
                <div className="compare-pane-body">
                  <SheetRenderer
                    sheet={conflict.incoming}
                    numberMode={false}
                    displayKey={conflict.incoming.displayKey ?? conflict.incoming.key}
                  />
                </div>
              </div>
            </div>
            {conflict.remaining > 0 && (
              <label className="modal-applyall">
                <input
                  type="checkbox"
                  checked={conflictApplyAll}
                  onChange={(e) => setConflictApplyAll(e.target.checked)}
                />
                <span>
                  Apply this choice to the remaining {conflict.remaining}
                  {" "}duplicate{conflict.remaining === 1 ? "" : "s"} in this
                  import
                </span>
              </label>
            )}
            <div className="modal-actions">
              <button
                className="modal-btn"
                onClick={() => resolveConflict(null)}
              >
                Cancel
              </button>
              <button
                className="modal-btn primary"
                onClick={() =>
                  resolveConflict({
                    choice: "rename",
                    applyToAll: conflictApplyAll,
                  })
                }
              >
                Keep both
              </button>
              <button
                className="modal-btn danger"
                onClick={() =>
                  resolveConflict({
                    choice: "replace",
                    applyToAll: conflictApplyAll,
                  })
                }
              >
                Replace existing
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

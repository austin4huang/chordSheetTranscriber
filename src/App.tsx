import { useEffect, useState } from "react";
import { SheetList } from "./components/SheetList";
import { SheetEditor } from "./components/SheetEditor";
import { getSheet, getSet, whenStorageReady } from "./lib/storage";
import { initPersistence } from "./lib/persist";
import "./App.css";

type View =
  | { kind: "list" }
  | { kind: "edit"; sheetId: string; setId: string | null };

export type ConflictChoice = "replace" | "rename";
export type ConflictAnswer = { choice: ConflictChoice; applyToAll: boolean };
export type AskConflict = (info: {
  title: string;
  remaining: number;
}) => Promise<ConflictAnswer | null>;

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
  // (save) can prompt through the same UI.
  const [conflict, setConflict] = useState<{
    title: string;
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
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="conflict-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="conflict-title" className="modal-title">
              A song titled "{conflict.title}" already exists
            </h3>
            <p className="modal-body">
              Replace the existing song, or keep both (the new one is
              renamed automatically).
            </p>
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
                Replace
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

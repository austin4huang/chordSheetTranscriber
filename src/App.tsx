import { useEffect, useState } from "react";
import { SheetList } from "./components/SheetList";
import { SheetEditor } from "./components/SheetEditor";
import { getSheet, getSet } from "./lib/storage";
import { initPersistence } from "./lib/persist";
import "./App.css";

type View =
  | { kind: "list" }
  | { kind: "edit"; sheetId: string; setId: string | null };

export default function App() {
  const [view, setView] = useState<View>({ kind: "list" });
  // Owned here so these view modes survive navigating between songs in a
  // set (SheetEditor is remounted per song via its `key`).
  const [numberMode, setNumberMode] = useState(false);
  const [editorHidden, setEditorHidden] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [split, setSplit] = useState(50);
  // "" until a key is chosen; then it carries across songs in a set.
  const [displayKey, setDisplayKey] = useState("");
  const [preferFlats, setPreferFlats] = useState(false);
  const [keyScopeSetId, setKeyScopeSetId] = useState<string | null>(null);

  // Request persistent storage and adopt a linked device folder (if any)
  // once per app load.
  useEffect(() => {
    void initPersistence();
  }, []);

  if (view.kind === "list") {
    return (
      <SheetList
        onOpen={(sheetId, setId = null) => setView({ kind: "edit", sheetId, setId })}
      />
    );
  }

  // Scope the carried display key: it's shared across songs in the same set,
  // but a standalone song is its own scope. Reset only when that scope token
  // actually changes (not every render — that would fight SheetEditor's
  // seed-from-song-key and loop).
  const keyScope = view.setId ?? `solo:${view.sheetId}`;
  if (keyScope !== keyScopeSetId) {
    setKeyScopeSetId(keyScope);
    setDisplayKey("");
    setPreferFlats(false);
  }

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

  return (
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
      displayKey={displayKey}
      onDisplayKeyChange={setDisplayKey}
      preferFlats={preferFlats}
      onPreferFlatsChange={setPreferFlats}
      onBack={() => setView({ kind: "list" })}
      onSaved={(s) => setView({ kind: "edit", sheetId: s.id, setId: view.setId })}
    />
  );
}

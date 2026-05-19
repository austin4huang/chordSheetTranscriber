import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { ChordSheet, Stroke, TextNote } from "../lib/types";
import { linesToText, textToSheet, saveSheet } from "../lib/storage";
import { noteToPitchClass } from "../lib/nashville";
import { SheetRenderer } from "./SheetRenderer";
import { exportRenderedPdf } from "../lib/pdfExport";
import { DownloadIcon } from "./icons";
import "./SheetEditor.css";

// Chromatic note names by pitch class, in both spellings. Enharmonic keys
// (pitch classes 1, 3, 6, 8, 10) differ between the two.
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const ENHARMONIC = new Set([1, 3, 6, 8, 10]);

function keyIndex(note: string): number {
  try {
    return noteToPitchClass(note);
  } catch {
    return 0;
  }
}

// ASCII note (e.g. "Eb") -> display label ("E♭").
function prettyKey(note: string): string {
  return note.replace("#", "♯").replace("b", "♭");
}

// Spell a pitch class as a note string, preferring flats or sharps.
function spellKey(pc: number, flats: boolean): string {
  return (flats ? FLAT_NAMES : SHARP_NAMES)[pc];
}

function isFlatSpelling(note: string): boolean {
  return note.slice(1).includes("b");
}

interface SetNav {
  name: string;
  index: number;
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
}

interface Props {
  initial: ChordSheet;
  onSaved: (sheet: ChordSheet) => void;
  onBack: () => void;
  setNav?: SetNav;
  /** These view modes are owned by the parent so they persist across songs
   *  in a set (this component is remounted per song via a `key` prop). */
  numberMode: boolean;
  onNumberModeChange: (v: boolean) => void;
  editorHidden: boolean;
  onEditorHiddenChange: Dispatch<SetStateAction<boolean>>;
  presenting: boolean;
  onPresentingChange: Dispatch<SetStateAction<boolean>>;
  split: number;
  onSplitChange: Dispatch<SetStateAction<number>>;
}

export function SheetEditor({
  initial,
  onSaved,
  onBack,
  setNav,
  numberMode,
  onNumberModeChange,
  editorHidden,
  onEditorHiddenChange,
  presenting,
  onPresentingChange,
  split,
  onSplitChange,
}: Props) {
  const [text, setText] = useState(() => linesToText(initial));
  // Text as of the last save, for dirty-tracking and the Save button state.
  const [annotations, setAnnotations] = useState<Stroke[]>(initial.annotations ?? []);
  const [texts, setTexts] = useState<TextNote[]>(initial.texts ?? []);
  const [savedText, setSavedText] = useState(text);
  const [savedAnno, setSavedAnno] = useState(() =>
    JSON.stringify([initial.annotations ?? [], initial.texts ?? []]),
  );
  const [justSaved, setJustSaved] = useState(false);
  const saveTimer = useRef<number | null>(null);
  const annoKey = JSON.stringify([annotations, texts]);
  const dirty = text !== savedText || annoKey !== savedAnno;
  const setNumberMode = onNumberModeChange;
  const [displayKey, setDisplayKey] = useState(initial.key);
  // Preferred accidental spelling for enharmonic keys (♯ vs ♭).
  const [preferFlats, setPreferFlats] = useState(() => isFlatSpelling(initial.key));
  const setEditorHidden = onEditorHiddenChange;
  const setPresenting = onPresentingChange;

  // In present mode: Esc exits; ←/→ flip between songs in the set.
  const navRef = useRef(setNav);
  useEffect(() => {
    navRef.current = setNav;
  });
  useEffect(() => {
    if (!presenting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPresenting(false);
      else if (e.key === "ArrowRight") navRef.current?.onNext?.();
      else if (e.key === "ArrowLeft") navRef.current?.onPrev?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting]);

  // Resizable split between the Editor and Preview panes (percent width of
  // the left pane).
  const setSplit = onSplitChange;
  const bodyRef = useRef<HTMLDivElement>(null);
  const renderRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const dragging = useRef(false);

  const onResizeDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);
  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !bodyRef.current) return;
    const rect = bodyRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setSplit(Math.min(80, Math.max(20, pct)));
  }, []);
  const onResizeUp = useCallback((e: React.PointerEvent) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);
  const resetSplit = useCallback(() => setSplit(50), []);

  const sheet = useMemo<ChordSheet>(() => {
    return textToSheet(text, initial);
  }, [text, initial]);

  // When the song's actual key changes (parsed from a {key:} directive),
  // reset the display key to it. Done during render (React's recommended
  // pattern for syncing state to a prop) rather than in an effect.
  const [prevSongKey, setPrevSongKey] = useState(sheet.key);
  if (sheet.key !== prevSongKey) {
    setPrevSongKey(sheet.key);
    setDisplayKey(sheet.key);
    setPreferFlats(isFlatSpelling(sheet.key));
  }

  const onSave = () => {
    const toSave = { ...sheet, annotations, texts, updatedAt: Date.now() };
    saveSheet(toSave);
    setSavedText(text);
    setSavedAnno(annoKey);
    setJustSaved(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => setJustSaved(false), 1800);
    onSaved(toSave);
  };
  const onExport = async () => {
    if (!renderRef.current || exporting) return;
    setExporting(true);
    try {
      // Capture the live preview so it matches the editor exactly (chords/
      // numbers, current key, strokes + text boxes). Embed current data so
      // reimport restores annotations too.
      await exportRenderedPdf(renderRef.current, { ...sheet, annotations, texts });
    } catch (e) {
      console.error("PDF export failed", e);
      alert("Sorry — couldn't generate the PDF.");
    } finally {
      setExporting(false);
    }
  };

  // Clear the "Saved" flash timer on unmount.
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  // ⌘/Ctrl+S saves. Ref keeps the listener stable while always calling the
  // latest onSave (which closes over current text/sheet).
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        onSaveRef.current();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // Step the display key by a semitone (pitch class wraps the octave),
  // spelling it with the preferred accidental.
  const stepKey = useCallback(
    (delta: number) => {
      setDisplayKey((cur) => spellKey((keyIndex(cur) + delta + 12) % 12, preferFlats));
    },
    [preferFlats],
  );
  // Pick the ♯ or ♭ spelling for the current key.
  const setAccidental = useCallback(
    (flats: boolean) => {
      setPreferFlats(flats);
      setDisplayKey((cur) => spellKey(keyIndex(cur), flats));
    },
    [],
  );
  const pc = keyIndex(displayKey);
  const isEnharmonic = ENHARMONIC.has(pc);
  // Compare by pitch class so an enharmonic spelling of the song key isn't
  // treated as transposed.
  const transposed = pc !== keyIndex(sheet.key);

  return (
    <div className="editor-root">
      <div className="editor-toolbar">
        <div className="tb-left">
        <div className="tb-group">
          <button onClick={onBack}>← Back</button>
          <button
            className={`tb-toggle-btn${editorHidden ? "" : " active"}`}
            onClick={() => setEditorHidden((h) => !h)}
            aria-pressed={!editorHidden}
            title={editorHidden ? "Show the editor" : "Hide the editor (preview only)"}
          >
            <span className="tb-toggle-icon" aria-hidden="true">◧</span>
            Editor
          </button>
        </div>
        <div className="tb-title">{sheet.title}</div>
        {setNav && (
          <div className="tb-setnav" title={`Set: ${setNav.name}`}>
            <button
              className="tb-nav"
              onClick={setNav.onPrev}
              disabled={!setNav.onPrev}
              aria-label="Previous song in set"
            >
              ‹
            </button>
            <span className="tb-setpos">
              {setNav.index + 1}/{setNav.total}
            </span>
            <button
              className="tb-nav"
              onClick={setNav.onNext}
              disabled={!setNav.onNext}
              aria-label="Next song in set"
            >
              ›
            </button>
          </div>
        )}
        </div>
        <div className="tb-right">
        <div className="tb-divider" />
        <div className="tb-group">
          <button
            className="tb-icon-btn"
            onClick={onExport}
            disabled={exporting}
            aria-label="Download PDF"
            title="Download as PDF — matches this view (chords/numbers, current key, annotations)"
          >
            {exporting ? "…" : <><DownloadIcon /><span className="btn-pdf-label">PDF</span></>}
          </button>
          <button
            onClick={onSave}
            className={`primary save-btn${justSaved ? " is-saved" : ""}`}
            disabled={!dirty && !justSaved}
            title={dirty ? "Save changes (⌘/Ctrl+S)" : "No unsaved changes"}
          >
            {justSaved ? "✓ Saved" : dirty ? "● Save" : "Saved"}
          </button>
          <button
            className="tb-icon-btn"
            onClick={() => setPresenting(true)}
            aria-label="Present"
            title="Present full screen (Esc to exit)"
          >
            ⛶
          </button>
        </div>
        </div>
        <div className="tb-center">
        <div className="tb-group">
          <span className="tb-label">Key</span>
          <div className={`key-stepper${numberMode ? " is-off" : ""}`}>
            <button
              type="button"
              className="key-step"
              onClick={() => stepKey(-1)}
              disabled={numberMode}
              aria-label="Transpose down a semitone"
              title="Down a semitone"
            >
              −
            </button>
            <select
              className="key-value"
              value={spellKey(pc, preferFlats)}
              onChange={(e) => setDisplayKey(e.target.value)}
              disabled={numberMode}
              aria-label="Display key"
            >
              {Array.from({ length: 12 }, (_, i) => {
                const name = spellKey(i, preferFlats);
                return <option key={i} value={name}>{prettyKey(name)}</option>;
              })}
            </select>
            <button
              type="button"
              className="key-step"
              onClick={() => stepKey(1)}
              disabled={numberMode}
              aria-label="Transpose up a semitone"
              title="Up a semitone"
            >
              +
            </button>
          </div>
          <div
            className={`acc-toggle${numberMode || !isEnharmonic ? " is-off" : ""}`}
            role="group"
            aria-label="Accidental spelling"
          >
            <button
              type="button"
              className={!preferFlats ? "active" : ""}
              aria-pressed={!preferFlats}
              onClick={() => setAccidental(false)}
              disabled={numberMode || !isEnharmonic}
              title="Use sharps"
            >
              ♯
            </button>
            <button
              type="button"
              className={preferFlats ? "active" : ""}
              aria-pressed={preferFlats}
              onClick={() => setAccidental(true)}
              disabled={numberMode || !isEnharmonic}
              title="Use flats"
            >
              ♭
            </button>
          </div>
          <button
            type="button"
            className="key-reset"
            onClick={() => {
              setDisplayKey(sheet.key);
              setPreferFlats(isFlatSpelling(sheet.key));
            }}
            disabled={numberMode || !transposed}
            title={`Reset to original key (${prettyKey(sheet.key)})`}
          >
            ↺ {prettyKey(sheet.key)}
          </button>
        </div>
        <div
          className="seg-toggle"
          role="group"
          aria-label="Notation display"
        >
          <button
            type="button"
            className={!numberMode ? "active" : ""}
            aria-pressed={!numberMode}
            onClick={() => setNumberMode(false)}
          >
            Chords
          </button>
          <button
            type="button"
            className={numberMode ? "active" : ""}
            aria-pressed={numberMode}
            onClick={() => setNumberMode(true)}
          >
            Numbers
          </button>
        </div>
        </div>
      </div>
      <div className="editor-body" ref={bodyRef}>
        {!editorHidden && (
        <>
        <div className="editor-pane is-editor" style={{ width: `${split}%` }}>
          <h3>Editor</h3>
          <p className="hint">
            ChordPro format. Put chords inline in brackets like <code>[D]Are you [G]hurting</code>.
            Use <code>[section: VERSE 1]</code> for section headings, plain bar-lines like
            <code> | D | G | D | G |</code> for chord-only lines, and <code>{"{key: D}"}</code> /
            <code>{"{title: ...}"}</code> directives at the top.
          </p>
          <textarea
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div
          className="editor-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize editor and preview"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onDoubleClick={resetSplit}
          title="Drag to resize · double-click to reset"
        >
          <span className="editor-resizer-grip" />
        </div>
        </>
        )}
        <div className="editor-pane">
          <h3>Preview</h3>
          <SheetRenderer
            sheet={sheet}
            numberMode={numberMode}
            displayKey={displayKey}
            annotations={annotations}
            onAnnotationsChange={setAnnotations}
            texts={texts}
            onTextsChange={setTexts}
            rootRef={renderRef}
          />
        </div>
      </div>
      {presenting && (
        <div className="present-overlay">
          <button
            className="present-exit"
            onClick={() => setPresenting(false)}
            title="Exit full screen (Esc)"
            aria-label="Exit full screen"
          >
            ✕ Exit
          </button>
          {setNav && (
            <div className="present-setnav">
              <button
                onClick={setNav.onPrev}
                disabled={!setNav.onPrev}
                aria-label="Previous song in set"
              >
                ‹ Prev
              </button>
              <span>
                {setNav.name} · {setNav.index + 1}/{setNav.total}
              </span>
              <button
                onClick={setNav.onNext}
                disabled={!setNav.onNext}
                aria-label="Next song in set"
              >
                Next ›
              </button>
            </div>
          )}
          <div className="present-sheet">
            <SheetRenderer
              sheet={sheet}
              numberMode={numberMode}
              displayKey={displayKey}
              annotations={annotations}
              onAnnotationsChange={setAnnotations}
            texts={texts}
            onTextsChange={setTexts}
            />
          </div>
        </div>
      )}
    </div>
  );
}

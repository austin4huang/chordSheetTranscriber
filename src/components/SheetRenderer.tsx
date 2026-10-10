import type { Dispatch, ReactNode, Ref, SetStateAction } from "react";
import type { ChordSheet, SheetLine, Stroke, TextNote } from "../lib/types";
import { chordToNumber, transposeChord, splitChords } from "../lib/nashville";
import { AnnotationLayer } from "./AnnotationLayer";
import "./SheetRenderer.css";

interface Props {
  sheet: ChordSheet;
  numberMode: boolean;
  displayKey: string;
  annotations?: Stroke[];
  onAnnotationsChange?: (next: Stroke[]) => void;
  texts?: TextNote[];
  onTextsChange?: (next: TextNote[]) => void;
  /** Reference content size the annotations were authored against, so the
   *  AnnotationLayer can scale them when the sheet re-renders at a different
   *  size. The first authored annotation seeds it via `onAnnoRefChange`. */
  annoRef?: { w: number; h: number } | null;
  onAnnoRefChange?: (ref: { w: number; h: number }) => void;
  /** Lifted to the App so the user's minimize choice survives switching
   *  between songs in a set (this tree remounts on song change). */
  annoToolbarCollapsed?: boolean;
  onAnnoToolbarCollapsedChange?: Dispatch<SetStateAction<boolean>>;
  /** Attached to the .sheet-render box so it can be rasterized for export. */
  rootRef?: Ref<HTMLDivElement>;
}

interface Token {
  chord: string | null;
  text: string;        // lyric text following this chord (until next chord)
}

function tokenizeChordPro(line: string): Token[] {
  const tokens: Token[] = [];
  const re = /\[([^\]]+)\]/g;
  let last = 0;
  let pendingChord: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const before = line.slice(last, m.index);
    if (before.length || pendingChord) {
      tokens.push({ chord: pendingChord, text: before });
    }
    pendingChord = m[1];
    last = m.index + m[0].length;
  }
  const tail = line.slice(last);
  if (tail.length || pendingChord) {
    tokens.push({ chord: pendingChord, text: tail });
  }
  if (tokens.length === 0) tokens.push({ chord: null, text: line });
  return tokens;
}

// numberMode: show Nashville numbers relative to the song's own key (key-
// independent — the display key does not change them). Otherwise transpose
// the printed chords from the song's key to the chosen display key.
interface XformCtx {
  numberMode: boolean;
  songKey: string;
  songMode: "major" | "minor";
  displayKey: string;
}

// Render accidentals as proper musical glyphs. In chord/number notation a
// lowercase "b" is always a flat (note letters are uppercase A–G), so this is
// safe to apply to chord text.
function prettyAccidentals(s: string): string {
  return s.replace(/#/g, "♯").replace(/b/g, "♭");
}

function transformOneChord(chord: string, ctx: XformCtx): string {
  return ctx.numberMode
    // superscriptExtensions off: the raised look is applied visually below
    // (as styled markup), so number mode must not also bake in Unicode
    // superscript digits — that would double up on "1⁷".
    ? chordToNumber(chord, ctx.songKey, { keyMode: ctx.songMode, superscriptExtensions: false })
    : transposeChord(chord, ctx.songKey, ctx.displayKey);
}

// Wrap ♯/♭ glyphs in a styled span so they read clearly against the small
// monospace chord text.
function withAccidentals(text: string): ReactNode {
  const parts = text.split(/([♯♭])/);
  return parts.map((p, i) =>
    p === "♯" || p === "♭"
      ? <span className="sr-acc" key={i}>{p}</span>
      : p,
  );
}

// Split a transformed chord into the part that prints at full size — the root
// letter or scale degree, its accidental, and a minor "m" — and the extension
// that rides above it. Bass notes stay full size, as lead sheets print them.
// Letter roots are uppercase A–G, so the lowercase "b" of a number-mode degree
// ("b3") can't be mistaken for a root.
const CHORD_SHAPE = /^([A-G](?:#|b)?|[#b]?[1-7])(min|m(?!aj))?([^/]*)(\/.+)?$/;

// Bracket contents are free text ("N.C.", "Capo 2", "2x"), and a stray leading
// A–G would otherwise make the remainder float up as a bogus extension. Only
// raise a tail that is built from real extension vocabulary.
const EXTENSION_SHAPE = /^(?:maj|add|sus|dim|aug|alt|no|°|\+|[0-9#b()Δ,.-])+$/i;

function renderOneChord(display: string, key: number): ReactNode {
  const m = CHORD_SHAPE.exec(display);
  if (!m || (m[3] && !EXTENSION_SHAPE.test(m[3]))) {
    return <span key={key}>{withAccidentals(prettyAccidentals(display))}</span>;
  }
  const [, head, minor, ext, bass] = m;
  return (
    <span key={key}>
      {withAccidentals(prettyAccidentals(head))}
      {minor}
      {/* Already raised and shrunk, so accidentals inside an extension get
          the plain glyph rather than the enlarged .sr-acc treatment. */}
      {ext && <span className="sr-ext">{prettyAccidentals(ext)}</span>}
      {bass && withAccidentals(prettyAccidentals(bass))}
    </span>
  );
}

function renderChord(chord: string, ctx: XformCtx): ReactNode {
  try {
    // A bracket may hold several chords ("[D G A]" / "[DG]"); transform each
    // independently. Single chords (and non-chord content) take the null path
    // and are transformed as one token, unchanged from before.
    const parts = splitChords(chord);
    if (!parts) return renderOneChord(transformOneChord(chord, ctx), 0);
    return parts.map((c, i) => (
      <span key={i}>
        {i > 0 && " "}
        {renderOneChord(transformOneChord(c, ctx), 0)}
      </span>
    ));
  } catch {
    return chord;
  }
}

function renderBarLine(line: string, ctx: XformCtx): ReactNode {
  // Capturing split: even indices are the separators ("| ", " |"), odd indices
  // the chord tokens.
  const pieces = line.split(/([A-G](?:#|b)?[A-Za-z0-9°+#b()/-]*)/g);
  return pieces.map((piece, i) => {
    if (i % 2 === 0 || !piece) return piece;
    try {
      // A single matched token may itself be run-together chords ("DG");
      // split and transform each, matching the bracketed-chord behavior.
      const parts = splitChords(piece);
      if (!parts) return renderOneChord(transformOneChord(piece, ctx), i);
      return (
        <span key={i}>
          {parts.map((c, j) => (
            <span key={j}>
              {j > 0 && " "}
              {renderOneChord(transformOneChord(c, ctx), 0)}
            </span>
          ))}
        </span>
      );
    } catch {
      return piece;
    }
  });
}

function LineRow({
  line,
  ctx,
  index,
}: {
  line: SheetLine;
  ctx: XformCtx;
  index: number;
}) {
  if (line.kind === "blank")
    return <div className="sr-blank" data-line-index={index} />;
  if (line.kind === "section")
    return (
      <div className="sr-section" data-line-index={index}>
        {line.text}
      </div>
    );
  if (line.kind === "chord-only") {
    return (
      <div className="sr-chordonly" data-line-index={index}>
        {renderBarLine(line.text, ctx)}
      </div>
    );
  }
  // chordpro
  const tokens = tokenizeChordPro(line.text);
  return (
    <div className="sr-line" data-line-index={index}>
      {tokens.map((t, i) => (
        <span className="sr-pair" data-token-index={i} key={i}>
          <span className="sr-chord">
            {t.chord ? renderChord(t.chord, ctx) :" "}
          </span>
          <span className="sr-lyric">{t.text || " "}</span>
        </span>
      ))}
    </div>
  );
}

export function SheetRenderer({
  sheet,
  numberMode,
  displayKey,
  annotations,
  onAnnotationsChange,
  texts,
  onTextsChange,
  annoRef,
  onAnnoRefChange,
  annoToolbarCollapsed,
  onAnnoToolbarCollapsedChange,
  rootRef,
}: Props) {
  const ctx: XformCtx = {
    numberMode,
    songKey: sheet.key,
    songMode: sheet.mode,
    displayKey,
  };
  return (
    <div className="sheet-render" ref={rootRef}>
      {onAnnotationsChange && onTextsChange && (
        <AnnotationLayer
          annotations={annotations ?? []}
          onChange={onAnnotationsChange}
          texts={texts ?? []}
          onTextsChange={onTextsChange}
          refSize={annoRef ?? null}
          onRefSize={onAnnoRefChange}
          collapsed={annoToolbarCollapsed}
          onCollapsedChange={onAnnoToolbarCollapsedChange}
        />
      )}
      <header className="sr-header">
        <h2>{sheet.title}</h2>
        <div className="sr-meta">
          {sheet.artist && <span>{sheet.artist}</span>}
          <span>
            Key:{" "}
            {numberMode
              ? "Numbers"
              : prettyAccidentals(displayKey) + (sheet.mode === "minor" ? "m" : "")}
          </span>
          {sheet.tempo && <span>Tempo: {sheet.tempo}</span>}
          {sheet.time && <span>Time: {sheet.time}</span>}
        </div>
      </header>
      <div className="sr-body">
        {(() => {
          // Group each section header with the lines that follow it so the
          // browser tries to keep them together within a column. A section
          // is only split when the group is so tall the engine can't keep
          // it in one column (the natural "imbalance" threshold).
          const groups: { start: number; items: { line: SheetLine; idx: number }[] }[] = [];
          sheet.lines.forEach((line, i) => {
            if (line.kind === "section" || groups.length === 0) {
              groups.push({ start: i, items: [{ line, idx: i }] });
            } else {
              groups[groups.length - 1].items.push({ line, idx: i });
            }
          });
          return groups.map((g) => (
            <div key={g.start} className="sr-section-group">
              {g.items.map(({ line, idx }) => (
                <LineRow key={idx} line={line} ctx={ctx} index={idx} />
              ))}
            </div>
          ));
        })()}
      </div>
    </div>
  );
}

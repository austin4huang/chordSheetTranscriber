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
    ? chordToNumber(chord, ctx.songKey, { keyMode: ctx.songMode })
    : transposeChord(chord, ctx.songKey, ctx.displayKey);
}

function transformChord(chord: string, ctx: XformCtx): string {
  try {
    // A bracket may hold several chords ("[D G A]" / "[DG]"); transform each
    // independently. Single chords (and non-chord content) take the null path
    // and are transformed as one token, unchanged from before.
    const parts = splitChords(chord);
    const out = parts
      ? parts.map((c) => transformOneChord(c, ctx)).join(" ")
      : transformOneChord(chord, ctx);
    return prettyAccidentals(out);
  } catch {
    return chord;
  }
}

function transformBarLine(line: string, ctx: XformCtx): string {
  return line.replace(/([A-G](?:#|b)?[A-Za-z0-9°+#b()/-]*)/g, (tok) => {
    try {
      // A single matched token may itself be run-together chords ("DG");
      // split and transform each, matching the bracketed-chord behavior.
      const parts = splitChords(tok);
      const out = parts
        ? parts.map((c) => transformOneChord(c, ctx)).join(" ")
        : transformOneChord(tok, ctx);
      return prettyAccidentals(out);
    } catch {
      return tok;
    }
  });
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
        {withAccidentals(transformBarLine(line.text, ctx))}
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
            {t.chord ? withAccidentals(transformChord(t.chord, ctx)) :" "}
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

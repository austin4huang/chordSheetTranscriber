import type { ReactNode } from "react";
import type { ChordSheet, SheetLine, Stroke, TextNote } from "../lib/types";
import { chordToNumber, transposeChord } from "../lib/nashville";
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

function transformChord(chord: string, ctx: XformCtx): string {
  try {
    return prettyAccidentals(
      ctx.numberMode
        ? chordToNumber(chord, ctx.songKey, { keyMode: ctx.songMode })
        : transposeChord(chord, ctx.songKey, ctx.displayKey),
    );
  } catch {
    return chord;
  }
}

function transformBarLine(line: string, ctx: XformCtx): string {
  return line.replace(/([A-G](?:#|b)?[A-Za-z0-9°+#b()/-]*)/g, (tok) => {
    try {
      return prettyAccidentals(
        ctx.numberMode
          ? chordToNumber(tok, ctx.songKey, { keyMode: ctx.songMode })
          : transposeChord(tok, ctx.songKey, ctx.displayKey),
      );
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

function LineRow({ line, ctx }: { line: SheetLine; ctx: XformCtx }) {
  if (line.kind === "blank") return <div className="sr-blank" />;
  if (line.kind === "section") return <div className="sr-section">{line.text}</div>;
  if (line.kind === "chord-only") {
    return <div className="sr-chordonly">{withAccidentals(transformBarLine(line.text, ctx))}</div>;
  }
  // chordpro
  const tokens = tokenizeChordPro(line.text);
  return (
    <div className="sr-line">
      {tokens.map((t, i) => (
        <span className="sr-pair" key={i}>
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
}: Props) {
  const ctx: XformCtx = {
    numberMode,
    songKey: sheet.key,
    songMode: sheet.mode,
    displayKey,
  };
  return (
    <div className="sheet-render">
      {onAnnotationsChange && onTextsChange && (
        <AnnotationLayer
          annotations={annotations ?? []}
          onChange={onAnnotationsChange}
          texts={texts ?? []}
          onTextsChange={onTextsChange}
        />
      )}
      <header className="sr-header">
        <h2>{sheet.title}</h2>
        <div className="sr-meta">
          {sheet.artist && <span>{sheet.artist}</span>}
          <span>
            Key: {numberMode ? "Numbers" : sheet.key + (sheet.mode === "minor" ? "m" : "")}
          </span>
          {sheet.tempo && <span>Tempo: {sheet.tempo}</span>}
          {sheet.time && <span>Time: {sheet.time}</span>}
        </div>
      </header>
      <div className="sr-body">
        {sheet.lines.map((line, i) => (
          <LineRow key={i} line={line} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}

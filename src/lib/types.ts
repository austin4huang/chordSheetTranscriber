export type LineKind = "chordpro" | "chord-only" | "section" | "blank" | "comment";

export interface SheetLine {
  kind: LineKind;
  text: string;          // raw line content. chordpro: "[D]Are you [G]hurting"
                         // chord-only: "| D | G | D | G |"
                         // section: "VERSE 1"
                         // comment: "# Tempo - 140"
}

// A free-hand annotation stroke. Points are flattened [x0,y0,x1,y1,...].
// When `anchor` is set, points are offsets in ref-px from the anchor
// element's top-left, so the whole stroke translates with the anchor when
// layout reflows (column changes, internal line wraps). Without `anchor`
// (legacy), points are absolute ref-px in the sheet's content box.
export interface Stroke {
  color: string;
  width: number;
  points: number[];
  anchor?: { lineIndex: number; tokenIndex?: number };
}

// A free-positioned text annotation. When `anchor` is set, x/y are pixels
// relative to the anchor element's top-left, so the box reflows with the
// anchor on resize / column changes. Anchor preference: the chord/lyric
// `tokenIndex` within a chordpro line (tracks the *specific* pair as the
// line wraps internally); falls back to whole-line anchor for non-chordpro
// lines (section/blank/chord-only). Without `anchor` they're absolute
// pixels in the sheet's content box (legacy; auto-migrated on first render).
export interface TextNote {
  id: string;
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: string;
  w?: number;          // manual box size; unset = auto-fit to text
  h?: number;
  anchor?: { lineIndex: number; tokenIndex?: number };
}

export interface ChordSheet {
  id: string;
  title: string;
  artist?: string;
  key: string;            // e.g. "D"
  mode: "major" | "minor";
  tempo?: number;
  time?: string;          // e.g. "6/8"
  lines: SheetLine[];
  annotations?: Stroke[];
  texts?: TextNote[];
  /** Pixel size of the rendered sheet content box at the time the
   *  annotations above were authored. Used to proportionally scale strokes
   *  and text boxes when the sheet re-renders at a different size. Legacy
   *  sheets without this field render with no scaling (effectively the
   *  current size = reference). */
  annoRef?: { w: number; h: number };
  /** Chosen display (transposed) key + accidental spelling, persisted per
   *  song. Unset = use the song's own `key`. Number-mode is a set-wide view
   *  toggle (App state) that doesn't touch these. */
  displayKey?: string;
  preferFlats?: boolean;
  createdAt?: number;     // unset on legacy sheets — fall back to updatedAt
  updatedAt: number;
}

export function blankSheet(): ChordSheet {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "Untitled",
    key: "C",
    mode: "major",
    lines: [],
    createdAt: now,
    updatedAt: now,
  };
}

// --- Schema guards for untrusted input -------------------------------------
// Used at boundaries where externally-supplied data crosses into the app
// (PDF /Keywords payloads, JSON backups, files in a linked folder). Reject
// anything that doesn't match the minimum required shape so downstream code
// only ever sees well-formed sheets.

const LINE_KINDS = new Set<LineKind>([
  "chordpro",
  "chord-only",
  "section",
  "comment",
  "blank",
]);

export function isSheetLine(o: unknown): o is SheetLine {
  if (!o || typeof o !== "object") return false;
  const l = o as { kind?: unknown; text?: unknown };
  return (
    typeof l.kind === "string" &&
    LINE_KINDS.has(l.kind as LineKind) &&
    typeof l.text === "string"
  );
}

export function isChordSheet(o: unknown): o is ChordSheet {
  if (!o || typeof o !== "object") return false;
  const s = o as Partial<ChordSheet>;
  return (
    typeof s.id === "string" &&
    typeof s.title === "string" &&
    typeof s.key === "string" &&
    (s.mode === "major" || s.mode === "minor") &&
    typeof s.updatedAt === "number" &&
    Array.isArray(s.lines) &&
    s.lines.every(isSheetLine)
  );
}

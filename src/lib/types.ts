export type LineKind = "chordpro" | "chord-only" | "section" | "blank" | "comment";

export interface SheetLine {
  kind: LineKind;
  text: string;          // raw line content. chordpro: "[D]Are you [G]hurting"
                         // chord-only: "| D | G | D | G |"
                         // section: "VERSE 1"
                         // comment: "# Tempo - 140"
}

// A free-hand annotation stroke. Points are flattened [x0,y0,x1,y1,...] in
// pixels relative to the rendered sheet's content box.
export interface Stroke {
  color: string;
  width: number;
  points: number[];
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

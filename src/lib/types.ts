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

// A free-positioned text annotation. x/y are the box's top-left in pixels
// relative to the rendered sheet's content box.
export interface TextNote {
  id: string;
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: string;
  w?: number;          // manual box size; unset = auto-fit to text
  h?: number;
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

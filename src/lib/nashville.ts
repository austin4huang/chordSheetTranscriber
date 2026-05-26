// Nashville Number System conversion.
// Given a key and a chord symbol, produce a number-notation string.

export type Quality = "maj" | "min" | "dim" | "aug" | "sus2" | "sus4" | "5";

export interface ParsedChord {
  root: string;          // normalized: A, A#, Bb, etc.
  quality: Quality;
  extensions: string;    // e.g. "7", "maj7", "9", "add9", "7sus4"
  bass: string | null;   // normalized bass note or null
  raw: string;           // original input
}

const SHARP_SCALE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_SCALE = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const FLAT_EQUIV: Record<string, string> = {
  Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#",
};

const MAJOR_SCALE_DEGREES = [0, 2, 4, 5, 7, 9, 11];   // semitones for 1..7
const MINOR_SCALE_DEGREES = [0, 2, 3, 5, 7, 8, 10];

export function normalizeNote(n: string): string {
  if (!n) return n;
  const head = n[0].toUpperCase() + n.slice(1).toLowerCase();
  if (FLAT_EQUIV[head]) return FLAT_EQUIV[head];
  if (head.endsWith("#") || head.endsWith("b")) {
    return head[0].toUpperCase() + head.slice(1);
  }
  return head;
}

export function noteToPitchClass(n: string): number {
  const norm = normalizeNote(n);
  const idx = SHARP_SCALE.indexOf(norm);
  if (idx < 0) throw new Error(`Unknown note: ${n}`);
  return idx;
}

export function parseChord(input: string): ParsedChord | null {
  const raw = input.trim();
  if (!raw) return null;
  // Pull off the bass first to keep the regex simple
  let body = raw;
  let bass: string | null = null;
  const slashIdx = raw.lastIndexOf("/");
  if (slashIdx > 0) {
    const bassCand = raw.slice(slashIdx + 1);
    if (/^[A-G](#|b)?$/.test(bassCand)) {
      bass = normalizeNote(bassCand);
      body = raw.slice(0, slashIdx);
    }
  }
  const m = body.match(/^([A-G](?:#|b)?)(.*)$/);
  if (!m) return null;
  const root = normalizeNote(m[1]);
  const tail = m[2] || "";

  let quality: Quality = "maj";
  let rest = tail;
  // Order matters: longer matches first
  const qualityMatchers: Array<[RegExp, Quality]> = [
    [/^sus2/, "sus2"],
    [/^sus4/, "sus4"],
    [/^sus/, "sus4"],
    [/^(°|o|dim)/, "dim"],
    [/^(aug|\+)/, "aug"],
    [/^5(?![0-9])/, "5"],
    [/^(min|m)(?!aj)/, "min"],
  ];
  for (const [re, q] of qualityMatchers) {
    const mm = rest.match(re);
    if (mm) {
      quality = q;
      rest = rest.slice(mm[0].length);
      break;
    }
  }
  return { root, quality, extensions: rest, bass, raw };
}

// Whether a key should spell accidentals with flats. Explicit accidentals
// win (Bb/Eb… → flats, F#/C#… → sharps); among the natural-letter keys only
// F is conventionally a flat key (one flat, Bb), the rest spell with sharps.
export function keyPrefersFlats(key: string): boolean {
  const m = key.trim().match(/^([A-G])(#|b)?/);
  if (!m) return false;
  if (m[2] === "b") return true;
  if (m[2] === "#") return false;
  return m[1] === "F";
}

// Transpose a chord symbol from one key to another, shifting the root (and
// any slash bass) while preserving quality/extension text verbatim. Returns
// the input unchanged for non-chords or a zero-interval transpose.
export function transposeChord(input: string, fromKey: string, toKey: string): string {
  if (!parseChord(input)) return input;
  const shift = ((noteToPitchClass(toKey) - noteToPitchClass(fromKey)) % 12 + 12) % 12;
  if (shift === 0) return input;
  // Spell accidentals to match the target key: a flat key (e.g. "Eb", "Bb")
  // yields flats, otherwise sharps.
  const scale = keyPrefersFlats(toKey) ? FLAT_SCALE : SHARP_SCALE;
  const shiftNote = (n: string) => scale[(noteToPitchClass(n) + shift) % 12];

  const raw = input.trim();
  let body = raw;
  let bass: string | null = null;
  const slashIdx = raw.lastIndexOf("/");
  if (slashIdx > 0 && /^[A-G](#|b)?$/.test(raw.slice(slashIdx + 1))) {
    bass = raw.slice(slashIdx + 1);
    body = raw.slice(0, slashIdx);
  }
  const m = body.match(/^([A-G](?:#|b)?)(.*)$/);
  if (!m) return input;
  let out = shiftNote(m[1]) + m[2];
  if (bass) out += "/" + shiftNote(bass);
  return out;
}

// Split a bracket's contents into individual chord symbols when it holds more
// than one — whitespace-separated ("D G A") or run-together capitals ("DG").
// A new chord begins at each uppercase root letter A–G that isn't a slash-bass
// note; whitespace also separates. Returns the chords in order, or null when
// the contents aren't a clean run of ≥2 chords (a lyric, a marker like "N.C.",
// or just one chord) — callers then treat the bracket as a single token and
// leave it unchanged.
export function splitChords(content: string): string[] | null {
  const n = content.length;
  const isRoot = (c: string) => c >= "A" && c <= "G";
  const tokens: string[] = [];
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(content[i])) i++; // skip separators
    if (i >= n) break;
    if (!isRoot(content[i])) return null; // every chord must start on a root
    let j = i + 1;
    while (j < n) {
      const c = content[j];
      if (/\s/.test(c) || isRoot(c)) break; // next chord or separator
      if (c === "/") {
        // Keep a slash-bass note ("/F#") attached to the current chord.
        const k = j + 1;
        if (k < n && isRoot(content[k])) {
          j = k + 1;
          if (j < n && (content[j] === "#" || content[j] === "b")) j++;
          continue;
        }
        break;
      }
      j++;
    }
    const tok = content.slice(i, j);
    if (!parseChord(tok)) return null; // bail out on any non-chord piece
    tokens.push(tok);
    i = j;
  }
  return tokens.length >= 2 ? tokens : null;
}

const SUPER_DIGITS: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
};
function superscript(s: string): string {
  return s.replace(/[0-9]/g, (d) => SUPER_DIGITS[d] || d);
}

export interface ConvertOptions {
  keyMode?: "major" | "minor";
  superscriptExtensions?: boolean;
}

function degreeFromSemitones(semis: number, mode: "major" | "minor"): string {
  const scale = mode === "major" ? MAJOR_SCALE_DEGREES : MINOR_SCALE_DEGREES;
  const s = ((semis % 12) + 12) % 12;
  const exact = scale.indexOf(s);
  if (exact >= 0) return String(exact + 1);
  // Not diatonic — find nearest scale degree and add accidental
  for (let i = 0; i < scale.length; i++) {
    if (scale[i] === s - 1) return `#${i + 1}`;
    if (scale[i] === s + 1) return `b${i + 1}`;
  }
  return `?${s}`;
}

export function chordToNumber(
  input: string,
  key: string,
  opts: ConvertOptions = {}
): string {
  const mode = opts.keyMode ?? "major";
  const sup = opts.superscriptExtensions ?? true;
  const parsed = parseChord(input);
  if (!parsed) return input;
  const keyPc = noteToPitchClass(key);
  const rootPc = noteToPitchClass(parsed.root);
  const degree = degreeFromSemitones(rootPc - keyPc, mode);

  let qSuffix = "";
  switch (parsed.quality) {
    case "min": qSuffix = "m"; break;
    case "dim": qSuffix = "°"; break;
    case "aug": qSuffix = "+"; break;
    case "sus2": qSuffix = "sus2"; break;
    case "sus4": qSuffix = "sus"; break;
    case "5": qSuffix = "5"; break;
    case "maj": qSuffix = ""; break;
  }
  const ext = parsed.extensions
    ? sup ? superscript(parsed.extensions) : parsed.extensions
    : "";

  let result = `${degree}${qSuffix}${ext}`;

  if (parsed.bass) {
    const bassPc = noteToPitchClass(parsed.bass);
    const bassDeg = degreeFromSemitones(bassPc - keyPc, mode);
    result += `/${bassDeg}`;
  }
  return result;
}

import type { ChordSheet, SheetLine } from "./types";
import { parseChord } from "./nashville";

const KEY = "musicApp.sheets.v1";

// A Set is just an ordered list of references into the global sheet database;
// the sheets themselves stay shared, so editing one updates it everywhere.
export interface SongSet {
  id: string;
  name: string;
  sheetIds: string[];
  updatedAt: number;
}

export interface Stored {
  sheets: ChordSheet[];
  sets?: SongSet[];
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { sheets: [], sets: [] };
    const parsed = JSON.parse(raw) as Stored;
    return { sheets: parsed.sheets ?? [], sets: parsed.sets ?? [] };
  } catch {
    return { sheets: [], sets: [] };
  }
}

// Durable-storage layer subscribes here: every mutation funnels through
// write(), so this is the single place to mirror the library to IndexedDB
// and a linked device folder.
let writeListener: ((s: Stored) => void) | null = null;
export function onStoreWrite(cb: ((s: Stored) => void) | null) {
  writeListener = cb;
}

function write(s: Stored) {
  localStorage.setItem(KEY, JSON.stringify(s));
  try {
    writeListener?.(s);
  } catch {
    /* persistence is best-effort; never block a local save */
  }
}

/** Whole-library snapshot (for backup/export and folder sync). */
export function readStore(): Stored {
  const s = read();
  return { sheets: s.sheets, sets: s.sets ?? [] };
}

/** Replace the entire library (restore from backup / linked folder).
 *  `notify` writes through the persistence layer too (default); pass false
 *  when applying data that *came from* that layer to avoid an echo. */
export function replaceStore(s: Stored, notify = true) {
  const clean: Stored = { sheets: s.sheets ?? [], sets: s.sets ?? [] };
  if (notify) {
    write(clean);
  } else {
    localStorage.setItem(KEY, JSON.stringify(clean));
  }
}

export function listSheets(): ChordSheet[] {
  return read().sheets.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSheet(id: string): ChordSheet | undefined {
  return read().sheets.find((s) => s.id === id);
}

export function saveSheet(sheet: ChordSheet) {
  const s = read();
  const idx = s.sheets.findIndex((x) => x.id === sheet.id);
  const updated = { ...sheet, updatedAt: Date.now() };
  if (idx >= 0) s.sheets[idx] = updated;
  else s.sheets.push(updated);
  write(s);
}

export function deleteSheet(id: string) {
  const s = read();
  s.sheets = s.sheets.filter((x) => x.id !== id);
  // Drop the sheet from any sets that referenced it.
  s.sets = (s.sets ?? []).map((set) => ({
    ...set,
    sheetIds: set.sheetIds.filter((sid) => sid !== id),
  }));
  write(s);
}

export function listSets(): SongSet[] {
  return (read().sets ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSet(id: string): SongSet | undefined {
  return (read().sets ?? []).find((s) => s.id === id);
}

export function saveSet(set: SongSet) {
  const s = read();
  const sets = s.sets ?? [];
  const idx = sets.findIndex((x) => x.id === set.id);
  const updated = { ...set, updatedAt: Date.now() };
  if (idx >= 0) sets[idx] = updated;
  else sets.push(updated);
  write({ ...s, sets });
}

export function deleteSet(id: string) {
  const s = read();
  write({ ...s, sets: (s.sets ?? []).filter((x) => x.id !== id) });
}

// ChordPro <-> SheetLine[] serialization for the textarea editor.
// Format:
//   {title: ...}
//   {key: D}
//   [section: VERSE 1]
//   | D | G | D | G |        <- chord-only line is preserved verbatim
//   [D]Are you [G]hurting...
//   (blank line)
export function linesToText(sheet: ChordSheet): string {
  const out: string[] = [];
  out.push(`{title: ${sheet.title}}`);
  if (sheet.artist) out.push(`{artist: ${sheet.artist}}`);
  out.push(`{key: ${sheet.key}${sheet.mode === "minor" ? "m" : ""}}`);
  if (sheet.tempo) out.push(`{tempo: ${sheet.tempo}}`);
  if (sheet.time) out.push(`{time: ${sheet.time}}`);
  out.push("");
  for (const line of sheet.lines) {
    if (line.kind === "section") out.push(`[section: ${line.text}]`);
    else if (line.kind === "blank") out.push("");
    else out.push(line.text);
  }
  return out.join("\n");
}

export function textToSheet(text: string, base: ChordSheet): ChordSheet {
  const lines = text.split(/\r?\n/);
  const result: ChordSheet = { ...base, lines: [] };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      result.lines.push({ kind: "blank", text: "" });
      continue;
    }
    const directive = line.match(/^\{(\w+):\s*(.*)\}$/);
    if (directive) {
      const [, k, v] = directive;
      if (k === "title") result.title = v.trim();
      else if (k === "artist") result.artist = v.trim();
      else if (k === "key") {
        const m = v.trim().match(/^([A-G](?:#|b)?)(m)?$/);
        if (m) {
          result.key = m[1];
          result.mode = m[2] ? "minor" : "major";
        }
      } else if (k === "tempo") result.tempo = Number(v) || undefined;
      else if (k === "time") result.time = v.trim();
      continue;
    }
    const sec = line.match(/^\[section:\s*(.*)\]$/);
    if (sec) {
      result.lines.push({ kind: "section", text: sec[1].trim() });
      continue;
    }
    if (looksLikeChordOnly(line)) {
      result.lines.push({ kind: "chord-only", text: line });
    } else {
      result.lines.push({ kind: "chordpro", text: line });
    }
  }
  // Trim leading/trailing blank lines
  while (result.lines.length && result.lines[0].kind === "blank") result.lines.shift();
  while (result.lines.length && result.lines.at(-1)!.kind === "blank") result.lines.pop();
  return result;
}

const CHORD_TOKEN_RE =
  /^[A-G](?:#|b)?(?:maj7|maj9|maj|min|m|M|°|o|dim|aug|\+|sus2|sus4|sus|5)?[0-9a-zA-Z()#b+\-]*?(?:\/[A-G](?:#|b)?)?$/;

function isChordToken(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  return CHORD_TOKEN_RE.test(t) && parseChord(t) !== null;
}

function looksLikeChordOnly(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // Inline bracketed chords mean it's a chordpro lyric line, not chord-only.
  if (/\[[^\]]+\]/.test(t)) return false;
  if (t.includes("|")) {
    const tokens = t.split(/\s+/).filter(Boolean);
    return tokens.every((tok) => /^[|:]+$/.test(tok) || /^[A-G]/.test(tok));
  }
  // No bar-lines: still a chord line if, ignoring parenthetical performance
  // annotations like "(1st Ending)" / "(To Chorus)", every token is a chord.
  // Require >=2 chords (or a paren annotation) so a lone word like "A" or a
  // one-word lyric isn't mistaken for a chord line.
  const hadParen = /\([^)]*\)/.test(t);
  const rest = t.replace(/\([^)]*\)/g, " ").trim().split(/\s+/).filter(Boolean);
  if (rest.length === 0 || !rest.every(isChordToken)) return false;
  return rest.length >= 2 || hadParen;
}

// Discard helper for new-sheet bootstrapping
export function emptySheetWithDefaults(): ChordSheet {
  return {
    id: crypto.randomUUID(),
    title: "Untitled",
    key: "C",
    mode: "major",
    lines: [
      { kind: "section", text: "VERSE 1" },
      { kind: "chordpro", text: "[C]Type your [G]lyrics here" },
    ] as SheetLine[],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** createdAt with a legacy fallback (older sheets have no createdAt). */
export function createdAtOf(s: ChordSheet): number {
  return s.createdAt ?? s.updatedAt;
}

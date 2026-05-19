// PDF chord-sheet parser. Extracts text items with positions from a PDF using
// pdfjs-dist, then reconstructs the chord-over-lyric layout into ChordPro lines.

import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ChordSheet, SheetLine } from "./types";
import { parseChord } from "./nashville";
import { recoverLigatures, recoverLigaturesAligned } from "./ligatures";
import { decodePayload, type EmbeddedPayload } from "./pdfExport";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

interface Item {
  text: string;
  x: number;
  y: number;        // higher = closer to top in our normalized space
  width: number;
  height: number;   // glyph height; superscripts are noticeably shorter
}

const CHORD_TOKEN_RE =
  /^[A-G](?:#|b)?(?:maj7|maj9|maj|min|m|M|°|o|dim|aug|\+|sus2|sus4|sus|5)?[0-9a-zA-Z()#b+\-]*?(?:\/[A-G](?:#|b)?)?$/;

function isChordToken(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (!CHORD_TOKEN_RE.test(t)) return false;
  return parseChord(t) !== null;
}

function isBarlineToken(s: string): boolean {
  return /^[|:]+$/.test(s.trim());
}

// PDFs frequently encode "ff", "fi", "fl", "ffi", "ffl" as single ligature
// glyphs. Map them back to ASCII so lyrics like "fire" don't come out "re".
function normalizeLigatures(s: string): string {
  return s
    .replace(/ﬀ/g, "ff")
    .replace(/ﬁ/g, "fi")
    .replace(/ﬂ/g, "fl")
    .replace(/ﬃ/g, "ffi")
    .replace(/ﬄ/g, "ffl")
    .replace(/ﬅ/g, "st")
    .replace(/ﬆ/g, "st");
}

// Reconstruct a text line from x-positioned items, inserting spaces from the
// positional gap between runs. A space glyph is only ~0.3 of an average
// character's width, so any clear gap must yield at least one space — naive
// rounding drops normal word spaces and glues words together ("Comingon").
function reconstructLine(row: Item[]): { text: string; charX: number[] } {
  const sorted = [...row].sort((a, b) => a.x - b.x);
  let text = "";
  const charX: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i];
    if (i > 0) {
      const prev = sorted[i - 1];
      const prevEnd = prev.x + prev.width;
      const gap = it.x - prevEnd;
      // Estimate glyph width from the longer neighbour (single-char items
      // give unreliable per-char widths).
      const ref = prev.text.length >= it.text.length ? prev : it;
      const avgCharW = ref.width / Math.max(1, ref.text.length);
      const spaceW = Math.max(0.5, avgCharW * 0.5);
      let spaces = 0;
      if (gap > avgCharW * 0.28) {
        spaces = Math.max(1, Math.round(gap / spaceW));
      }
      for (let s = 0; s < spaces; s++) {
        charX.push(prevEnd + s * spaceW);
        text += " ";
      }
    }
    const charW = it.width / Math.max(1, it.text.length);
    for (let c = 0; c < it.text.length; c++) {
      charX.push(it.x + c * charW);
      text += it.text[c];
    }
  }
  return recoverLigaturesAligned(text, charX);
}

async function extractItems(file: File): Promise<Item[][]> {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages: Item[][] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const items: Item[] = [];
    for (const it of tc.items as any[]) {
      if (!it.str || !it.str.trim()) continue;
      // PDF transform: [a, b, c, d, e, f]; e=x, f=y. y grows upward.
      const x = it.transform[4];
      const y = it.transform[5];
      items.push({ text: normalizeLigatures(it.str), x, y, width: it.width, height: it.height });
    }
    pages.push(items);
  }
  return pages;
}

// Chord extensions ("7", "9", "sus4", "(b9)") are often typeset as a smaller
// glyph raised above the chord's baseline. PDF extraction puts them on their
// own near-baseline, so row grouping splits "F#m7" into an "F#m" chord row and
// a stray "7" row that then looks like a lyric. Merge each superscript back
// onto the chord token it sits at the end of, before rows are formed.
const EXTENSION_RE = /^[0-9#b()+\-/]+$/;

function mergeSuperscripts(items: Item[]): Item[] {
  const consumed = new Set<number>();
  for (let s = 0; s < items.length; s++) {
    const sup = items[s];
    if (!EXTENSION_RE.test(sup.text.trim()) || !/[0-9]/.test(sup.text)) continue;
    let best = -1;
    let bestGap = Infinity;
    for (let b = 0; b < items.length; b++) {
      if (b === s || consumed.has(b)) continue;
      const base = items[b];
      const rise = sup.y - base.y;
      // Raised, but well within a line (not the row above), and smaller glyph.
      if (rise <= base.height * 0.15 || rise >= base.height * 0.7) continue;
      if (sup.height > base.height * 0.92) continue;
      // Sits immediately at the end of the base token.
      const gap = sup.x - (base.x + base.width);
      if (gap < -3 || gap > base.height * 0.6) continue;
      if (Math.abs(gap) < bestGap) {
        bestGap = Math.abs(gap);
        best = b;
      }
    }
    if (best >= 0) {
      const base = items[best];
      base.text = base.text.trimEnd() + sup.text.trim();
      base.width = sup.x + sup.width - base.x;
      consumed.add(s);
    }
  }
  return items.filter((_, i) => !consumed.has(i));
}

// Group items into rows by y. PDFs typically place items on the exact same
// baseline for a row, so a small epsilon suffices.
function groupRows(items: Item[]): Item[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Item[][] = [];
  const EPS = 2;
  for (const it of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last[0].y - it.y) <= EPS) {
      last.push(it);
    } else {
      rows.push([it]);
    }
  }
  for (const r of rows) r.sort((a, b) => a.x - b.x);
  return rows;
}

// Detect a two-column layout by finding a vertical "gutter": a central band of
// x where almost no text sits, flanked by dense text on both sides. Returns the
// gutter's center x, or null for single-column pages. Full-width lines (title,
// CCLI footer) cross the gutter but are few, so they barely lift its coverage.
function findGutter(items: Item[]): number | null {
  if (items.length < 16) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.x);
    maxX = Math.max(maxX, it.x + it.width);
  }
  const span = maxX - minX;
  if (span <= 0) return null;

  const BINS = 120;
  const binW = span / BINS;
  const cover = new Array(BINS).fill(0);
  for (const it of items) {
    const b0 = Math.max(0, Math.floor((it.x - minX) / binW));
    const b1 = Math.min(BINS - 1, Math.floor((it.x + it.width - minX) / binW));
    for (let b = b0; b <= b1; b++) cover[b]++;
  }
  const peak = Math.max(...cover);
  if (peak < 4) return null;

  // The gutter is a *relative valley*: the thinnest central band, flanked by
  // dense column masses. An absolute "near-zero" threshold misses sheets
  // whose columns nearly touch (the valley floor can be ~15% of peak), so
  // measure the dip against the masses on either side instead.
  const lo = Math.floor(BINS * 0.22);
  const hi = Math.ceil(BINS * 0.78);
  let minC = Infinity;
  let minBin = -1;
  for (let b = lo; b <= hi; b++) {
    if (cover[b] < minC) {
      minC = cover[b];
      minBin = b;
    }
  }
  if (minBin < 0) return null;

  let leftMax = 0;
  for (let b = 0; b <= minBin; b++) leftMax = Math.max(leftMax, cover[b]);
  let rightMax = 0;
  for (let b = minBin; b < BINS; b++) rightMax = Math.max(rightMax, cover[b]);

  // Need a substantial text mass in each column, and the valley must be
  // markedly thinner than both of them.
  if (leftMax < peak * 0.5 || rightMax < peak * 0.5) return null;
  if (minC > peak * 0.45 || minC > Math.min(leftMax, rightMax) * 0.6) return null;

  // Grow the gutter out from its lowest point across the contiguous low band.
  const gutThresh = Math.max(
    minC + Math.max(1, peak * 0.05),
    Math.min(leftMax, rightMax) * 0.45,
  );
  let s = minBin;
  let e = minBin;
  while (s - 1 >= 0 && cover[s - 1] <= gutThresh) s--;
  while (e + 1 < BINS && cover[e + 1] <= gutThresh) e++;
  if (e - s + 1 < 2) return null;

  const gutterCenterBin = (s + e + 1) / 2;
  if (gutterCenterBin < BINS * 0.18 || gutterCenterBin > BINS * 0.82) return null;
  return minX + gutterCenterBin * binW;
}

// Split a page's items into ordered columns (left then right) if it has a
// two-column layout, otherwise return the page as a single group.
function splitColumns(items: Item[]): Item[][] {
  const gutter = findGutter(items);
  if (gutter == null) return [items];
  const left: Item[] = [];
  const right: Item[] = [];
  for (const it of items) {
    if (it.x + it.width / 2 < gutter) left.push(it);
    else right.push(it);
  }
  return [left, right];
}

function classifyRow(row: Item[]): "chord" | "chord-only-line" | "lyric" | "section" | "header" | "other" {
  const tokens = row.map((i) => i.text.trim()).filter(Boolean);
  if (tokens.length === 0) return "other";
  const all = tokens.join(" ");
  // Orphan chord-extension superscripts that failed to reattach to their
  // base chord (common in some WorshipTogether exports) land on their own
  // rows: lone numbers/parens/quality suffixes with no note letter, e.g.
  // "2", "7", "(4)", "sus", "sus  sus  sus", "2     (4)". A real chord
  // always leads with a note A–G, so anything that's *only* these fragments
  // (and never a chord/bar-line/lyric) is dropped rather than emitted.
  const ORPHAN_EXT = /^\(?(?:sus\d?|add\d{1,2}|maj\d?|min|dim|aug|m|\d{1,2})\)?$/i;
  if (tokens.every((t) => ORPHAN_EXT.test(t))) return "other";
  // Plain-PDF song masthead, e.g. "One Way Jesus – (G)" — drop from the body
  // (the title/key are recovered separately by detectSongHeader).
  if (all.length < 60 && SONG_HEADER_RE.test(all)) return "header";
  // Bracketed section label(s): "[Verse 2]", "[Bridge] [x2]".
  if (BRACKET_SECTION_RE.test(all.trim())) return "section";
  // Section header: usually all caps single short label
  if (
    tokens.length <= 3 &&
    /^[A-Z0-9 \-]+$/.test(all) &&
    /^(INTRO|VERSE|CHORUS|BRIDGE|PRE[ -]?CHORUS|INSTRUMENTAL|INTERLUDE|TURNAROUND|TAG|OUTRO|ENDING|REFRAIN|VAMP)\b/.test(all.trim())
  ) {
    return "section";
  }
  // Chord-only line: contains barlines and chord tokens
  if (tokens.some(isBarlineToken) && tokens.every((t) => isBarlineToken(t) || isChordToken(t))) {
    return "chord-only-line";
  }
  // All tokens are chords (no barlines) -> chord row hovering above a lyric row
  if (tokens.every(isChordToken)) {
    return "chord";
  }
  // Chord row carrying an inline performance annotation, e.g.
  // "(1st Ending)   A   B   C#m" or "(2nd Ending) A B E (To Chorus)".
  // Strip the parenthetical labels; if everything else is chords/barlines,
  // treat it as a chord line so the chords keep their styling and transpose.
  if (all.includes("(")) {
    const rest = all.replace(/\([^)]*\)/g, " ").trim().split(/\s+/).filter(Boolean);
    if (rest.length > 0 && rest.some(isChordToken) && rest.every((t) => isBarlineToken(t) || isChordToken(t))) {
      return "chord-only-line";
    }
  }
  // Header / footer boilerplate: song metadata ("Key -", "Tempo -") and the
  // SongSelect/CCLI license footer ("For use solely with the SongSelect®
  // Terms of Use. All rights reserved. www.ccli.com").
  if (
    /(Key\s*-|Tempo\s*-|Time\s*-|CCLI|©)/.test(all) ||
    /(SongSelect|ccli\.com|All rights reserved|Terms of Use|CCLI License)/i.test(all) ||
    // WorshipTogether/worship publishing footer boilerplate that gets
    // column-split into the body, e.g.
    // "Ltd | Vamos Publishing | worshiptogether.com songs | Martin…".
    /(worshiptogether|Publishing|Music Services|Capitol\s*CMG|sixsteps|Be Essential|Bethel Music|Hillsong|Integrity|Essential Music|Used by permission|admin\.|\bLtd\b)/i.test(
      all,
    )
  ) {
    return "header";
  }
  return "lyric";
}

// Merge a chord row positioned above a lyric row into a ChordPro string.
function mergeChordOverLyric(chordRow: Item[], lyricRow: Item[]): string {
  // Build the lyric string with character-position bookkeeping. PDF text items
  // for a lyric line are usually contiguous strings; we concatenate them in
  // x-order with single spaces and remember where each item starts.
  const { text: lyric, charX } = reconstructLine(lyricRow);

  // For each chord, find the character index whose x is closest to chord.x.
  const sortedChords = [...chordRow].sort((a, b) => a.x - b.x);
  // Insert chord markers from right to left so earlier indices remain valid.
  const insertions: Array<{ idx: number; chord: string }> = [];
  for (const c of sortedChords) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < charX.length; i++) {
      const d = Math.abs(charX[i] - c.x);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (charX.length === 0) bestIdx = 0;
    // If chord.x is past the last char, append at end
    if (charX.length > 0 && c.x > charX[charX.length - 1] + 5) {
      bestIdx = charX.length;
    }
    insertions.push({ idx: bestIdx, chord: c.text.trim() });
  }
  insertions.sort((a, b) => b.idx - a.idx);
  let out = lyric;
  for (const ins of insertions) {
    out = out.slice(0, ins.idx) + `[${ins.chord}]` + out.slice(ins.idx);
  }
  return out;
}

function chordOnlyRowToText(row: Item[]): string {
  return row.map((i) => i.text.trim()).filter(Boolean).join(" ");
}

// Emit a chord line, peeling off parenthetical performance annotations
// ("(1st Ending)", "(To Chorus)") as their own section lines so they render
// as labels (blue) instead of being run through chord transposition — which
// otherwise mangles them (e.g. "(1st Ending)" -> "(1st 1nding)" in number
// mode). Only whole-token "(...)" groups are peeled, so chord extensions like
// "C(add9)" stay intact. Order is preserved.
function pushChordLine(text: string, lines: SheetLine[]): void {
  const re = /(?:^|\s)(\([^)]*\))(?=\s|$)/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const annStart = m.index + m[0].indexOf("(");
    const chords = text.slice(lastEnd, annStart).trim();
    if (chords) lines.push({ kind: "chord-only", text: chords });
    lines.push({ kind: "section", text: m[1] });
    lastEnd = re.lastIndex;
  }
  const tail = text.slice(lastEnd).trim();
  if (tail) lines.push({ kind: "chord-only", text: tail });
}

function detectKey(items: Item[]): { key: string; mode: "major" | "minor" } | null {
  for (const it of items) {
    const m = it.text.match(/Key\s*-\s*([A-G](?:#|b)?)(m)?/i);
    if (m) {
      return {
        key: m[1][0].toUpperCase() + m[1].slice(1),
        mode: m[2] ? "minor" : "major",
      };
    }
  }
  return null;
}

function detectTitle(items: Item[]): string | null {
  // Title is typically the topmost large item on page 1.
  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) => b.y - a.y);
  return sorted[0]?.text.trim() || null;
}

const WHOLE_PAREN_RE = /^\([^)]*\)$/;

// A chord row that also carries parenthetical annotation items, e.g.
// "(1st Ending) A B C#m" or "(2nd Ending) A B E (To Chorus)". Returns the
// annotation items split into those left of the chords (leading labels) and
// those right of them (trailing cues), plus the bare chord items — so the
// labels can become section lines while the chords still attach to lyrics.
function splitAnnotationRow(
  row: Item[],
): { lead: Item[]; chords: Item[]; trail: Item[] } | null {
  const ann = row.filter((it) => WHOLE_PAREN_RE.test(it.text.trim()));
  if (ann.length === 0) return null;
  const chords = row.filter((it) => !WHOLE_PAREN_RE.test(it.text.trim()));
  if (
    chords.length === 0 ||
    !chords.some((it) => isChordToken(it.text)) ||
    !chords.every((it) => isBarlineToken(it.text) || isChordToken(it.text))
  ) {
    return null;
  }
  const firstChordX = Math.min(...chords.map((c) => c.x));
  const lead = ann.filter((a) => a.x < firstChordX).sort((a, b) => a.x - b.x);
  const trail = ann.filter((a) => a.x >= firstChordX).sort((a, b) => a.x - b.x);
  return { lead, chords, trail };
}

// Convert the rows of one column (or single-column page) into sheet lines.
function emitRows(rows: Item[][], lines: SheetLine[]): void {
  const tagged = rows.map((r) => ({ row: r, kind: classifyRow(r) }));
  let i = 0;
  while (i < tagged.length) {
    const cur = tagged[i];
    if (cur.kind === "header") { i++; continue; }
    if (cur.kind === "section") {
      const secText = recoverLigatures(cur.row.map((x) => x.text).join(" ").trim())
        .replace(/[[\]]/g, " ") // strip "[Verse 2]" / "[Bridge] [x2]" brackets
        .replace(/\s+/g, " ")
        .trim();
      lines.push({ kind: "section", text: secText });
      i++;
      continue;
    }
    if (cur.kind === "chord-only-line") {
      const split = splitAnnotationRow(cur.row);
      if (split) {
        // Leading labels ("(1st Ending)") render as their own blue sections.
        for (const a of split.lead) lines.push({ kind: "section", text: a.text.trim() });
        const next = tagged[i + 1];
        if (next && next.kind === "lyric") {
          lines.push({ kind: "chordpro", text: mergeChordOverLyric(split.chords, next.row) });
          // Trailing cues ("(To Chorus)") go after the lyric, out of the way.
          for (const a of split.trail) lines.push({ kind: "section", text: a.text.trim() });
          i += 2;
          continue;
        }
        lines.push({ kind: "chord-only", text: chordOnlyRowToText(split.chords) });
        for (const a of split.trail) lines.push({ kind: "section", text: a.text.trim() });
        i++;
        continue;
      }
      pushChordLine(chordOnlyRowToText(cur.row), lines);
      i++;
      continue;
    }
    if (cur.kind === "chord") {
      const next = tagged[i + 1];
      if (next && next.kind === "lyric") {
        lines.push({ kind: "chordpro", text: mergeChordOverLyric(cur.row, next.row) });
        i += 2;
        continue;
      }
      // Chord row with no lyric beneath -> treat as chord-only
      pushChordLine(chordOnlyRowToText(cur.row), lines);
      i++;
      continue;
    }
    if (cur.kind === "lyric") {
      // Lyric with no chord row above
      lines.push({ kind: "chordpro", text: reconstructLine(cur.row).text });
      i++;
      continue;
    }
    i++;
  }
}

/** If the PDF was exported by this app, recover the exact embedded data
 *  (lossless round-trip). Returns null for foreign PDFs. */
export async function extractEmbeddedPayload(
  file: File,
): Promise<EmbeddedPayload | null> {
  try {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const meta = await pdf.getMetadata();
    const kw = (meta.info as { Keywords?: string } | undefined)?.Keywords;
    return decodePayload(kw);
  } catch {
    return null;
  }
}

// SongSelect repeats the title on continuation/footer pages with a page
// suffix ("This Is Amazing Grace - 2"). Strip it so a song's later pages
// don't look like a different song.
function stripPageSuffix(s: string): string {
  return s.replace(/\s*[-–]\s*\d{1,2}\s*$/, "");
}
function normTitle(s: string | null): string {
  return stripPageSuffix((s ?? "").toLowerCase().replace(/\s+/g, " ").trim()).trim();
}

const SECTION_KEYWORD_RE =
  /\b(INTRO|VERSE|CHORUS|PRE[- ]?CHORUS|BRIDGE|INSTRUMENTAL|INTERLUDE|TURNAROUND|TAG|OUTRO|ENDING|REFRAIN|VAMP)\b/i;

// A "song title – (Key)" masthead used by plain (non-SongSelect) chord PDFs,
// e.g. "One Way Jesus – (G)", "Here I Bow – (D)". The title text excludes
// "[" / "]" so it can't swallow an adjacent bracket section label.
const SONG_HEADER_RE =
  /([A-Za-z0-9][A-Za-z0-9'’&.,! ]{0,48}?)\s*[–—-]\s*\(([A-G](?:#|b)?)(m)?\)/;

// A row that's only bracketed section label(s): "[Verse 2]", "[Bridge] [x2]".
const BRACKET_SECTION_RE = /^(?:\[[^\]]+\]\s*)+$/;

function detectSongHeader(
  items: Item[],
): { title: string; key: string; mode: "major" | "minor" } | null {
  // Look near the top of the page (titles sit at/near the top).
  const top = [...items].sort((a, b) => b.y - a.y).slice(0, 16);
  const joined = top.map((i) => i.text).join(" ");
  const m = joined.match(SONG_HEADER_RE);
  if (!m) return null;
  const title = m[1].trim().replace(/\s+/g, " ");
  if (!title) return null;
  return {
    title,
    key: m[2][0].toUpperCase() + m[2].slice(1),
    mode: m[3] ? "minor" : "major",
  };
}

// A song's first page in a SongSelect-style bundle carries metadata: a
// "Key -"/"Tempo -" header and/or a CCLI/SongSelect footer.
function pageHasMasthead(pageItems: Item[]): boolean {
  if (detectKey(pageItems)) return true;
  return pageItems.some((it) =>
    /(CCLI|SongSelect|ccli\.com)/i.test(it.text),
  );
}

// Real song content (not just a repeated title + CCLI/copyright footer).
// SongSelect's trailing copyright page has only a handful of boilerplate
// items, so it must not be allowed to start a new song.
function pageHasSongContent(pageItems: Item[]): boolean {
  if (pageItems.some((it) => SECTION_KEYWORD_RE.test(it.text))) return true;
  const meaty = pageItems.filter(
    (it) =>
      it.text.trim().length > 0 &&
      !/(CCLI|SongSelect|ccli\.com|©|All rights reserved|Key\s*-|Tempo\s*-|Time\s*-)/i.test(
        it.text,
      ),
  );
  return meaty.length > 8;
}

// CCLI/publishing footer or a repeated "Title - N" page header that leaked
// into the body (used to trim trailing junk from continuation pages).
const FOOTER_LINE_RE =
  /(CCLI|SongSelect|ccli\.com|©|All rights reserved|Terms of Use|worshiptogether|Publishing|Music Services|Capitol\s*CMG|sixsteps|Be Essential|Bethel Music|Hillsong|Integrity|Essential Music|Used by permission|admin\.|\bLtd\b)/i;

function pagesToSheet(pages: Item[][]): Partial<ChordSheet> {
  const allItems = pages.flat();
  const lines: SheetLine[] = [];

  for (const rawPageItems of pages) {
    // Reattach superscript chord extensions ("F#m" + raised "7" -> "F#m7")
    // before any row grouping so they aren't mistaken for stray lyric lines.
    const pageItems = mergeSuperscripts(rawPageItems);
    // Two-column sheets must be read column-by-column; grouping purely by y
    // would interleave the left and right columns onto the same line.
    const columns = splitColumns(pageItems);
    for (let c = 0; c < columns.length; c++) {
      emitRows(groupRows(columns[c]), lines);
      if (c < columns.length - 1) lines.push({ kind: "blank", text: "" });
    }
    lines.push({ kind: "blank", text: "" });
  }

  // Drop the page masthead (repeated title, author, publishing credit) that
  // precedes the first section. These aren't headers in the "Key -"/CCLI
  // sense, so they'd otherwise leak in as lyrics before VERSE 1. Only trim
  // when a section actually exists, so section-less sheets keep all content.
  const firstSection = lines.findIndex((l) => l.kind === "section");
  if (firstSection > 0) lines.splice(0, firstSection);

  // Prefer a "Name – (Key)" masthead (plain chord PDFs); fall back to the
  // CCLI "Key -" line and the topmost text.
  const hdr = detectSongHeader(allItems);
  const keyInfo = hdr
    ? { key: hdr.key, mode: hdr.mode }
    : detectKey(allItems);
  const title = hdr?.title ?? detectTitle(allItems);
  const baseTitle = normTitle(title);

  // Trim trailing junk: blank lines, plus the CCLI/copyright footer and the
  // repeated "Title - N" page header that SongSelect puts on continuation
  // pages (these get appended after the real song once pages are merged).
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    const text = last.text.trim();
    const isFooter =
      last.kind === "blank" ||
      (last.kind !== "section" &&
        (FOOTER_LINE_RE.test(text) ||
          (!!baseTitle && normTitle(text) === baseTitle)));
    if (!isFooter) break;
    lines.pop();
  }

  return {
    title: title || "Untitled",
    key: keyInfo?.key || "C",
    mode: keyInfo?.mode || "major",
    lines,
  };
}

export async function parsePdfToSheet(file: File): Promise<Partial<ChordSheet>> {
  const pages = await extractItems(file);
  return pagesToSheet(pages);
}

/**
 * Split a multi-song PDF (e.g. a SongSelect set/bundle) into one sheet per
 * song. Pages are grouped by their masthead title: a page only starts a new
 * song when its top title differs AND it carries song metadata (Key-/CCLI),
 * so multi-page songs and non-SongSelect single songs stay intact. Returns
 * one entry when only a single song is detected.
 */
export async function parsePdfToSheets(
  file: File,
): Promise<Partial<ChordSheet>[]> {
  const pages = await extractItems(file);
  if (pages.length === 0) return [pagesToSheet(pages)];

  const groups: Item[][][] = [];
  let curTitle = "";
  for (const page of pages) {
    const items = mergeSuperscripts(page);
    const hdr = detectSongHeader(items);
    const t = normTitle(hdr?.title ?? detectTitle(items));
    // A page starts a new song when its title differs and it carries either a
    // SongSelect masthead (Key-/CCLI) OR a plain "Name – (Key)" masthead.
    const startsNew =
      groups.length === 0 ||
      (!!t &&
        t !== curTitle &&
        (pageHasMasthead(items) || !!hdr) &&
        pageHasSongContent(items));
    if (startsNew) {
      groups.push([page]);
      if (t) curTitle = t;
    } else {
      groups[groups.length - 1].push(page);
    }
  }

  return groups.map((g) => pagesToSheet(g));
}

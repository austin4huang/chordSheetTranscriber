// Visual PDF export for songs and sets. The PDF is a clean, human-readable
// chord sheet (chords above lyrics). The exact source data is also embedded
// in the PDF's /Keywords metadata so importing one of *our* PDFs round-trips
// losslessly (annotations, text notes, set order included). Foreign PDFs
// fall back to the heuristic parser in pdfParser.ts.

import { jsPDF } from "jspdf";
import { toPng } from "html-to-image";
import React from "react";
import { createRoot } from "react-dom/client";
import { type ChordSheet, isChordSheet } from "./types";
import { transposeChord, splitChords } from "./nashville";
import { SheetRenderer } from "../components/SheetRenderer";

const MARKER = "CHORDSHEETv1:";

export type EmbeddedPayload =
  | { v: 1; kind: "song"; sheet: ChordSheet }
  | { v: 1; kind: "set"; name: string; sheets: ChordSheet[] };

// UTF-8-safe base64 round-trip. The legacy `unescape(encodeURIComponent(...))`
// trick is deprecated and mis-handles some Unicode (notably emoji, lone
// surrogates); TextEncoder/TextDecoder do it correctly.
function utf8ToB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function encodePayload(obj: EmbeddedPayload): string {
  return MARKER + utf8ToB64(JSON.stringify(obj));
}

/** Decode an embedded payload from a PDF /Keywords string, or null if it
 *  isn't one of ours / is corrupt. */
export function decodePayload(keywords: string | null | undefined): EmbeddedPayload | null {
  if (!keywords || !keywords.startsWith(MARKER)) return null;
  try {
    const json = b64ToUtf8(keywords.slice(MARKER.length));
    const obj = JSON.parse(json);
    if (isEmbeddedPayload(obj)) return obj;
  } catch {
    /* fall through */
  }
  return null;
}

// Schema guard for embedded payloads. The PDF /Keywords field is attacker-
// controllable (someone could craft a PDF with a CHORDSHEETv1: header that
// claims to be a "song" but has malformed lines). The deep `isChordSheet`
// check from types.ts validates every line, so downstream code only ever
// sees well-formed sheets.
function isEmbeddedPayload(o: unknown): o is EmbeddedPayload {
  if (!o || typeof o !== "object") return false;
  const obj = o as { v?: unknown; kind?: unknown };
  if (obj.v !== 1) return false;
  if (obj.kind === "song") {
    return isChordSheet((obj as { sheet?: unknown }).sheet);
  }
  if (obj.kind === "set") {
    const s = obj as { name?: unknown; sheets?: unknown };
    return (
      typeof s.name === "string" &&
      Array.isArray(s.sheets) &&
      s.sheets.every(isChordSheet)
    );
  }
  return false;
}

// --- Layout -----------------------------------------------------------------

const PAGE_H = 792; // letter, pt
const PAGE_W = 612; // letter, pt
const MARGIN = 54;
const COL_GAP = 24;     // gutter between the two body columns
const BODY_FONT = 8.5;  // chords + lyrics — a touch smaller so lines fit a column
const LINE_H = 11;      // lyric row advance
const CHORD_H = 10;     // chord row advance (above a lyric)
const LINE_GAP = 3;     // extra breathing room after each text line
const SECTION_GAP = 11; // space before a section header
// Keep a section (its header + lines) whole in one column rather than splitting
// it to balance the two columns — but only when it fits within this fraction of
// a column's height. A taller section is allowed to flow across the break so it
// doesn't leave most of a column empty. Lower this to favor balance over
// togetherness; 1 keeps any section that fits a column intact.
const SECTION_KEEP_MAX_FRAC = 1;

// Chords print red, section labels blue, body text near-black.
function chordColor(doc: jsPDF) { doc.setTextColor(198, 40, 40); }
function sectionColor(doc: jsPDF) { doc.setTextColor(40, 90, 200); }
function bodyColor(doc: jsPDF) { doc.setTextColor(20); }

// True when a line is just the title again (case/spacing/punctuation-
// insensitive, ignoring any [chords]). Used to drop the duplicate title line
// some imports carry as the song's first lyric.
function sameAsTitle(title: string, lineText: string): boolean {
  const norm = (s: string) =>
    s.replace(/\[[^\]]*\]/g, "").replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
  const t = norm(title);
  return t.length > 0 && norm(lineText) === t;
}

// Transpose a bracket's chord(s) from the song key to the display key,
// mirroring SheetRenderer (exports never use number mode). Multi-chord
// brackets ("D G A") transpose each piece. We keep "#"/"b" as ASCII rather
// than ♯/♭ glyphs — the standard PDF Courier font doesn't carry those.
function xformChords(content: string, songKey: string, displayKey: string): string {
  if (songKey === displayKey) return content;
  try {
    const parts = splitChords(content);
    return parts
      ? parts.map((c) => transposeChord(c, songKey, displayKey)).join(" ")
      : transposeChord(content, songKey, displayKey);
  } catch {
    return content;
  }
}

// Transpose every chord token inside a "| D | G |" bar line (mirrors
// SheetRenderer.transformBarLine).
function xformBarLine(line: string, songKey: string, displayKey: string): string {
  if (songKey === displayKey) return line;
  return line.replace(/([A-G](?:#|b)?[A-Za-z0-9°+#b()/-]*)/g, (tok) => {
    try {
      const parts = splitChords(tok);
      return parts
        ? parts.map((c) => transposeChord(c, songKey, displayKey)).join(" ")
        : transposeChord(tok, songKey, displayKey);
    } catch {
      return tok;
    }
  });
}

// Split a ChordPro line into {chord, text} tokens: each token is a chunk of
// lyric with the chord (if any) that sits at its start. Mirrors
// SheetRenderer.tokenizeChordPro.
function tokenizeChordPro(line: string): { chord: string | null; text: string }[] {
  const tokens: { chord: string | null; text: string }[] = [];
  const re = /\[([^\]]+)\]/g;
  let last = 0;
  let pending: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const before = line.slice(last, m.index);
    if (before.length || pending) tokens.push({ chord: pending, text: before });
    pending = m[1];
    last = m.index + m[0].length;
  }
  const tail = line.slice(last);
  if (tail.length || pending) tokens.push({ chord: pending, text: tail });
  return tokens;
}

/**
 * Lay a ChordPro line out as one or more aligned (chord row, lyric row) pairs,
 * wrapping at word boundaries so nothing runs past `maxChars` monospace cells.
 * A chord stays glued to the word it sits above: if that word wraps to the next
 * line, its chord wraps with it. Chords print in the display (transposed) key.
 */
function wrapChordLine(
  line: string,
  songKey: string,
  displayKey: string,
  maxChars: number,
): { chords: string; lyric: string }[] {
  const rows: { chords: string; lyric: string }[] = [];
  let lyric = "";
  let chords = "";
  const flush = () => {
    rows.push({ chords: chords.replace(/\s+$/, ""), lyric });
    lyric = "";
    chords = "";
  };
  // Place a chord starting above column `col`, padding the chord row to reach
  // it and keeping a space between adjacent chords.
  const placeChord = (col: number, chord: string) => {
    if (chords.length > col) chords += " ";
    while (chords.length < col) chords += " ";
    chords += chord;
  };

  for (const tok of tokenizeChordPro(line)) {
    const chord = tok.chord ? xformChords(tok.chord, songKey, displayKey) : "";
    // Words and the whitespace between them, in order.
    const pieces = tok.text.match(/\s+|\S+/g) ?? [];
    let chordUsed = false;
    if (pieces.length === 0) {
      if (chord) placeChord(lyric.length, chord); // chord with no trailing text
      continue;
    }
    for (const piece of pieces) {
      if (/^\s+$/.test(piece)) {
        if (lyric.length > 0) lyric += piece; // never lead a wrapped row with spaces
        continue;
      }
      // A real word. Its chord (the token's, if not yet placed) travels with it,
      // so test the wrap *before* committing either.
      if (lyric.trimEnd().length > 0 && lyric.length + piece.length > maxChars) {
        flush();
      }
      if (chord && !chordUsed) {
        placeChord(lyric.length, chord);
        chordUsed = true;
      }
      lyric += piece;
    }
    if (chord && !chordUsed) placeChord(lyric.length, chord);
  }
  if (lyric.length || chords.length) flush();
  return rows.length ? rows : [{ chords: "", lyric: "" }];
}

/** Word-wrap a plain monospace line to at most `maxChars` cells per row,
 *  breaking only at spaces (so chord-only bar lines like "| E | A | B |" keep
 *  their tokens intact). A single word longer than the column is left as-is. */
function wrapText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const lines: string[] = [];
  let cur = "";
  for (const piece of text.match(/\s+|\S+/g) ?? []) {
    if (/^\s+$/.test(piece)) {
      if (cur.length > 0) cur += piece; // don't lead a wrapped row with spaces
      continue;
    }
    if (cur.trimEnd().length > 0 && cur.length + piece.length > maxChars) {
      lines.push(cur.replace(/\s+$/, ""));
      cur = "";
    }
    cur += piece;
  }
  if (cur.length) lines.push(cur.replace(/\s+$/, ""));
  return lines.length ? lines : [text];
}

function newDoc(): jsPDF {
  // `compress` FlateDecode-compresses the page content streams. For vector
  // text (chord sheets) that's a ~10× win and costs nothing; JPEG image data
  // is already compressed, so raster pages are unaffected.
  return new jsPDF({ unit: "pt", format: "letter", compress: true });
}

/** Render one song as two-column vector text. `y` is the top of the page-1
 *  header (the title + meta span the full width above the columns); the body
 *  then flows left column → right column → next page. Returns the final y.
 *
 *  Chords print in the chosen display (transposed) key, matching the on-screen
 *  renderer. Number mode is a view-only toggle and is never baked into an
 *  export, so it isn't applied here. */
function drawSheet(doc: jsPDF, sheet: ChordSheet, y: number): number {
  const displayKey = sheet.displayKey || sheet.key;
  const left = MARGIN;
  const bottom = PAGE_H - MARGIN;
  const colW = (PAGE_W - MARGIN * 2 - COL_GAP) / 2;

  // --- Full-width header (first page only) ---
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  bodyColor(doc);
  doc.text(sheet.title || "Untitled", left, y);
  y += 22;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(110);
  const meta = [
    `Key ${displayKey}${sheet.mode === "minor" ? "m" : ""}`,
    sheet.artist || null,
    sheet.tempo ? `${sheet.tempo} bpm` : null,
    sheet.time || null,
  ]
    .filter(Boolean)
    .join("   ·   ");
  if (meta) {
    doc.text(meta, left, y);
    y += 16;
  } else {
    y += 6;
  }
  bodyColor(doc);

  const colTop = y + 8; // columns begin just below the header (page 1)

  // Drop a leading line that merely repeats the title (and any blank after it).
  let lines = sheet.lines;
  const first = lines.findIndex((l) => l.kind !== "blank");
  if (first >= 0 && sameAsTitle(sheet.title, lines[first].text)) {
    let cut = first + 1;
    while (cut < lines.length && lines[cut].kind === "blank") cut++;
    lines = lines.slice(cut);
  }

  // Monospace cells that fit one column, used to wrap long lyric/chord lines.
  doc.setFont("courier", "normal");
  doc.setFontSize(BODY_FONT);
  const charW = doc.getTextWidth("0123456789") / 10;
  const maxChars = Math.max(8, Math.floor(colW / charW));

  // --- Pass 1: turn each line into a self-contained, measurable block. Each
  // block knows its height and how to paint itself at a given (x, top), so the
  // layout pass can place it anywhere without re-deriving geometry. A block's
  // first text baseline sits at `top`; later rows are offset down from there.
  interface Block {
    h: number;
    blank?: boolean;
    section?: boolean;
    draw: (x: number, top: number) => void;
  }
  const blocks: Block[] = [];
  for (const ln of lines) {
    if (ln.kind === "blank") {
      blocks.push({ h: LINE_H * 0.6, blank: true, draw: () => {} });
    } else if (ln.kind === "section") {
      const label = ln.text.toUpperCase();
      blocks.push({
        h: SECTION_GAP + LINE_H + LINE_GAP,
        section: true,
        draw: (x, top) => {
          doc.setFont("courier", "bold");
          doc.setFontSize(BODY_FONT + 1);
          sectionColor(doc);
          doc.text(label, x, top + SECTION_GAP);
          bodyColor(doc);
        },
      });
    } else if (ln.kind === "comment") {
      const wrapped = wrapText(ln.text.replace(/^#\s?/, ""), maxChars);
      blocks.push({
        h: wrapped.length * LINE_H + LINE_GAP,
        draw: (x, top) => {
          doc.setFont("courier", "italic");
          doc.setFontSize(BODY_FONT);
          doc.setTextColor(130);
          let yy = top;
          for (const w of wrapped) { doc.text(w, x, yy); yy += LINE_H; }
          bodyColor(doc);
        },
      });
    } else if (ln.kind === "chord-only") {
      const wrapped = wrapText(xformBarLine(ln.text, sheet.key, displayKey), maxChars);
      blocks.push({
        h: wrapped.length * CHORD_H + LINE_GAP,
        draw: (x, top) => {
          doc.setFont("courier", "bold");
          doc.setFontSize(BODY_FONT);
          chordColor(doc);
          let yy = top;
          for (const w of wrapped) { doc.text(w, x, yy); yy += CHORD_H; }
          bodyColor(doc);
        },
      });
    } else {
      // chordpro: one or more wrapped (chord row, lyric row) pairs, kept
      // together as a single block so a wrapped line never splits across columns
      const rows = wrapChordLine(ln.text, sheet.key, displayKey, maxChars);
      const h =
        rows.reduce((s, r) => s + (r.chords ? CHORD_H : 0) + LINE_H, 0) + LINE_GAP;
      blocks.push({
        h,
        draw: (x, top) => {
          doc.setFontSize(BODY_FONT);
          let yy = top;
          for (const r of rows) {
            if (r.chords) {
              doc.setFont("courier", "bold");
              chordColor(doc);
              doc.text(r.chords, x, yy);
              yy += CHORD_H;
            }
            doc.setFont("courier", "normal");
            bodyColor(doc);
            doc.text(r.lyric || " ", x, yy);
            yy += LINE_H;
          }
        },
      });
    }
  }

  // --- Pass 2: place the blocks into two columns.
  //
  // `capColumn` is one column's usable height (uniform, using the header-
  // shortened page-1 height so nothing ever overflows). `columnsNeeded(H)`
  // greedily packs the blocks into columns no taller than H and counts them.
  //
  // First find the fewest columns the content actually needs at full capacity,
  // hence the fewest pages. Then:
  //  • One page → balance: shrink the per-column height to the smallest that
  //    still fits in 2 columns, so a short song splits evenly instead of
  //    cramming column 1 and leaving column 2 empty.
  //  • Multiple pages → fill each column to capacity (page-by-page, like the
  //    on-screen renderer's columns), so earlier pages are full and only the
  //    last page is short — no half-empty pages.
  const capColumn = bottom - colTop;

  // Group each section header with the lines under it (until the next header);
  // content before the first header is its own group. Packing prefers to keep a
  // group whole in one column instead of splitting it for balance.
  const groups: Block[][] = [];
  for (const b of blocks) {
    if (b.section || groups.length === 0) groups.push([]);
    groups[groups.length - 1].push(b);
  }
  const keepWholeMax = SECTION_KEEP_MAX_FRAC * capColumn;

  // Pack the groups into columns no taller than `H`. A group that fits within
  // `keepWholeMax` stays in one column (jumping to the next if it won't fit the
  // remaining space); a taller group flows block-by-block across the break.
  // Returns each block tagged with its column index and offset from the column
  // top. `H` only bounds where breaks happen — a kept-whole group placed in a
  // fresh column may exceed `H` but never `capColumn`, so it can't overflow.
  interface Placed { block: Block; column: number; top: number; }
  const pack = (H: number): Placed[] => {
    const out: Placed[] = [];
    let column = 0;
    let used = 0;
    const emit = (b: Block) => {
      if (used === 0 && b.blank) return; // never start a column with blank space
      out.push({ block: b, column, top: used });
      used += b.h;
    };
    for (const g of groups) {
      const gh = g.reduce((s, b) => s + b.h, 0);
      if (gh <= keepWholeMax) {
        if (used > 0 && used + gh > H) { column++; used = 0; }
        for (const b of g) emit(b);
      } else {
        for (const b of g) {
          if (used > 0 && used + b.h > H) { column++; used = 0; }
          emit(b);
        }
      }
    }
    return out;
  };
  const columnCount = (H: number): number => {
    const p = pack(H);
    return p.length ? p[p.length - 1].column + 1 : 1;
  };

  // Fewest columns (hence pages) at full capacity. One page → balance by
  // shrinking the per-column height to the smallest that still fits two
  // columns; multiple pages → fill to capacity page-by-page.
  const pages = Math.max(1, Math.ceil(columnCount(capColumn) / 2));
  let target = capColumn;
  if (pages === 1) {
    let lo = 0;
    let hi = capColumn;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (columnCount(mid) <= 2) hi = mid;
      else lo = mid;
    }
    target = hi;
  }

  // Draw: map each global column index to its page/side and absolute top.
  let curPage = 0;
  for (const pl of pack(target)) {
    const page = Math.floor(pl.column / 2);
    while (curPage < page) { doc.addPage(); curPage++; }
    const x = left + (pl.column % 2) * (colW + COL_GAP);
    pl.block.draw(x, (page === 0 ? colTop : MARGIN) + pl.top);
  }
  return colTop;
}

function triggerDownload(doc: jsPDF, filename: string) {
  const blob = doc.output("blob");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeName(s: string): string {
  return (s.trim() || "Untitled").replace(/[^\w.\- ]+/g, "_").slice(0, 80);
}

export function exportSongPdf(sheet: ChordSheet) {
  const doc = newDoc();
  drawSheet(doc, sheet, MARGIN);
  doc.setProperties({
    title: sheet.title,
    subject: "Chord sheet",
    keywords: encodePayload({ v: 1, kind: "song", sheet }),
  });
  triggerDownload(doc, `${safeName(sheet.title)}.pdf`);
}

export function exportSetPdf(name: string, sheets: ChordSheet[]) {
  const doc = newDoc();
  let first = true;
  for (const sheet of sheets) {
    if (!first) doc.addPage();
    first = false;
    drawSheet(doc, sheet, MARGIN);
  }
  if (sheets.length === 0) {
    doc.setFontSize(12);
    doc.text(`Set "${name}" (empty)`, MARGIN, MARGIN + 20);
  }
  doc.setProperties({
    title: name,
    subject: "Chord-sheet set",
    keywords: encodePayload({ v: 1, kind: "set", name, sheets }),
  });
  triggerDownload(doc, `${safeName(name)}.pdf`);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Rasterize the live rendered sheet node (so it captures exactly what the
 * editor shows: chords vs numbers, the current display key, freehand strokes
 * and text boxes) into a paginated PDF. The canonical sheet data is still
 * embedded for lossless reimport.
 */
export async function exportRenderedPdf(
  node: HTMLElement,
  sheet: ChordSheet,
): Promise<void> {
  // The sheet box is its own scroll container, so by default html-to-image
  // would only grab the visible portion. Temporarily expand it to its full
  // content height so the whole song is captured. Doing this on the live
  // node lets the AnnotationLayer's ResizeObserver re-fit the stroke overlay
  // to the full height, keeping annotations aligned.
  const s = node.style;
  const saved = {
    overflow: s.overflow,
    height: s.height,
    maxHeight: s.maxHeight,
    width: s.width,
  };
  // Pin the current width so the multi-column layout (column count) doesn't
  // change while we let the height grow.
  s.width = `${node.clientWidth}px`;
  s.overflow = "visible";
  s.maxHeight = "none";
  s.height = "auto";
  // Let layout settle and the ResizeObserver-driven SVG overlay resize.
  await new Promise<void>((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r())),
  );
  await new Promise<void>((r) => setTimeout(r, 60));

  let dataUrl: string;
  try {
    dataUrl = await toPng(node, {
      pixelRatio: 1.5,
      backgroundColor: "#ffffff",
      width: node.scrollWidth,
      height: node.scrollHeight,
      // The annotation toolbar is editing chrome — never include it.
      filter: (n) =>
        !(n instanceof Element && n.classList?.contains("anno-toolbar")),
    });
  } finally {
    s.overflow = saved.overflow;
    s.height = saved.height;
    s.maxHeight = saved.maxHeight;
    s.width = saved.width;
  }
  const img = await loadImage(dataUrl);

  const doc = newDoc();
  paginateImageInto(doc, img, false);

  doc.setProperties({
    title: sheet.title,
    subject: "Chord sheet",
    keywords: encodePayload({ v: 1, kind: "song", sheet }),
  });
  triggerDownload(doc, `${safeName(sheet.title)}.pdf`);
}

// --- Off-screen rendering (used by per-song list export + set export) ------
// Mount SheetRenderer into a hidden DOM node so we can capture the same
// visuals you see in the editor preview (chords/annotations/key/etc.) even
// when the song isn't currently open.

// Wide enough for the renderer to flow into 2 columns (`.sr-body` uses
// column-width: 26rem ≈ 416 px + a 2.5rem gap, so it needs ~870 px+). The
// captured image is then scaled to fit the PDF's content width, which makes
// the text proportionally smaller but fits more song per page.
const OFFSCREEN_WIDTH = 1100;

async function renderSheetToPng(sheet: ChordSheet): Promise<string> {
  const container = document.createElement("div");
  container.className = "pdf-export-host";
  container.style.cssText =
    `position: fixed; left: -99999px; top: 0; width: ${OFFSCREEN_WIDTH}px;` +
    " background: #ffffff; padding: 0; z-index: -1; pointer-events: none;";
  document.body.appendChild(container);
  // Scoped overrides so the export matches the clean "presenting" look: no
  // sheet-card border / padding / min-height (kills the trailing whitespace
  // on short songs) and no text-box borders or resize handles (editing
  // chrome shouldn't appear in the PDF). Lives in <head> so React's render
  // doesn't strip it out of the container.
  const styleEl = document.createElement("style");
  styleEl.dataset.pdfExport = "1";
  styleEl.textContent = `
    .pdf-export-host .sheet-render {
      border: none;
      border-radius: 0;
      padding: 1rem 1.25rem;
      min-height: 0;
      background: #fff;
    }
    .pdf-export-host .anno-textbox,
    .pdf-export-host .anno-text {
      border: none !important;
      outline: none !important;
      box-shadow: none !important;
      background: transparent !important;
    }
    .pdf-export-host .anno-resize { display: none !important; }
  `;
  document.head.appendChild(styleEl);
  const root = createRoot(container);
  try {
    root.render(
      React.createElement(SheetRenderer, {
        sheet,
        numberMode: false,
        displayKey: sheet.displayKey || sheet.key,
        annotations: sheet.annotations ?? [],
        onAnnotationsChange: () => {},
        texts: sheet.texts ?? [],
        onTextsChange: () => {},
        annoRef: sheet.annoRef ?? null,
      }),
    );
    // Let React commit, fonts settle, the AnnotationLayer's ResizeObserver
    // measure line rects, and the SVG stroke overlay size itself.
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
    await new Promise<void>((r) => setTimeout(r, 180));
    const node = container.firstElementChild as HTMLElement | null;
    if (!node) throw new Error("Off-screen sheet didn't mount");
    return await toPng(node, {
      pixelRatio: 1.5,
      backgroundColor: "#ffffff",
      width: node.scrollWidth,
      height: node.scrollHeight,
      filter: (n) =>
        !(n instanceof Element && n.classList?.contains("anno-toolbar")),
    });
  } finally {
    root.unmount();
    container.remove();
    styleEl.remove();
  }
}

// How aggressively a rasterized page is encoded. `quality` is the JPEG
// quality (0–1); `resScale` shrinks the stored pixel resolution (1 = native,
// 0.5 = half on each axis → ¼ the pixels). The page's *layout* size in the
// PDF is unaffected — only fidelity/byte-size changes.
interface PageEncoding {
  quality: number;
  resScale: number;
}
const DEFAULT_ENCODING: PageEncoding = { quality: 0.85, resScale: 1 };

// Slice the source image into per-page bands and add each as its own image,
// rather than offsetting one tall image (which bleeds into the page margins
// and duplicates ~24pt of content at every page break).
function paginateImageInto(
  doc: jsPDF,
  img: HTMLImageElement,
  startNewPage: boolean,
  enc: PageEncoding = DEFAULT_ENCODING,
): boolean {
  const { quality, resScale } = enc;
  const margin = 24;
  const contentW = 612 - margin * 2;
  const contentH = PAGE_H - margin * 2;
  const scale = contentW / img.naturalWidth; // pt per source px
  const srcSliceH = contentH / scale;        // source px per full page
  const src = document.createElement("canvas");
  src.width = img.naturalWidth;
  src.height = img.naturalHeight;
  src.getContext("2d")!.drawImage(img, 0, 0);
  const pages = Math.max(1, Math.ceil(img.naturalHeight / srcSliceH));
  for (let i = 0; i < pages; i++) {
    const yStart = i * srcSliceH;
    const sliceH = Math.min(srcSliceH, img.naturalHeight - yStart);
    const slice = document.createElement("canvas");
    // Down-rez the stored pixels (resScale) while keeping the same on-page
    // footprint. Fewer pixels → far smaller JPEG, the strongest lever we have.
    slice.width = Math.max(1, Math.round(img.naturalWidth * resScale));
    slice.height = Math.max(1, Math.round(sliceH * resScale));
    // Fill white first so JPEG (no alpha) doesn't render any transparent
    // pixels as black bands.
    const sctx = slice.getContext("2d")!;
    sctx.fillStyle = "#ffffff";
    sctx.fillRect(0, 0, slice.width, slice.height);
    // Copy just this page's band of the source, scaled into the slice canvas.
    sctx.drawImage(
      src,
      0, yStart, img.naturalWidth, sliceH,
      0, 0, slice.width, slice.height,
    );
    // JPEG compresses chord-sheet pages (mostly white + text) ~5–10× smaller
    // than PNG; lower quality trades crispness for size when we need to fit a
    // byte budget (see fitToBudget).
    const url = slice.toDataURL("image/jpeg", quality);
    const drawH = sliceH * scale; // ≤ contentH
    if (startNewPage || i > 0) doc.addPage();
    startNewPage = true;
    doc.addImage(url, "JPEG", margin, margin, contentW, drawH);
  }
  return startNewPage;
}

// --- Size targeting ---------------------------------------------------------
// Rasterized pages add up fast: each one is its own JPEG, so a handful of them
// can blow past a couple hundred KB at full quality. To keep exports portable
// (email attachments, upload limits) we cap the *actual* output blob at
// ~200 KB. Measuring the real blob — not an estimate — means the embedded
// lossless payload and PDF structure are counted too, so the ceiling holds.
// Vector-text pages are tiny and never hit this; it only bites raster pages.

// ~195 KiB (199,680 bytes): comfortably under 200 KB by either the KB or KiB
// reading, with a little headroom.
const SIZE_TARGET_BYTES = 195 * 1024;

// Search bounds. We never exceed the long-standing 0.85 default, and won't
// drop JPEG quality below 0.3 (text stays legible); past that we down-rez
// instead, which preserves edges better than very low JPEG quality.
const Q_MAX = 0.85;
const Q_MIN = 0.3;
const RES_STEPS = [1, 0.8, 0.65, 0.5];

function docBytes(doc: jsPDF): number {
  return doc.output("blob").size;
}

/**
 * Build the smallest-quality-loss PDF that still fits `target` bytes.
 *
 * `build(enc)` must produce a complete jsPDF (pages + metadata) at the given
 * encoding. We try progressively lower resolutions; at each resolution we
 * binary-search JPEG quality for the highest value that fits. The very first
 * attempt is full quality/resolution, so small sets (the common case) pay just
 * one build. If nothing fits — e.g. a giant set whose embedded payload alone
 * exceeds the target — we return the smallest variant we produced.
 */
function fitToBudget(
  build: (enc: PageEncoding) => jsPDF,
  target: number,
): jsPDF {
  let smallest: { doc: jsPDF; bytes: number } | null = null;
  const consider = (doc: jsPDF): number => {
    const bytes = docBytes(doc);
    if (!smallest || bytes < smallest.bytes) smallest = { doc, bytes };
    return bytes;
  };

  for (const resScale of RES_STEPS) {
    // Best case first: top quality at this resolution.
    const top = build({ quality: Q_MAX, resScale });
    if (consider(top) <= target) return top;

    // Top quality overflows — binary-search downward for the best fit.
    let lo = Q_MIN;
    let hi = Q_MAX;
    let fit: jsPDF | null = null;
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      const doc = build({ quality: mid, resScale });
      if (consider(doc) <= target) {
        fit = doc;
        lo = mid; // try to claw back quality
      } else {
        hi = mid; // still too big
      }
    }
    if (fit) return fit;
    // Even Q_MIN overflowed at this resolution; drop to the next one.
  }
  // Nothing fit the budget; hand back the smallest we managed to build.
  return smallest!.doc;
}

/** Per-song download that matches the editor preview (annotations, key,
 *  formatting) and embeds the lossless payload — the rendered analogue of
 *  the older text-based `exportSongPdf`. */
export async function exportSongRenderedPdf(sheet: ChordSheet): Promise<void> {
  // Clean songs draw as crisp vector text (a few KB); only a song with pen
  // strokes / text notes needs the rasterized capture, which then gets
  // squeezed under the size budget. Mirrors the set export's hybrid choice.
  const img = needsRaster(sheet)
    ? await loadImage(await renderSheetToPng(sheet))
    : null;
  const build = (enc: PageEncoding): jsPDF => {
    const doc = newDoc();
    if (img) paginateImageInto(doc, img, false, enc);
    else drawSheet(doc, sheet, MARGIN);
    doc.setProperties({
      title: sheet.title,
      subject: "Chord sheet",
      keywords: encodePayload({ v: 1, kind: "song", sheet }),
    });
    return doc;
  };
  triggerDownload(fitToBudget(build, SIZE_TARGET_BYTES), `${safeName(sheet.title)}.pdf`);
}

/** A song needs rasterizing only if it carries freehand strokes or text-note
 *  overlays — the one thing vector text can't reproduce. Everything else
 *  (chords, lyrics, transposed key) draws as real text. */
function needsRaster(sheet: ChordSheet): boolean {
  return (sheet.annotations?.length ?? 0) > 0 || (sheet.texts?.length ?? 0) > 0;
}

/** Set download = the songs concatenated into one PDF (page break between
 *  songs), embedding the full set payload for lossless reimport.
 *
 *  Songs without annotations are drawn as real vector text — a whole set of
 *  them stays in the tens of KB because the pages share the standard PDF fonts
 *  (nothing is embedded) instead of being one fat JPEG each. Only songs that
 *  actually have pen strokes / text notes fall back to the rasterized capture,
 *  and just those pages are squeezed under the size budget by trading JPEG
 *  quality (then resolution) for bytes — see `fitToBudget`. Rasterizing is the
 *  expensive step, so we do it once up front for just the songs that need it
 *  and reuse the cached images across the budget search. */
export async function exportSetRenderedPdf(
  name: string,
  sheets: ChordSheet[],
): Promise<void> {
  // Pre-rasterize only the annotated songs, keyed by their index in the set.
  const imgs = new Map<number, HTMLImageElement>();
  for (let i = 0; i < sheets.length; i++) {
    if (needsRaster(sheets[i])) {
      imgs.set(i, await loadImage(await renderSheetToPng(sheets[i])));
    }
  }

  const build = (enc: PageEncoding): jsPDF => {
    const doc = newDoc();
    let started = false; // has any content been placed yet?
    sheets.forEach((sheet, i) => {
      const img = imgs.get(i);
      if (img) {
        started = paginateImageInto(doc, img, started, enc);
      } else {
        if (started) doc.addPage(); // each song starts on a fresh page
        drawSheet(doc, sheet, MARGIN);
        started = true;
      }
    });
    if (!started) {
      doc.setFontSize(12);
      doc.text(`Set "${name}" (empty)`, 24, 44);
    }
    doc.setProperties({
      title: name,
      subject: "Chord-sheet set",
      keywords: encodePayload({ v: 1, kind: "set", name, sheets }),
    });
    return doc;
  };

  // All-vector sets are already tiny, so the first (full-quality) build wins
  // immediately; the search only does real work when raster pages are present.
  triggerDownload(fitToBudget(build, SIZE_TARGET_BYTES), `${safeName(name)}.pdf`);
}

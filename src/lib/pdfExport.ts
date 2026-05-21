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
const MARGIN = 54;
const BODY_FONT = 9.5;
const LINE_H = 12; // lyric row
const CHORD_H = 11; // chord row above a lyric
const SECTION_GAP = 10;

/** Split a ChordPro line into an aligned chord row and lyric row. */
function chordProToRows(line: string): { chords: string; lyric: string } {
  const re = /\[([^\]]+)\]/g;
  let lyric = "";
  let chords = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    lyric += line.slice(last, m.index);
    while (chords.length < lyric.length) chords += " ";
    chords += m[1] + " ";
    last = m.index + m[0].length;
  }
  lyric += line.slice(last);
  return { chords: chords.replace(/\s+$/, ""), lyric };
}

function newDoc(): jsPDF {
  return new jsPDF({ unit: "pt", format: "letter" });
}

/** Render one song starting at `y`; returns the y after it. Adds pages as
 *  needed. `startPage` forces a page break before the song (used for sets). */
function drawSheet(doc: jsPDF, sheet: ChordSheet, y: number): number {
  const bottom = PAGE_H - MARGIN;
  const ensure = (need: number) => {
    if (y + need > bottom) {
      doc.addPage();
      y = MARGIN;
    }
  };

  // Header
  ensure(40);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.text(sheet.title || "Untitled", MARGIN, y);
  y += 20;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(110);
  const meta = [
    `Key ${sheet.key}${sheet.mode === "minor" ? "m" : ""}`,
    sheet.artist ? sheet.artist : null,
    sheet.tempo ? `${sheet.tempo} bpm` : null,
    sheet.time ? sheet.time : null,
  ]
    .filter(Boolean)
    .join("   ·   ");
  if (meta) {
    doc.text(meta, MARGIN, y);
    y += 16;
  } else {
    y += 6;
  }
  doc.setTextColor(20);

  for (const ln of sheet.lines) {
    if (ln.kind === "blank") {
      y += LINE_H * 0.6;
      continue;
    }
    if (ln.kind === "section") {
      ensure(SECTION_GAP + CHORD_H);
      y += SECTION_GAP;
      doc.setFont("courier", "bold");
      doc.setFontSize(BODY_FONT + 1);
      doc.setTextColor(40, 90, 200);
      doc.text(ln.text.toUpperCase(), MARGIN, y);
      doc.setTextColor(20);
      y += LINE_H + 2;
      continue;
    }
    if (ln.kind === "comment") {
      ensure(LINE_H);
      doc.setFont("courier", "italic");
      doc.setFontSize(BODY_FONT);
      doc.setTextColor(130);
      doc.text(ln.text.replace(/^#\s?/, ""), MARGIN, y);
      doc.setTextColor(20);
      y += LINE_H;
      continue;
    }
    if (ln.kind === "chord-only") {
      ensure(CHORD_H);
      doc.setFont("courier", "bold");
      doc.setFontSize(BODY_FONT);
      doc.setTextColor(40, 90, 200);
      doc.text(ln.text, MARGIN, y);
      doc.setTextColor(20);
      y += CHORD_H;
      continue;
    }
    // chordpro
    const { chords, lyric } = chordProToRows(ln.text);
    if (chords) {
      ensure(CHORD_H + LINE_H);
      doc.setFont("courier", "bold");
      doc.setFontSize(BODY_FONT);
      doc.setTextColor(40, 90, 200);
      doc.text(chords, MARGIN, y);
      y += CHORD_H;
      doc.setTextColor(20);
    } else {
      ensure(LINE_H);
    }
    doc.setFont("courier", "normal");
    doc.setFontSize(BODY_FONT);
    doc.text(lyric || " ", MARGIN, y);
    y += LINE_H;
  }
  return y;
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

// Slice the source image into per-page bands and add each as its own image,
// rather than offsetting one tall image (which bleeds into the page margins
// and duplicates ~24pt of content at every page break).
function paginateImageInto(
  doc: jsPDF,
  img: HTMLImageElement,
  startNewPage: boolean,
): boolean {
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
    slice.width = img.naturalWidth;
    slice.height = Math.max(1, Math.round(sliceH));
    // Fill white first so JPEG (no alpha) doesn't render any transparent
    // pixels as black bands.
    const sctx = slice.getContext("2d")!;
    sctx.fillStyle = "#ffffff";
    sctx.fillRect(0, 0, slice.width, slice.height);
    sctx.drawImage(src, 0, -yStart);
    // JPEG at 0.85 quality compresses chord-sheet pages (mostly white + text)
    // ~5–10× smaller than PNG with no visible loss.
    const url = slice.toDataURL("image/jpeg", 0.85);
    const drawH = sliceH * scale; // ≤ contentH
    if (startNewPage || i > 0) doc.addPage();
    startNewPage = true;
    doc.addImage(url, "JPEG", margin, margin, contentW, drawH);
  }
  return startNewPage;
}

/** Per-song download that matches the editor preview (annotations, key,
 *  formatting) and embeds the lossless payload — the rendered analogue of
 *  the older text-based `exportSongPdf`. */
export async function exportSongRenderedPdf(sheet: ChordSheet): Promise<void> {
  const dataUrl = await renderSheetToPng(sheet);
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

/** Set download = each song captured the same way an individual download is,
 *  concatenated into one PDF (with page breaks between songs). Embeds the
 *  full set payload for lossless reimport. */
export async function exportSetRenderedPdf(
  name: string,
  sheets: ChordSheet[],
): Promise<void> {
  const doc = newDoc();
  let started = false;
  for (const sheet of sheets) {
    const dataUrl = await renderSheetToPng(sheet);
    const img = await loadImage(dataUrl);
    started = paginateImageInto(doc, img, started);
  }
  if (!started) {
    doc.setFontSize(12);
    doc.text(`Set "${name}" (empty)`, 24, 44);
  }
  doc.setProperties({
    title: name,
    subject: "Chord-sheet set",
    keywords: encodePayload({ v: 1, kind: "set", name, sheets }),
  });
  triggerDownload(doc, `${safeName(name)}.pdf`);
}

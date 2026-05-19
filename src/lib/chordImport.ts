// Import chord charts from Ultimate-Guitar.
//
// This app is a client-only SPA, so it can't fetch ug.com directly (CORS +
// bot protection). We try a couple of public CORS proxies; if those fail the
// user can paste the page source ("View Source" → copy) or the raw tab text
// instead — all three inputs are accepted by importChords().
//
// NOTE: chord charts are copyrighted. This is for personal use where the user
// holds the appropriate licence (e.g. CCLI). UG content is also crowd-sourced
// and frequently inaccurate — treat every import as a draft to verify.

import type { ChordSheet, SheetLine } from "./types";

export interface ImportedSheet {
  title: string;
  artist?: string;
  key: string;
  mode: "major" | "minor";
  lines: SheetLine[];
}

const PROXIES = [
  (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u: string) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
];

const SECTION_WORDS =
  /^(intro|verse|pre[- ]?chorus|chorus|bridge|tag|outro|ending|interlude|instrumental|refrain|vamp|turnaround|hook|breakdown|solo|coda)\b/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/gi, "/")
    .replace(/&amp;/g, "&");
}

async function fetchPageHtml(url: string): Promise<string> {
  let lastErr: unknown = null;
  for (const wrap of PROXIES) {
    try {
      const res = await fetch(wrap(url));
      if (!res.ok) continue;
      const text = await res.text();
      if (text && text.includes("js-store")) return text;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    "Couldn't fetch the page (the proxy may be down or the site blocked it). " +
      "Open the song in your browser, use View → Page Source, and paste the " +
      "source here instead.",
    { cause: lastErr },
  );
}

/** Pull Ultimate-Guitar's embedded JSON store out of page HTML. */
function extractUgStore(html: string): any | null {
  const m = html.match(/class="js-store"\s+data-content="([^"]*)"/);
  if (!m) return null;
  try {
    return JSON.parse(decodeEntities(m[1]));
  } catch {
    return null;
  }
}

/** Merge a UG chord line (with [ch]…[/ch]) onto the following lyric line as
 *  inline ChordPro: "[G]I see the [Em]King". */
function mergeChordLine(chordRaw: string, lyric: string): string {
  const chords: { pos: number; name: string }[] = [];
  let col = 0;
  let i = 0;
  while (i < chordRaw.length) {
    if (chordRaw.startsWith("[ch]", i)) {
      const end = chordRaw.indexOf("[/ch]", i);
      if (end === -1) break;
      const name = chordRaw.slice(i + 4, end).trim();
      if (name) chords.push({ pos: col, name });
      col += name.length;
      i = end + 5;
    } else {
      col++;
      i++;
    }
  }
  let lyr = lyric;
  let out = "";
  let cursor = 0;
  for (const c of chords) {
    const p = c.pos;
    if (p > lyr.length) lyr = lyr.padEnd(p);
    out += lyr.slice(cursor, p) + `[${c.name}]`;
    cursor = p;
  }
  out += lyr.slice(cursor);
  return out;
}

const stripCh = (s: string) => s.replace(/\[\/?ch\]/g, "");
const hasCh = (s: string) => s.includes("[ch]");
const hasLetters = (s: string) => /[A-Za-z]/.test(stripCh(s));

/** Convert a UG `wiki_tab.content` string into ChordPro SheetLines. */
function ugContentToLines(content: string): SheetLine[] {
  const raw = content
    .replace(/\r\n/g, "\n")
    .replace(/\[\/?tab\]/g, "")
    .split("\n");
  const lines: SheetLine[] = [];

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].replace(/\s+$/, "");
    const trimmed = line.trim();

    if (!trimmed) {
      lines.push({ kind: "blank", text: "" });
      continue;
    }

    // Section header: "[Verse 1]" / "Chorus:" / "PRE-CHORUS"
    const bracket = trimmed.match(/^\[([^\]]+)\]$/);
    if (bracket && !hasCh(trimmed) && SECTION_WORDS.test(bracket[1].trim())) {
      lines.push({ kind: "section", text: bracket[1].trim() });
      continue;
    }
    if (!hasCh(trimmed)) {
      const bare = trimmed.replace(/:$/, "");
      if (SECTION_WORDS.test(bare) && bare.length <= 24 && !/\s{2,}/.test(bare)) {
        lines.push({ kind: "section", text: bare });
        continue;
      }
    }

    if (hasCh(line)) {
      const isChordOnly = !stripCh(line).replace(/[^\S].*/, "").trim()
        ? true
        : !/[a-z]{2,}/.test(stripCh(line)); // no real words ⇒ chord row
      const next = raw[i + 1] ?? "";
      const nextIsLyric =
        next.trim() && !hasCh(next) && hasLetters(next) && !SECTION_WORDS.test(next.trim());
      if (isChordOnly && nextIsLyric) {
        lines.push({ kind: "chordpro", text: mergeChordLine(line, next) });
        i++; // consumed the lyric line
      } else if (isChordOnly) {
        // Standalone chord row (riff/turnaround) — keep spacing.
        lines.push({ kind: "chord-only", text: stripCh(line) });
      } else {
        // Chords already inline with words on one line.
        lines.push({ kind: "chordpro", text: stripCh(line) });
      }
      continue;
    }

    // Plain lyric line.
    lines.push({ kind: "chordpro", text: line });
  }

  while (lines.length && lines[0].kind === "blank") lines.shift();
  while (lines.length && lines.at(-1)!.kind === "blank") lines.pop();
  return lines;
}

function parseTonality(t: string | undefined): {
  key: string;
  mode: "major" | "minor";
} {
  const m = (t ?? "").trim().match(/^([A-G][#b]?)(m)?$/);
  if (!m) return { key: "C", mode: "major" };
  return { key: m[1], mode: m[2] ? "minor" : "major" };
}

function fromUgStore(store: any): ImportedSheet | null {
  const data = store?.store?.page?.data;
  const tab = data?.tab ?? data?.tab_view?.meta;
  const content: string | undefined = data?.tab_view?.wiki_tab?.content;
  if (!content) return null;
  const { key, mode } = parseTonality(
    data?.tab_view?.meta?.tonality ?? tab?.tonality_name,
  );
  return {
    title: tab?.song_name || data?.tab?.song_name || "Imported song",
    artist: tab?.artist_name || data?.tab?.artist_name || undefined,
    key,
    mode,
    lines: ugContentToLines(content),
  };
}

// --- "interleaved" web-copy format -----------------------------------------
// Worship-site copies put each chord on its own line, splitting it into the
// lyric ("Falling down in w" / "Db" / "orship"). Sections are bare lines and
// there may be a "| Gb / / Bbm |" style bar line.

const INTERLEAVED_CHORD =
  /^[A-G](?:#|b)?(?:m|maj|min|dim|aug|sus|add)*\d*(?:\([^)]*\))?(?:sus)?\d*(?:\/[A-G](?:#|b)?)?$/;

const INTERLEAVED_SECTION =
  /^(intro|verses?|pre[\s-]?chorus|chorus|half[\s-]?chorus|bridge|tag|outro|ending|interlude|instrumental|refrain|vamp|turnaround|hook|coda|repeat)\b/i;

function isInterleavedChord(t: string): boolean {
  // A lone single letter ("A thousand…") is the word, not a chord — real
  // chords in this format are virtually always multi-character.
  if (t.length < 2) return false;
  return INTERLEAVED_CHORD.test(t);
}

function isInterleavedSection(t: string): boolean {
  return (
    t.length <= 40 &&
    !t.includes("|") &&
    !isInterleavedChord(t) &&
    INTERLEAVED_SECTION.test(t)
  );
}

function parseInterleaved(text: string): ImportedSheet {
  const rawLines = text.replace(/\r/g, "").split("\n");
  const lines: SheetLine[] = [];
  let cur = "";
  let pending: string | null = null;
  let firstChord: string | null = null;

  const flush = () => {
    if (pending && cur.trim() !== "") {
      cur += `[${pending}]`;
      pending = null;
    }
    if (cur.trim() !== "") {
      lines.push({ kind: "chordpro", text: cur.trim() });
    } else if (pending) {
      lines.push({ kind: "chord-only", text: pending });
    }
    cur = "";
    pending = null;
  };

  for (const line of rawLines) {
    const t = line.trim();
    if (t === "") {
      flush();
      continue;
    }
    if (isInterleavedSection(t)) {
      flush();
      lines.push({ kind: "section", text: t.replace(/\s+/g, " ") });
      continue;
    }
    if (t.includes("|")) {
      flush();
      lines.push({ kind: "chord-only", text: t });
      continue;
    }
    if (isInterleavedChord(t)) {
      if (!firstChord) firstChord = t;
      pending = t;
      continue;
    }
    // lyric fragment — keep the line's own spacing verbatim: a mid-word
    // split has no trailing space ("w" → "[Db]orship"), a word boundary
    // keeps its space ("A " → "A [Db]thousand"). Trim only the line's
    // leading indentation when it's the start of the lyric line.
    if (pending) {
      // If the chord joins two phrases (next fragment starts a new word,
      // i.e. uppercase) but the previous fragment lost its trailing space,
      // restore it. Mid-word continuations are lowercase, so they're safe.
      if (cur !== "" && !/\s$/.test(cur) && /^\s*[A-Z]/.test(line)) {
        cur += " ";
      }
      cur += `[${pending}]`;
      pending = null;
    }
    cur += cur === "" ? line.replace(/^\s+/, "") : line;
  }
  flush();

  // Collapse blank runs the format leaves behind.
  while (lines.length && lines[0].kind === "blank") lines.shift();
  while (lines.length && lines.at(-1)!.kind === "blank") lines.pop();

  const keyM = firstChord?.match(/^[A-G](?:#|b)?/);
  return {
    title: "Imported song",
    key: keyM ? keyM[0] : "C",
    mode: "major",
    lines,
  };
}

// --- "chords above lyrics" format ------------------------------------------
// The classic plain-text layout: [Section] headers, a chord row whose chords
// are positioned by spaces over the lyric row beneath, "| / / |" rhythm bars,
// "(Ab)" optional chords, and stray ">" accent cues.

const CO_CHORD =
  /^\(?[A-G](?:#|b)?(?:m|maj|min|dim|aug|sus|add)*\d*(?:\([^)]*\))?(?:sus)?\d*(?:\/[A-G](?:#|b)?)?\)?$/;
const CO_BAR = /^(?:[|/]+|>)$/;

const coIsChord = (t: string) => CO_CHORD.test(t);
const coChordName = (t: string) => t.replace(/^\(+|\)+$/g, "");

function coClassify(line: string): "section" | "bar" | "chords" | "cue" | "lyric" | "blank" {
  const t = line.trim();
  if (t === "") return "blank";
  if (/^\[[^\]]+\]/.test(t)) return "section";
  if (t === ">" || /^>+$/.test(t)) return "cue";
  const toks = t.split(/\s+/);
  const chords = toks.filter(coIsChord);
  if (chords.length > 0 && toks.every((x) => coIsChord(x) || CO_BAR.test(x))) {
    return toks.some((x) => CO_BAR.test(x)) ? "bar" : "chords";
  }
  return "lyric";
}

/** Insert each chord into the lyric at the column it sits above. */
function coMerge(chordLine: string, lyric: string): string {
  const toks: { col: number; name: string }[] = [];
  for (let i = 0; i < chordLine.length; ) {
    if (chordLine[i] === " " || chordLine[i] === "\t") {
      i++;
      continue;
    }
    let j = i;
    while (j < chordLine.length && !/\s/.test(chordLine[j])) j++;
    const raw = chordLine.slice(i, j);
    if (coIsChord(raw)) toks.push({ col: i, name: coChordName(raw) });
    i = j;
  }
  let lyr = lyric.replace(/\s+$/, "");
  let out = "";
  let cursor = 0;
  for (const c of toks) {
    let pos = Math.max(cursor, c.col);
    if (pos > lyr.length) lyr = lyr.padEnd(pos);
    out += lyr.slice(cursor, pos) + `[${c.name}]`;
    cursor = pos;
  }
  out += lyr.slice(cursor);
  // Tidy a leading chord that sits over the lyric's indentation.
  return out.replace(/^\s+/, "").replace(/^(\[[^\]]+\])\s+/, "$1");
}

function parseChordOverLyrics(text: string): ImportedSheet {
  const raw = text.replace(/\r/g, "").split("\n");
  const lines: SheetLine[] = [];
  let firstChord: string | null = null;
  const noteFirst = (s: string) => {
    if (!firstChord) {
      const m = coChordName(s.split(/\s+/).find(coIsChord) ?? "").match(
        /^[A-G](?:#|b)?/,
      );
      if (m) firstChord = m[0];
    }
  };

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    const kind = coClassify(line);
    if (kind === "blank") {
      lines.push({ kind: "blank", text: "" });
      continue;
    }
    if (kind === "cue") continue; // ">" accent marker — drop
    if (kind === "section") {
      const name = (line.match(/\[([^\]]+)\]/g) || [])
        .map((b) => b.slice(1, -1).trim())
        .join(" ")
        .trim();
      lines.push({ kind: "section", text: name || line.trim() });
      continue;
    }
    if (kind === "bar") {
      noteFirst(line);
      // Drop lone ">" cue tokens; keep the rhythm/bar line verbatim.
      lines.push({
        kind: "chord-only",
        text: line.trim().replace(/\s*>\s*/g, " ").trim(),
      });
      continue;
    }
    if (kind === "chords") {
      noteFirst(line);
      // Skip blank/cue lines to find the row this chord line sits over.
      let j = i + 1;
      while (j < raw.length && coClassify(raw[j]) === "cue") j++;
      const next = j < raw.length ? raw[j] : "";
      if (next.trim() !== "" && coClassify(next) === "lyric") {
        lines.push({ kind: "chordpro", text: coMerge(line, next) });
        i = j; // consumed the lyric row
      } else {
        lines.push({ kind: "chord-only", text: line.trim() });
      }
      continue;
    }
    // plain lyric with no chord row above it
    lines.push({ kind: "chordpro", text: line.trim() });
  }

  while (lines.length && lines[0].kind === "blank") lines.shift();
  while (lines.length && lines.at(-1)!.kind === "blank") lines.pop();

  return {
    title: "Imported song",
    key: firstChord ?? "C",
    mode: "major",
    lines,
  };
}

const HAS_BRACKET_SECTIONS = /^[ \t]*\[[^\]\n]+\][ \t]*$/m;

/**
 * Accepts: an Ultimate-Guitar URL (fetched via proxy), pasted page source,
 * raw tab text with [ch]/[tab] markers, or pasted chord text — either the
 * "interleaved" worship-copy style or the classic "chords above lyrics"
 * layout with [Section] headers.
 */
export async function importChords(input: string): Promise<ImportedSheet> {
  const text = input.trim();
  if (!text) throw new Error("Paste a URL, page source, or chord text.");

  let html: string | null = null;
  if (/^https?:\/\//i.test(text)) {
    if (!/ultimate-guitar\.com/i.test(text)) {
      throw new Error(
        "Only Ultimate-Guitar URLs are supported for direct fetch. For other " +
          "sites, paste the chord text instead.",
      );
    }
    html = await fetchPageHtml(text);
  } else if (text.includes("js-store")) {
    html = text; // pasted page source
  }

  if (html) {
    const store = extractUgStore(html);
    const sheet = store && fromUgStore(store);
    if (sheet && sheet.lines.length) return sheet;
    throw new Error(
      "Found the page but couldn't read its chord data (Ultimate-Guitar may " +
        "have changed their format).",
    );
  }

  // Raw tab text fallback (UG "copy" text uses [ch]/[tab]).
  if (text.includes("[ch]") || text.includes("[tab]")) {
    const lines = ugContentToLines(text);
    if (lines.length) {
      return { title: "Imported song", key: "C", mode: "major", lines };
    }
  }

  // Classic "chords above lyrics" with [Section] headers.
  if (HAS_BRACKET_SECTIONS.test(text)) {
    const co = parseChordOverLyrics(text);
    if (
      co.lines.some((l) => l.kind !== "blank" && l.text.trim() !== "")
    ) {
      return co;
    }
  }

  // Generic worship-site "copy" text: chords interleaved into the lyrics.
  const interleaved = parseInterleaved(text);
  if (
    interleaved.lines.some(
      (l) => l.kind !== "blank" && l.text.trim() !== "",
    )
  ) {
    return interleaved;
  }

  throw new Error(
    "Unrecognized input. Paste an Ultimate-Guitar URL/page source, or pasted " +
      "chord text (chords inline or on their own lines).",
  );
}

export function toChordSheet(s: ImportedSheet): ChordSheet {
  return {
    id: crypto.randomUUID(),
    title: s.title,
    artist: s.artist,
    key: s.key,
    mode: s.mode,
    lines: s.lines,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

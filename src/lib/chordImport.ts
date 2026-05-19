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

/**
 * Accepts: an Ultimate-Guitar URL (fetched via proxy), pasted page source,
 * or raw tab text containing [ch]/[tab] markers.
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

  throw new Error(
    "Unrecognized input. Paste an Ultimate-Guitar URL, the page source, or " +
      "the tab text (it should contain [ch] chord markers).",
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
    updatedAt: Date.now(),
  };
}

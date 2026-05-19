// Recover f-ligatures dropped by PDF text extraction.
//
// SongSelect/CCLI chord PDFs embed subset fonts with no ToUnicode map for
// their "ff", "fi", "fl", "ffi", "ffl" ligature glyphs. pdf.js emits each as
// a NUL (U+0000) -- a real, positioned glyph whose text is lost. We can't tell
// which ligature a NUL was from the glyph alone, so we reconstruct the word
// and pick the substitution that yields a real English word.

import { LIGATURE_WORDS } from "./ligatureWords";

// Tried in order of real-world frequency; the first substitution that forms a
// known word wins, and "fi" is the fallback when nothing matches.
const LIGS = ["fi", "fl", "ff", "ffl", "ffi"] as const;

// U+0000 is what pdf.js emits here; U+FFFD is a defensive catch-all.
function isPlaceholder(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c === 0x0000 || c === 0xfffd;
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z']/.test(ch) || isPlaceholder(ch);
}

export function hasLigaturePlaceholder(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0000 || c === 0xfffd) return true;
  }
  return false;
}

// Old dictionaries lack inflections (no "fires", "flames"). Accept a word if
// it or a simple stem of it is known.
function known(norm: string): boolean {
  if (!norm) return false;
  if (LIGATURE_WORDS.has(norm)) return true;
  const stems = [
    norm.replace(/'s$/, ""),
    norm.replace(/s$/, ""),
    norm.replace(/es$/, ""),
    norm.replace(/ies$/, "y"),
    norm.replace(/ed$/, ""),
    norm.replace(/ed$/, "e"),
    norm.replace(/ied$/, "y"),
    norm.replace(/ing$/, ""),
    norm.replace(/ing$/, "e"),
    norm.replace(/d$/, ""),
  ];
  return stems.some((s) => s !== norm && s.length > 1 && LIGATURE_WORDS.has(s));
}

// Choose the ligature (cased) for each placeholder in a word. Tries ligature
// combinations in priority order and returns the first that forms a known
// word; otherwise falls back to "fi" for every placeholder.
function resolvePlaceholderLigs(word: string): string[] {
  const slots: number[] = [];
  for (let i = 0; i < word.length; i++) {
    if (isPlaceholder(word[i])) slots.push(i);
  }
  if (slots.length === 0) return [];

  const letters = word.replace(/[^A-Za-z]/g, "");
  const upper = letters.length > 0 && letters === letters.toUpperCase();
  const cased = (lig: string) => (upper ? lig.toUpperCase() : lig);

  const build = (combo: readonly string[]) => {
    let out = "";
    let k = 0;
    for (let i = 0; i < word.length; i++) {
      out += isPlaceholder(word[i]) ? combo[k++] : word[i];
    }
    return out.toLowerCase().replace(/[^a-z]/g, "");
  };

  let best: string[] | null = null;
  const search = (idx: number, combo: string[]) => {
    if (best) return;
    if (idx === slots.length) {
      if (known(build(combo))) best = [...combo];
      return;
    }
    for (const lig of LIGS) {
      search(idx + 1, [...combo, lig]);
      if (best) return;
    }
  };
  search(0, []);

  const chosen = best ?? slots.map(() => "fi");
  return chosen.map(cased);
}

function resolveWord(word: string): string {
  const ligs = resolvePlaceholderLigs(word);
  if (ligs.length === 0) return word;
  let out = "";
  let k = 0;
  for (const ch of word) out += isPlaceholder(ch) ? ligs[k++] : ch;
  return out;
}

// Replace dropped-ligature placeholders throughout a line of text.
export function recoverLigatures(text: string): string {
  if (!hasLigaturePlaceholder(text)) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (isWordChar(text[i])) {
      let j = i;
      while (j < text.length && isWordChar(text[j])) j++;
      out += resolveWord(text.slice(i, j));
      i = j;
    } else {
      out += text[i++];
    }
  }
  return out;
}

// Alignment-aware recovery: rebuilds the per-character x array so a NUL that
// expands to "fi" doesn't desync chord placement. Inserted letters inherit
// the placeholder glyph's x.
export function recoverLigaturesAligned(
  text: string,
  charX: number[],
): { text: string; charX: number[] } {
  if (!hasLigaturePlaceholder(text)) return { text, charX };
  let outText = "";
  const outX: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (isWordChar(text[i])) {
      let j = i;
      while (j < text.length && isWordChar(text[j])) j++;
      const word = text.slice(i, j);
      const ligs = resolvePlaceholderLigs(word);
      let k = 0;
      for (let p = 0; p < word.length; p++) {
        const x = charX[i + p];
        if (isPlaceholder(word[p])) {
          for (const ch of ligs[k++]) {
            outText += ch;
            outX.push(x);
          }
        } else {
          outText += word[p];
          outX.push(x);
        }
      }
      i = j;
    } else {
      outText += text[i];
      outX.push(charX[i]);
      i++;
    }
  }
  return { text: outText, charX: outX };
}

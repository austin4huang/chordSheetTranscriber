# Chord Sheet Transcriber

A browser-based chord-sheet library for musicians who want to import, edit,
transpose, annotate, and organize chord charts — all locally in the browser.
Built with React + TypeScript + Vite. No server, no account: your library
lives in your browser (with optional auto-save to a device folder on Chromium
browsers, plus `.json` backup/restore everywhere).

## Features

- **Import** chord sheets from several sources:
  - **PDFs** (e.g. SongSelect downloads) — the parser extracts chord positions
    and lyrics. PDFs previously exported from this app round-trip losslessly
    because the original ChordPro is embedded in the file.
  - **Ultimate-Guitar URLs** (or pasted page source if direct fetch is blocked).
  - **Raw chord text** — paste ChordPro, UG tab text, or worship-site copies
    with chords on their own lines above the lyrics.
- **ChordPro editor** with a live side-by-side preview. Inline chords use
  `[D]Are you [G]hurting`, section markers use `[section: VERSE 1]`, and you
  can add directives like `{key: D}` / `{title: ...}` at the top.
- **Transpose** by semitone with a one-click reset to the song's original key.
  Sharp/flat spelling toggles for enharmonic keys.
- **Nashville numbers** — flip the whole sheet into number-system notation
  relative to the song's key.
- **Annotations** — pen (three colors), text boxes with adjustable font size,
  eraser, and a draggable/minimize-able floating toolbar. Annotations scale
  with the sheet and are saved with the song.
- **Sets / setlists** — group songs in order, drag to reorder, and step
  through them while presenting. Songs stay in the global library and can
  appear in multiple sets.
- **Present mode** — full-screen, distraction-free view with prev/next
  navigation when you're in a set.
- **Export to PDF** — exports the *rendered* view (current key, numbers or
  chords, annotations included). Single songs or whole sets. Exports embed
  the source ChordPro so they re-import cleanly.
- **Storage**
  - Library lives in `localStorage` by default.
  - `.json` backup / restore from the **Storage** panel.
  - On Chromium browsers, link a device folder to auto-save every change.

## Getting started

Requires Node 18+ (Node 20+ recommended).

```bash
npm install
npm run dev      # start the dev server (Vite, with HMR)
npm run build    # type-check + production build into dist/
npm run preview  # serve the production build locally
npm run lint     # run ESLint
```

Then open the URL Vite prints (typically <http://localhost:5173>).

## Using the app

1. **Add a song.** From the library screen, choose **+ New sheet** for a
   blank ChordPro song, or **Import** for a PDF / URL / pasted text.
2. **Edit and preview.** The left pane is ChordPro; the right pane re-renders
   as you type. The split is draggable; double-click the divider to reset,
   or use the chevron to hide the editor entirely.
3. **Transpose** with the `−` / `+` buttons in the toolbar, switch
   spelling with `♯` / `♭`, or hit the reset button to return to the song's
   original key. **Numbers** swaps the chart into Nashville numbers.
4. **Annotate** with the floating toolbar over the preview. Drag the grip to
   move it; the chevron minimizes it (and that choice persists when you
   navigate between songs in a set).
5. **Build a set.** Back on the library, create a set, then add songs via
   the **+ Set** dropdown on each song row. Drag the grip handles inside a
   set to reorder.
6. **Present.** Open a song (or a whole set) and press the present button
   in the toolbar. `Esc` exits. When you opened from a set, the in-set
   prev / next controls follow you into present mode.
7. **Download.** The PDF button exports what you currently see. Files you
   export from this app are re-importable here.
8. **Back up.** Open the **Storage** panel in the header to download a
   `.json` backup, restore from one, or (on Chromium) link a folder for
   continuous auto-save.

## Keyboard shortcuts

Active while viewing a song; suppressed whenever a text field, the chord
editor, or a text-annotation box has focus.

| Key | Action                       |
| --- | ---------------------------- |
| `F` | Toggle present full-screen   |
| `E` | Toggle the chord editor pane |
| `C` | Switch to Chords             |
| `N` | Switch to Numbers            |
| `T` | Annotation: text-box tool    |
| `P` | Annotation: cursor / pointer |
| `↑` / `↓` | Transpose up / down a semitone (editor); scroll the page (present) |
| `←` / `→` | Previous / next song in a set |
| `W` / `S` | Scroll page up / down (present only) |
| `A` / `D` | Previous / next song (present only)  |
| `Esc`     | Exit present mode         |
| `⌘/Ctrl + S` | Save                   |

## Project layout

```
src/
  App.tsx                 # top-level view state (list ↔ editor) + conflict modal
  components/
    SheetList.tsx         # library: songs, sets, import, search, storage
    SheetEditor.tsx       # editor + toolbar (transpose, save, present, ...)
    SheetRenderer.tsx     # the chord/lyric layout used in preview and PDF
    AnnotationLayer.tsx   # pen / text / eraser overlay on the renderer
    icons.tsx             # shared inline SVG icons
  lib/
    pdfParser.ts          # PDF → ChordPro extraction
    pdfExport.ts          # render → PDF (single song or whole set)
    chordImport.ts        # Ultimate-Guitar / pasted-text importer
    nashville.ts          # key / number-system / transposition helpers
    storage.ts            # localStorage-backed library
    persist.ts            # device-folder linking + persistent-storage request
    types.ts              # shared types (ChordSheet, SheetLine, Stroke, ...)
```

## Tech

- React 19 + TypeScript + Vite
- `pdfjs-dist` for PDF parsing, `jspdf` + `html-to-image` for PDF export
- No backend. Everything runs in the browser; data stays on your device.

## Note on imported content

Imported chord charts are copyrighted by their authors and publishers. Use
this tool for personal study, licensed use, or content you have rights to,
and verify accuracy against an authoritative source.

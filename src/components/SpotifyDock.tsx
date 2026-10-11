import { useState } from "react";
import type { ChordSheet } from "../lib/types";
import { SpotifyIcon, XIcon } from "./icons";
import "./SpotifyDock.css";

interface Props {
  /** Only for pre-filling the Spotify search with title + artist. */
  sheet: ChordSheet;
  /** Held as editor state rather than read off `sheet`, which is re-derived
   *  from the textarea and so still carries the value this song loaded with. */
  trackId: string | undefined;
  /** Persisted immediately by the caller (storage.updateSheet), the same way
   *  displayKey/preferFlats are — linking a recording isn't a text edit, so it
   *  shouldn't mark the editor dirty or fight an unsaved draft. */
  onLink: (trackId: string | undefined) => void;
  onClose: () => void;
}

// Accepts whatever the user has on the clipboard: a share link (with or
// without Spotify's locale prefix and tracking query), a spotify: URI, or a
// bare ID pasted out of one of those.
function parseTrackId(input: string): string | null {
  const s = input.trim();
  const url = s.match(
    /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})\b/,
  );
  if (url) return url[1];
  const uri = s.match(/^spotify:track:([A-Za-z0-9]{22})$/);
  if (uri) return uri[1];
  if (/^[A-Za-z0-9]{22}$/.test(s)) return s;
  return null;
}

/** Docked reference-recording player. Lives at the foot of the editor rather
 *  than in a modal so the chart stays readable while it plays.
 *
 *  Spotify's Widget Terms require the embed to be shown as served and never
 *  obscured, so everything we add sits *around* the iframe — never over it —
 *  and the iframe keeps the height Spotify's own oEmbed response specifies. */
export function SpotifyDock({ sheet, trackId: id, onLink, onClose }: Props) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function link() {
    const parsed = parseTrackId(draft);
    if (!parsed) {
      setError("That doesn't look like a Spotify track link.");
      return;
    }
    setError(null);
    setDraft("");
    onLink(parsed);
  }

  // Spotify has no unauthenticated search, so the bridge to finding a track is
  // their own search page in a new tab, pre-filled from the song's metadata.
  const searchUrl =
    "https://open.spotify.com/search/" +
    encodeURIComponent([sheet.title, sheet.artist].filter(Boolean).join(" "));

  return (
    <div className="sp-dock" role="region" aria-label="Reference recording">
      <button
        className="sp-close"
        onClick={onClose}
        aria-label="Hide the reference recording"
        title="Hide (closing stops playback)"
      >
        <XIcon />
      </button>

      {!id ? (
        <div className="sp-link-form">
          <label htmlFor="sp-url" className="sp-label">
            <SpotifyIcon /> Link a reference recording
          </label>
          <div className="sp-link-row">
            <input
              id="sp-url"
              type="text"
              value={draft}
              placeholder="Paste a Spotify track link…"
              onChange={(e) => {
                setDraft(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") link();
                // The editor binds bare keys (F to present, ↑/↓ to transpose);
                // keep them from firing while typing in here.
                e.stopPropagation();
              }}
            />
            <button className="sp-primary" onClick={link} disabled={!draft.trim()}>
              Link
            </button>
            <a
              className="sp-secondary"
              href={searchUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Find on Spotify ↗
            </a>
          </div>
          {error && <div className="sp-error">{error}</div>}
        </div>
      ) : (
        <>
          {/* Spotify's own height for the standard embed; `allow` is the list
              from their oEmbed response. Permissions-Policy defaults these to
              same-origin, so the attribute is what delegates them to the
              iframe. */}
          <iframe
            className="sp-embed"
            title="Spotify player"
            src={`https://open.spotify.com/embed/track/${id}`}
            height="152"
            frameBorder="0"
            allowFullScreen
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
            loading="lazy"
          />
          {/* The embed plays a full track only when it can read a Spotify
              session cookie, which needs a secure origin (its cookies are
              Secure/SameSite=None) and a browser that allows third-party
              cookies — so it falls back to a 30s preview over plain HTTP, and
              in browsers that block third-party cookies outright, Safari
              included. This link sidesteps all of it by handing off to the
              installed app, which plays in full and keeps playing after you
              switch back to the chart, so narrow screens promote it. */}
          <div className="sp-actions">
            <a
              className="sp-open"
              href={`https://open.spotify.com/track/${id}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open in Spotify ↗
            </a>
            <button
              className="sp-unlink"
              onClick={() => onLink(undefined)}
              title="Forget this track for this song"
            >
              Unlink
            </button>
          </div>
        </>
      )}
    </div>
  );
}

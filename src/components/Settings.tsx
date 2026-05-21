import { useEffect, useRef, useState } from "react";
import { getPrefs, updatePrefs, type Prefs } from "../lib/prefs";
import {
  getStorageStatus,
  downloadBackup,
  restoreBackup,
  linkFolder,
  reconnectFolder,
  unlinkFolder,
  clearLibrary,
  onStorageChanged,
  onLibraryChanged,
  type StorageStatus,
} from "../lib/persist";
import { useModal } from "../lib/useModal";
import { onStorageError } from "../lib/storage";
import { DownloadIcon, TrashIcon, UploadIcon, XIcon } from "./icons";
import "./Settings.css";

interface Props {
  onClose: () => void;
}

type TabKey = "display" | "defaults" | "storage" | "reference";
const TABS: { key: TabKey; label: string }[] = [
  { key: "display", label: "Display" },
  { key: "defaults", label: "Defaults" },
  { key: "storage", label: "Storage" },
  { key: "reference", label: "Reference" },
];

const PEN_COLORS = [
  "#1a1a1a", "#e23b2e", "#f59e0b", "#1f9d57",
  "#1f6dd6", "#7c3aed", "#ec4899", "#0891b2",
];

/** Settings modal — surfaces the persisted preferences in src/lib/prefs.ts
 *  plus the storage / backup controls. Grouped into three sections; adding a
 *  new pref is: extend `Prefs`, then add a row inside the right section here.
 *
 *  Pref edits are transactional: the row controls update a local *draft*
 *  copy; nothing reaches the prefs store (and therefore the rest of the
 *  app) until the user hits Done. Cancel / X / backdrop click / Esc discard
 *  the draft — when the draft is dirty they confirm first so a stray click
 *  can't lose work. Storage-section actions (link/unlink, backup/restore,
 *  clear library) are NOT prefs — they're immediate side-effects either way. */
export function Settings({ onClose }: Props) {
  // Draft prefs, seeded from the currently persisted values on mount. The
  // patch helper only updates this local copy; commit happens in `onDone`.
  const [prefs, setPrefs] = useState<Prefs>(getPrefs());
  const patch = (p: Partial<Prefs>) => setPrefs((d) => ({ ...d, ...p }));
  // Active tab. Defaults to Storage on each open; deliberate, so the user
  // always lands on a consistent starting point.
  const [tab, setTab] = useState<TabKey>("storage");
  const isDirty = () => {
    const saved = getPrefs();
    return (Object.keys(prefs) as (keyof Prefs)[]).some(
      (k) => prefs[k] !== saved[k],
    );
  };
  const onDone = () => {
    if (isDirty()) updatePrefs(prefs);
    onClose();
  };
  const tryClose = () => {
    if (isDirty() && !confirm("Discard unsaved settings changes?")) return;
    onClose();
  };
  const modalRef = useModal(tryClose);

  // Storage status / actions. Mirrored from the same source as the header
  // badge — both subscribe to storage + library change events so they
  // refresh together after any folder link/unlink/reconnect/restore.
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [storageMsg, setStorageMsg] = useState<
    { text: string; kind: "ok" | "error" } | null
  >(null);
  const restoreRef = useRef<HTMLInputElement>(null);
  // Two-step "Clear everything" confirm: first click arms (button turns red,
  // label changes), second click within ~3 s actually wipes. Auto-disarms.
  const [confirmingClear, setConfirmingClear] = useState(false);
  const confirmTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    },
    [],
  );
  const onClearAll = () => {
    if (!confirmingClear) {
      setConfirmingClear(true);
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => {
        setConfirmingClear(false);
        confirmTimer.current = null;
      }, 3000);
      return;
    }
    if (confirmTimer.current) {
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
    setConfirmingClear(false);
    setStorageMsg(null);
    clearLibrary()
      .then(() => setStorageMsg({ text: "Library cleared.", kind: "ok" }))
      .catch((e) =>
        setStorageMsg({
          text: e instanceof Error ? e.message : "Couldn't clear library.",
          kind: "error",
        }),
      );
  };
  useEffect(() => {
    const refresh = () => {
      getStorageStatus().then(setStorageStatus).catch(() => {});
    };
    refresh();
    const off1 = onStorageChanged(refresh);
    const off2 = onLibraryChanged(refresh);
    // Surface IDB write failures that happen out-of-band (e.g. background
    // saves while the modal is open). Otherwise the user wouldn't know
    // their save vanished until next reload.
    const off3 = onStorageError(({ error }) =>
      setStorageMsg({
        text: `Couldn't save to local storage: ${error.message}`,
        kind: "error",
      }),
    );
    return () => {
      off1();
      off2();
      off3();
    };
  }, []);

  const storageAction = async (fn: () => Promise<unknown>, ok: string) => {
    setStorageMsg(null);
    try {
      await fn();
      setStorageMsg({ text: ok, kind: "ok" });
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return;
      setStorageMsg({
        text: e instanceof Error ? e.message : "Something went wrong.",
        kind: "error",
      });
    }
  };

  return (
    <div className="modal-backdrop" onClick={tryClose}>
      <div
        ref={modalRef}
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-head">
          <h3 id="settings-title">Settings</h3>
          <button
            className="settings-close"
            onClick={tryClose}
            aria-label="Close settings"
            title="Close"
          >
            <XIcon />
          </button>
        </header>

        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`settings-tab${tab === t.key ? " is-active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "display" && (
        <section className="settings-section">
          <div className="settings-row">
            <label htmlFor="pref-font-scale">Sheet font size</label>
            <select
              id="pref-font-scale"
              value={prefs.fontScale}
              onChange={(e) =>
                patch({ fontScale: e.target.value as Prefs["fontScale"] })
              }
            >
              <option value="sm">Small</option>
              <option value="md">Normal</option>
              <option value="lg">Large</option>
            </select>
          </div>
          <div className="settings-row">
            <label htmlFor="pref-columns">Column layout</label>
            <select
              id="pref-columns"
              value={prefs.singleColumn ? "single" : "auto"}
              onChange={(e) => patch({ singleColumn: e.target.value === "single" })}
            >
              <option value="auto">Auto (multi-column when wide)</option>
              <option value="single">Always single column</option>
            </select>
          </div>
        </section>
        )}

        {tab === "defaults" && (
        <section className="settings-section">
          <div className="settings-row">
            <label>Pen color</label>
            <div className="settings-swatches">
              {PEN_COLORS.map((c) => (
                <button
                  key={c}
                  className={`settings-swatch${prefs.penColor === c ? " is-active" : ""}`}
                  style={{ background: c }}
                  onClick={() => patch({ penColor: c })}
                  aria-label={`Pen color ${c}`}
                  title={c}
                />
              ))}
            </div>
          </div>
          <div className="settings-row">
            <label htmlFor="pref-fontsize">Text annotation size</label>
            <input
              id="pref-fontsize"
              type="number"
              min={10}
              max={72}
              step={2}
              value={prefs.penFontSize}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) patch({ penFontSize: n });
              }}
            />
          </div>
          <div className="settings-row">
            <label htmlFor="pref-numbermode">Open new songs in</label>
            <select
              id="pref-numbermode"
              value={prefs.defaultNumberMode ? "numbers" : "chords"}
              onChange={(e) =>
                patch({ defaultNumberMode: e.target.value === "numbers" })
              }
            >
              <option value="chords">Chord names</option>
              <option value="numbers">Nashville numbers</option>
            </select>
          </div>
          <div className="settings-row">
            <label htmlFor="pref-tb-collapsed">Annotation toolbar</label>
            <select
              id="pref-tb-collapsed"
              value={prefs.annoToolbarCollapsed ? "collapsed" : "expanded"}
              onChange={(e) =>
                patch({ annoToolbarCollapsed: e.target.value === "collapsed" })
              }
            >
              <option value="expanded">Expanded by default</option>
              <option value="collapsed">Collapsed by default</option>
            </select>
          </div>
          <div className="settings-row">
            <label htmlFor="pref-conflict">On import conflict</label>
            <select
              id="pref-conflict"
              value={prefs.conflictDefault}
              onChange={(e) =>
                patch({
                  conflictDefault: e.target.value as Prefs["conflictDefault"],
                })
              }
            >
              <option value="ask">Always ask</option>
              <option value="rename">Always keep both</option>
              <option value="replace">Always replace</option>
            </select>
          </div>
        </section>
        )}

        {tab === "storage" && (
        <section className="settings-section">
          <p className="storage-status">
            {storageStatus?.persistent
              ? "✓ Persistent storage granted (the browser won't auto-evict your library)."
              : "Using best-effort browser storage — link a folder below for real durability."}
          </p>

          <div className="storage-row">
            <button
              className="ghost-btn"
              onClick={downloadBackup}
              title="Save a .json backup of your library"
            >
              <DownloadIcon />Backup
            </button>
            <button
              className="ghost-btn"
              onClick={() => restoreRef.current?.click()}
              title="Restore library from a .json backup"
            >
              <UploadIcon />Restore
            </button>
          </div>

          {storageStatus?.folderSupported ? (
            <div className="storage-row">
              {storageStatus.folderName ? (
                <>
                  <span className="storage-status">
                    Folder: <strong>{storageStatus.folderName}</strong>{" "}
                    {storageStatus.folderConnected
                      ? "· connected (auto-saving)"
                      : "· not connected"}
                  </span>
                  <span className="spacer" />
                  {!storageStatus.folderConnected && (
                    <button
                      className="ghost-btn"
                      onClick={() =>
                        storageAction(reconnectFolder, "Folder reconnected.")
                      }
                    >
                      Reconnect
                    </button>
                  )}
                  <button
                    className="ghost-btn"
                    onClick={() =>
                      storageAction(unlinkFolder, "Folder unlinked.")
                    }
                  >
                    Unlink
                  </button>
                </>
              ) : (
                <button
                  className="ghost-btn"
                  onClick={() =>
                    storageAction(linkFolder, "Folder linked — auto-saving here.")
                  }
                >
                  Link a device folder (auto-save)
                </button>
              )}
            </div>
          ) : (
            <p className="storage-status">
              This browser can't save to a device folder (Chromium only). Use
              Backup / Restore instead.
            </p>
          )}

          {storageMsg && (
            <p
              className={`storage-msg${storageMsg.kind === "error" ? " is-error" : ""}`}
              role={storageMsg.kind === "error" ? "alert" : "status"}
            >
              {storageMsg.text}
            </p>
          )}
          <input
            ref={restoreRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) storageAction(() => restoreBackup(f), "Library restored.");
              e.target.value = "";
            }}
          />
          <div className="settings-danger">
            <span className="settings-danger-label">Danger zone</span>
            <button
              className={`ghost-btn bulk-delete${confirmingClear ? " is-confirming" : ""}`}
              onClick={onClearAll}
              title={
                confirmingClear
                  ? "Click again within 3 seconds to permanently delete every song and set"
                  : "Permanently delete every song and set"
              }
            >
              <TrashIcon />
              {confirmingClear ? "Click again to confirm" : "Clear library…"}
            </button>
          </div>
        </section>
        )}

        {tab === "reference" && (
        <section className="settings-section">
          <details className="settings-details">
            <summary>Keyboard shortcuts</summary>
            <table className="shortcuts">
              <tbody>
                <tr><th colSpan={2}>Editor / preview</th></tr>
                <tr><td><kbd>T</kbd></td><td>Text annotation tool</td></tr>
                <tr><td><kbd>P</kbd></td><td>Pointer / cursor tool</td></tr>
                <tr><td><kbd>F</kbd></td><td>Toggle full-screen present</td></tr>
                <tr><td><kbd>E</kbd></td><td>Toggle editor pane</td></tr>
                <tr><td><kbd>C</kbd></td><td>Chord-name notation</td></tr>
                <tr><td><kbd>N</kbd></td><td>Nashville-number notation</td></tr>
                <tr><td><kbd>↑</kbd> <kbd>↓</kbd></td><td>Transpose key (editor) · scroll (present)</td></tr>
                <tr><td><kbd>⌘/Ctrl</kbd>+<kbd>S</kbd></td><td>Save</td></tr>
                <tr><td><kbd>Esc</kbd></td><td>Exit text edit · cursor mode · exit present</td></tr>
                <tr><th colSpan={2}>Present mode</th></tr>
                <tr><td><kbd>W</kbd> <kbd>S</kbd></td><td>Scroll up / down</td></tr>
                <tr><td><kbd>A</kbd> <kbd>D</kbd></td><td>Previous / next song in set</td></tr>
                <tr><th colSpan={2}>Selection</th></tr>
                <tr><td><kbd>Shift</kbd>+click</td><td>Multi-select annotations or songs (range)</td></tr>
                <tr><td><kbd>⌘/Ctrl</kbd>+click</td><td>Toggle a single annotation in selection</td></tr>
                <tr><td><kbd>Backspace</kbd></td><td>Delete selected annotations</td></tr>
              </tbody>
            </table>
          </details>
          <details className="settings-details">
            <summary>About</summary>
            <p className="settings-note">
              Chord Sheet Transcriber — local-first chord-sheet editor with
              annotations, transposing, and presenter mode. Source on{" "}
              <a
                href="https://github.com/austin4huang/chordSheetTranscriber"
                target="_blank"
                rel="noreferrer"
              >
                GitHub
              </a>
              .
            </p>
          </details>
        </section>
        )}

        <footer className="settings-foot">
          <button className="modal-btn" onClick={tryClose}>
            Cancel
          </button>
          <button className="modal-btn primary" onClick={onDone}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

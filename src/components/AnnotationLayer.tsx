import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Stroke, TextNote } from "../lib/types";
import "./AnnotationLayer.css";

const COLORS = ["#e23b2e", "#1f6dd6", "#1f9d57"];
const PEN_WIDTH = 2.5;
const ERASE_RADIUS = 14;
const MIN_FONT = 10;
const MAX_FONT = 72;

type Tool = "off" | "pen" | "eraser" | "text" | "move";
const HIT_RADIUS = 10;

interface Props {
  annotations: Stroke[];
  onChange: (next: Stroke[]) => void;
  texts: TextNote[];
  onTextsChange: (next: TextNote[]) => void;
  /** Reference content size the stored coordinates are in. When null, the
   *  layer uses the current rendered size as the reference (identity scale)
   *  and seeds it via `onRefSize` the first time something is authored. */
  refSize?: { w: number; h: number } | null;
  onRefSize?: (ref: { w: number; h: number }) => void;
  /** Lifted so the user's minimize choice survives switching songs in a set
   *  (this component remounts on song change). Falls back to local state. */
  collapsed?: boolean;
  onCollapsedChange?: Dispatch<SetStateAction<boolean>>;
}

const CursorIcon = (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
    <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" fill="currentColor" />
  </svg>
);

const EraserIcon = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
    <path d="M22 21H7" />
    <path d="m5 11 9 9" />
  </svg>
);

const GripIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
    <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
    <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
    <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
  </svg>
);

const CollapseIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 6l-6 6 6 6" />
  </svg>
);

const PencilIcon = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

const TrashIcon = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </svg>
);

interface TextBoxProps {
  note: TextNote;
  editing: boolean;
  selected: boolean;
  eraser: boolean;
  move: boolean;
  pointerEvents: "auto" | "none";
  /** Added to note.x/note.y for display, so a box anchored to a line tracks
   *  that line's current position on resize/reflow. */
  offsetX: number;
  offsetY: number;
  /** Screen-px → reference-space divisors for resize deltas. (Selection
   *  drag is handled by the parent so it uses host-pixel deltas.) */
  scaleX: number;
  scaleY: number;
  onText: (text: string) => void;
  onResize: (w?: number, h?: number) => void;
  onEdit: () => void;
  /** Double-click shortcut: switch to the Text tool and start editing this
   *  box. */
  onActivateText: () => void;
  onErase: () => void;
  onBlur: () => void;
  onEscape: () => void;
  /** Pointer-down/move/up forwarded to the parent so the same drag system
   *  handles both stroke and text-box selection/group-move. */
  onSelectDown: (id: string, clientX: number, clientY: number, modifier: boolean) => void;
  onSelectMove: (clientX: number, clientY: number) => void;
  onSelectUp: () => void;
}

function TextBox({
  note, editing, selected, eraser, move, pointerEvents,
  offsetX, offsetY, scaleX, scaleY,
  onText, onResize, onEdit, onActivateText, onErase, onBlur, onEscape,
  onSelectDown, onSelectMove, onSelectUp,
}: TextBoxProps) {
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  // Focus the textarea whenever this box becomes the editing target (e.g.
  // after a double-click promoted it from cursor-mode to the text tool).
  // `autoFocus` only fires on first mount, so a state-driven focus is needed.
  useEffect(() => {
    if (editing) textAreaRef.current?.focus();
  }, [editing]);
  const boxRef = useRef<HTMLDivElement>(null);
  const min = useRef({ w: 0, h: 0 });
  const drag = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  // Size the box to exactly fit the textarea's content. We can't use a
  // separate <div> mirror because <div> and <textarea> measure text
  // slightly differently (different internal padding, caret reservation,
  // font metrics) — the discrepancy is small but consistently clips text
  // by a few pixels. Instead we collapse the box to 0×0, read the
  // textarea's own scrollWidth/scrollHeight (which report the natural
  // content extent regardless of overflow), then restore. useLayoutEffect
  // runs synchronously before paint so the 0-state is never visible.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const ta = textAreaRef.current;
    if (!box || !ta) return;
    const prevW = box.style.width;
    const prevH = box.style.height;
    box.style.width = "0px";
    box.style.height = "0px";
    // scrollWidth already includes the textarea's own padding; +4 covers
    // the 2px border on each side plus a couple px of caret slack.
    const cw = ta.scrollWidth + 4;
    const ch = ta.scrollHeight + 2;
    box.style.width = prevW;
    box.style.height = prevH;
    min.current = { w: cw, h: ch };
    const w = note.w != null ? Math.max(note.w, cw) : cw;
    const h = note.h != null ? Math.max(note.h, ch) : ch;
    box.style.width = w + "px";
    box.style.height = h + "px";
  }, [note.text, note.fontSize, note.w, note.h]);

  const onHandleDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const box = boxRef.current!;
    drag.current = { x: e.clientX, y: e.clientY, w: box.offsetWidth, h: box.offsetHeight };
  };
  const onHandleMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const w = Math.max(
      min.current.w,
      drag.current.w + (e.clientX - drag.current.x) / scaleX,
    );
    const h = Math.max(
      min.current.h,
      drag.current.h + (e.clientY - drag.current.y) / scaleY,
    );
    onResize(w, h);
  };
  const onHandleUp = (e: React.PointerEvent) => {
    if (!drag.current) return;
    (e.target as Element).releasePointerCapture(e.pointerId);
    drag.current = null;
    const box = boxRef.current!;
    // Snapped back to the text's natural size → revert to auto-fit.
    if (box.offsetWidth <= min.current.w + 2 && box.offsetHeight <= min.current.h + 2) {
      onResize(undefined, undefined);
    }
  };

  // Drag the whole box to reposition it (cursor-mode).
  const dragActive = useRef(false);
  // Manual double-click detection — `e.detail` on PointerEvent isn't reliable
  // across browsers and breaks after pointer-capture, so we just compare
  // timestamps + positions ourselves. ~450 ms / ~14 px is comfortable.
  const lastClick = useRef<{ t: number; x: number; y: number } | null>(null);
  const onBoxDown = (e: React.PointerEvent) => {
    if (!move) return;
    const now = performance.now();
    const last = lastClick.current;
    if (
      last &&
      now - last.t < 450 &&
      Math.abs(e.clientX - last.x) < 14 &&
      Math.abs(e.clientY - last.y) < 14
    ) {
      // Double-click → switch to the Text tool and start editing this box.
      lastClick.current = null;
      e.preventDefault();
      e.stopPropagation();
      onActivateText();
      return;
    }
    lastClick.current = { t: now, x: e.clientX, y: e.clientY };
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragActive.current = true;
    const modifier = e.shiftKey || e.metaKey || e.ctrlKey;
    onSelectDown(note.id, e.clientX, e.clientY, modifier);
  };
  const onBoxMove = (e: React.PointerEvent) => {
    if (!dragActive.current) return;
    onSelectMove(e.clientX, e.clientY);
  };
  const onBoxUp = (e: React.PointerEvent) => {
    if (!dragActive.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragActive.current = false;
    onSelectUp();
  };

  return (
    <div
      ref={boxRef}
      className={`anno-textbox${move ? " is-move" : ""}${selected ? " is-selected" : ""}`}
      style={{ left: note.x + offsetX, top: note.y + offsetY, pointerEvents }}
      onPointerDown={onBoxDown}
      onPointerMove={onBoxMove}
      onPointerUp={onBoxUp}
      onPointerCancel={onBoxUp}
    >
      <textarea
        ref={textAreaRef}
        className="anno-text"
        value={note.text}
        autoFocus={editing}
        readOnly={move}
        style={{ fontSize: note.fontSize, color: note.color }}
        onPointerDown={(e) => {
          if (move) return;
          e.stopPropagation();
          if (eraser) onErase();
          else onEdit();
        }}
        onChange={(e) => onText(e.target.value)}
        onBlur={onBlur}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            // Blur fires onBlur (which clears editingId and prunes empty
            // boxes); onEscape then swaps the tool back to cursor.
            e.currentTarget.blur();
            onEscape();
          }
        }}
        placeholder="Type…"
      />
      <span
        className="anno-resize"
        title="Drag to resize"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
      />
    </div>
  );
}

type LineRect = { left: number; top: number; width: number; height: number };

function sameRects(
  a: Map<number, LineRect>,
  b: Map<number, LineRect>,
): boolean {
  if (a.size !== b.size) return false;
  // Tolerate sub-pixel jitter from getBoundingClientRect so layout-stable
  // re-renders don't keep flipping the rects map.
  const EPS = 0.5;
  for (const [k, r] of a) {
    const o = b.get(k);
    if (
      !o ||
      Math.abs(o.left - r.left) > EPS ||
      Math.abs(o.top - r.top) > EPS ||
      Math.abs(o.width - r.width) > EPS ||
      Math.abs(o.height - r.height) > EPS
    )
      return false;
  }
  return true;
}

function strokePath(s: Stroke): string {
  const p = s.points;
  if (p.length < 2) return "";
  let d = `M ${p[0]} ${p[1]}`;
  for (let i = 2; i < p.length; i += 2) d += ` L ${p[i]} ${p[i + 1]}`;
  return d;
}

export function AnnotationLayer({
  annotations,
  onChange,
  texts,
  onTextsChange,
  refSize,
  onRefSize,
  collapsed: collapsedProp,
  onCollapsedChange,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // Bounding rects (in host-relative px) of each line in the rendered sheet,
  // keyed by `sheet.lines` index. Used to anchor text boxes to a line so they
  // reflow with it when the layout changes.
  const [lineRects, setLineRects] = useState<
    Map<number, { left: number; top: number; width: number; height: number }>
  >(new Map());
  const [tool, setTool] = useState<Tool>("off");
  const [color, setColor] = useState(COLORS[0]);
  const [fontSize, setFontSize] = useState(16);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Two-step confirm for "Clear all": first click arms it (button turns red,
  // tooltip changes to "Click again to confirm"), second click within
  // CLEAR_CONFIRM_MS actually clears. Otherwise it auto-disarms.
  const [confirmingClear, setConfirmingClear] = useState(false);
  const clearConfirmTimer = useRef<number | null>(null);
  const [draft, setDraft] = useState<Stroke | null>(null);
  const drawing = useRef(false);
  // Multi-selection (cursor mode): strokes by array index, text boxes by id.
  const [selStrokes, setSelStrokes] = useState<Set<number>>(() => new Set());
  const [selTexts, setSelTexts] = useState<Set<string>>(() => new Set());
  // Drag-state shared between stroke and textbox initiators. Captured at
  // pointerdown so the group moves relative to its starting positions.
  type DragSnap = {
    startClientX: number;
    startClientY: number;
    strokesSnap: { index: number; points: number[] }[];
    textsSnap: { id: string; x: number; y: number }[];
    initiator: { kind: "stroke"; key: number } | { kind: "text"; key: string };
    wasSelected: boolean;
    modifier: boolean;
    moved: boolean;
  };
  const dragRef = useRef<DragSnap | null>(null);
  const [collapsedLocal, setCollapsedLocal] = useState(false);
  const collapsed = collapsedProp ?? collapsedLocal;
  const setCollapsed: Dispatch<SetStateAction<boolean>> =
    onCollapsedChange ?? setCollapsedLocal;
  const [pos, setPos] = useState({ dx: 0, dy: 0 });
  const gripDrag = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);

  // T → Text tool, P → cursor/pointer. Suppressed while a text annotation
  // is being edited or any other editable element has focus.
  useEffect(() => {
    if (editingId) return;
    const isEditable = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el.isContentEditable
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target)) return;
      // Delete-key path: only consume the keystroke when there's something
      // selected to delete; otherwise let it pass through (e.g. browser back).
      if (e.key === "Backspace" || e.key === "Delete") {
        if (selStrokes.size === 0 && selTexts.size === 0) return;
        e.preventDefault();
        onChange(annotations.filter((_, i) => !selStrokes.has(i)));
        onTextsChange(texts.filter((t) => !selTexts.has(t.id)));
        setSelStrokes(new Set());
        setSelTexts(new Set());
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "t") {
        e.preventDefault();
        setTool("text");
      } else if (k === "p") {
        e.preventDefault();
        setTool("off");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingId, selStrokes, selTexts, annotations, texts, onChange, onTextsChange]);

  // Switching to any non-cursor tool clears the selection. Selection only
  // makes sense in cursor mode.
  useEffect(() => {
    if (tool !== "off") {
      setSelStrokes(new Set());
      setSelTexts(new Set());
    }
  }, [tool]);

  // Pointerdown anywhere outside an annotation clears the selection. If the
  // click landed on a different (unselected) annotation, that annotation's
  // own pointerdown sets the new selection — net effect: the previous
  // selection drops away and the clicked one becomes selected. Toolbar
  // clicks are *not* spared so any toolbar action (or even a no-op click)
  // also deselects, matching the "click anything outside the selection"
  // mental model.
  //
  // What counts as "on an annotation": a stroke is the actual <path> element
  // inside the annotation SVG (its halo path has pointer-events: none), and
  // a textbox is anything inside `.anno-textbox`. The SVG element *itself*
  // is intentionally not spared — clicking the empty SVG area (no stroke
  // under the pointer) should clear, since browsers can deliver such a
  // click with the `<svg>` as the target rather than letting it pass
  // through to the lyrics underneath.
  useEffect(() => {
    if (selStrokes.size === 0 && selTexts.size === 0) return;
    const onWinDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      const tag = target.tagName.toLowerCase();
      if (tag === "path" && target.closest(".anno-svg")) return;
      if (target.closest(".anno-textbox")) return;
      setSelStrokes(new Set());
      setSelTexts(new Set());
    };
    window.addEventListener("pointerdown", onWinDown);
    return () => window.removeEventListener("pointerdown", onWinDown);
  }, [selStrokes, selTexts]);

  const onGripDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    gripDrag.current = { x: e.clientX, y: e.clientY, dx: pos.dx, dy: pos.dy };
  };
  const onGripMove = (e: React.PointerEvent) => {
    if (!gripDrag.current) return;
    setPos({
      dx: gripDrag.current.dx + (e.clientX - gripDrag.current.x),
      dy: gripDrag.current.dy + (e.clientY - gripDrag.current.y),
    });
  };
  const onGripUp = (e: React.PointerEvent) => {
    if (!gripDrag.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    gripDrag.current = null;
  };

  // Effective reference (the coordinate space stored annotations live in).
  // When a sheet has no ref yet, we render with identity scale and seed the
  // ref the moment something is authored (or on mount if legacy annotations
  // already exist — best-guess but locks in the current position).
  const ref =
    refSize && refSize.w > 0 && refSize.h > 0 ? refSize : size;
  const seedRefIfNeeded = useCallback(() => {
    if (!refSize && size.w > 0 && size.h > 0 && onRefSize) {
      onRefSize({ w: size.w, h: size.h });
    }
  }, [refSize, size.w, size.h, onRefSize]);
  // Legacy sheets that already have annotations/text but no stored ref:
  // adopt the current rendered size so future resizes scale from here.
  useEffect(() => {
    if (
      !refSize &&
      size.w > 0 &&
      (annotations.length > 0 || texts.length > 0) &&
      onRefSize
    ) {
      onRefSize({ w: size.w, h: size.h });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h]);

  useLayoutEffect(() => {
    const host = svgRef.current?.parentElement;
    if (!host) return;
    const measure = () => {
      setSize((prev) => {
        const w = host.scrollWidth;
        const h = host.scrollHeight;
        return prev.w === w && prev.h === h ? prev : { w, h };
      });
      const hostRect = host.getBoundingClientRect();
      const next = new Map<
        number,
        { left: number; top: number; width: number; height: number }
      >();
      host
        .querySelectorAll<HTMLElement>("[data-line-index]")
        .forEach((el) => {
          const r = el.getBoundingClientRect();
          const idx = Number(el.dataset.lineIndex);
          if (Number.isFinite(idx)) {
            next.set(idx, {
              left: r.left - hostRect.left,
              top: r.top - hostRect.top,
              width: r.width,
              height: r.height,
            });
          }
        });
      setLineRects((prev) => (sameRects(prev, next) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    // Also observe the multi-column body — its height changes on reflow even
    // when the host width doesn't.
    const body = host.querySelector(".sr-body");
    if (body) ro.observe(body);
    return () => ro.disconnect();
  }, []);


  // Convert a client (screen) coordinate into the SVG's user-space, which is
  // the reference coordinate space the stored strokes live in. Using the
  // SVG's own CTM means new strokes are recorded in ref-space regardless of
  // current rendered size — they line up with old strokes automatically.
  const point = useCallback(
    (e: { clientX: number; clientY: number }): [number, number] => {
      const svg = svgRef.current!;
      const ctm = svg.getScreenCTM();
      if (!ctm) {
        const r = svg.getBoundingClientRect();
        return [
          Math.round((e.clientX - r.left) * 10) / 10,
          Math.round((e.clientY - r.top) * 10) / 10,
        ];
      }
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const p = pt.matrixTransform(ctm.inverse());
      return [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10];
    },
    [],
  );

  // Pointer coords in the host (.sheet-render) box's current px — used for
  // anchoring text boxes, which live in current-size space (so they can be
  // attached to a line whose position is also measured in host px).
  const pointHost = useCallback(
    (e: { clientX: number; clientY: number }): [number, number] => {
      const host = svgRef.current?.parentElement;
      if (!host) return [0, 0];
      const r = host.getBoundingClientRect();
      return [
        Math.round((e.clientX - r.left) * 10) / 10,
        Math.round((e.clientY - r.top) * 10) / 10,
      ];
    },
    [],
  );

  // Find the line whose rect contains (x, y), or the closest by vertical
  // center if none does (so a click in the gutter still anchors usefully).
  const findLineAt = useCallback(
    (x: number, y: number): number | null => {
      let bestIdx: number | null = null;
      let bestDy = Infinity;
      for (const [idx, r] of lineRects) {
        if (
          x >= r.left &&
          x <= r.left + r.width &&
          y >= r.top &&
          y <= r.top + r.height
        ) {
          return idx;
        }
        const cy = r.top + r.height / 2;
        const dy = Math.abs(y - cy);
        if (dy < bestDy) {
          bestDy = dy;
          bestIdx = idx;
        }
      }
      return bestIdx;
    },
    [lineRects],
  );

  // One-time migration: any text box without an anchor — drawn before this
  // feature existed — gets attached to the line under its current position
  // and re-saved with relative coords, so future reflows track it. Gated
  // by a ref so it runs at most once per mount (any later resize will not
  // re-anchor an already-anchored box and won't shift its stored coords).
  const migratedRef = useRef(false);
  useEffect(() => {
    if (migratedRef.current) return;
    if (lineRects.size === 0 || size.w === 0 || size.h === 0) return;
    if (!texts.some((t) => !t.anchor)) {
      migratedRef.current = true;
      return;
    }
    // Convert stored coords (which may be in the previous viewBox/ref space)
    // into host px so we look up the right line.
    const sx = ref.w > 0 ? size.w / ref.w : 1;
    const sy = ref.h > 0 ? size.h / ref.h : 1;
    const migrated = texts.map((t) => {
      if (t.anchor) return t;
      const vx = t.x * sx;
      const vy = t.y * sy;
      const idx = findLineAt(vx, vy);
      if (idx == null) return t;
      const r = lineRects.get(idx);
      if (!r) return t;
      return {
        ...t,
        x: vx - r.left,
        y: vy - r.top,
        anchor: { lineIndex: idx },
      };
    });
    migratedRef.current = true;
    if (migrated.some((t, i) => t !== texts[i])) onTextsChange(migrated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineRects]);

  const eraseAt = useCallback(
    (x: number, y: number) => {
      const keep = annotations.filter((s) => {
        const lim = (ERASE_RADIUS + s.width) ** 2;
        for (let i = 0; i < s.points.length; i += 2) {
          const dx = s.points[i] - x;
          const dy = s.points[i + 1] - y;
          if (dx * dx + dy * dy <= lim) return false;
        }
        return true;
      });
      if (keep.length !== annotations.length) onChange(keep);
    },
    [annotations, onChange],
  );

  // Index of the topmost stroke whose path passes near (x, y), or -1.
  const hitStroke = useCallback(
    (x: number, y: number): number => {
      for (let s = annotations.length - 1; s >= 0; s--) {
        const pts = annotations[s].points;
        const lim = (HIT_RADIUS + annotations[s].width) ** 2;
        for (let i = 0; i < pts.length; i += 2) {
          const dx = pts[i] - x;
          const dy = pts[i + 1] - y;
          if (dx * dx + dy * dy <= lim) return s;
        }
      }
      return -1;
    },
    [annotations],
  );
  // Shared drag/selection logic, invoked from both the SVG (strokes) and
  // TextBox (text annotations). Selection updates "eagerly" at pointerdown
  // for unselected items (so they highlight as the user begins to drag);
  // already-selected items defer their resolution to pointerup so a click
  // can still toggle them off without losing them mid-drag.
  const beginDrag = (
    kind: "stroke" | "text",
    key: number | string,
    clientX: number,
    clientY: number,
    modifier: boolean,
  ) => {
    const wasSelected =
      kind === "stroke"
        ? selStrokes.has(key as number)
        : selTexts.has(key as string);
    let nextS: Set<number>;
    let nextT: Set<string>;
    if (!wasSelected) {
      if (modifier) {
        nextS = new Set(selStrokes);
        nextT = new Set(selTexts);
        if (kind === "stroke") nextS.add(key as number);
        else nextT.add(key as string);
      } else {
        nextS = kind === "stroke" ? new Set([key as number]) : new Set();
        nextT = kind === "text" ? new Set([key as string]) : new Set();
      }
      setSelStrokes(nextS);
      setSelTexts(nextT);
    } else {
      nextS = new Set(selStrokes);
      nextT = new Set(selTexts);
    }
    dragRef.current = {
      startClientX: clientX,
      startClientY: clientY,
      strokesSnap: [...nextS].map((i) => ({
        index: i,
        points: [...annotations[i].points],
      })),
      textsSnap: [...nextT]
        .map((id) => {
          const t = texts.find((x) => x.id === id);
          return t ? { id, x: t.x, y: t.y } : null;
        })
        .filter((v): v is { id: string; x: number; y: number } => v !== null),
      initiator:
        kind === "stroke"
          ? { kind: "stroke", key: key as number }
          : { kind: "text", key: key as string },
      wasSelected,
      modifier,
      moved: false,
    };
  };

  const continueDrag = (clientX: number, clientY: number) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = clientX - d.startClientX;
    const dy = clientY - d.startClientY;
    if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    d.moved = true;
    // Texts are stored in host-pixel coords; strokes are in reference (sheet)
    // coords. Translate the host-pixel delta into ref-space for strokes.
    const sw = size.w || 1;
    const sh = size.h || 1;
    const refDx = (dx * ref.w) / sw;
    const refDy = (dy * ref.h) / sh;
    if (d.textsSnap.length) {
      const m = new Map(d.textsSnap.map((t) => [t.id, t]));
      onTextsChange(
        texts.map((t) => {
          const o = m.get(t.id);
          return o ? { ...t, x: o.x + dx, y: o.y + dy } : t;
        }),
      );
    }
    if (d.strokesSnap.length) {
      const m = new Map(d.strokesSnap.map((s) => [s.index, s.points]));
      onChange(
        annotations.map((s, i) => {
          const orig = m.get(i);
          if (!orig) return s;
          return {
            ...s,
            points: orig.map((v, j) => (j % 2 === 0 ? v + refDx : v + refDy)),
          };
        }),
      );
    }
  };

  const endDrag = () => {
    const d = dragRef.current;
    if (!d) return;
    // Click without dragging: apply the deferred selection update.
    if (!d.moved && d.wasSelected) {
      if (d.modifier) {
        // Modifier+click on a selected item → toggle off.
        if (d.initiator.kind === "stroke") {
          setSelStrokes((s) => {
            const n = new Set(s);
            n.delete(d.initiator.key as number);
            return n;
          });
        } else {
          setSelTexts((s) => {
            const n = new Set(s);
            n.delete(d.initiator.key as string);
            return n;
          });
        }
      } else {
        // Plain click on a selected item: if it was the sole selection, clear.
        // Otherwise replace selection with just this item.
        const total = selStrokes.size + selTexts.size;
        if (total <= 1) {
          setSelStrokes(new Set());
          setSelTexts(new Set());
        } else {
          setSelStrokes(
            new Set(d.initiator.kind === "stroke" ? [d.initiator.key as number] : []),
          );
          setSelTexts(
            new Set(d.initiator.kind === "text" ? [d.initiator.key as string] : []),
          );
        }
      }
    }
    dragRef.current = null;
  };

  const onDown = (e: React.PointerEvent) => {
    // Cursor mode: empty-area clicks pass through (lyric selection); only a
    // stroke hit captures the pointer to select/drag that stroke.
    if (tool === "off") {
      const [x, y] = point(e);
      const idx = hitStroke(x, y);
      if (idx < 0) return;
      e.preventDefault();
      svgRef.current!.setPointerCapture(e.pointerId);
      drawing.current = true;
      const modifier = e.shiftKey || e.metaKey || e.ctrlKey;
      beginDrag("stroke", idx, e.clientX, e.clientY, modifier);
      return;
    }
    // Prevent the browser's default pointer-down focus handling — otherwise
    // it steals focus back from a freshly-created text box, blurring it
    // while empty so it's instantly removed.
    e.preventDefault();
    // Lock in the reference size the first time the user actually authors
    // something, so the new annotation's coords are interpreted in the same
    // space we'll scale from on later resizes.
    if (tool === "text" || tool === "pen") seedRefIfNeeded();
    const [x, y] = point(e);
    if (tool === "text") {
      // Anchor the box to the line under the pointer so it reflows with that
      // line when columns/layout change. x/y stored are RELATIVE to that
      // line's top-left in host px (current size).
      const [hx, hy] = pointHost(e);
      const lineIndex = findLineAt(hx, hy);
      const r = lineIndex != null ? lineRects.get(lineIndex) : undefined;
      const id = crypto.randomUUID();
      const note: TextNote =
        lineIndex != null && r
          ? {
              id,
              x: hx - r.left,
              y: hy - r.top,
              text: "",
              fontSize,
              color,
              anchor: { lineIndex },
            }
          : { id, x, y, text: "", fontSize, color };
      onTextsChange([...texts, note]);
      setEditingId(id);
      return;
    }
    svgRef.current!.setPointerCapture(e.pointerId);
    drawing.current = true;
    if (tool === "eraser") eraseAt(x, y);
    else setDraft({ color, width: PEN_WIDTH, points: [x, y] });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    if (dragRef.current) {
      continueDrag(e.clientX, e.clientY);
      return;
    }
    const [x, y] = point(e);
    if (tool === "eraser") eraseAt(x, y);
    else setDraft((d) => (d ? { ...d, points: [...d.points, x, y] } : d));
  };

  const onUp = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    drawing.current = false;
    svgRef.current?.releasePointerCapture(e.pointerId);
    if (dragRef.current) {
      endDrag();
      return;
    }
    if (draft && draft.points.length >= 2) onChange([...annotations, draft]);
    setDraft(null);
  };

  const updateText = (id: string, patch: Partial<TextNote>) =>
    onTextsChange(texts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const removeText = (id: string) => {
    onTextsChange(texts.filter((t) => t.id !== id));
    if (editingId === id) setEditingId(null);
  };

  const setSizeFor = (next: number) => {
    const v = Math.min(MAX_FONT, Math.max(MIN_FONT, next));
    setFontSize(v);
    if (editingId) updateText(editingId, { fontSize: v });
  };

  const CLEAR_CONFIRM_MS = 3000;
  const clearAll = () => {
    if (!confirmingClear) {
      setConfirmingClear(true);
      if (clearConfirmTimer.current)
        window.clearTimeout(clearConfirmTimer.current);
      clearConfirmTimer.current = window.setTimeout(() => {
        setConfirmingClear(false);
        clearConfirmTimer.current = null;
      }, CLEAR_CONFIRM_MS);
      return;
    }
    if (clearConfirmTimer.current) {
      window.clearTimeout(clearConfirmTimer.current);
      clearConfirmTimer.current = null;
    }
    setConfirmingClear(false);
    onChange([]);
    onTextsChange([]);
  };
  // Cleanup the confirm timer on unmount.
  useEffect(
    () => () => {
      if (clearConfirmTimer.current)
        window.clearTimeout(clearConfirmTimer.current);
    },
    [],
  );

  // The SVG always accepts events so a click on a painted stroke can start a
  // drag in cursor mode; empty SVG areas pass through to the lyrics underneath
  // (we omit the transparent backdrop rect when `tool === "off"`).
  const interactive = true;
  // Text boxes need pointer events for all tools except pen drawing.
  const textHit = tool !== "pen";
  const empty = annotations.length === 0 && texts.length === 0;

  return (
    <>
      <div
        className={`anno-toolbar${collapsed ? " is-collapsed" : ""}`}
        style={{ transform: `translate(${pos.dx}px, ${pos.dy}px)` }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          className="anno-btn anno-grip"
          title="Drag to move toolbar"
          aria-label="Move toolbar"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
        >
          {GripIcon}
        </button>
        {!collapsed && (
          <>
            <button className={`anno-btn${tool === "off" ? " active" : ""}`}
              onClick={() => setTool("off")}
              title="Cursor (P) — select text on empty areas, drag annotations when hovering"
              aria-label="Cursor">{CursorIcon}</button>
            {COLORS.map((c) => (
              <button key={c}
                className={`anno-swatch${tool === "pen" && color === c ? " active" : ""}`}
                style={{ background: c }}
                onClick={() => { setColor(c); setTool("pen"); }}
                title="Pen" aria-label={`Pen ${c}`} />
            ))}
            <button className={`anno-btn${tool === "text" ? " active" : ""}`}
              onClick={() => setTool("text")} title="Text box (T)" aria-label="Text box"
              style={{ fontWeight: 700 }}>T</button>
            <div className="anno-fontsize" title="Font size">
              <button className="anno-btn" onClick={() => setSizeFor(fontSize - 2)}
                aria-label="Smaller font">−</button>
              <span>{fontSize}</span>
              <button className="anno-btn" onClick={() => setSizeFor(fontSize + 2)}
                aria-label="Larger font">+</button>
            </div>
            <button className={`anno-btn${tool === "eraser" ? " active" : ""}`}
              onClick={() => setTool("eraser")} title="Eraser (removes whole strokes)"
              aria-label="Eraser">{EraserIcon}</button>
            <button
              className={`anno-btn${confirmingClear ? " is-confirming" : ""}`}
              onClick={clearAll}
              disabled={empty}
              title={
                confirmingClear
                  ? "Click again to confirm — this removes all pen and text annotations"
                  : "Clear all annotations"
              }
              aria-label={confirmingClear ? "Confirm clear all" : "Clear all"}
            >
              {TrashIcon}
            </button>
          </>
        )}
        <button
          className="anno-btn anno-collapse"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Show annotation tools" : "Hide annotation tools"}
          aria-label={collapsed ? "Show annotation tools" : "Hide annotation tools"}
        >
          {collapsed ? PencilIcon : CollapseIcon}
        </button>
      </div>

      <svg
        ref={svgRef}
        className="anno-svg"
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${ref.w || 1} ${ref.h || 1}`}
        preserveAspectRatio="none"
        style={{
          pointerEvents: interactive ? "auto" : "none",
          cursor:
            tool === "eraser"
              ? "cell"
              : tool === "text"
                ? "text"
                : tool === "pen"
                  ? "crosshair"
                  : "default",
        }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {/* Backdrop catches clicks across empty SVG areas. Omitted in cursor
            mode so empty-area clicks fall through to the lyrics. */}
        {tool !== "off" && (
          <rect x={0} y={0} width={ref.w} height={ref.h} fill="transparent" />
        )}
        {/* Selection halos render under the strokes so the original color
            stays readable. */}
        {tool === "off" && annotations.map((s, i) =>
          selStrokes.has(i) ? (
            <path
              key={`sel-${i}`}
              d={strokePath(s)}
              stroke="rgba(42,108,220,0.35)"
              strokeWidth={s.width + 8}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          ) : null,
        )}
        {annotations.map((s, i) => (
          <path key={i} d={strokePath(s)} stroke={s.color} strokeWidth={s.width}
            fill="none" strokeLinecap="round" strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            style={tool === "off" ? { cursor: "move" } : undefined} />
        ))}
        {draft && (
          <path d={strokePath(draft)} stroke={draft.color} strokeWidth={draft.width}
            fill="none" strokeLinecap="round" strokeLinejoin="round"
            vectorEffect="non-scaling-stroke" />
        )}
      </svg>

      {/* Text boxes are positioned per-anchor against the current line rect,
          so they reflow when the layout changes (e.g., 2-col ↔ 1-col).
          Unanchored boxes render at their absolute coords until the
          auto-migration effect attaches them to a line. */}
      {texts.map((t) => {
        const r = t.anchor ? lineRects.get(t.anchor.lineIndex) : null;
        const offX = r ? r.left : 0;
        const offY = r ? r.top : 0;
        return (
          <TextBox
            key={t.id}
            note={t}
            editing={editingId === t.id}
            selected={selTexts.has(t.id)}
            eraser={tool === "eraser"}
            // Cursor mode: text boxes are draggable like the old "move" tool.
            move={tool === "off"}
            pointerEvents={textHit ? "auto" : "none"}
            offsetX={offX}
            offsetY={offY}
            scaleX={1}
            scaleY={1}
            onText={(text) => updateText(t.id, { text })}
            onResize={(w, h) => updateText(t.id, { w, h })}
            onEdit={() => setEditingId(t.id)}
            onActivateText={() => {
              setTool("text");
              setEditingId(t.id);
            }}
            onErase={() => removeText(t.id)}
            onBlur={() => {
              if (!t.text.trim()) removeText(t.id);
              setEditingId((cur) => (cur === t.id ? null : cur));
            }}
            onEscape={() => setTool("off")}
            onSelectDown={(id, cx, cy, modifier) =>
              beginDrag("text", id, cx, cy, modifier)
            }
            onSelectMove={(cx, cy) => continueDrag(cx, cy)}
            onSelectUp={() => endDrag()}
          />
        );
      })}
    </>
  );
}

import { useCallback, useLayoutEffect, useRef, useState } from "react";
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

const MoveIcon = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3" />
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
  eraser: boolean;
  move: boolean;
  pointerEvents: "auto" | "none";
  onText: (text: string) => void;
  onResize: (w?: number, h?: number) => void;
  onMove: (x: number, y: number) => void;
  onEdit: () => void;
  onErase: () => void;
  onBlur: () => void;
}

function TextBox({
  note, editing, eraser, move, pointerEvents,
  onText, onResize, onMove, onEdit, onErase, onBlur,
}: TextBoxProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const min = useRef({ w: 0, h: 0 });
  const drag = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  // Measure the text's true extent via a hidden mirror (a textarea has a
  // default intrinsic width and never shrinks to its content), so the box's
  // minimum size is exactly the text.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const mirror = mirrorRef.current;
    if (!box || !mirror) return;
    const cw = mirror.offsetWidth + 2; // +2 for the caret
    const ch = mirror.offsetHeight;
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
    const w = Math.max(min.current.w, drag.current.w + (e.clientX - drag.current.x));
    const h = Math.max(min.current.h, drag.current.h + (e.clientY - drag.current.y));
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

  // Drag the whole box to reposition it (Move tool).
  const moveDrag = useRef<{ x: number; y: number; nx: number; ny: number } | null>(null);
  const onBoxDown = (e: React.PointerEvent) => {
    if (!move) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    moveDrag.current = { x: e.clientX, y: e.clientY, nx: note.x, ny: note.y };
  };
  const onBoxMove = (e: React.PointerEvent) => {
    if (!moveDrag.current) return;
    onMove(
      moveDrag.current.nx + (e.clientX - moveDrag.current.x),
      moveDrag.current.ny + (e.clientY - moveDrag.current.y),
    );
  };
  const onBoxUp = (e: React.PointerEvent) => {
    if (!moveDrag.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    moveDrag.current = null;
  };

  return (
    <div
      ref={boxRef}
      className={`anno-textbox${move ? " is-move" : ""}`}
      style={{ left: note.x, top: note.y, pointerEvents }}
      onPointerDown={onBoxDown}
      onPointerMove={onBoxMove}
      onPointerUp={onBoxUp}
      onPointerCancel={onBoxUp}
    >
      <div
        ref={mirrorRef}
        className="anno-text anno-mirror"
        style={{ fontSize: note.fontSize }}
        aria-hidden="true"
      >
        {note.text.length ? note.text : " "}
      </div>
      <textarea
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

function strokePath(s: Stroke): string {
  const p = s.points;
  if (p.length < 2) return "";
  let d = `M ${p[0]} ${p[1]}`;
  for (let i = 2; i < p.length; i += 2) d += ` L ${p[i]} ${p[i + 1]}`;
  return d;
}

export function AnnotationLayer({ annotations, onChange, texts, onTextsChange }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tool, setTool] = useState<Tool>("off");
  const [color, setColor] = useState(COLORS[0]);
  const [fontSize, setFontSize] = useState(16);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Stroke | null>(null);
  const drawing = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const [pos, setPos] = useState({ dx: 0, dy: 0 });
  const gripDrag = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);

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

  useLayoutEffect(() => {
    const host = svgRef.current?.parentElement;
    if (!host) return;
    const measure = () =>
      setSize((prev) => {
        const w = host.scrollWidth;
        const h = host.scrollHeight;
        return prev.w === w && prev.h === h ? prev : { w, h };
      });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const point = useCallback((e: { clientX: number; clientY: number }): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return [
      Math.round((e.clientX - r.left) * 10) / 10,
      Math.round((e.clientY - r.top) * 10) / 10,
    ];
  }, []);

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
  const strokeDrag = useRef<{ index: number; x: number; y: number; pts: number[] } | null>(null);

  const onDown = (e: React.PointerEvent) => {
    if (tool === "off") return;
    // Prevent the browser's default pointer-down focus handling — otherwise
    // it steals focus back from a freshly-created text box, blurring it
    // while empty so it's instantly removed.
    e.preventDefault();
    const [x, y] = point(e);
    if (tool === "text") {
      const id = crypto.randomUUID();
      onTextsChange([...texts, { id, x, y, text: "", fontSize, color }]);
      setEditingId(id);
      return;
    }
    if (tool === "move") {
      const idx = hitStroke(x, y);
      if (idx < 0) return;
      svgRef.current!.setPointerCapture(e.pointerId);
      drawing.current = true;
      strokeDrag.current = { index: idx, x, y, pts: [...annotations[idx].points] };
      return;
    }
    svgRef.current!.setPointerCapture(e.pointerId);
    drawing.current = true;
    if (tool === "eraser") eraseAt(x, y);
    else setDraft({ color, width: PEN_WIDTH, points: [x, y] });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const [x, y] = point(e);
    if (tool === "move" && strokeDrag.current) {
      const sd = strokeDrag.current;
      const dx = x - sd.x;
      const dy = y - sd.y;
      const moved = sd.pts.map((v, i) => (i % 2 === 0 ? v + dx : v + dy));
      onChange(annotations.map((s, i) => (i === sd.index ? { ...s, points: moved } : s)));
      return;
    }
    if (tool === "eraser") eraseAt(x, y);
    else setDraft((d) => (d ? { ...d, points: [...d.points, x, y] } : d));
  };

  const onUp = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    drawing.current = false;
    svgRef.current?.releasePointerCapture(e.pointerId);
    if (strokeDrag.current) {
      strokeDrag.current = null;
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

  const clearAll = () => {
    onChange([]);
    onTextsChange([]);
  };

  const interactive = tool !== "off";
  const textHit = tool === "text" || tool === "eraser" || tool === "move";
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
              onClick={() => setTool("off")} title="Stop annotating (scroll / select text)"
              aria-label="Cursor">{CursorIcon}</button>
            <button className={`anno-btn${tool === "move" ? " active" : ""}`}
              onClick={() => setTool("move")} title="Move strokes & text boxes"
              aria-label="Move">{MoveIcon}</button>
            {COLORS.map((c) => (
              <button key={c}
                className={`anno-swatch${tool === "pen" && color === c ? " active" : ""}`}
                style={{ background: c }}
                onClick={() => { setColor(c); setTool("pen"); }}
                title="Pen" aria-label={`Pen ${c}`} />
            ))}
            <button className={`anno-btn${tool === "text" ? " active" : ""}`}
              onClick={() => setTool("text")} title="Text box" aria-label="Text box"
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
            <button className="anno-btn" onClick={clearAll} disabled={empty}
              title="Clear all annotations" aria-label="Clear all">{TrashIcon}</button>
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

      <svg ref={svgRef} className="anno-svg" width={size.w} height={size.h}
        style={{
          pointerEvents: interactive ? "auto" : "none",
          cursor: tool === "eraser" ? "cell" : tool === "text" ? "text" : tool === "move" ? "move" : interactive ? "crosshair" : "default",
        }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {/* Transparent backdrop so clicks anywhere (not just on painted
            strokes) register — an SVG only hit-tests painted pixels. */}
        <rect x={0} y={0} width={size.w} height={size.h} fill="transparent" />
        {annotations.map((s, i) => (
          <path key={i} d={strokePath(s)} stroke={s.color} strokeWidth={s.width}
            fill="none" strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {draft && (
          <path d={strokePath(draft)} stroke={draft.color} strokeWidth={draft.width}
            fill="none" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>

      {texts.map((t) => (
        <TextBox
          key={t.id}
          note={t}
          editing={editingId === t.id}
          eraser={tool === "eraser"}
          move={tool === "move"}
          pointerEvents={textHit ? "auto" : "none"}
          onText={(text) => updateText(t.id, { text })}
          onResize={(w, h) => updateText(t.id, { w, h })}
          onMove={(x, y) => updateText(t.id, { x, y })}
          onEdit={() => setEditingId(t.id)}
          onErase={() => removeText(t.id)}
          onBlur={() => {
            if (!t.text.trim()) removeText(t.id);
            setEditingId((cur) => (cur === t.id ? null : cur));
          }}
        />
      ))}
    </>
  );
}

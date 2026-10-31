import useStore from '../../store/index.js';

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

const TYPE_COLOR = {
  online:  '#00c864',
  offline: '#e03060',
  keylog:  '#f0c030',
  bank:    '#e03060',
  unlock:  '#9855e8',
  inject:  '#3b7af0',
  cmd:     '#d4950a',
  vnc:     '#3b7af0',
  nfc:     '#22d3ee',
  loc:     '#00c864',
  sys:     '#8a7a60',
};

const TYPE_ICON = {
  online:  '📱',
  offline: '📴',
  keylog:  '⌨',
  bank:    '🏦',
  unlock:  '🔓',
  inject:  '💉',
  cmd:     '⚡',
  nfc:     '📡',
  loc:     '📍',
  sys:     '🔧',
};

export default function Notifications() {
  const events = useStore(s => s.events);

  return (
    <div className="fade-up">
      <div className="section-title mb12">
        <span className="section-icon">🔔</span>
        Notificações em Tempo Real
        <span className="pill pill-gold" style={{ marginLeft: 8, fontSize: 10 }}>{events.length}</span>
      </div>

      {events.length === 0 && (
        <div className="no-data" style={{ marginTop: 60 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🔔</div>
          <div>Aguardando eventos...</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {events.map((ev, i) => (
          <div key={i} className="card card-sm"
            style={{ borderLeftWidth: 3, borderLeftColor: TYPE_COLOR[ev.type] || '#8a7a60', borderLeftStyle: 'solid' }}>
            <div className="row-sb">
              <div className="row gap8">
                <span style={{ fontSize: 16 }}>{TYPE_ICON[ev.type] || '●'}</span>
                <span className="txt-sm" style={{ color: TYPE_COLOR[ev.type] || 'var(--text2)', wordBreak: 'break-all' }}>
                  {ev.text}
                </span>
              </div>
              <span className="txt-xs txt-dim" style={{ flexShrink: 0, marginLeft: 8 }}>{fmtTime(ev.ts)}</span>
            </div>
          </div>
        ))}
      </div>

      <div style={{ height: 20 }} />
    </div>
  );
}

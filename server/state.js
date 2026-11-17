'use strict';

// ── Live connections ───────────────────────────────────────────────────────────
const devices    = new Map();   // device_id → { ws, deviceId, ip, lastSeen }
const dashboards = new Set();   // Set<WebSocket>

// Stream subscribers
const vncSubs    = new Map();   // device_id → Set<ws>
const cameraSubs = new Map();
const audioSubs  = new Map();

// Offline command queue
const commandQueue = new Map(); // device_id → Array<{ msg, ts }>
const CMD_QUEUE_MAX = 50;

// Per-(ws, device_id) rate limit for VNC frames
// WeakMap<ws, Map<device_id, lastSentMs>>
const vncRateLimiter = new WeakMap();
const VNC_MIN_MS = Math.floor(1000 / 60); // 60 fps cap

// Backpressure threshold: skip sending to a subscriber if its send buffer
// exceeds this limit — prevents memory spiral when dashboard is on a slow link.
const VNC_BACKPRESSURE_BYTES = 256 * 1024; // 256 KB

function getOrCreate(map, key) {
  if (!map.has(key)) map.set(key, new Set());
  return map.get(key);
}

function isOpen(ws) { return ws && ws.readyState === 1; }

// ── Broadcast helpers ─────────────────────────────────────────────────────────
function broadcastAll(msg) {
  const str = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const ws of dashboards)
    if (isOpen(ws)) { try { ws.send(str); } catch (_) {} }
}

function broadcastToSubs(subsMap, deviceId, msg) {
  const subs = subsMap.get(deviceId);
  if (!subs || subs.size === 0) return;
  const isBin = Buffer.isBuffer(msg) || msg instanceof ArrayBuffer;
  const str   = isBin ? null : (typeof msg === 'string' ? msg : JSON.stringify(msg));
  for (const ws of subs) {
    if (!isOpen(ws)) continue;
    try { isBin ? ws.send(msg, { binary: true }) : ws.send(str); } catch (_) {}
  }
}

// ── VNC relay — hot path ──────────────────────────────────────────────────────
// Called up to 60× per second per device. Every micro-optimisation here matters.
function relayVncFrame(deviceId, jpegBuf) {
  const subs = vncSubs.get(deviceId);
  if (!subs || subs.size === 0) return;

  const now = Date.now();
  // Build the JSON header ONCE per frame, not once per subscriber.
  // {type,device_id,ts} is ~50 bytes; reuse the same Buffer for all subs.
  // Build ONCE per frame, reuse across all subscribers.
  // Must be a string (text frame opcode 0x01) so the client's JSON.parse
  // path fires. Sending a Buffer auto-promotes to binary (opcode 0x02),
  // which the client would treat as a JPEG frame — breaking the stream.
  const header = `{"type":"vnc_meta","device_id":"${deviceId}","ts":${now}}`;

  for (const ws of subs) {
    if (!isOpen(ws)) continue;

    // ── Backpressure guard ──────────────────────────────────────────────────
    // ws.bufferedAmount is the number of bytes queued in the Node.js send buffer.
    // If it's backing up, the subscriber cannot consume frames fast enough —
    // skip this frame entirely rather than growing the buffer unboundedly.
    if (ws.bufferedAmount > VNC_BACKPRESSURE_BYTES) continue;

    // ── 60 fps rate limiter per (ws, deviceId) ──────────────────────────────
    if (!vncRateLimiter.has(ws)) vncRateLimiter.set(ws, new Map());
    const devMap = vncRateLimiter.get(ws);
    const last   = devMap.get(deviceId) || 0;
    if (now - last < VNC_MIN_MS) continue;
    devMap.set(deviceId, now);

    // ── Send: JSON header + binary JPEG frame ───────────────────────────────
    try {
      ws.send(header);              // text frame — client JSON.parse → sets _pendingVncId
      ws.send(jpegBuf, { binary: true });        // raw JPEG bytes
    } catch (_) {}
  }
}

// ── Command helpers ───────────────────────────────────────────────────────────
function sendToDevice(deviceId, msg) {
  const dev = devices.get(deviceId);
  if (!dev || !isOpen(dev.ws)) return false;
  const str = typeof msg === 'string' ? msg : JSON.stringify(msg);
  try { dev.ws.send(str); return true; } catch (_) { return false; }
}

function queueOrSend(deviceId, msg) {
  if (sendToDevice(deviceId, msg)) return { sent: true, queued: false };
  if (!commandQueue.has(deviceId)) commandQueue.set(deviceId, []);
  const q = commandQueue.get(deviceId);
  if (q.length < CMD_QUEUE_MAX) q.push({ msg, ts: Date.now() });
  return { sent: false, queued: true };
}

function flushQueue(deviceId) {
  const q = commandQueue.get(deviceId);
  if (!q || q.length === 0) return 0;
  let flushed = 0;
  for (const { msg } of q) if (sendToDevice(deviceId, msg)) flushed++;
  commandQueue.delete(deviceId);
  return flushed;
}

function removeFromAllSubs(ws) {
  for (const map of [vncSubs, cameraSubs, audioSubs])
    for (const subs of map.values()) subs.delete(ws);
}

module.exports = {
  devices, dashboards,
  vncSubs, cameraSubs, audioSubs,
  commandQueue,
  broadcastAll, broadcastToSubs, relayVncFrame,
  sendToDevice, queueOrSend, flushQueue,
  removeFromAllSubs, getOrCreate,
};

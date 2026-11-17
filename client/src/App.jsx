import { useEffect } from 'react';
import useStore from './store/index.js';
import { ws } from './ws.js';
import TopBar       from './components/TopBar.jsx';
import BottomNav    from './components/BottomNav.jsx';
import Overview     from './components/pages/Overview.jsx';
import Android      from './components/pages/Android.jsx';
import Notifications from './components/pages/Notifications.jsx';
import Logs         from './components/pages/Logs.jsx';

function Windows() {
  return (
    <div className="fade-up">
      <div className="no-data" style={{ marginTop: 60 }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🖥</div>
        <div>Módulo Windows não configurado</div>
      </div>
    </div>
  );
}

export default function App() {
  const tab = useStore(s => s.tab);

  useEffect(() => {
    // WS sends device_list + online_set + stats on connect via _sendInitialState.
    // HTTP fetch of /api/stats is kept only for initial skeleton before WS connects.
    ws.connect();
    fetch('/api/stats')
      .then(r => r.json())
      .then(s => useStore.getState().setStats(s))
      .catch(() => {});
    // /api/devices removed — device_list from WS is the authoritative source
    // and avoids the race where HTTP replaces real-time online status.
  }, []);

  const PAGES = {
    overview:      <Overview />,
    android:       <Android />,
    windows:       <Windows />,
    notifications: <Notifications />,
    logs:          <Logs />,
  };

  return (
    <>
      <div className="bg-art" />
      <div className="app-wrap">
        <TopBar />
        <div className="main-scroll">
          {PAGES[tab] || <Overview />}
        </div>
        <BottomNav />
      </div>
    </>
  );
}

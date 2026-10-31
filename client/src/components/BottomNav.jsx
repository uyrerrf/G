import useStore from '../store/index.js';

const TABS = [
  { id: 'overview',      icon: '⊞',  label: 'Overview'      },
  { id: 'android',       icon: '📱',  label: 'Android'       },
  { id: 'windows',       icon: '🖥',  label: 'Windows'       },
  { id: 'notifications', icon: '🔔',  label: 'Notificações'  },
  { id: 'logs',          icon: '📋',  label: 'Logs',  extra: true },
  { id: 'logout',        icon: '⏏',   label: 'LOGOUT', danger: true },
];

export default function BottomNav() {
  const tab    = useStore(s => s.tab);
  const setTab = useStore(s => s.setTab);

  function handleTab(id) {
    if (id === 'logout') {
      if (confirm('Sair do OXY?')) window.location.reload();
      return;
    }
    setTab(id);
  }

  // Show 5 tabs on mobile — hide Logs in collapsed view
  const visible = TABS.filter(t => !t.extra);

  return (
    <nav className="bottom-nav">
      <div className="nav-items">
        {visible.map(t => (
          <div
            key={t.id}
            className={`nav-item ${tab === t.id ? 'active' : ''} ${t.danger ? 'logout' : ''}`}
            onClick={() => handleTab(t.id)}
          >
            <span className="icon">{t.icon}</span>
            <span>{t.label}</span>
          </div>
        ))}
      </div>
    </nav>
  );
}

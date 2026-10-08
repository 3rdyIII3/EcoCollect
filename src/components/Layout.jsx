import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import Topbar from './Topbar.jsx';

/** Sidebar definition, gated by role exactly as the PHP layout did. */
function navSections({ isAdmin, isStaff }) {
  const sections = [];

  sections.push({
    label: 'MAIN',
    items: [{ to: '/dashboard', icon: 'bi-speedometer2', label: 'Dashboard' }],
  });

  if (isAdmin) {
    sections.push({
      label: 'MANAGEMENT',
      items: [
        { to: '/barangays', icon: 'bi-geo-alt', label: 'Barangays' },
        { to: '/collectors', icon: 'bi-people', label: 'Collectors', disabled: true },
        { to: '/users', icon: 'bi-person-gear', label: 'Users', disabled: true },
        { to: '/schedules', icon: 'bi-calendar-week', label: 'Schedules', disabled: true },
      ],
    });
  }

  sections.push({
    label: 'COLLECTIONS',
    items: [
      { to: '/qr-scanner', icon: 'bi-qr-code-scan', label: 'Scan QR', disabled: true },
      { to: '/collection-add', icon: 'bi-plus-circle', label: 'Record Collection' },
      { to: '/collections', icon: 'bi-trash', label: isStaff ? 'All Collections' : 'My Collections' },
      ...(isAdmin
        ? [{ to: '/qr-codes', icon: 'bi-qr-code', label: 'QR Codes', disabled: true }]
        : []),
    ],
  });

  if (isStaff) {
    sections.push({
      label: 'REPORTS',
      items: [
        { to: '/reports', icon: 'bi-graph-up', label: 'Analytics', disabled: true },
        { to: '/rankings', icon: 'bi-trophy', label: 'Rankings', disabled: true },
      ],
    });
  }

  sections.push({
    label: 'OPERATIONS',
    items: [
      { to: '/dumping', icon: 'bi-exclamation-triangle', label: 'Dumping Reports', disabled: true },
      ...(isStaff
        ? [{ to: '/notifications', icon: 'bi-bell', label: 'Notifications', disabled: true }]
        : []),
      ...(isAdmin ? [{ to: '/settings', icon: 'bi-gear', label: 'Settings', disabled: true }] : []),
    ],
  });

  return sections;
}

export default function Layout() {
  const { user, isAdmin, isStaff, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => setOpen(false), [location.pathname]);

  // Unread badge. Polls rather than streams; the original app also polled on load.
  useEffect(() => {
    if (!isStaff) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api.get('/api/notifications?unread_count=1');
        if (!cancelled) setUnread(data?.unread || 0);
      } catch {
        /* badge is cosmetic; ignore failures */
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isStaff, location.pathname]);

  const sections = navSections({ isAdmin, isStaff });

  return (
    <div className="d-flex">
      <nav className={`sidebar${open ? ' show' : ''}`} id="sidebar">
        <div className="sidebar-brand">
          <i className="bi bi-recycle"></i>
          <span>EcoCollect</span>
        </div>
        <ul className="sidebar-nav">
          {sections.flatMap((section) => [
            <li key={`${section.label}-label`} className="nav-section">
              {section.label}
            </li>,
            ...section.items.map((item) => (
              <li key={item.to}>
                {item.disabled ? (
                  // Not yet ported: still a real link, but pointed at the
                  // placeholder page rather than nowhere, and locked-looking.
                  <NavLink to={item.to} className="text-muted" title="Coming in the next pass">
                    <i className={`bi ${item.icon}`}></i>
                    <span>{item.label}</span>
                    <i className="bi bi-lock-fill ms-auto small opacity-50"></i>
                  </NavLink>
                ) : (
                  <NavLink to={item.to}>
                    <i className={`bi ${item.icon}`}></i>
                    <span>{item.label}</span>
                  </NavLink>
                )}
              </li>
            )),
          ])}
        </ul>
      </nav>

      {open && <div className="sidebar-backdrop" onClick={() => setOpen(false)} />}

      <div className="main-content">
        <Topbar unread={unread} user={user} onLogout={async () => {
          await logout();
          navigate('/login', { replace: true });
        }} />
        <div className="content-wrapper">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function Topbar({ unread, user, onLogout }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [items, setItems] = useState([]);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!bellOpen) return undefined;
    let cancelled = false;
    api
      .get('/api/notifications?limit=6')
      .then((d) => {
        if (!cancelled && d?.items) setItems(d.items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bellOpen]);

  // Close on outside click / Escape, so the menus behave like real dropdowns.
  useEffect(() => {
    if (!menuOpen && !bellOpen) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setMenuOpen(false);
        setBellOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setBellOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, bellOpen]);

  const initial = (user?.full_name || user?.username || '?').trim().charAt(0).toUpperCase();

  return (
    <nav className="top-navbar" ref={rootRef}>
      <button
        className="btn btn-link sidebar-toggle"
        onClick={() => document.getElementById('sidebar')?.classList.toggle('show')}
        aria-label="Toggle navigation"
      >
        <i className="bi bi-list fs-4"></i>
      </button>

      <div className="d-flex align-items-center gap-1 ms-auto">
        <div className="position-relative">
          <button
            className="btn btn-link position-relative"
            onClick={() => {
              setBellOpen((v) => !v);
              setMenuOpen(false);
            }}
            aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
          >
            <i className="bi bi-bell fs-5"></i>
            {unread > 0 && (
              <span className="position-absolute top-0 start-100 translate-middle badge rounded-pill bg-danger">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>

          {bellOpen && (
            <div
              className="dropdown-menu dropdown-menu-end show notification-dropdown"
              style={{ width: 350, maxHeight: 400, overflowY: 'auto', display: 'block' }}
            >
              <h6 className="dropdown-header">Notifications</h6>
              {items.length === 0 ? (
                <div className="dropdown-item text-muted text-center py-3">
                  {unread ? 'Loading…' : 'No notifications'}
                </div>
              ) : (
                items.map((n) => (
                  <div key={n.id} className={`dropdown-item${n.is_read ? '' : ' bg-light'}`}>
                    <div className="fw-semibold small">{n.title}</div>
                    <div className="text-muted" style={{ fontSize: '0.8rem' }}>
                      {n.message}
                    </div>
                    <div className="text-muted" style={{ fontSize: '0.7rem' }}>
                      {timeAgo(n.created_at)}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div className="position-relative">
          <button
            className="btn btn-link dropdown-toggle d-flex align-items-center"
            onClick={() => {
              setMenuOpen((v) => !v);
              setBellOpen(false);
            }}
          >
            <div className="avatar me-2">{initial}</div>
            <span className="d-none d-md-inline">{user?.full_name}</span>
          </button>

          {menuOpen && (
            <ul className="dropdown-menu dropdown-menu-end show" style={{ display: 'block' }}>
              <li>
                <span className="dropdown-item-text text-muted small">
                  {user?.role?.charAt(0).toUpperCase() + (user?.role?.slice(1) || '')}
                </span>
              </li>
              <li>
                <hr className="dropdown-divider" />
              </li>
              <li>
                <button className="dropdown-item text-danger" onClick={onLogout}>
                  <i className="bi bi-box-arrow-left me-2"></i>Logout
                </button>
              </li>
            </ul>
          )}
        </div>
      </div>
    </nav>
  );
}

import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import AdminLogin from './pages/AdminLogin.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Collections from './pages/Collections.jsx';
import Barangays from './pages/Barangays.jsx';
import NotPorted from './pages/NotPorted.jsx';

function FullPageSpinner() {
  return (
    <div className="d-flex align-items-center justify-content-center vh-100">
      <div className="spinner-border text-primary" role="status">
        <span className="visually-hidden">Loading…</span>
      </div>
    </div>
  );
}

/** Blocks a route until the session is known, then enforces the role requirement. */
function Protected({ children, require }) {
  const { user, loading, isAdmin, isSupervisor } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;

  // An account still on its published default password can reach nothing else.
  // The exception is this very route: without it, Protected would redirect to
  // /change-password, which renders Protected, and bounce forever.
  if (user.must_change_password && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }

  // Role checks come after, and every one of these is enforced again server-side -
  // this only decides what to render, never what is permitted.
  if (require === 'admin' && !isAdmin) return <Navigate to="/dashboard" replace />;
  if (require === 'staff' && !isAdmin && !isSupervisor) return <Navigate to="/dashboard" replace />;

  return children;
}

/** Sends an already-signed-in visitor away from /login. */
function PublicOnly({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (user) return <Navigate to="/dashboard" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicOnly>
            <Login />
          </PublicOnly>
        }
      />

      {/* Presentation-only split. Same endpoint, same throttle, same CSRF check as
          /login - the admin page additionally refuses non-admin roles client-side,
          which is convenience rather than enforcement. Every admin API already
          re-checks the role server-side. */}
      <Route
        path="/admin/login"
        element={
          <PublicOnly>
            <AdminLogin />
          </PublicOnly>
        }
      />

      {/* Sits outside the Layout shell on purpose: no sidebar, no data, nothing but
          the form, until the default password is replaced. */}
      <Route
        path="/change-password"
        element={
          <Protected>
            <ChangePassword />
          </Protected>
        }
      />

      <Route
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />

        {/* Collections: every role can record and list; the API scopes collectors
            to their own rows. */}
        <Route path="/collections" element={<Collections />} />
        <Route path="/collection-add" element={<Collections mode="create" />} />

        <Route
          path="/barangays"
          element={
            <Protected require="admin">
              <Barangays />
            </Protected>
          }
        />
        <Route
          path="/barangay-add"
          element={
            <Protected require="admin">
              <Barangays mode="create" />
            </Protected>
          }
        />
        <Route
          path="/barangay-edit/:id"
          element={
            <Protected require="admin">
              <Barangays mode="edit" />
            </Protected>
          }
        />
        <Route
          path="/barangay-view/:id"
          element={
            <Protected require="admin">
              <Barangays mode="view" />
            </Protected>
          }
        />

        {/* Still to be ported in the next pass - listed so the sidebar is honest
            about what exists rather than linking to blank pages. */}
        <Route
          path="/:rest*"
          element={
            <NotPorted
              planned={[
                '/collectors',
                '/users',
                '/schedules',
                '/qr-scanner',
                '/qr-codes',
                '/notifications',
                '/settings',
                '/dumping',
                '/reports',
                '/rankings',
              ]}
            />
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

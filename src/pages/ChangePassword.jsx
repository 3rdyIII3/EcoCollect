import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';

/**
 * Forced password change.
 *
 * Reached when a session's user still has must_change_password set - true for any
 * account seeded with the published default password. The shell blocks every other
 * route until this one completes, so the change cannot be skipped by navigating.
 */
export default function ChangePassword() {
  const { user, refresh, logout } = useAuth();
  const navigate = useNavigate();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;

    if (next !== confirm) {
      setError('The new passwords do not match.');
      return;
    }

    setError('');
    setBusy(true);
    try {
      await api.post('/api/auth/password', {
        current_password: current,
        new_password: next,
      });
      // Clear the field holding the old password, so it is not left sitting in the
      // DOM (and in browser memory) after a successful change.
      setCurrent('');
      setNext('');
      setConfirm('');
      // Re-read the session so must_change_password clears everywhere it is
      // rendered from, not just in this component's local state.
      await refresh();
      navigate('/dashboard', { replace: true });
    } catch (err) {
      // A throttled response carries the wait, so say when to come back rather than
      // implying the current password was wrong.
      const wait = err.retryAfterSeconds;
      setError(
        wait
          ? `Too many failed attempts. Please wait ${wait} second${wait === 1 ? '' : 's'} and try again.`
          : err.message || 'Could not change the password.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <body className="login-page">
      <div className="login-split">
        <div className="login-brand-panel">
          <div className="login-grid-pattern"></div>
          <div className="login-brand-content">
            <div className="login-brand-logo">
              <i className="bi bi-recycle"></i>
            </div>
            <h2>Municipality of Ipil</h2>
            <h1>EcoCollect</h1>
            <p>QR-Based Waste Collection Management System</p>
          </div>
        </div>

        <div className="login-form-panel">
          <div className="login-card">
            <div className="login-header">
              <div className="login-logo">
                <i className="bi bi-shield-lock"></i>
              </div>
              <h1>Set a new password</h1>
              <p>
                You are signed in as <strong>{user?.username}</strong>, but this account
                is still using the default password. Choose your own to continue.
              </p>
            </div>

            {error && (
              <div className="alert alert-danger fade show" role="alert">
                <i className="bi bi-exclamation-circle me-2"></i>
                {error}
              </div>
            )}

            <form onSubmit={onSubmit}>
              <div className="mb-3">
                <label htmlFor="current" className="form-label">
                  Current password
                </label>
                <input
                  type="password"
                  className="form-control"
                  id="current"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  required
                  autoFocus
                  autoComplete="current-password"
                />
              </div>

              <div className="mb-3">
                <label htmlFor="next" className="form-label">
                  New password
                </label>
                <input
                  type="password"
                  className="form-control"
                  id="next"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  required
                  minLength={12}
                  autoComplete="new-password"
                />
                <small className="form-text">
                  At least 12 characters. A passphrase works well - several unrelated
                  words is stronger and easier to remember than a short jumble.
                </small>
              </div>

              <div className="mb-4">
                <label htmlFor="confirm" className="form-label">
                  Confirm new password
                </label>
                <input
                  type="password"
                  className="form-control"
                  id="confirm"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  minLength={12}
                  autoComplete="new-password"
                />
              </div>

              <button type="submit" className="btn btn-primary btn-lg w-100" disabled={busy}>
                {busy ? (
                  <>
                    <span className="spinner-border spinner-border-sm me-2"></span>Saving…
                  </>
                ) : (
                  <>
                    <i className="bi bi-check-circle me-2"></i>Save and continue
                  </>
                )}
              </button>

              <button
                type="button"
                className="btn btn-link w-100 mt-2 text-secondary"
                onClick={async () => {
                  await logout();
                  navigate('/login', { replace: true });
                }}
              >
                Sign out instead
              </button>
            </form>
          </div>
        </div>
      </div>
    </body>
  );
}
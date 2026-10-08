import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import CaptchaField from '../components/CaptchaField.jsx';

/**
 * The sign-in form, shared by the staff and admin login pages.
 *
 * Both routes render this; the only difference is the surrounding framing and where
 * a non-admin is sent afterwards. Everything that actually decides whether someone
 * is allowed in lives in POST /api/auth/login and the role checks inside each API
 * handler, so a separate-looking admin page is presentation, not a second gate.
 *
 * Kept in one component deliberately: the two pages must not drift apart, or a fix
 * applied to one (the throttled-response message, the password field clearing) would
 * silently be missing from the other.
 */
export default function LoginForm({
  // Which page is asking. Only affects copy and the button label.
  variant = 'staff',
  // Roles allowed to continue from here. Someone who authenticates successfully but
  // does not hold one is signed straight back out by login() and told why.
  allowedRoles = null,
}) {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Bumped after any failure to force a fresh challenge from the server.
  const [captchaKey, setCaptchaKey] = useState(0);

  const isAdminPortal = variant === 'admin';

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;

    setError('');
    setBusy(true);
    try {
      // The role check happens inside login(), before the session is published - see
      // the note there. A null return means the credentials were valid but this is not
      // the right door, and the server-side session has already been discarded.
      const user = await login(username, password, captcha, allowedRoles);

      if (!user) {
        setPassword('');
        setCaptcha('');
        setCaptchaKey((k) => k + 1);
        setError(
          'That account cannot sign in here. Use the main sign-in page, or contact an administrator.',
        );
        return;
      }

      // An account still on the published default password goes to the forced change
      // first. Protected would bounce it there anyway; going directly avoids a flash
      // of the dashboard before the redirect lands.
      navigate(user.must_change_password ? '/change-password' : '/dashboard', { replace: true });
    } catch (err) {
      // A throttled response carries the wait, so the message can say when to come
      // back instead of implying the credentials were wrong.
      const wait = err.retryAfterSeconds;
      setError(
        wait
          ? `Too many failed attempts. Please wait ${wait} second${wait === 1 ? '' : 's'} and try again.`
          : err.message || 'Login failed. Please try again.',
      );
      // Clear the password so a retry does not resubmit what was just rejected. The
      // captcha answer is single-use either way - the server expires its cookie on
      // every failure - so fetch a new question for the retry.
      setPassword('');
      setCaptcha('');
      setCaptchaKey((k) => k + 1);
      document.getElementById('password')?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && (
        <div className="alert alert-danger alert-dismissible fade show" role="alert">
          <i className="bi bi-exclamation-circle me-2"></i>
          {error}
          <button
            type="button"
            className="btn-close"
            onClick={() => setError('')}
            aria-label="Dismiss"
          ></button>
        </div>
      )}

      <form onSubmit={onSubmit}>
        <div className="mb-3">
          <label htmlFor="username" className="form-label">
            Username
          </label>
          <div className="input-group">
            <span className="input-group-text">
              <i className={`bi ${isAdminPortal ? 'bi-person-badge' : 'bi-person'}`}></i>
            </span>
            <input
              type="text"
              className="form-control"
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
              autoComplete="username"
              placeholder="Enter your username"
            />
          </div>
        </div>

        <div className="mb-4">
          <label htmlFor="password" className="form-label">
            Password
          </label>
          <div className="input-group">
            <span className="input-group-text">
              <i className="bi bi-lock"></i>
            </span>
            <input
              type="password"
              className="form-control"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              placeholder="Enter your password"
            />
          </div>
        </div>

        <CaptchaField value={captcha} onChange={setCaptcha} reloadKey={captchaKey} />

        <button type="submit" className="btn btn-primary btn-lg w-100" disabled={busy}>
          {busy ? (
            <>
              <span className="spinner-border spinner-border-sm me-2"></span>Signing in…
            </>
          ) : (
            <>
              <i className="bi bi-box-arrow-in-right me-2"></i>
              {isAdminPortal ? 'Sign In as Administrator' : 'Sign In'}
            </>
          )}
        </button>
      </form>
    </>
  );
}
import { Link } from 'react-router-dom';
import LoginForm from '../lib/login-form.jsx';

/**
 * Administrator sign-in.
 *
 * Separate route and separate presentation, but deliberately NOT a separate security
 * boundary. Both pages call the same POST /api/auth/login, which applies the same
 * throttle, CSRF check and bcrypt comparison. This page's only extra rule is
 * allowedRoles: an account that authenticates successfully without the admin role is
 * signed straight back out.
 *
 * The reason for the split is operational rather than defensive - it lets an admin
 * be handed a link to one address, and makes an accidental staff sign-in on the admin
 * page obvious rather than silent. Anyone who reaches an admin-only API without the
 * role is refused by the handler regardless of which page they signed in at.
 */
const ADMIN_ICONS = [
  'bi-shield-lock',
  'bi-person-badge',
  'bi-graph-up-arrow',
  'bi-clipboard-data',
  'bi-gear',
  'bi-journal-check',
  'bi-bar-chart-line',
  'bi-building',
];

export default function AdminLogin() {
  return (
    <body className="login-page login-page-admin">
      <div className="login-split">
        <div className="login-brand-panel">
          <div className="login-grid-pattern"></div>
          <div className="login-floating-icons">
            {ADMIN_ICONS.map((icon, i) => (
              <span key={icon} className={`lf-icon lf-${i + 1}`}>
                <i className={`bi ${icon}`}></i>
              </span>
            ))}
          </div>
          <div className="login-brand-content">
            <div className="login-brand-logo">
              <i className="bi bi-shield-lock"></i>
            </div>
            <h2>Restricted Area</h2>
            <h1>Admin Console</h1>
            <p>EcoCollect &middot; Municipality of Ipil</p>
            <div className="login-brand-features">
              <div className="lbf-item">
                <i className="bi bi-check-circle-fill"></i> Manage users and collectors
              </div>
              <div className="lbf-item">
                <i className="bi bi-check-circle-fill"></i> Configure barangay records
              </div>
              <div className="lbf-item">
                <i className="bi bi-check-circle-fill"></i> Review system-wide analytics
              </div>
            </div>
          </div>
          <div className="login-brand-footer">
            All access attempts are recorded for audit.
          </div>
        </div>

        <div className="login-form-panel">
          <div className="login-card">
            <div className="login-header">
              <div className="login-logo login-logo-admin">
                <i className="bi bi-person-badge"></i>
              </div>
              <h1>Administrator Sign In</h1>
              <p>Credentials are required for the admin console</p>
            </div>

            <div className="login-notice">
              <i className="bi bi-info-circle me-1"></i>
              Only accounts with the administrator role may continue from this page.
            </div>

            <LoginForm variant="admin" allowedRoles={['admin']} />

            <div className="login-alt-link">
              <Link to="/login">
                <i className="bi bi-arrow-left me-1"></i>
                Back to staff sign in
              </Link>
            </div>
          </div>
        </div>
      </div>
    </body>
  );
}
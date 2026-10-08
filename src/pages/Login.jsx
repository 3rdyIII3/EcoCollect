import { Link } from 'react-router-dom';
import LoginForm from '../lib/login-form.jsx';

const FLOATING_ICONS = [
  'bi-recycle',
  'bi-leaf',
  'bi-trash',
  'bi-box-seam',
  'bi-droplet',
  'bi-arrow-repeat',
  'bi-globe-americas',
  'bi-clipboard-data',
];

export default function Login() {
  return (
    <body className="login-page">
      <div className="login-split">
        <div className="login-brand-panel">
          <div className="login-grid-pattern"></div>
          <div className="login-floating-icons">
            {FLOATING_ICONS.map((icon, i) => (
              <span key={icon} className={`lf-icon lf-${i + 1}`}>
                <i className={`bi ${icon}`}></i>
              </span>
            ))}
          </div>
          <div className="login-brand-content">
            <div className="login-brand-logo">
              <i className="bi bi-recycle"></i>
            </div>
            <h2>Municipality of Ipil</h2>
            <h1>EcoCollect</h1>
            <p>QR-Based Waste Collection Management System</p>
            <div className="login-brand-features">
              <div className="lbf-item">
                <i className="bi bi-check-circle-fill"></i> Track waste collection in real-time
              </div>
              <div className="lbf-item">
                <i className="bi bi-check-circle-fill"></i> QR-based verification system
              </div>
              <div className="lbf-item">
                <i className="bi bi-check-circle-fill"></i> Analytics and barangay rankings
              </div>
            </div>
          </div>
          <div className="login-brand-footer">
            &copy; {new Date().getFullYear()} EcoCollect &middot; Municipality of Ipil
          </div>
        </div>

        <div className="login-form-panel">
          <div className="login-card">
            <div className="login-header">
              <div className="login-logo">
                <i className="bi bi-shield-lock"></i>
              </div>
              <h1>Welcome Back</h1>
              <p>Sign in to your account</p>
            </div>

            <LoginForm variant="staff" />

            <div className="login-alt-link">
              <Link to="/admin/login">
                <i className="bi bi-person-badge me-1"></i>
                Administrator sign in
              </Link>
            </div>
          </div>
        </div>
      </div>
    </body>
  );
}
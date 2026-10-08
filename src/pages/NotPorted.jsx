import { Link, useLocation } from 'react-router-dom';

const LABELS = {
  '/collectors': 'Collectors',
  '/users': 'Users',
  '/schedules': 'Schedules',
  '/qr-scanner': 'QR Scanner',
  '/qr-codes': 'QR Codes',
  '/notifications': 'Notifications',
  '/settings': 'Settings',
  '/dumping': 'Dumping Reports',
  '/reports': 'Analytics & Reports',
  '/rankings': 'Barangay Rankings',
};

const NOTES = {
  '/qr-scanner': 'Needs the camera scanner library and a lookup endpoint per scan.',
  '/collectors': 'Needs a collector CRUD endpoint and user linking.',
  '/users': 'Needs a user CRUD endpoint with role changes.',
  '/schedules': 'Needs weekday-ordered scheduling; the Postgres CASE ordering helper is ready in api/_lib/db.js.',
  '/notifications': 'Read-only listing is already live; the mark-read/archive actions are next.',
  '/settings': 'Needs a settings endpoint with an explicit key allowlist — the MySQL version persisted plaintext passwords this way, so the schema now rejects secret-like keys.',
  '/dumping': 'Needs CRUD plus photo upload, which requires Vercel Blob.',
  '/reports': 'The charts and totals already render on the dashboard; this page is mostly filters and CSV export.',
  '/rankings': 'The per-capita ranking query needs porting from ROUND() and FIELD() semantics.',
  '/qr-codes': 'Needs a QR renderer; the codes are already stored per barangay.',
};

/**
 * Placeholder for modules not yet ported.
 *
 * Rendering an explicit "not yet built" page is deliberate: a silently blank route
 * reads as a broken app, whereas this tells whoever opens it exactly what is left.
 */
export default function NotPorted({ planned }) {
  const { pathname } = useLocation();
  const label = LABELS[pathname] || 'This page';

  return (
    <div className="text-center py-5">
      <div className="empty-state">
        <i className="bi bi-cone-striped"></i>
        <h5 className="mt-3">{label} is not in this pass yet</h5>
        <p className="text-muted" style={{ maxWidth: 520, margin: '0 auto' }}>
          {NOTES[pathname] ||
            'This module is part of the full port but was scheduled after the core MVP so the Vercel, database and auth wiring could be verified first.'}
        </p>
        <Link to="/dashboard" className="btn btn-outline-secondary btn-sm">
          <i className="bi bi-arrow-left me-1"></i>Back to Dashboard
        </Link>
      </div>

      <div className="card mt-4 mx-auto" style={{ maxWidth: 560 }}>
        <div className="card-header py-2">
          <h6 className="mb-0 small fw-semibold">Still to port</h6>
        </div>
        <div className="card-body">
          <div className="d-flex flex-wrap gap-1">
            {planned.map((p) => (
              <Link
                key={p}
                to={p}
                className={`btn btn-sm ${p === pathname ? 'btn-primary' : 'btn-outline-secondary'}`}
              >
                {LABELS[p]?.replace(' & Reports', '') || p}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

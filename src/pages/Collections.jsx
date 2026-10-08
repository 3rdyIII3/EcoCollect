import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { num, dateOnly, timeOnly } from '../lib/format.js';

const WASTE_TYPES = ['Mixed', 'Organic', 'Plastic', 'Residual', 'Recyclable', 'Hazardous'];
const STATUSES = ['completed', 'partial', 'missed'];

const EMPTY_FORM = {
  barangay_id: '',
  collector_id: '',
  weight_kg: '',
  waste_type: 'Mixed',
  bags_count: '0',
  notes: '',
  collection_date: '',
  collection_time: '',
  status: 'completed',
};

export default function Collections({ mode }) {
  const { isAdmin, user } = useAuth();
  const creating = mode === 'create';

  const [filters, setFilters] = useState({
    q: '',
    waste_type: '',
    status: '',
    date_from: '',
    date_to: '',
    page: 1,
  });
  const [data, setData] = useState({ rows: [], pagination: { page: 1, pages: 1, total: 0 } });
  const [lookups, setLookups] = useState({ barangays: [], collectors: [] });
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api
      .get(`/api/collections${qs(filters)}`)
      .then((d) => setData(d))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  // Reference data + sensible defaults for a new record.
  useEffect(() => {
    api
      .get('/api/lookups')
      .then((d) => {
        setLookups(d);
        setForm((f) => ({
          ...f,
          collection_date: f.collection_date || d.today,
          collection_time: f.collection_time || new Date().toTimeString().slice(0, 5),
          collector_id: isAdmin ? f.collector_id : d.me.collector_id || '',
        }));
      })
      .catch((e) => setError(e.message));
  }, [isAdmin]);

  function setFilter(patch) {
    // Any filter change resets to page 1, otherwise you can land on an empty page.
    setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api.post('/api/collections', { action: 'create', ...form });
      setNotice('Collection recorded successfully.');
      setForm((f) => ({ ...EMPTY_FORM, collection_date: f.collection_date, collection_time: f.collection_time }));
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(row) {
    if (!window.confirm(`Delete the collection at ${row.barangay_name}?`)) return;
    try {
      await api.post('/api/collections', { action: 'delete', id: row.id });
      setNotice('Collection deleted.');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  /* --------------------------------------------------------------- form */
  const formPanel = (
    <div className="card mb-3">
      <div className="card-header py-2">
        <h6 className="mb-0 small fw-bold">
          <i className="bi bi-plus-circle me-1 text-primary"></i>Record Collection
        </h6>
      </div>
      <div className="card-body p-3">
        <form onSubmit={submit}>
          <div className="mb-2">
            <label className="form-label small fw-semibold">Barangay</label>
            <select
              className="form-select form-select-sm"
              value={form.barangay_id}
              onChange={(e) => setForm({ ...form, barangay_id: e.target.value })}
              required
            >
              <option value="">Select barangay…</option>
              {lookups.barangays.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>

          {isAdmin && (
            <div className="mb-2">
              <label className="form-label small fw-semibold">Collector</label>
              <select
                className="form-select form-select-sm"
                value={form.collector_id}
                onChange={(e) => setForm({ ...form, collector_id: e.target.value })}
                required
              >
                <option value="">Select collector…</option>
                {lookups.collectors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.full_name}
                    {c.route ? ` — ${c.route}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="row g-2">
            <div className="col-6">
              <label className="form-label small fw-semibold">Weight (kg)</label>
              <input
                type="number"
                step="0.1"
                min="0.1"
                className="form-control form-control-sm"
                value={form.weight_kg}
                onChange={(e) => setForm({ ...form, weight_kg: e.target.value })}
                required
              />
            </div>
            <div className="col-6">
              <label className="form-label small fw-semibold">Bags</label>
              <input
                type="number"
                min="0"
                className="form-control form-control-sm"
                value={form.bags_count}
                onChange={(e) => setForm({ ...form, bags_count: e.target.value })}
              />
            </div>
          </div>

          <div className="mb-2 mt-2">
            <label className="form-label small fw-semibold">Waste Type</label>
            <select
              className="form-select form-select-sm"
              value={form.waste_type}
              onChange={(e) => setForm({ ...form, waste_type: e.target.value })}
            >
              {WASTE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <div className="row g-2">
            <div className="col-6">
              <label className="form-label small fw-semibold">Date</label>
              <input
                type="date"
                className="form-control form-control-sm"
                value={form.collection_date}
                onChange={(e) => setForm({ ...form, collection_date: e.target.value })}
                required
              />
            </div>
            <div className="col-6">
              <label className="form-label small fw-semibold">Time</label>
              <input
                type="time"
                className="form-control form-control-sm"
                value={form.collection_time}
                onChange={(e) => setForm({ ...form, collection_time: e.target.value })}
                required
              />
            </div>
          </div>

          <div className="mb-2 mt-2">
            <label className="form-label small fw-semibold">Notes</label>
            <textarea
              className="form-control form-control-sm"
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </div>

          <button type="submit" className="btn btn-primary btn-sm w-100" disabled={saving}>
            {saving ? 'Saving…' : 'Record Collection'}
          </button>
        </form>
      </div>
    </div>
  );

  /* --------------------------------------------------------------- list */
  return (
    <>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h5 className="mb-0">
          <i className="bi bi-trash me-2 text-primary"></i>
          {isAdmin ? 'All Collections' : 'My Collections'}
        </h5>
        {!creating && (
          <Link to="/collection-add" className="btn btn-primary btn-sm">
            <i className="bi bi-plus-circle me-1"></i>Record Collection
          </Link>
        )}
      </div>

      {error && (
        <div className="alert alert-danger py-2">
          <i className="bi bi-exclamation-circle me-1"></i>
          {error}
        </div>
      )}
      {notice && (
        <div className="alert alert-success py-2">
          <i className="bi bi-check-circle me-1"></i>
          {notice}
        </div>
      )}

      <div className="row g-3">
        {creating && <div className="col-lg-4">{formPanel}</div>}

<div className={creating ? 'col-lg-8' : 'col-12'}>
          {/* The record form lives on /collection-add only. Inlining it here too would
              duplicate the sidebar entry and push the table below the fold, which is
              what the PHP version's split of list vs. record pages avoided. */}

          <div className="card mb-3">
            <div className="card-body py-2 px-3">
              <div className="row g-2 align-items-end">
                <div className="col-md-3">
                  <label className="form-label small mb-1">Search</label>
                  <input
                    className="form-control form-control-sm"
                    value={filters.q}
                    onChange={(e) => setFilter({ q: e.target.value })}
                    placeholder="Barangay or collector"
                  />
                </div>
                <div className="col-md-2">
                  <label className="form-label small mb-1">Type</label>
                  <select
                    className="form-select form-select-sm"
                    value={filters.waste_type}
                    onChange={(e) => setFilter({ waste_type: e.target.value })}
                  >
                    <option value="">All</option>
                    {WASTE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-md-2">
                  <label className="form-label small mb-1">Status</label>
                  <select
                    className="form-select form-select-sm"
                    value={filters.status}
                    onChange={(e) => setFilter({ status: e.target.value })}
                  >
                    <option value="">All</option>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-md-2">
                  <label className="form-label small mb-1">From</label>
                  <input
                    type="date"
                    className="form-control form-control-sm"
                    value={filters.date_from}
                    onChange={(e) => setFilter({ date_from: e.target.value })}
                  />
                </div>
                <div className="col-md-2">
                  <label className="form-label small mb-1">To</label>
                  <input
                    type="date"
                    className="form-control form-control-sm"
                    value={filters.date_to}
                    onChange={(e) => setFilter({ date_to: e.target.value })}
                  />
                </div>
                <div className="col-md-1 d-grid">
                  <button className="btn btn-outline-secondary btn-sm" onClick={load} title="Refresh">
                    <i className="bi bi-funnel"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-body p-0">
              <div className="table-responsive">
                <table className="table table-sm table-hover mb-0">
                  <thead>
                    <tr>
                      <th>Barangay</th>
                      <th>Collector</th>
                      <th>Date</th>
                      <th>Time</th>
                      <th className="text-end">Weight</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th style={{ width: 50 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading && (
                      <tr>
                        <td colSpan={8} className="text-center py-4 text-muted">
                          <div className="spinner-border spinner-border-sm me-2"></div>Loading…
                        </td>
                      </tr>
                    )}
                    {!loading && data.rows.length === 0 && (
                      <tr>
                        <td colSpan={8} className="text-center py-4 text-muted">
                          No collections found.
                        </td>
                      </tr>
                    )}
                    {!loading &&
                      data.rows.map((r) => (
                        <tr key={r.id}>
                          <td className="small fw-medium">{r.barangay_name}</td>
                          <td className="small">{r.collector_name}</td>
                          <td className="small">{dateOnly(r.collection_date)}</td>
                          <td className="small text-muted">{timeOnly(r.collection_time)}</td>
                          <td className="small text-end fw-semibold">{num(r.weight_kg)} kg</td>
                          <td className="small">
                            <span className="badge bg-light text-dark">{r.waste_type}</span>
                          </td>
                          <td className="small">
                            <span
                              className={`badge badge-status badge-${
                                r.status === 'completed'
                                  ? 'success'
                                  : r.status === 'partial'
                                    ? 'warning'
                                    : 'danger'
                              }`}
                            >
                              {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                            </span>
                          </td>
                          <td className="text-end">
                            <button
                              className="btn btn-outline-danger btn-sm py-0 px-1"
                              onClick={() => remove(r)}
                              title="Delete"
                            >
                              <i className="bi bi-trash"></i>
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="d-flex justify-content-between align-items-center mt-3">
            <small className="text-muted">
              Page {data.pagination.page} of {data.pagination.pages} · {data.pagination.total}{' '}
              collection(s)
            </small>
            <div className="btn-group btn-group-sm">
              <button
                className="btn btn-outline-secondary"
                disabled={data.pagination.page <= 1}
                onClick={() => setFilter({ page: data.pagination.page - 1 })}
              >
                <i className="bi bi-chevron-left"></i>
              </button>
              <button
                className="btn btn-outline-secondary"
                disabled={data.pagination.page >= data.pagination.pages}
                onClick={() => setFilter({ page: data.pagination.page + 1 })}
              >
                <i className="bi bi-chevron-right"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

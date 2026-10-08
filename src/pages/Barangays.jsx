import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';

const EMPTY = {
  id: null,
  name: '',
  population: '',
  zone: '',
  address: '',
  qr_code: '',
  latitude: '',
  longitude: '',
  is_active: true,
};

export default function Barangays({ mode }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = mode === 'edit';
  const viewing = mode === 'view';

  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api
      .get('/api/barangays?include_inactive=1')
      .then((d) => {
        setRows(d.rows);
        if (editing || viewing) {
          const found = d.rows.find((r) => String(r.id) === String(id));
          if (found) setForm({ ...EMPTY, ...found });
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id, editing, viewing]);

  useEffect(() => {
    load();
  }, [load]);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api.post('/api/barangays', {
        action: editing ? 'update' : 'create',
        ...form,
      });
      setNotice(editing ? 'Barangay updated.' : 'Barangay created.');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function deactivate(row) {
    if (!window.confirm(`Deactivate ${row.name}? Its collection history is kept.`)) return;
    try {
      await api.post('/api/barangays', { action: 'delete', id: row.id });
      setNotice(`${row.name} deactivated.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function reactivate(row) {
    try {
      await api.post('/api/barangays', { action: 'update', ...row, is_active: true });
      setNotice(`${row.name} reactivated.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  /* --------------------------------------------------------- detail views */
  if (editing || viewing) {
    const readOnly = viewing;
    return (
      <>
        <div className="d-flex justify-content-between align-items-center mb-3">
          <h5 className="mb-0">{viewing ? 'Barangay Details' : 'Edit Barangay'}</h5>
          <button className="btn btn-outline-secondary btn-sm" onClick={() => navigate('/barangays')}>
            <i className="bi bi-arrow-left me-1"></i>Back
          </button>
        </div>

        {error && <div className="alert alert-danger py-2">{error}</div>}

        <div className="card">
          <div className="card-body">
            <form onSubmit={submit}>
              <div className="row g-3">
                <div className="col-md-6">
                  <label className="form-label">Name</label>
                  <input
                    className="form-control"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required
                    disabled={readOnly}
                  />
                </div>
                <div className="col-md-3">
                  <label className="form-label">Population</label>
                  <input
                    type="number"
                    min="0"
                    className="form-control"
                    value={form.population}
                    onChange={(e) => setForm({ ...form, population: e.target.value })}
                    disabled={readOnly}
                  />
                </div>
                <div className="col-md-3">
                  <label className="form-label">Zone</label>
                  <input
                    className="form-control"
                    value={form.zone}
                    onChange={(e) => setForm({ ...form, zone: e.target.value })}
                    disabled={readOnly}
                  />
                </div>
                <div className="col-12">
                  <label className="form-label">Address</label>
                  <input
                    className="form-control"
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                    disabled={readOnly}
                  />
                </div>
                <div className="col-md-6">
                  <label className="form-label">QR Code</label>
                  <input
                    className="form-control"
                    value={form.qr_code}
                    onChange={(e) => setForm({ ...form, qr_code: e.target.value })}
                    disabled={readOnly}
                  />
                  {readOnly && (
                    <small className="text-muted d-block">
                      Generated automatically when left blank on create.
                    </small>
                  )}
                </div>
                <div className="col-md-3">
                  <label className="form-label">Latitude</label>
                  <input
                    className="form-control"
                    value={form.latitude ?? ''}
                    onChange={(e) => setForm({ ...form, latitude: e.target.value })}
                    disabled={readOnly}
                  />
                </div>
                <div className="col-md-3">
                  <label className="form-label">Longitude</label>
                  <input
                    className="form-control"
                    value={form.longitude ?? ''}
                    onChange={(e) => setForm({ ...form, longitude: e.target.value })}
                    disabled={readOnly}
                  />
                </div>
                <div className="col-md-6">
                  <div className="form-check form-switch mt-4">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="active"
                      checked={Boolean(form.is_active)}
                      onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                      disabled={readOnly}
                    />
                    <label className="form-check-label" htmlFor="active">
                      Active
                    </label>
                  </div>
                </div>
              </div>

              {!readOnly && (
                <div className="mt-3">
                  <button type="submit" className="btn btn-primary" disabled={saving}>
                    <i className="bi bi-check-lg me-1"></i>
                    {saving ? 'Saving…' : 'Save Changes'}
                  </button>
                </div>
              )}
            </form>
          </div>
        </div>
      </>
    );
  }

  /* ------------------------------------------------------------ list + add */
  return (
    <>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h5 className="mb-0">
          <i className="bi bi-geo-alt me-2 text-primary"></i>Barangays
        </h5>
        <button className="btn btn-primary btn-sm" onClick={() => setForm(EMPTY)}>
          <i className="bi bi-plus-circle me-1"></i>Add Barangay
        </button>
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
        <div className="col-lg-8">
          <div className="card">
            <div className="card-body p-0">
              <div className="table-responsive">
                <table className="table table-sm table-hover mb-0">
                  <thead>
                    <tr>
                      <th>Barangay</th>
                      <th>QR Code</th>
                      <th className="text-end">Population</th>
                      <th className="text-end">Collections</th>
                      <th className="text-end">Total (kg)</th>
                      <th>Status</th>
                      <th style={{ width: 120 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading && (
                      <tr>
                        <td colSpan={7} className="text-center py-4 text-muted">
                          <div className="spinner-border spinner-border-sm me-2"></div>Loading…
                        </td>
                      </tr>
                    )}
                    {!loading && rows.length === 0 && (
                      <tr>
                        <td colSpan={7} className="text-center py-4 text-muted">
                          No barangays yet.
                        </td>
                      </tr>
                    )}
                    {!loading &&
                      rows.map((r) => (
                        <tr key={r.id} className={r.is_active ? '' : 'table-light'}>
                          <td className="small fw-medium">{r.name}</td>
                          <td className="small">
                            <code>{r.qr_code}</code>
                          </td>
                          <td className="small text-end">{Number(r.population).toLocaleString()}</td>
                          <td className="small text-end">{r.collection_count}</td>
                          <td className="small text-end">
                            {Number(r.total_weight).toLocaleString(undefined, {
                              minimumFractionDigits: 1,
                              maximumFractionDigits: 1,
                            })}
                          </td>
                          <td className="small">
                            <span className={`badge badge-status badge-${r.is_active ? 'success' : 'danger'}`}>
                              {r.is_active ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td className="text-end text-nowrap">
                            <button
                              className="btn btn-outline-secondary btn-sm py-0 px-1 me-1"
                              onClick={() => navigate(`/barangay-view/${r.id}`)}
                              title="View"
                            >
                              <i className="bi bi-eye"></i>
                            </button>
                            <button
                              className="btn btn-outline-primary btn-sm py-0 px-1 me-1"
                              onClick={() => navigate(`/barangay-edit/${r.id}`)}
                              title="Edit"
                            >
                              <i className="bi bi-pencil"></i>
                            </button>
                            {r.is_active ? (
                              <button
                                className="btn btn-outline-danger btn-sm py-0 px-1"
                                onClick={() => deactivate(r)}
                                title="Deactivate"
                              >
                                <i className="bi bi-x-lg"></i>
                              </button>
                            ) : (
                              <button
                                className="btn btn-outline-success btn-sm py-0 px-1"
                                onClick={() => reactivate(r)}
                                title="Reactivate"
                              >
                                <i className="bi bi-check-lg"></i>
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <div className="col-lg-4">
          <div className="card">
            <div className="card-header py-2">
              <h6 className="mb-0 small fw-bold">
                <i className="bi bi-plus-circle me-1 text-primary"></i>
                {form.id ? 'Update Barangay' : 'Add Barangay'}
              </h6>
            </div>
            <div className="card-body p-3">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setSaving(true);
                  api
                    .post('/api/barangays', {
                      action: form.id ? 'update' : 'create',
                      ...form,
                    })
                    .then((d) => {
                      setNotice(form.id ? 'Barangay updated.' : `Barangay created with QR ${d.qr_code || form.qr_code}.`);
                      setForm(EMPTY);
                      load();
                    })
                    .catch((err) => setError(err.message))
                    .finally(() => setSaving(false));
                }}
              >
                <div className="mb-2">
                  <label className="form-label small fw-semibold">Name</label>
                  <input
                    className="form-control form-control-sm"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required
                  />
                </div>
                <div className="row g-2">
                  <div className="col-6">
                    <label className="form-label small fw-semibold">Population</label>
                    <input
                      type="number"
                      min="0"
                      className="form-control form-control-sm"
                      value={form.population}
                      onChange={(e) => setForm({ ...form, population: e.target.value })}
                    />
                  </div>
                  <div className="col-6">
                    <label className="form-label small fw-semibold">Zone</label>
                    <input
                      className="form-control form-control-sm"
                      value={form.zone}
                      onChange={(e) => setForm({ ...form, zone: e.target.value })}
                    />
                  </div>
                </div>
                <div className="mb-2 mt-2">
                  <label className="form-label small fw-semibold">Address</label>
                  <input
                    className="form-control form-control-sm"
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                  />
                </div>
                <div className="mb-2">
                  <label className="form-label small fw-semibold">QR Code</label>
                  <input
                    className="form-control form-control-sm"
                    value={form.qr_code}
                    onChange={(e) => setForm({ ...form, qr_code: e.target.value })}
                    placeholder="Leave blank to auto-generate"
                  />
                </div>
                <button type="submit" className="btn btn-primary btn-sm w-100" disabled={saving}>
                  {saving ? 'Saving…' : form.id ? 'Update' : 'Create'}
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

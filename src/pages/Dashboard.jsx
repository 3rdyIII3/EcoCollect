import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Chart as ChartJS, registerables } from 'chart.js';
import { Line, Doughnut, Bar } from 'react-chartjs-2';
import { api, qs } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { num, shortDate, formatDateTime } from '../lib/format.js';

ChartJS.register(...registerables);

const WASTE_COLORS = {
  Organic: '#16a34a',
  Plastic: '#2563eb',
  Residual: '#64748b',
  Recyclable: '#d97706',
  Hazardous: '#dc2626',
  Mixed: '#7c3aed',
};

const PERIODS = [
  { value: 'week', label: 'Last 7 Days' },
  { value: 'month', label: 'Last 30 Days' },
  { value: 'year', label: 'Last 12 Months' },
];

function statusVariant(status) {
  if (status === 'completed') return 'success';
  if (status === 'partial') return 'warning';
  return 'danger';
}

function StatCard({ icon, tone, value, unit, label }) {
  return (
    <div className="col-md-3">
      <div className={`stat-card stat-card-icon stat-card-${tone}`}>
        <div className="stat-card-icon-bg">
          <i className={`bi ${icon}`}></i>
        </div>
        <div className="stat-value">
          {value} {unit ? <small>{unit}</small> : null}
        </div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user, isStaff } = useAuth();
  const [period, setPeriod] = useState('month');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get(`/api/dashboard${qs({ period })}`)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError('');
        }
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [period]);

  const charts = useMemo(() => {
    if (!data?.series) return null;
    const { dailyTrend, wasteByType, monthlyTrend } = data.series;

    return {
      daily: {
        labels: dailyTrend.map((d) => shortDate(d.collection_date)),
        datasets: [
          {
            data: dailyTrend.map((d) => Number(d.total)),
            borderColor: '#2563eb',
            backgroundColor: 'rgba(37,99,235,0.1)',
            fill: true,
            tension: 0.4,
          },
        ],
      },
      type: {
        labels: wasteByType.map((d) => d.waste_type),
        datasets: [
          {
            data: wasteByType.map((d) => Number(d.total)),
            backgroundColor: wasteByType.map((d) => WASTE_COLORS[d.waste_type] || '#94a3b8'),
            borderWidth: 0,
          },
        ],
      },
      monthly: {
        labels: monthlyTrend.map((d) => d.month),
        datasets: [
          {
            data: monthlyTrend.map((d) => Number(d.total)),
            backgroundColor: 'rgba(37,99,235,0.7)',
            borderRadius: 4,
          },
        ],
      },
    };
  }, [data]);

  if (loading && !data) {
    return (
      <div className="text-center py-5">
        <div className="spinner-border text-primary"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="alert alert-danger">
        <i className="bi bi-exclamation-circle me-2"></i>
        {error}
      </div>
    );
  }

  const { stats, recent, series } = data;
  const firstName = (user?.full_name || 'there').split(' ')[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good Morning' : hour < 18 ? 'Good Afternoon' : 'Good Evening';
  // "This Month" is reported in tonnes in the original UI; keep that unit.
  const monthTonnes = (stats.monthKg / 1000).toFixed(1);

  return (
    <>
      <div className="welcome-banner">
        <div className="welcome-banner-content">
          <div className="welcome-text">
            <h4>
              {greeting}, {firstName}!
            </h4>
            <p>Here's the system overview for {data.today}.</p>
          </div>
          <div className="welcome-stats-inline">
            <div className="ws-item">
              <span className="ws-value">{monthTonnes}t</span>
              <span className="ws-label">This Month</span>
            </div>
            {stats.pendingReports != null && (
              <div className="ws-item">
                <span className="ws-value">{stats.pendingReports}</span>
                <span className="ws-label">Pending Reports</span>
              </div>
            )}
          </div>
        </div>
        <div className="welcome-banner-shape"></div>
        <div className="welcome-banner-shape wb-shape-2"></div>
      </div>

      {isStaff && series && (
        <div className="card mb-3">
          <div className="card-body py-2 px-3">
            <div className="row g-2 align-items-end">
              <div className="col-md-4">
                <label className="form-label small fw-semibold mb-1">Period</label>
                <select
                  className="form-select form-select-sm"
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                >
                  {PERIODS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="row g-3 mb-4">
        <StatCard icon="bi-speedometer2" tone="blue" value={num(stats.todayKg)} unit="kg" label="Collected Today" />
        <StatCard
          icon="bi-check-circle"
          tone="green"
          value={`${stats.completedToday} / ${stats.scheduledToday}`}
          label="Completed / Scheduled"
        />
        <StatCard icon="bi-calendar-month" tone="orange" value={monthTonnes} unit="t" label="This Month" />
        {stats.pendingReports != null && (
          <StatCard
            icon="bi-exclamation-triangle"
            tone="red"
            value={stats.pendingReports}
            label="Pending Reports"
          />
        )}
      </div>

      {isStaff && series && (
        <>
          <div className="row g-3 mb-4">
            {[
              ['Total Waste', num(series.totals.totalWeight), 'kg'],
              ['Completed', series.totals.completed, ''],
              ['Completion Rate', series.totals.completionRate, '%'],
              ['Avg per Collection', num(series.totals.avgPerCollection), 'kg'],
            ].map(([label, value, unit]) => (
              <div className="col-md-3" key={label}>
                <div className="stat-card">
                  <div className="stat-label">{label}</div>
                  <div className="stat-value">
                    {value} {unit ? <small className="text-muted">{unit}</small> : null}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="row g-3 mb-4">
            <div className="col-lg-8">
              <div className="card">
                <div className="card-header">
                  <h6 className="mb-0 small fw-semibold">Daily Trend</h6>
                </div>
                <div className="card-body">
                  <div className="chart-container">
                    <Line
                      data={charts.daily}
                      options={{
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: { legend: { display: false } },
                        scales: { y: { beginAtZero: true }, x: { grid: { display: false } } },
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
            <div className="col-lg-4">
              <div className="card">
                <div className="card-header">
                  <h6 className="mb-0 small fw-semibold">Waste Composition</h6>
                </div>
                <div className="card-body">
                  <div className="chart-container">
                    <Doughnut
                      data={charts.type}
                      options={{
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: { legend: { position: 'bottom', labels: { usePointStyle: true } } },
                        cutout: '65%',
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="row g-3 mb-4">
            <div className="col-lg-6">
              <div className="card">
                <div className="card-header">
                  <h6 className="mb-0 small fw-semibold">Waste by Barangay</h6>
                </div>
                <div className="card-body p-0">
                  <table className="table table-sm mb-0">
                    <thead>
                      <tr>
                        <th>Barangay</th>
                        <th className="text-end">Weight</th>
                        <th className="text-end">Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {series.wasteByBarangay.map((r) => (
                        <tr key={r.id}>
                          <td className="fw-medium small">{r.name}</td>
                          <td className="text-end small">{num(r.total_weight)}</td>
                          <td className="text-end small">{r.collection_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div className="col-lg-6">
              <div className="card">
                <div className="card-header">
                  <h6 className="mb-0 small fw-semibold">Collector Performance</h6>
                </div>
                <div className="card-body p-0">
                  <table className="table table-sm mb-0">
                    <thead>
                      <tr>
                        <th>Collector</th>
                        <th className="text-end">Trips</th>
                        <th className="text-end">Weight</th>
                      </tr>
                    </thead>
                    <tbody>
                      {series.wasteByCollector.map((r) => (
                        <tr key={r.full_name}>
                          <td className="fw-medium small">{r.full_name}</td>
                          <td className="text-end small">{r.trips}</td>
                          <td className="text-end small">{num(r.total_weight)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h6 className="mb-0 small fw-semibold">Monthly Trend</h6>
            </div>
            <div className="card-body">
              <div className="chart-container">
                <Bar
                  data={charts.monthly}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true }, x: { grid: { display: false } } },
                  }}
                />
              </div>
            </div>
          </div>
        </>
      )}

      <div className={`card${isStaff && series ? ' mt-4' : ''}`}>
        <div className="card-header py-3 d-flex justify-content-between align-items-center">
          <h6 className="mb-0 fw-bold">
            <i className="bi bi-clock-history me-2 text-primary"></i>Recent Collections
          </h6>
          <Link to="/collections" className="btn btn-sm btn-outline-primary">
            View All <i className="bi bi-arrow-right ms-1"></i>
          </Link>
        </div>
        <div className="card-body p-0">
          <div className="table-responsive">
            <table className="table table-sm mb-0">
              <thead>
                <tr>
                  <th>Barangay</th>
                  <th>Collector</th>
                  <th>Weight</th>
                  <th>Type</th>
                  <th>Time</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {recent.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center text-muted py-4">
                      No collections recorded yet.
                    </td>
                  </tr>
                ) : (
                  recent.map((r) => (
                    <tr key={r.id}>
                      <td className="small fw-medium">{r.barangay_name}</td>
                      <td className="small">{r.collector_name}</td>
                      <td className="small fw-medium">{num(r.weight_kg)} kg</td>
                      <td className="small">
                        <span className="badge bg-light text-dark">{r.waste_type}</span>
                      </td>
                      <td className="small text-muted">
                        {formatDateTime(r.collection_date, r.collection_time)}
                      </td>
                      <td>
                        <span className={`badge badge-status badge-${statusVariant(r.status)}`}>
                          {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

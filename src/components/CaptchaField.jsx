import { useCallback, useEffect, useState } from 'react';

/**
 * Arithmetic captcha field for the login form.
 *
 * The question comes from GET /api/auth/captcha and the answer never leaves the
 * server, so there is nothing on the page to read - the client has to compute it.
 * `reloadKey` is bumped by the form after a failed attempt, which both re-fetches a
 * new challenge and re-renders this component; the server also expires the old cookie
 * on any failure, so a stale answer cannot be reused.
 *
 * Rendered as plain text rather than an image on purpose: it stays legible on a phone
 * in poor light, works with a screen reader, and needs no image pipeline.
 */
export default function CaptchaField({ value, onChange, reloadKey = 0 }) {
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/auth/captcha?n=${Date.now()}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setQuestion(data?.question || '');
    } catch (err) {
      setQuestion('');
      // The usual cause is a missing or too-short JWT_SECRET, since that is what the
      // captcha cookie is signed with. Say so rather than showing a bare number.
      setError(`Could not load the security question (${err.message}).`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  return (
    <div className="mb-4">
      <label htmlFor="captcha" className="form-label">
        Security question
      </label>

      <div className="captcha-row">
        <div className="captcha-box">
          {loading && <span className="captcha-placeholder">Loading…</span>}
          {!loading && error && <span className="captcha-placeholder text-danger">Error</span>}
          {!loading && !error && (
            // The equation is rendered as text, not an image, so a screen reader
            // announces it and it stays legible at any zoom level.
            <span className="captcha-question" aria-live="polite">
              {question} <span className="captcha-equals">=</span> ?
            </span>
          )}
        </div>
        <button
          type="button"
          className="captcha-refresh"
          onClick={load}
          title="Get a new question"
          aria-label="Get a new security question"
        >
          <i className="bi bi-arrow-clockwise"></i>
        </button>
      </div>

      {error && (
        <small className="text-danger d-block mt-1">
          <i className="bi bi-exclamation-triangle me-1"></i>
          {error}
        </small>
      )}

      <input
        type="text"
        className="form-control captcha-input mt-2"
        id="captcha"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={3}
        autoComplete="off"
        placeholder="Type the answer"
        disabled={!question}
        // Reachable by keyboard and screen reader rather than colour-only.
        aria-describedby="captcha-hint"
      />
      <small id="captcha-hint" className="form-text">
        To confirm you are a person, answer the question above.
      </small>
    </div>
  );
}
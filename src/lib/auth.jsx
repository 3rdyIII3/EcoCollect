import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setCsrfToken } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get('/api/auth/me');
      setUser(data?.user ?? null);
      return data?.user ?? null;
    } catch {
      setUser(null);
      return null;
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  /**
   * Signs in and, on success, publishes the user to the whole app.
   *
   * @param username
   * @param password
   * @param captcha     answer to the arithmetic security question
   * @param allowedRoles  when provided, an account outside these roles is signed
   *   straight back out and null is returned instead. The check happens BEFORE
   *   setUser, so no component ever observes a session that is about to be discarded
   *   - otherwise a route guard would redirect on the way out.
   * @returns the signed-in user, or null if the role was refused
   */
  const login = useCallback(async (username, password, captcha, allowedRoles = null) => {
    // The login POST needs a CSRF pair before a session exists, so mint one first.
    const { csrfToken } = await api.get('/api/auth/csrf');
    setCsrfToken(csrfToken);
    const data = await api.post('/api/auth/login', { username, password, captcha });
    setCsrfToken(data.csrfToken);

    if (allowedRoles && !allowedRoles.includes(data?.user?.role)) {
      // Valid credentials, wrong door. Drop the cookies the server just issued so a
      // live session is not left behind, and never publish the user.
      await api.post('/api/auth/logout').catch(() => {});
      return null;
    }

    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      logout,
      refresh,
      isAdmin: user?.role === 'admin',
      isSupervisor: user?.role === 'supervisor',
      isStaff: user?.role === 'admin' || user?.role === 'supervisor',
    }),
    [user, loading, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

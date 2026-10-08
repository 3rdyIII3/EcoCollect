import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router-dom';
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import './styles.css';
import App from './App.jsx';
import { AuthProvider } from './lib/auth.jsx';

// bootstrap's JS bundle supplies the dropdown/modal behaviour the shell relies on.
// It is optional-chained at each use site so a CDN hiccup degrades to plain markup
// instead of a blank screen.
import('bootstrap').catch(() => {});

function routeTitle(pathname) {
  if (pathname.startsWith('/admin/login')) return 'Administrator Sign In · EcoCollect';
  if (pathname === '/login') return 'Sign In · EcoCollect';
  if (pathname === '/change-password') return 'Set a New Password · EcoCollect';
  return 'EcoCollect';
}

/**
 * Keeps the document title in step with the route.
 *
 * The two sign-in pages share index.html, so without this a bookmarked admin link
 * would be labelled "EcoCollect" in the tab and in the browser history. A title is
 * not a security control, but a wrong one is a small signal a visitor should not be
 * following.
 *
 * Driven by useLocation rather than a popstate listener, so it also fires on
 * client-side navigation, which does not touch history state itself.
 */
function RouteTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = routeTitle(pathname);
  }, [pathname]);
  return null;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <RouteTitle />
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
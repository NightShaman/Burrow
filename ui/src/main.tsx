import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './app/ErrorBoundary';
import { ConfirmProvider } from './app/ConfirmDialog';
import { LoginPage } from './features/auth/LoginPage';
import './app.css';

type HealthResponse = {
  auth?: { mode?: string; required?: boolean };
  ui?: { authMode?: string; authEnabled?: boolean };
  error?: string;
};

function Root() {
  const [authState, setAuthState] = useState<'checking' | 'open' | 'login'>('checking');

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/health', {
      headers: {
        accept: 'application/json',
        // Send an empty Basic credential on the boot probe so browsers do not
        // show their native Basic Auth dialog before the app can render its own
        // lock screen. Real credentials are only set by LoginPage.
        authorization: 'Basic Og==',
      },
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as HealthResponse;
        // A configured Basic Auth runtime challenges with 401. An unconfigured
        // auth mode must not strand the operator on a login screen.
        const needsBasicLogin = body.ui?.authMode === 'basic' || (response.status === 401 && body.auth?.mode === 'basic');
        if (!cancelled) setAuthState(needsBasicLogin ? 'login' : 'open');
      })
      .catch(() => {
        // Keep the UI reachable if the probe itself fails; the app will surface
        // its normal runtime error state rather than inventing an auth prompt.
        if (!cancelled) setAuthState('open');
      });
    return () => { cancelled = true; };
  }, []);

  if (authState === 'checking') return <div className="app-loading" aria-label="Loading">Loading…</div>;
  if (authState === 'login') return <LoginPage onAuthenticated={() => setAuthState('open')} />;
  return <App />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary><ConfirmProvider><Root /></ConfirmProvider></ErrorBoundary>
  </React.StrictMode>,
);


import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './app/ErrorBoundary';
import { ConfirmProvider } from './app/ConfirmDialog';
import { LoginPage } from './features/auth/LoginPage';
import { ReauthGate } from './features/auth/ReauthGate';
import { discoverAuthMode } from './app/auth';
import './app.css';

function Root() {
  const [authState, setAuthState] = useState<'checking' | 'open' | 'login'>('checking');

  useEffect(() => {
    let cancelled = false;
    void discoverAuthMode()
      .then(({ mode }) => {
        if (!cancelled) setAuthState(mode === 'basic' ? 'login' : 'open');
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
  return <ReauthGate><App /></ReauthGate>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary><ConfirmProvider><Root /></ConfirmProvider></ErrorBoundary>
  </React.StrictMode>,
);


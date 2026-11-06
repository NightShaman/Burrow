import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { discoverAuthMode } from '../../src/app/auth';
import '../../src/app.css';
const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(e.message));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
window.fetch = async (input) => {
  if (String(input) !== '/api/auth/discovery') throw new Error(`Unexpected auth API ${input}`);
  const shape = new URLSearchParams(location.search).get('mode');
  return Response.json(
    shape === 'invalid'
      ? { auth: { mode: 'bogus' } }
      : { auth: { mode: shape === 'none' ? 'none' : 'basic' } },
  );
};
Object.assign(window, { fixtureEvidence: { errors } });
function Fixture() {
  const [result, setResult] = useState('Discovering…');
  React.useEffect(() => {
    void discoverAuthMode().then(
      (value) => setResult(value.mode),
      () => setResult('auth_discovery_failed'),
    );
  }, []);
  return (
    <main className="cockpit" data-theme="smatchet">
      <header className="app-header">
        Actual auth discovery module — isolated nested API response
      </header>
      <h1 role="status">{result}</h1>
      <p>
        Modes: ?route=auth&amp;mode=basic | none | invalid. No live challenge or credential entry.
      </p>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

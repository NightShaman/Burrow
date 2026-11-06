import React from 'react';
import { createRoot } from 'react-dom/client';
import { FirstRunSetup } from '../../src/features/settings/FirstRunSetup';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import '../../src/app.css';
const requests: unknown[] = [],
  errors: string[] = [];
window.addEventListener('error', (e) => errors.push(e.message));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
Object.assign(window, { fixtureEvidence: { requests, errors } });
window.fetch = async (input, init) => {
  const path = String(input),
    method = init?.method ?? 'GET';
  requests.push({ path, method });
  if (path === '/api/settings/model-connections') return Response.json({ connections: [] });
  if (path === '/api/settings/model-connections/openai-oauth/start')
    return Response.json({
      connection: {
        id: 'fixture-oauth',
        provider: 'OpenAI',
        apiType: 'openai-responses',
        baseUrl: 'https://fixture.invalid/v1',
        models: [],
      },
      login: { id: 'fixture-login', status: 'waiting_for_code' },
    });
  if (path.endsWith('/cancel'))
    return Response.json({ login: { id: 'fixture-login', status: 'cancelled' } });
  throw new Error(`Unexpected first-run mocked API ${method} ${path}`);
};
createRoot(document.getElementById('root')!).render(
  <ConfirmProvider>
    <main className="cockpit" data-theme="smatchet">
      <header className="app-header">
        Actual mandatory FirstRunSetup — local OAuth response only
      </header>
      <FirstRunSetup
        agents={[]}
        selectedId=""
        onSelect={() => {}}
        onAgentsChanged={async () => {}}
        onModelConnectionsChanged={async () => {}}
        onOperatorProfileChanged={() => {}}
        onFirstRunComplete={() => {}}
      />
    </main>
  </ConfirmProvider>,
);

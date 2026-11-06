import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ModelConnections } from '../../src/features/settings/ModelConnections';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import type { SavedProvider } from '../../src/app/types';
import { UnsavedChangesProvider } from '../../src/app/UnsavedChanges';
import '../../src/app.css';
import '../../src/features/settings/settingsWorkspace.css';
import '../../src/features/settings/settingsSizing.css';
const account = (id: string, provider: string, family = 'OpenAI'): SavedProvider => ({
  id,
  provider,
  apiType: family === 'OpenAI' ? 'openai-responses' : 'anthropic-messages',
  url: 'https://example.invalid',
  apiKey: '',
  models: ['shared-model'],
  auth: { type: 'oauth', provider: family },
});
let connections: SavedProvider[] = [
  account('first', 'Personal ChatGPT'),
  {
    ...account('second', 'Work ChatGPT — a realistically long account name'),
    autoUseExpiringResets: true,
  },
  account('claude', 'Claude Max', 'Anthropic'),
  { ...account('api', 'OpenAI API key'), auth: undefined, apiKeyConfigured: true },
  {
    ...account('pool', 'OpenAI pool'),
    apiType: 'openai-lb',
    pool: { enabled: true, memberConnectionIds: ['first'], sticky: true },
  },
];
const requests: unknown[] = [];
let failNextSave = false;
window.fetch = (async (url, options) => {
  const path = String(url),
    body = JSON.parse(String(options?.body || '{}'));
  requests.push({ path, body });
  if (path.endsWith('/discover'))
    return Response.json({
      models: [
        { id: 'shared-model', displayName: 'Shared model', selected: true },
        { id: 'second-model', displayName: 'Reasoning model', selected: true },
      ],
    });
  if (path === '/api/settings/model-connections' && options?.method === 'POST') {
    if (failNextSave) {
      failNextSave = false;
      return Response.json({ error: 'Fixture save failure' }, { status: 500 });
    }
    const saved = {
      ...connections.find((item) => item.id === body.id),
      ...body,
      id: body.id || `new-pool-${connections.length}`,
      url: body.baseUrl,
      apiKey: '',
      connectionModels: [
        { id: 'shared-model', selected: true },
        { id: 'second-model', selected: true },
      ],
      models: ['shared-model', 'second-model'],
    };
    connections = [...connections.filter((item) => item.id !== saved.id), saved];
    return Response.json({ connection: saved });
  }
  return Response.json({ error: 'Unexpected fixture request' }, { status: 400 });
}) as typeof fetch;
Object.assign(window, { fixtureEvidence: { requests } });
function Fixture() {
  const [providers, setProviders] = useState(connections);
  const [loadBalancing, setLoadBalancing] = useState(false);

  return (
    <main
      className="settings-mode settings-blank-slate settings-fidgit"
      style={{ height: '100vh' }}
    >
      <div className="settings-prototype-menu settings-blank-column">
        <h2>Settings</h2>
        <button>Connections</button>
      </div>
      <div className="settings-prototype-sections settings-blank-column">
        <h2>Connections</h2>
        <button onClick={() => setLoadBalancing(false)}>Models</button>
        <button onClick={() => setLoadBalancing(true)}>Load Balancing</button>
        <button
          onClick={() => {
            failNextSave = true;
          }}
        >
          Fail next save
        </button>
      </div>
      <div
        className="settings-content-workspace settings-content-single settings-content-models"
        data-layout="single"
      >
        <div className="settings-prototype-configuration settings-blank-column">
          <ModelConnections
            key={String(loadBalancing)}
            loadBalancing={loadBalancing}
            savedProviders={providers}
            onModelConnectionsChanged={async () => setProviders([...connections])}
            mcpConnections={null}
            overflowTarget={null}
          />
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <ConfirmProvider>
    <UnsavedChangesProvider>
      <Fixture />
    </UnsavedChangesProvider>
  </ConfirmProvider>,
);

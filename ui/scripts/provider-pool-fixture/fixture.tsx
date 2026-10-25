import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ModelConnections } from '../../src/features/settings/ModelConnections';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import type { SavedProvider } from '../../src/app/types';
import '../../src/app.css';
const account = (id: string, provider: string, family = 'OpenAI'): SavedProvider => ({ id, provider, apiType: family === 'OpenAI' ? 'openai-responses' : 'anthropic-messages', url: 'https://example.invalid', apiKey: '', models: ['shared-model'], auth: { type: 'oauth', provider: family } });
let connections: SavedProvider[] = [account('first', 'Personal ChatGPT'), account('second', 'Work ChatGPT — a realistically long account name'), account('claude', 'Claude Max', 'Anthropic')];
const requests: unknown[] = [];
window.fetch = (async (url, options) => {
  const path = String(url), body = JSON.parse(String(options?.body || '{}'));
  requests.push({ path, body });
  if (path.endsWith('/discover')) return Response.json({ models: [{ id: 'shared-model', displayName: 'Shared model', selected: true }, { id: 'second-model', displayName: 'Reasoning model', selected: true }] });
  if (path === '/api/settings/model-connections' && options?.method === 'POST') {
    const saved = { ...body, id: body.id || `new-pool-${connections.length}`, url: '', apiKey: '', connectionModels: [{ id: 'shared-model', selected: true }, { id: 'second-model', selected: true }], models: ['shared-model', 'second-model'] };
    connections = [...connections.filter(item => item.id !== saved.id), saved];
    return Response.json({ connection: saved });
  }
  return Response.json({ error: 'Unexpected fixture request' }, { status: 400 });
}) as typeof fetch;
Object.assign(window, { fixtureEvidence: { requests } });
function Fixture() {
  const [providers, setProviders] = useState(connections);
  const [loadBalancing, setLoadBalancing] = useState(true);
  const [overflow, setOverflow] = useState<HTMLDivElement | null>(null);
  return <main className="settings-blank-slate" style={{ height: '100vh' }}>
    <div className="settings-prototype-menu settings-blank-column"><h2>Settings</h2><button>Connections</button></div><div className="settings-prototype-sections settings-blank-column"><h2>Connections</h2><button onClick={() => setLoadBalancing(false)}>Models</button><button onClick={() => setLoadBalancing(true)}>Load Balancing</button></div>
    <div className="settings-prototype-configuration settings-blank-column"><ModelConnections key={String(loadBalancing)} loadBalancing={loadBalancing} savedProviders={providers} onModelConnectionsChanged={async () => setProviders([...connections])} mcpConnections={null} overflowTarget={overflow} /></div>
    <div className="settings-prototype-overflow settings-blank-column" ref={setOverflow} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<ConfirmProvider><Fixture /></ConfirmProvider>);

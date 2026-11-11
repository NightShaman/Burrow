import React from 'react';
import catalog from './backend-catalog.json';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import { Forge } from '../../src/features/forge/ForgePage';

// Isolated in-memory fixture: never dispatch generation or contact a backend.
const requests: unknown[] = [];
const models = catalog.models;
let selections = { image: { connectionId: 'capability-fixture', modelId: 'gif-only' } };
const jobs: unknown[] = [];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.origin).pathname;
  const method = init?.method ?? 'GET';
  requests.push({ path, method, body: init?.body });
  if (path === '/api/forge/catalog') return json({ ...catalog, models });
  if (path === '/api/forge/selections') {
    if (method === 'PUT') {
      const { mode, ...pair } = JSON.parse(String(init?.body));
      selections = { ...selections, [mode]: pair };
    }
    return json({ selections });
  }
  if (path === '/api/forge/jobs' && method === 'POST') {
    const body = JSON.parse(String(init?.body));
    const job = {
      ...body,
      id: `fixture-${jobs.length}`,
      kind: 'image',
      status: 'succeeded',
      createdAt: '2026-11-11T13:00:00Z',
      updatedAt: '2026-11-11T13:00:00Z',
      artifacts: [],
    };
    jobs.unshift(job);
    return json({ job });
  }
  if (path === '/api/forge/jobs') return json({ jobs });
  throw new Error(`Unexpected fixture request: ${method} ${path}`);
};
Object.assign(window, {
  forgeFixture: {
    requests,
    removeGif() {
      models[1].imageOptions = structuredClone(catalog.models[0].imageOptions);
    },
  },
});
createRoot(document.getElementById('root')!).render(
  <ConfirmProvider>
    <Forge
      selectedAgentId="smatchet"
      sessionId="fixture"
      savedProviders={[{ id: 'capability-fixture', provider: 'Compatible image API' }]}
    />
  </ConfirmProvider>,
);

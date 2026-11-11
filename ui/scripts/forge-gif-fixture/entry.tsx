import React from 'react';
import imageCapability from './catalog-capability.json';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import { Forge } from '../../src/features/forge/ForgePage';

// Isolated in-memory fixture: never dispatch generation or contact a backend.
const requests: unknown[] = [];
const base = {
  connectionId: 'fixture',
  kind: 'image',
  available: true,
  controls: [],
};
const models = [
  {
    ...base,
    modelId: 'animated',
    label: 'Animation-capable image model',
    imageOptions: imageCapability,
  },
  { ...base, modelId: 'still', label: 'Still-only image model' },
];
let selections = {};
const scenario = new URLSearchParams(location.search).get('state');
const jobs: unknown[] =
  scenario === 'error'
    ? [
        {
          id: 'failed',
          connectionId: 'fixture',
          modelId: 'animated',
          kind: 'image',
          prompt: 'A magenta dragon turns toward the camera.',
          status: 'failed',
          createdAt: '2026-11-11T13:00:00Z',
          updatedAt: '2026-11-11T13:00:00Z',
          artifacts: [],
          errorDetails: {
            stage: 'encoding',
            code: 'gif_encode_failed',
            message: 'Could not encode the animated GIF. No artifact was produced.',
          },
        },
      ]
    : [];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.origin).pathname;
  const method = init?.method ?? 'GET';
  requests.push({ path, method, body: init?.body });
  if (path === '/api/forge/catalog') return json({ models, music: { models: [] } });
  if (path === '/api/forge/selections') {
    if (method === 'PUT') {
      const { mode, ...pair } = JSON.parse(String(init?.body));
      selections = { ...selections, [mode]: pair };
    }
    return json({ selections });
  }
  if (path === '/api/forge/jobs' && method === 'POST') {
    if (scenario === 'error')
      return json({ error: 'Animated GIF is unavailable for this model.' }, 400);
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
Object.assign(window, { forgeFixture: { requests } });
createRoot(document.getElementById('root')!).render(
  <ConfirmProvider>
    <Forge
      selectedAgentId="smatchet"
      sessionId="fixture"
      savedProviders={[{ id: 'fixture', provider: 'Fixture provider' }]}
    />
  </ConfirmProvider>,
);

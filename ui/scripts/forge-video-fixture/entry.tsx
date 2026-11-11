import React from 'react';
import catalogFixture from './catalog.json';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import { Forge } from '../../src/features/forge/ForgePage';

// Every API request is handled in memory. No backend or provider calls.
const requests: unknown[] = [];
const scenario = new URLSearchParams(location.search).get('state');
const catalog =
  scenario === 'unsupported' ? catalogFixture.textOnlyCatalog : catalogFixture.catalog;
const models = catalog.models;
let selections = {};
const jobs: unknown[] = [
  {
    id: 'existing-image-job',
    connectionId: 'google',
    modelId: 'image',
    kind: 'image',
    prompt: 'Magenta dragon study',
    status: 'succeeded',
    createdAt: '2026-11-11T19:00:00Z',
    updatedAt: '2026-11-11T19:00:00Z',
    artifacts: [
      {
        id: 'existing-image',
        kind: 'image',
        name: 'dragon-study.png',
        mimeType: 'image/png',
        sizeBytes: 1024,
        previewUrl: '/fixture-image.png',
      },
    ],
  },
];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.origin).pathname;
  const method = init?.method ?? 'GET';
  requests.push({ path, method, body: init?.body });
  if (path === '/fixture-image.png') {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 420;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#17131e';
    ctx.fillRect(0, 0, 640, 420);
    ctx.fillStyle = '#d946ef';
    ctx.font = '90px serif';
    ctx.textAlign = 'center';
    ctx.fillText('✦', 320, 220);
    ctx.fillStyle = '#dec8e4';
    ctx.font = '20px monospace';
    ctx.fillText('Dragon study · fixture', 320, 310);
    return new Response(await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png')));
  }
  if (path === '/api/forge/catalog')
    return json({
      ...catalog,
      agentReferenceImages:
        scenario === 'empty'
          ? []
          : [
              { agentId: 'smatchet', agentName: 'Smatchet', id: 'portrait-s' },
              { agentId: 'kerning', agentName: 'Kerning', id: 'portrait-k' },
            ],
      operatorReferenceImage: scenario === 'empty' ? null : { id: 'portrait-o' },
    });
  if (path === '/api/forge/selections') {
    if (method === 'PUT') {
      const { mode, ...pair } = JSON.parse(String(init?.body));
      selections = { ...selections, [mode]: pair };
    }
    return json({ selections });
  }
  if (path === '/api/forge/jobs' && method === 'POST') {
    if (scenario === 'error') return json({ error: 'forge_reference_artifact_invalid' }, 409);
    const body = JSON.parse(String(init?.body));
    const job = {
      ...body,
      id: `fixture-${jobs.length}`,
      kind: models.find((m) => m.modelId === body.modelId)?.kind,
      status: 'succeeded',
      createdAt: '2026-11-11T19:00:00Z',
      updatedAt: '2026-11-11T19:00:00Z',
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
      savedProviders={[{ id: 'google', provider: 'Google' }]}
    />
  </ConfirmProvider>,
);

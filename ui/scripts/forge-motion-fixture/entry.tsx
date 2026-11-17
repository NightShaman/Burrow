import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import { Forge } from '../../src/features/forge/ForgePage';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
const nativeFrame = window.requestAnimationFrame.bind(window);
function pump() {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((cb) => cb(now));
  nativeFrame(pump);
}
nativeFrame(pump);
let status = 'running';
let now = 0;
let sequence = 0;
const frames = new Map<number, FrameRequestCallback>();
window.requestAnimationFrame = (cb) => {
  frames.set(++sequence, cb);
  return sequence;
};
window.cancelAnimationFrame = (id) => {
  frames.delete(id);
};
function advance() {
  for (let i = 0; i < 25; i++) {
    now += 40;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((cb) => cb(now));
  }
}
const original = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const path = String(input);
  if (!path.includes('/api/')) return original(input, init);
  const body = path.includes('/forge/catalog')
    ? { models: [] }
    : path.includes('/forge/jobs')
      ? {
          jobs: [
            {
              id: 'agent-job',
              kind: 'image',
              mode: 'image',
              prompt: 'Agent-started image lifecycle fixture',
              status,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              artifacts:
                status === 'succeeded'
                  ? [
                      {
                        id: 'sample',
                        kind: 'image',
                        name: 'fixture.png',
                        mimeType: 'image/png',
                        sizeBytes: 1234,
                        previewUrl: '/forge.png',
                      },
                    ]
                  : [],
            },
          ],
        }
      : path.includes('/ui/preferences')
        ? { preferences: { forgeEffects: true } }
        : { selections: {} };
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
};
createRoot(document.getElementById('root')!).render(
  <ConfirmProvider>
    <div style={{ padding: 12 }}>
      <button
        onClick={() => {
          status = 'succeeded';
        }}
      >
        Complete agent job (next poll)
      </button>
      <button onClick={advance}>Advance presentation 1 second</button>
      <Forge selectedAgentId="smatchet" sessionId="fixture" />
    </div>
  </ConfirmProvider>,
);

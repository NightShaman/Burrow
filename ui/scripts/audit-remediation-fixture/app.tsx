// Real App polling gate, with a strictly local in-memory API responder.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/App';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import '../../src/app.css';
const requests: { path: string; method: string }[] = [],
  errors: string[] = [];
let failChat: (() => void) | null = null,
  chatStreamStarted = false;
window.addEventListener('error', (e) => errors.push(e.message));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
window.localStorage.setItem('hc.leftRailLayout', JSON.stringify({ version: 1, value: 'single' }));
window.localStorage.setItem('hc.leftSinglePanel', JSON.stringify({ version: 1, value: 'agents' }));
window.localStorage.setItem('hc.rightRailLayout', JSON.stringify({ version: 1, value: 'single' }));
window.localStorage.setItem(
  'hc.rightSinglePanel',
  JSON.stringify({ version: 1, value: 'workspace' }),
);
window.localStorage.setItem('hc.selectedAgentId', JSON.stringify({ version: 1, value: 'hatchet' }));
Object.assign(window, {
  fixtureEvidence: { requests, errors },
  fixtureFailChat: () => {
    if (!failChat) throw new Error('No pending accepted stream');
    failChat();
    failChat = null;
  },
  fixtureChatStreamStarted: () => chatStreamStarted,
});
window.fetch = async (input, init) => {
  const path = String(input),
    method = init?.method ?? 'GET';
  requests.push({ path, method });
  const url = new URL(path, 'https://fixture.invalid');
  let data: any;
  if (url.pathname === '/api/chat' && method === 'POST') {
    chatStreamStarted = true;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              type: 'assistant.delta',
              data: { delta: 'Synthetic partial answer before failed stream' },
            }) + '\n',
          ),
        );
        failChat = () => controller.error(new Error('Synthetic accepted stream interruption'));
      },
    });
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
  }
  if (url.pathname === '/api/health')
    data = { ok: true, version: 'fixture', ui: { authMode: 'none' } };
  else if (url.pathname === '/api/setup/status') data = { wizardStep: 'ready', configured: true };
  else if (url.pathname === '/api/agents')
    data = { agents: [{ id: 'hatchet', name: 'Hatchet', enabled: true, avatar: 'H' }] };
  else if (url.pathname === '/api/agents/overview')
    data = {
      agents: [
        {
          agent: { id: 'hatchet', name: 'Hatchet', enabled: true, avatar: 'H' },
          sessionId: 'default',
          selection: null,
          status: { agents: [] },
          contexts: { default: {} },
        },
      ],
    };
  else if (url.pathname === '/api/settings/identities')
    data = { operator: { name: 'Fixture operator', avatar: '' }, agents: [] };
  else if (url.pathname === '/api/settings/model-connections') data = { connections: [] };
  else if (url.pathname === '/api/workspace/files')
    data = { files: [{ path: '/workspace/hatchet/fixture.txt', type: 'file' }] };
  else if (url.pathname === '/api/sessions')
    data = {
      sessions: [
        { id: 'default', title: 'Fixture chat A', updatedAt: '2026-11-06T04:00:00Z' },
        { id: 'second', title: 'Fixture chat B', updatedAt: '2026-11-06T04:00:00Z' },
      ],
    };
  else if (url.pathname === '/api/sessions/default' || url.pathname === '/api/sessions/second')
    data = {
      session: { id: url.pathname.split('/')[3], turns: [], hasMore: false, nextCursor: null },
    };
  else if (url.pathname === '/api/chat/runs/active')
    data = { runs: [], childActivities: [], a2aActivities: [] };
  else if (url.pathname === '/api/chat/inputs') data = { generation: 1, inputs: [] };
  else if (url.pathname === '/api/task-board/conversation-project')
    data = { ok: true, project: null };
  else if (url.pathname === '/api/agents/hatchet/model-selection') data = { selection: null };
  else if (url.pathname === '/api/agents/status') data = { status: { agents: [] } };
  else if (url.pathname === '/api/session/context-status') data = { status: {} };
  else if (url.pathname === '/api/mods' || url.pathname === '/api/mod-panels')
    data = { mods: [], panels: [] };
  else if (url.pathname === '/api/metrics')
    data = {
      ok: true,
      process: {
        cpu: { percent: 0 },
        uptimeSeconds: 0,
        rssBytes: 0,
        heapUsedBytes: 0,
        heapTotalBytes: 0,
        externalBytes: 0,
      },
      load: { oneMinute: 0, fiveMinutes: 0, fifteenMinutes: 0 },
      filesystem: { usedBytes: 0, totalBytes: 1, availableBytes: 1 },
    };
  else throw new Error(`Unexpected App fixture API ${method} ${path}`);
  return Response.json(data);
};
createRoot(document.getElementById('root')!).render(
  <ConfirmProvider>
    <App />
  </ConfirmProvider>,
);

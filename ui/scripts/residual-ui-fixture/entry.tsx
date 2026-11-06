import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useChatSession } from '../../src/features/chat/useChatSession';
import { ChatTranscript } from '../../src/features/chat/ChatTranscript';
import { GroupChannelsPage } from '../../src/features/groups/GroupChannelsPage';
import type { Agent } from '../../src/app/types';
import '../../src/app.css';

// All reads/writes are in-memory. CSP also prohibits backend/provider connections.
const requests: { path: string; method: string }[] = [];
const pending: { id: string; resolve: (value: Response) => void }[] = [];
const errors: string[] = [];
let failRefresh = false;
let sent = false;
let resolveSend: (() => void) | undefined;
const response = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const turn = (id: string) => ({
  id,
  type: 'message',
  role: 'user',
  content: id,
  ts: '2026-11-06T21:00:00Z',
});
window.addEventListener('error', (e) => errors.push(e.message));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
window.fetch = async (input, init) => {
  const path = String(input),
    method = init?.method ?? 'GET';
  requests.push({ path, method });
  const url = new URL(path, 'http://fixture.invalid');
  if (url.pathname === '/api/settings/identities') return response({});
  if (url.pathname.endsWith('/messages') && method === 'POST')
    return new Promise((resolve) => {
      resolveSend = () => {
        sent = true;
        failRefresh = true;
        resolve(response({ ok: true }));
      };
    });
  if (url.pathname.startsWith('/api/group-channels/')) {
    if (failRefresh)
      return new Response(JSON.stringify({ error: 'refresh unavailable' }), { status: 503 });
    return response({
      channel: {
        id: 'room-1',
        participantAgentIds: [],
        turns: sent ? [turn('Confirmed group message')] : [turn('Existing group conversation')],
      },
    });
  }
  if (url.pathname === '/api/sessions') return response({ sessions: [{ id: 'a' }, { id: 'b' }] });
  const id = url.pathname.split('/').pop()!;
  if (url.searchParams.has('before'))
    return new Promise((resolve) => {
      pending.push({ id, resolve });
    });
  if (url.pathname.startsWith('/api/sessions/'))
    return response({
      session: { id, turns: [turn(`${id} newest`)], hasMore: true, nextCursor: 'older' },
    });
  return response({ runs: [], subagents: [] });
};
Object.assign(window, {
  fixtureEvidence: { requests, pending, errors },
  fixtureReleaseOlder: (index: number, label: string) =>
    pending[index].resolve(
      response({ session: { id: pending[index].id, turns: [turn(label)], hasMore: false } }),
    ),
  fixtureConfirmSend: () => resolveSend?.(),
  fixtureRecover: () => {
    failRefresh = false;
  },
});
const base = {
  avatar: 'M',
  activity: 'Idle',
  context: null,
  provider: '',
  model: '',
  effort: '',
  temperature: 0,
  workspace: '',
  files: [],
  subagents: [],
};
function ChatFixture() {
  const [agentId, setAgentId] = useState('magenta');
  const chat = useChatSession(agentId);
  const agent = { ...base, id: agentId, name: agentId } as Agent;
  return (
    <>
      <header className="app-header" style={{ display: 'flex', gap: 16, padding: 16 }}>
        <strong>Mocked chat pagination</strong>
        <button onClick={() => chat.selectSession('a')}>Session A</button>
        <button onClick={() => chat.selectSession('b')}>Session B</button>
        <button onClick={() => setAgentId(agentId === 'magenta' ? 'teal' : 'magenta')}>
          Switch agent
        </button>
        <output data-testid="owner">
          {agentId}/{chat.sessionId}
        </output>
        <output data-testid="loading">{String(chat.isLoadingOlder)}</output>
      </header>
      <section className="workspace" style={{ gridColumn: '1 / 4', gridRow: 2 }}>
        <ChatTranscript
          selected={agent}
          parent={agent}
          operator={{ name: 'You', avatar: 'Y' }}
          isNewSession={false}
          turns={chat.turns}
          isLoading={chat.isLoadingConversation}
          onLoadOlder={chat.loadOlder}
          hasOlder={chat.hasOlder}
          isLoadingOlder={chat.isLoadingOlder}
          error={chat.chatError}
          isSending={false}
          activeRunId=""
          liveProgress={[]}
          liveAnswer=""
        />
      </section>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <main className="cockpit" data-theme="smatchet" style={{ height: '100vh' }}>
    {location.search.includes('group') ? (
      <>
        <header className="app-header" style={{ padding: 16 }}>
          Mocked Group Channels — no live sends
        </header>
        <section className="workspace" style={{ gridColumn: '1 / 4', gridRow: 2 }}>
          <GroupChannelsPage channelId="room-1" agents={[]} />
        </section>
      </>
    ) : (
      <ChatFixture />
    )}
  </main>,
);

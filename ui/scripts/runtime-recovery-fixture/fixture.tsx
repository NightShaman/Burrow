import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useChatSession } from '../../src/features/chat/useChatSession';
import { AuthenticationSettings } from '../../src/features/settings/AuthenticationSettings';
import '../../src/app.css';

// Every API operation is synthetic. Unknown requests fail closed.
let reset = false,
  fresh = false,
  authAttempts = 0;
let release: (() => void) | undefined;
const calls: string[] = [];
Object.assign(window, { recoveryEvidence: { calls } });
window.fetch = async (input, init) => {
  const url = String(input);
  calls.push(`${init?.method ?? 'GET'} ${url}`);
  if (url.endsWith('/api/settings/ui-auth')) {
    if (++authAttempts === 1)
      return Response.json({ error: 'Synthetic recovery outage' }, { status: 503 });
    return Response.json({
      auth: { mode: 'none' },
      effective: { mode: 'trusted-proxy', source: 'environment' },
    });
  }
  if (url.includes('/reset?')) {
    reset = true;
    return Response.json({});
  }
  if (url.includes('/api/sessions?')) return Response.json({ sessions: [{ id: 'recovery' }] });
  if (url.includes('/api/sessions/recovery?')) {
    if (url.includes('before=')) {
      if (!fresh)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return Response.json({
        session: {
          id: 'recovery',
          turns: [
            {
              id: fresh ? 'fresh-old' : 'obsolete',
              role: 'user',
              content: fresh ? 'Fresh older history' : 'OBSOLETE HISTORY',
            },
          ],
          hasMore: false,
          metadata: { resetGeneration: fresh ? 1 : 0 },
        },
      });
    }
    return Response.json({
      session: {
        id: 'recovery',
        turns: reset
          ? fresh
            ? [{ id: 'fresh', role: 'user', content: 'Fresh conversation' }]
            : []
          : [{ id: 'before', role: 'user', content: 'Before reset conversation' }],
        hasMore: !reset || fresh,
        nextCursor: 'older',
        metadata: { resetGeneration: reset ? 1 : 0 },
      },
    });
  }
  if (url.includes('/api/runs')) return Response.json({ runs: [] });
  throw Error(`Unexpected fixture fetch: ${url}`);
};
function Fixture() {
  const chat = useChatSession('recovery-agent');
  const [status, setStatus] = useState('Ready');
  return (
    <main style={{ padding: 40, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 40 }}>
      <section className="rail-panel" style={{ padding: 24 }}>
        <h1>Runtime Recovery</h1>
        <p>Real useChatSession · synthetic API only</p>
        <button
          id="older"
          disabled={!chat.hasOlder || chat.isLoadingOlder}
          onClick={() => void chat.loadOlder()}
        >
          Load older history
        </button>
        <button
          id="reset"
          onClick={() => void chat.resetSession().then(() => setStatus('Reset confirmed'))}
        >
          Reset session
        </button>
        <button
          id="release"
          onClick={() => {
            release?.();
            setStatus('Obsolete request released');
          }}
        >
          Release obsolete history
        </button>
        <button
          id="fresh"
          onClick={() => {
            fresh = true;
            chat.leaveNewSessionForMessage();
            void chat.refreshConversation().then(() => setStatus('Fresh conversation loaded'));
          }}
        >
          Refresh fresh conversation
        </button>
        <p id="status">{status}</p>
        <p id="paging">{JSON.stringify({ older: chat.hasOlder, loading: chat.isLoadingOlder })}</p>
        <div id="turns">
          {chat.turns.map((turn, i) => (
            <p key={i}>{turn.content}</p>
          ))}
        </div>
        <p role="alert">{chat.chatError}</p>
      </section>
      <section className="rail-panel" style={{ padding: 24 }}>
        <h1>Authentication recovery</h1>
        <AuthenticationSettings />
      </section>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

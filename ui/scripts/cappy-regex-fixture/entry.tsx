import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import { GroupChannelsPage } from '../../src/features/groups/GroupChannelsPage';
import { ChatMessage } from '../../src/features/chat/ChatMessage';
import { ChatComposer } from '../../src/features/chat/ChatComposer';
import { useChatComposer } from '../../src/features/chat/useChatComposer';
import { conversationCacheKey } from '../../src/features/chat/chatConversationCache';
import { readDraftCache, writeDraftCache } from '../../src/features/chat/chatDraftCache';
import { trimStreamedAnswer } from '../../src/features/chat/useChatRun';
import { useAppMutations } from '../../src/app/useAppMutations';
import type { Agent } from '../../src/app/types';
import type { ChatAttachment } from '../../src/app/api';
const agents = [
  { id: 'jose', name: 'José', enabled: true },
  { id: 'yamada', name: '山田', enabled: true },
] as Agent[];
window.fetch = async () =>
  new Response(
    JSON.stringify({
      ok: true,
      channel: { id: 'fixture', name: 'Design review', participantAgentIds: ['jose', 'yamada'] },
      turns: [
        {
          id: '1',
          role: 'user',
          content: 'Review the parser changes and keep the original formatting.',
          ts: '2026-11-11T23:00:00Z',
        },
      ],
      runs: [],
    }),
    { headers: { 'content-type': 'application/json' } },
  );
const draftReview = new URLSearchParams(location.search).has('drafts');
if (draftReview && !localStorage.getItem('hc.chatDrafts')) {
  writeDraftCache(
    Object.fromEntries(
      Array.from({ length: 55 }, (_, index) => [
        conversationCacheKey('jose', `draft-${index}`),
        {
          value: `Unsent draft ${index}: preserve my authored work.`,
          updatedAt: Date.now() - 7 * 24 * 60 * 60 * 1000,
        },
      ]),
    ),
  );
}
const final = 'The final answer is authoritative.';
const stream =
  '```python\nif ready:\n    act()\n```\n\n- Keep the indentation\n  - Nested item\n\n' + final;
function Review() {
  const [scope] = useState({});
  const composer = useChatComposer('jose', draftReview ? 'draft-54' : 'normal', scope, () => true);
  const { draft, setDraft } = composer;
  const [attached, setAttached] = useState<ChatAttachment[]>([]);
  const [error, setError] = useState('');
  const mutations = useAppMutations({
    selected: undefined,
    setAgents: () => {},
    refreshSessions: async () => {},
    reportError: setError,
    writeModelSelection: async () => {},
    attached,
    isAttachmentScopeCurrent: () => true,
    setAttachment: (items) => setAttached((v) => [...v, ...items]),
  });
  const group = new URLSearchParams(location.search).get('view') === 'group';
  function inject(kind: string) {
    const file =
      kind === 'jsonl'
        ? new File(['{"ok":true}\n'], 'data.jsonl', { type: 'application/x-ndjson' })
        : kind === 'binary'
          ? new File([new Uint8Array([0, 1, 2, 255])], 'disguised.txt', {
              type: 'application/octet-stream',
            })
          : new File(['export default true;'], 'module.mjs', { type: 'application/javascript' });
    if (group) {
      const input = document.querySelector('input[type=file]') as HTMLInputElement;
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else mutations.attachImage([file]);
  }
  return (
    <div
      style={{
        height: '100vh',
        display: 'grid',
        gridTemplateRows: '48px minmax(0,1fr)',
        padding: '20px 60px',
        gap: 20,
      }}
    >
      <nav style={{ display: 'flex', gap: 16 }}>
        <a href="?view=normal">Normal chat</a>
        <a href="?view=group">Group chat</a>
        <button onClick={() => inject('jsonl')}>Attach JSONL</button>
        <button onClick={() => inject('js')}>Attach JavaScript</button>
        <button onClick={() => inject('binary')}>Attach binary</button>
        {draftReview && <span>Stored authored drafts: {Object.keys(readDraftCache()).length}</span>}
      </nav>
      {group ? (
        <GroupChannelsPage channelId="fixture" agents={agents} />
      ) : (
        <main
          className="chat-panel"
          style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}
        >
          <div className="chat-messages" style={{ flex: 1, overflow: 'auto' }}>
            <ChatMessage
              side="agent"
              name="Smatchet"
              avatar=""
              time="17:00"
              text={final}
              streamedAnswer={trimStreamedAnswer(stream, final)}
            />
          </div>
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          <ChatComposer
            draft={draft}
            setDraft={setDraft}
            attached={attached}
            onAttach={mutations.attachImage}
            onRemoveAttachment={(i) => setAttached((v) => v.filter((_, j) => i !== j))}
            onSend={() => {}}
            placeholder="Message Smatchet"
          />
        </main>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Review />);

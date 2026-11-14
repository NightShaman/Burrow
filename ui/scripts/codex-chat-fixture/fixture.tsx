import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Chat } from '../../src/features/chat/ChatPage';
import type { Agent, Subagent } from '../../src/app/types';
import type { ChatAttachment } from '../../src/app/api';
import '../../src/app.css';
window.fetch = async () =>
  new Response(JSON.stringify({ inputs: [], generation: 1, sessions: [] }), {
    headers: { 'Content-Type': 'application/json' },
  });
const parent: Agent = {
  id: 'smatchet',
  name: 'Smatchet',
  avatar: 'S',
  activity: 'idle',
  context: null,
  provider: 'test',
  model: 'test',
  effort: 'off',
  temperature: 0.2,
  workspace: '',
  files: [],
  subagents: [],
};
const child: Subagent = {
  id: 'codex-child',
  name: 'Codex UI review',
  avatar: 'C',
  activity: '',
  context: null,
  stream: 'codex-child',
  depth: 1,
  harness: 'codex',
};
function Fixture() {
  const params = new URLSearchParams(location.search);
  const ordinary = params.has('ordinary');
  const [draft, setDraft] = useState('Check the keyboard navigation and report any regressions.');
  const [attached, setAttached] = useState<ChatAttachment[]>(
    params.has('stale')
      ? [
          {
            name: 'notes.txt',
            type: 'text/plain',
            content: 'data:text/plain;base64,bm90ZXM=',
            size: 5,
            encoding: 'data-url',
          },
        ]
      : [],
  );
  const [sent, setSent] = useState(false);
  return (
    <main
      style={{
        maxWidth: 1180,
        height: 'calc(100dvh - 48px)',
        margin: '24px auto',
        padding: '0 24px',
      }}
    >
      <Chat
        selected={ordinary ? parent : child}
        parent={parent}
        operator={{ name: 'Goblin King', avatar: 'G' }}
        draft={draft}
        setDraft={setDraft}
        attached={attached}
        onAttach={(files) =>
          setAttached((prev) => [
            ...prev,
            ...files.map((file) => ({
              name: file.name,
              type: file.type,
              content: 'data:text/plain;base64,bm90ZXM=',
              size: 5,
              encoding: 'data-url',
            })),
          ])
        }
        onRemoveAttachment={(index) => setAttached((prev) => prev.filter((_, i) => i !== index))}
        isNewSession={false}
        turns={[
          {
            type: 'message',
            role: 'user',
            content: 'Review the existing minion interface without changing unrelated behavior.',
          },
          {
            type: 'message',
            role: 'assistant',
            content: 'The review is ready. Send a follow-up to continue this thread.',
          },
        ]}
        isLoading={false}
        error=""
        isSending={false}
        activeRunId=""
        liveProgress={[]}
        liveAnswer=""
        onSend={(_, accepted) => {
          accepted?.();
          setSent(true);
        }}
        onCancel={() => {}}
        selectedAgentId={ordinary ? parent.id : child.id}
        resourceAgentId={ordinary ? parent.id : child.id}
        sessionId={ordinary ? 'default' : child.stream}
      />
      {sent && <output role="status">Text follow-up accepted by fixture</output>}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

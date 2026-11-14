import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import { ChatTranscript } from '../../src/features/chat/ChatTranscript';
import { reconcileSessionTurns } from '../../src/features/chat/chatTurnReconciliation';
import type { SessionTurn, ChatSession } from '../../src/app/api';
const video: SessionTurn = {
  id: 'video',
  role: 'assistant',
  type: 'message',
  runId: 'forge',
  content: '',
  ts: '2026-11-14T04:53:18Z',
  metadata: {
    attachments: [
      { index: 0, name: 'outfit.mp4', type: 'video/mp4', artifactPath: 'artifacts/outfit.mp4' },
    ],
  },
};
const final: SessionTurn = {
  id: 'final',
  role: 'assistant',
  type: 'message',
  runId: 'forge',
  content: 'Your outfit showcase, my King.',
  ts: '2026-11-14T04:53:20Z',
};
const session: ChatSession = {
  id: 'default',
  turns: [video, final],
  activities: [
    {
      runId: 'forge',
      summary: '3 runtime actions',
      items: [{ label: 'Forge', detail: 'Generated video', status: 'ok' }],
    },
  ],
};
function Fixture() {
  const [turns, setTurns] = React.useState(() => reconcileSessionTurns(session, [video]));
  return (
    <main style={{ maxWidth: 1200, margin: '24px auto' }}>
      <button onClick={() => setTurns((current) => reconcileSessionTurns(session, current))}>
        Refresh snapshot
      </button>
      <ChatTranscript
        selected={{ id: 'smatchet', name: 'Smatchet', avatar: 'S' }}
        parent={{ id: 'smatchet', name: 'Smatchet', avatar: 'S' }}
        operator={{ name: 'King', avatar: 'K' }}
        isNewSession={false}
        turns={turns}
        isLoading={false}
        error=""
        isSending={false}
        activeRunId=""
        liveProgress={[]}
        liveAnswer=""
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

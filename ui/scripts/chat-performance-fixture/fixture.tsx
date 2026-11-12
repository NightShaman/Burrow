import React, { Profiler, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatTranscript } from '../../src/features/chat/ChatTranscript';
import { useChatSession } from '../../src/features/chat/useChatSession';
import { useChatInputs } from '../../src/features/chat/useChatInputs';
import { reconcileChatInputs } from '../../src/features/chat/chatInputs';
import type { ActiveChatRunsResponse, SessionTurn } from '../../src/app/api';
import type { Agent } from '../../src/app/types';
import '../../src/app.css';

const evidence = {
  polls: 0,
  inputs: 0,
  reloads: 0,
  markdown: 0,
  messages: 0,
  commits: [] as number[],
};
Object.assign(window, { chatPerf: evidence });
const paragraph =
  '# Investigation sample\n\nA realistic **engineering answer** with [a link](https://example.org), inline `code` and several paragraphs.\n\n- First supporting detail\n- Second supporting detail\n\n| Item | Result |\n| --- | --- |\n| Polling | Verified |\n| Render | Measured |\n\n' +
  'More technical explanation with **emphasis** and ordinary prose. '.repeat(8);
let turns: SessionTurn[] = Array.from({ length: 200 }, (_, i) => ({
  id: `row-${i}`,
  type: 'message',
  role: i % 2 ? 'assistant' : 'user',
  runId: `run-${i}`,
  ts: '2026-11-12T10:00:00Z',
  content: `${paragraph}\n\nMessage ${i + 1}`,
  metadata: i % 2 ? { chatResultVersion: 2, terminalStatus: 'completed' } : {},
}));
let active: ActiveChatRunsResponse = { ok: true, runs: [] };
let queued: unknown[] = [];
// Fail closed: this fixture cannot issue any real backend/provider request.
window.fetch = async (input) => {
  const url = String(input);
  if (url.includes('/api/chat/runs/active')) {
    evidence.polls++;
    return Response.json(active);
  }
  if (url.includes('/api/chat/inputs?')) {
    evidence.inputs++;
    return Response.json({ generation: 1, inputs: queued });
  }
  if (url.includes('/api/sessions?'))
    return Response.json({ sessions: [{ id: 'default', updatedAt: '2026-11-12T13:00:00Z' }] });
  if (url.includes('/api/sessions/default?')) {
    evidence.reloads++;
    return Response.json({
      session: { id: 'default', turns, metadata: { updatedAt: '2026-11-12T13:00:00Z' } },
    });
  }
  throw Error(`Unmocked fixture request: ${url}`);
};
const agent = { id: 'fixture', name: 'Smatchet', avatar: 'S', subagents: [] } as unknown as Agent;
const operator = { name: 'Goblin King', avatar: 'K' };
const empty: never[] = [];
function Fixture() {
  const chat = useChatSession('fixture');
  const inputs = useChatInputs('fixture', chat.sessionId, 0);
  const [version, update] = useState(0);
  const displayed = React.useMemo(
    () => reconcileChatInputs(chat.turns, inputs.inputs),
    [chat.turns, inputs.inputs],
  );
  const run = chat.runtimeRun;
  const change = (kind: string) => {
    if (kind === 'active')
      active = {
        ok: true,
        runs: [
          {
            agentId: 'fixture',
            sessionId: 'default',
            runId: 'current',
            status: 'running',
            latestUserMessage: 'Synthetic active message',
            answerText: 'Live **answer**',
          },
        ],
      };
    if (kind === 'advance')
      active.runs[0] = {
        ...active.runs[0],
        answerText: 'Updated live **answer**',
        progress: [
          { type: 'tool.started', runId: 'current', data: { tool: 'read', activityId: 'tool-1' } },
        ],
      };
    if (kind === 'terminal') {
      turns = [
        ...turns,
        {
          id: 'terminal',
          type: 'message',
          role: 'assistant',
          runId: 'current',
          content: 'Synthetic terminal answer',
          metadata: { chatResultVersion: 2, terminalStatus: 'completed' },
        },
      ];
      active = { ok: true, runs: [{ ...active.runs[0], status: 'completed' }] };
    }
    if (kind === 'attachment') {
      turns = [
        ...turns,
        {
          id: 'attachment',
          type: 'message',
          role: 'assistant',
          content: 'Late delivery',
          metadata: { attachments: [{ name: 'late.txt', type: 'text/plain' }] },
        },
      ];
      active = { ...active, pendingForgeDeliveries: 1 };
    }
    if (kind === 'settled') active = { ...active, pendingForgeDeliveries: 0 };
    if (kind === 'queue')
      queued = [
        {
          id: 'queued',
          intent: 'queue_next',
          status: 'held',
          generation: 1,
          message: 'Synthetic queued input',
          createdAt: '2026-11-12T13:00:00Z',
          attachments: [],
        },
      ];
    update(version + 1);
  };
  return (
    <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <strong>Synthetic chat performance acceptance</strong>
        {['active', 'advance', 'terminal', 'attachment', 'settled', 'queue'].map((kind) => (
          <button key={kind} onClick={() => change(kind)}>
            {kind}
          </button>
        ))}
        <output>{chat.turns.length} persisted messages</output>
      </header>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div className="chat-view" style={{ flex: 1, minWidth: 0 }}>
          <Profiler
            id="transcript"
            onRender={(_id, _phase, duration) => evidence.commits.push(duration)}
          >
            <ChatTranscript
              selected={agent}
              parent={agent}
              operator={operator}
              isNewSession={false}
              turns={displayed}
              isLoading={chat.isLoadingConversation}
              error={chat.chatError}
              isSending={Boolean(run)}
              activeRunId={run?.runId ?? ''}
              liveProgress={run?.progress ?? empty}
              liveAnswer={run?.answerText ?? ''}
              activeToolActivity={run?.toolActivity}
              runtimeUserMessage={run?.latestUserMessage}
              runtimeChildActivities={chat.runtimeChildActivities}
              a2aActivities={chat.a2aActivities}
              chatInputs={inputs.inputs}
            />
          </Profiler>
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

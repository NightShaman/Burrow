import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatTranscript } from '../../src/features/chat/ChatTranscript';
import { projectChatActivity } from '../../src/features/chat/chatActivityProjection';
import type { Agent } from '../../src/app/types';
import '../../src/app.css';

const agent: Agent = {
  id: 'kerning',
  name: 'Kerning',
  avatar: 'K',
  activity: '',
  context: null,
  provider: '',
  model: '',
  effort: '',
  temperature: 1,
  workspace: '',
  files: [],
  subagents: [],
};
function Example({ state }: { state: 'live' | 'completed' | 'error' }) {
  const live = state === 'live';
  const activity = projectChatActivity(
    {
      ok: true,
      runs: [
        {
          runId: 'fixture-run',
          agentId: agent.id,
          sessionId: 'fixture',
          status: 'running',
          progress: [
            {
              type: live ? 'tool.started' : 'tool.completed',
              data: {
                tool: 'mod_agent_tool',
                modToolName: 'notebook',
                activityId: 'notebook-1',
                ok: state !== 'error',
                status: state === 'error' ? 'failed' : 'completed',
                output: 'PRIVATE_PAYLOAD_MUST_NOT_APPEAR',
              },
            },
          ],
        },
      ],
    },
    {
      agentId: agent.id,
      sessionId: 'fixture',
      isChildSession: false,
      hadRuns: false,
      now: 0,
    },
  ).runtimeRun!.toolActivity!;
  useEffect(() => {
    document.querySelectorAll<HTMLDetailsElement>('details.tool-activity').forEach((card) => {
      card.open = true;
    });
  }, []);
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: 14, color: 'var(--text-muted)', margin: '0 0 12px' }}>
        {state === 'live'
          ? 'Live activity'
          : state === 'error'
            ? 'Completed activity · failed tool'
            : 'Completed activity'}
      </h2>
      <ChatTranscript
        selected={agent}
        parent={agent}
        operator={{ name: 'Rob', avatar: 'R' }}
        isNewSession={false}
        isLoading={false}
        error=""
        isSending={live}
        activeRunId={live ? 'fixture-run' : ''}
        activeToolActivity={live ? activity : undefined}
        liveProgress={[]}
        liveAnswer=""
        turns={
          live
            ? []
            : [
                {
                  role: 'assistant',
                  type: 'message',
                  runId: 'fixture-run',
                  content: state === 'error' ? 'The tool failed.' : 'Done.',
                  createdAt: '2026-11-11T15:00:00Z',
                  metadata: { toolActivity: activity },
                },
              ]
        }
      />
    </section>
  );
}
function Fixture() {
  return (
    <main style={{ maxWidth: 880, margin: '32px auto', padding: '0 24px' }}>
      <h1 style={{ fontSize: 18, marginBottom: 28 }}>Mod tool activity · component fixture</h1>
      <Example state="live" />
      <Example state="completed" />
      <Example state="error" />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

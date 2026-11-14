import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentTabs } from '../../src/app/AppChrome';
import { Chat } from '../../src/features/chat/ChatPage';
import { chatTerminalResult } from '../../src/features/chat/chatTerminal';
import { reconcileChatInputs, type ChatInput } from '../../src/features/chat/chatInputs';
import type { Agent } from '../../src/app/types';
import type { SessionTurn } from '../../src/app/api';
import '../../src/app.css';
import './fixture.css';

// Synthetic contract only. No provider/runtime/network calls or persisted settings.
window.fetch = async () => {
  throw new Error('Fixture blocks all fetches');
};
const evidence = { copied: [] as string[] };
Object.assign(window, { providerErrorEvidence: evidence });
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      evidence.copied.push(text);
    },
  },
});
document.execCommand = (command) => {
  if (command !== 'copy') return false;
  evidence.copied.push(document.querySelector<HTMLTextAreaElement>('body > textarea')?.value ?? '');
  return true;
};
const agent = {
  id: 'fixture',
  name: 'Hatchet',
  avatar: 'H',
  enabled: true,
  activity: '',
  context: null,
  provider: 'Synthetic',
  model: 'fixture',
  effort: '',
  temperature: 1,
  workspace: '',
  files: [],
  subagents: [],
} as Agent;
const at = '2026-11-05T20:00:00Z';
const no = () => {};
const runtimeCodes = [
  'context_compression_failed',
  'context_compression_unavailable',
  'context_preparation_prompt_over_budget',
  'context_preparation_uncovered_history',
  'CONTEXT_BOUNDARY_VIOLATION',
];
const states = [
  'provider',
  'fallback',
  'partial',
  'side',
  'local',
  'long',
  'success',
  ...runtimeCodes,
];
function Fixture() {
  const [state, setState] = useState<string>(
    new URLSearchParams(location.search).get('state') ?? 'provider',
  );
  const [draft, setDraft] = useState('');
  const runtime = runtimeCodes.includes(state);
  const upstream = state !== 'local' && !runtime;
  const message = runtime
    ? 'Compaction failed: selected model returned no summary. [REDACTED]'
    : state === 'long'
      ? `The usage limit has been reached. Try again after the account resets. Request reference: ${'a'.repeat(500)}\nContact support if this persists. <script>not executable</script>`
      : state === 'local'
        ? 'Selected model configuration is missing. [REDACTED]'
        : 'The usage limit has been reached';
  const terminal = chatTerminalResult(
    {
      result: {
        chatResultVersion: 2,
        terminalStatus: state === 'success' ? 'completed' : 'failed',
        modelFailure: {
          origin: upstream ? 'upstream' : 'burrow',
          code: runtime ? state : upstream ? 'provider_http_429' : 'model_result_invalid',
          retryable: upstream,
          ...(upstream ? { status: 429 } : {}),
          ...(state === 'fallback' ? {} : { message }),
        },
        modelRecovery: {
          version: 1,
          retryCount: 2,
          requests: [{ state: 'exhausted', attempt: 3, maxAttempts: 3, delayMs: 1000 }],
        },
      },
    },
    state === 'success' ? 'run.completed' : 'run.failed',
  );
  let turns: SessionTurn[] = [
    {
      type: 'message',
      role: 'user',
      content: 'Please continue the provider recovery work.',
      ts: at,
    },
    {
      type: 'message',
      role: 'assistant',
      content:
        state === 'partial'
          ? 'The genuine partial answer remains available.'
          : state === 'success'
            ? 'The response completed normally.'
            : '',
      ts: at,
      metadata: {
        ...terminal,
        ...(state === 'success'
          ? {
              toolActivity: {
                summary: 'Read file',
                status: 'warn' as const,
                items: [
                  {
                    id: 'failed',
                    label: 'Read file',
                    detail: 'src/config.json',
                    errorDetail: 'Permission denied: cannot read configuration. [REDACTED]',
                    status: 'error' as const,
                  },
                ],
              },
            }
          : {}),
      },
    },
  ];
  if (state === 'side') {
    const input = {
      id: 'side',
      intent: 'side_question',
      status: 'failed',
      agentId: 'fixture',
      sessionId: 'default',
      generation: 1,
      targetRunId: 'main',
      runId: 'side-run',
      createdAt: at,
      startedAt: at,
      completedAt: at,
      message: 'What happened to the side question?',
      attachments: [],
      result: { ok: false, answerText: '', decision: null, blockers: [], ...terminal },
      error: null,
      snapshot: null,
      promotedFrom: null,
      position: null,
    } as ChatInput;
    turns = reconcileChatInputs([], [input]);
  }
  return (
    <div className="cockpit">
      <div className="app-navigation-stack">
        <header className="app-header">
          <strong>Burrow</strong>
          <span>Isolated provider error acceptance</span>
        </header>
      </div>
      <aside className="left-rail fixture-rail">
        <strong>Hatchet</strong>
        {states.map((value) => (
          <button key={value} onClick={() => setState(value)}>
            {value}
          </button>
        ))}
      </aside>
      <main className="workspace">
        <DocumentTabs
          tabs={[{ id: 'chat', kind: 'chat', label: 'Chat' }]}
          activeTabId="chat"
          onSelect={no}
          onClose={no}
        />
        <Chat
          selected={agent}
          parent={agent}
          operator={{ name: 'Goblin King', avatar: 'G' }}
          draft={draft}
          setDraft={setDraft}
          attached={[]}
          onAttach={no}
          onRemoveAttachment={no}
          isNewSession={false}
          turns={turns}
          isLoading={false}
          error=""
          isSending={false}
          activeRunId=""
          liveProgress={[]}
          liveAnswer=""
          onSend={no}
          onCancel={no}
        />
      </main>
      <aside className="right-rail fixture-rail">
        <strong>Provider recovery</strong>
        <span>Synthetic terminal contract</span>
        <span>No live requests</span>
      </aside>
      <footer className="status-bar">
        Isolated fixture · connect-src none · no settings changes
      </footer>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

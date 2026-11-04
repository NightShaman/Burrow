import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentTabs } from '../../src/app/AppChrome';
import { Chat, ChatModelSelector } from '../../src/features/chat/ChatPage';
import { useChatSession } from '../../src/features/chat/useChatSession';
import { useChatRun } from '../../src/features/chat/useChatRun';
import { useRuntimeAgents } from '../../src/app/useRuntimeAgents';
import { reconcileModelCatalog } from '../../src/app/useRuntimeDashboard';
import { useModelSelectionWriter } from '../../src/app/useModelSelectionWriter';
import type { SavedProvider } from '../../src/app/types';
import '../../src/app.css';
import './fixture.css';

const providers = [
  {
    id: 'google',
    provider: 'Google',
    models: ['gemini'],
    apiType: 'google-generative-language',
    url: '',
    apiKey: '',
  },
  {
    id: 'lb',
    provider: 'OpenAI All',
    models: ['gpt-6-luna'],
    apiType: 'openai-lb',
    url: '',
    apiKey: '',
    modelEfforts: { 'gpt-6-luna': ['low', 'high'] },
  },
] as SavedProvider[];
const resident = {
  id: 'gerald',
  name: 'Gerald',
  avatar: 'G',
  enabled: true,
  modAgent: { ownerModId: 'menagerie', visibility: { agents: true, chat: true } },
};
let selection = {
  connectionId: 'lb',
  model: 'gpt-6-luna',
  reasoningEffort: 'high',
  temperature: 0.2,
};
const evidence = { requests: [] as unknown[], blocked: [] as string[] };
Object.assign(window, { residentChatEvidence: evidence });
const no = () => {};
window.fetch = (async (input, init) => {
  const path = String(input),
    method = init?.method ?? 'GET';
  let body: unknown = {};
  if (path === '/api/agents') body = { agents: [resident] };
  else if (path === '/api/agents/overview')
    body = {
      agents: [
        { agent: resident, sessionId: 'default', selection, status: { agents: [] }, contexts: {} },
      ],
    };
  else if (path === '/api/agents/gerald/model-selection') {
    if (method === 'PUT') selection = JSON.parse(String(init?.body));
    body = { selection };
  } else if (path.startsWith('/api/sessions?')) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    body = { sessions: [{ id: 'default' }] };
  } else if (path === '/api/sessions/default?agentId=gerald')
    body = {
      session: {
        id: 'default',
        turns: [
          {
            type: 'message',
            role: 'assistant',
            content:
              'Synthetic resident conversation. No live creature, credentials or provider is contacted.',
          },
        ],
      },
    };
  else if (path.startsWith('/api/chat/runs/active')) body = { runs: [], subagents: [] };
  else if (path.startsWith('/api/chat/inputs')) body = { inputs: [] };
  else if (path.includes('/session-labels')) body = { labels: [] };
  else if (path === '/api/chat') {
    evidence.requests.push(JSON.parse(String(init?.body)));
    window.dispatchEvent(new Event('fixture-request'));
    return new Response(JSON.stringify({ error: 'Synthetic request failure' }), { status: 503 });
  } else {
    evidence.blocked.push(path);
    return new Response('{}', { status: 404 });
  }
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
function Fixture() {
  const session = useChatSession('gerald');
  const refs = useRef(providers);
  const runtime = useRuntimeAgents({
    selectedAgentId: 'gerald',
    selectedStreamId: 'gerald',
    setSelectedAgentId: no,
    setSelectedStreamId: no,
    parentSessionIdForAgent: session.parentSessionIdForAgent,
    runtimeProviders: refs,
    onNoAgents: no,
    reportError: session.reportError,
  });
  const [catalog, setCatalog] = useState(providers);
  const selected = reconcileModelCatalog(runtime.agents, catalog)[0];
  const [blocked, setBlocked] = useState(false);
  const [receipt, setReceipt] = useState('No request sent');
  useEffect(() => {
    session.reportError(
      'Synthetic connection failure before session hydration. This error must remain readable until dismissed.',
    );
    const update = () => setReceipt(JSON.stringify(evidence.requests.at(-1)));
    window.addEventListener('fixture-request', update);
    return () => window.removeEventListener('fixture-request', update);
  }, []);
  const run = useChatRun({
    selectedAgentId: 'gerald',
    selected,
    savedProviders: catalog,
    session,
    setAgentActivity: no,
  });
  const write = useModelSelectionWriter(
    catalog,
    (id, patch) =>
      runtime.setAgents((all) =>
        all.map((agent) => (agent.id === id ? { ...agent, ...patch } : agent)),
      ),
    session.reportError,
  );
  return (
    <div className="cockpit">
      <div className="app-navigation-stack">
        <header className="app-header">
          <strong>Burrow · Resident chat acceptance</strong>
          <span>Isolated synthetic API</span>
        </header>
      </div>
      <aside className="left-rail fixture-rail">
        <strong>Menagerie</strong>
        <span>Gerald</span>
        <button
          onClick={() =>
            setCatalog((current) => (current.length === 2 ? [providers[0]] : providers))
          }
        >
          Toggle LB availability
        </button>
        <button
          onClick={() =>
            session.reportError(
              'Synthetic connection failure. This intentionally long error remains visible while polling and retrying. Request details are preserved without changing the configured load balancer.',
            )
          }
        >
          Report error
        </button>
      </aside>
      <main className="workspace">
        <DocumentTabs
          tabs={[{ id: 'chat', kind: 'chat', label: 'Chat' }]}
          activeTabId="chat"
          onSelect={no}
          onClose={no}
        />
        {selected && (
          <>
            <ChatModelSelector
              selected={selected}
              savedProviders={catalog}
              updateAgent={(patch) => write(selected, patch)}
              onSelectionBlockedChange={setBlocked}
              sessions={session.sessions}
              sessionId={session.sessionId}
              onSessionChange={session.selectSession}
              onNewSession={no}
              onNewNamedSession={no}
              onCreateGroup={no}
            />
            <Chat
              selected={selected}
              parent={selected}
              operator={{ name: 'Operator', avatar: 'O' }}
              draft={session.draft}
              setDraft={session.setDraft}
              attached={[]}
              onAttach={no}
              onRemoveAttachment={no}
              isNewSession={false}
              turns={session.turns}
              isLoading={session.isLoadingConversation}
              error={session.chatError}
              onDismissError={session.clearError}
              isSending={run.isSending}
              activeRunId={run.activeRunId}
              liveProgress={run.liveProgress}
              liveAnswer={run.liveAnswer}
              onSend={run.sendMessage}
              onCancel={no}
              selectedAgentId="gerald"
              resourceAgentId="gerald"
              sessionId={session.sessionId}
              selectionBlocked={blocked}
            />
          </>
        )}
      </main>
      <aside className="right-rail fixture-rail">
        <strong>Request receipt</strong>
        <output>{receipt}</output>
      </aside>
      <footer className="status-bar">Synthetic data · no live messages · connect-src none</footer>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

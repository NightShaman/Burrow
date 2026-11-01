import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import { UnsavedChangesProvider } from '../../src/app/UnsavedChanges';
import { useModelSelectionWriter } from '../../src/app/useModelSelectionWriter';
import { Chat, ChatModelSelector } from '../../src/features/chat/ChatPage';
import { Settings } from '../../src/features/settings/SettingsPage';
import { DocumentTabs } from '../../src/app/AppChrome';
import type { Agent, SavedProvider } from '../../src/app/types';
import '../../src/app.css';
import './fixture.css';

const native: SavedProvider = {
  id: 'native',
  provider: 'Anthropic [Synthetic]',
  apiType: 'anthropic-messages',
  url: '',
  apiKey: '',
  models: ['claude-native-fixture', 'claude-manual-fixture'],
  modelLabels: {
    'claude-native-fixture': 'Claude native · adaptive and tool-only thinking',
    'claude-manual-fixture': 'Claude manual · legacy budget support',
  },
  modelEfforts: {
    'claude-native-fixture': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-manual-fixture': ['low', 'medium', 'high'],
  },
  connectionModels: [
    {
      id: 'claude-native-fixture',
      thinkingModes: ['default', 'adaptive', 'between_tools'],
      thinkingEfforts: {
        default: ['low', 'medium', 'high', 'max'],
        adaptive: ['low', 'medium', 'high', 'max'],
        between_tools: ['low', 'medium', 'high'],
      },
    },
    {
      id: 'claude-manual-fixture',
      thinkingModes: ['default', 'disabled', 'enabled'],
      thinkingEfforts: {
        default: ['low', 'medium', 'high'],
        disabled: ['low', 'medium', 'high'],
        enabled: ['low', 'medium', 'high'],
      },
    },
  ],
};
const other: SavedProvider = {
  id: 'other',
  provider: 'OpenAI [Synthetic]',
  apiType: 'openai-responses',
  url: '',
  apiKey: '',
  models: ['other-fixture'],
  modelEfforts: { 'other-fixture': ['low', 'high'] },
};
const providers = [native, other];
const initial: Agent = {
  id: 'fixture',
  resourceId: 'fixture',
  name: 'Native thinking acceptance',
  avatar: 'N',
  enabled: true,
  context: null,
  activity: 'Idle',
  provider: native.provider,
  model: native.models[0],
  thinkingMode: null,
  effort: 'off',
  temperature: 0.2,
  workspace: '',
  files: [],
  subagents: [],
};
let mainSelection = {
  connectionId: native.id,
  model: initial.model,
  thinkingMode: null as string | null,
  reasoningEffort: 'off',
  temperature: 0.2,
};
let minionSelection: typeof mainSelection | null = { ...mainSelection };
const evidence = {
  requests: [] as { path: string; method: string; body: unknown }[],
  unexpected: [] as string[],
  errors: [] as string[],
  failNext: false,
  delay: 0,
  attemptedRuns: 0,
};
Object.assign(window, {
  nativeFixture: { evidence, main: () => mainSelection, minion: () => minionSelection },
});
window.fetch = async (input, init) => {
  const path = String(input),
    method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  evidence.requests.push({ path, method, body });
  const response = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (path.includes('/model-selection') || path.includes('/minion-model-selection')) {
    if (method === 'PUT') {
      if (evidence.delay) await new Promise((resolve) => setTimeout(resolve, evidence.delay));
      if (evidence.failNext) {
        evidence.failNext = false;
        return response({ error: 'Synthetic save rejected' }, 503);
      }
      if (path.includes('/minion-model-selection'))
        minionSelection = body.connectionId === null ? null : body;
      else mainSelection = body;
    }
    return response({
      ok: true,
      selection: path.includes('/minion-model-selection') ? minionSelection : mainSelection,
    });
  }
  if (path === '/api/mods') return response({ mods: [] });
  if (path === '/api/setup/status') return response({ firstRun: { completed: true }, ready: true });
  if (path === '/api/agents/fixture/minion-settings') return response({ ok: true, maxDepth: 2 });
  if (path.startsWith('/api/system/')) return response({ ok: true, stats: {} });
  evidence.unexpected.push(`${method} ${path}`);
  throw new Error('Unexpected isolated route: ' + path);
};
const no = () => {};
function Fixture() {
  const [agent, setAgent] = useState<Agent>(initial),
    [page, setPage] = useState<'chat' | 'settings'>('chat');
  const [blocked, setBlocked] = useState(false),
    [draft, setDraft] = useState('This draft must not be sent during acceptance.');
  const [error, setError] = useState('');
  const [navigationTarget, setNavigationTarget] = useState<HTMLElement | null>(null);
  const write = useModelSelectionWriter(
    providers,
    (_id, patch) => setAgent((current) => ({ ...current, ...patch })),
    (message) => {
      setError(message);
      evidence.errors.push(message);
    },
  );
  return (
    <div
      className={`cockpit ${page === 'settings' ? 'settings-mode settings-top-navigation' : ''}`}
    >
      <div className="app-navigation-stack">
        <header className="app-header">
          <strong>Burrow · isolated acceptance</strong>
          <nav className="page-tabs">
            <button onClick={() => setPage('chat')}>Chat</button>
            <button onClick={() => setPage('settings')}>Settings</button>
          </nav>
          <small>Synthetic selections only</small>
        </header>
        {page === 'settings' && (
          <div className="settings-navigation-card" ref={setNavigationTarget} />
        )}
      </div>
      {page === 'chat' && (
        <aside className="left-rail fixture-rail">
          <strong>Agents</strong>
          <button className="active">Native thinking acceptance</button>
          <span>Idle · no generation</span>
        </aside>
      )}
      <main className={`workspace ${page === 'settings' ? 'settings-workspace' : ''}`}>
        {page === 'chat' ? (
          <>
            <DocumentTabs
              tabs={[{ id: 'chat', kind: 'chat', label: 'Chat' }]}
              activeTabId="chat"
              onSelect={no}
              onClose={no}
            />
            <ChatModelSelector
              selected={agent}
              savedProviders={providers}
              updateAgent={(patch) => write(agent, patch)}
              onSelectionBlockedChange={setBlocked}
              sessions={[{ id: 'default' }, { id: 'Review native mode and effort controls' }]}
              sessionId="Review native mode and effort controls"
              onSessionChange={no}
              onNewSession={no}
              onNewNamedSession={no}
              onCreateGroup={no}
            />
            <Chat
              selected={agent}
              parent={agent}
              operator={{ name: 'Operator', avatar: 'O' }}
              draft={draft}
              setDraft={setDraft}
              attached={[]}
              onAttach={no}
              onRemoveAttachment={no}
              isNewSession={false}
              turns={[
                {
                  type: 'message',
                  role: 'assistant',
                  content:
                    'Mode and effort remain separate. This conversation uses a synthetic API with all real connections blocked.',
                },
              ]}
              isLoading={false}
              error={error}
              isSending={false}
              activeRunId=""
              liveProgress={[]}
              liveAnswer=""
              onSend={() => {
                evidence.attemptedRuns++;
              }}
              onCancel={no}
              selectionBlocked={blocked}
            />
          </>
        ) : (
          <Settings
            navigationTarget={navigationTarget}
            tab="agents"
            setTab={no}
            agents={[agent]}
            selected={agent}
            savedProviders={providers}
            onModelConnectionsChanged={async () => {}}
            onAgentsChanged={async () => {}}
            onOperatorProfileChanged={no}
            onFirstRunComplete={no}
            leftTopPanel="agents"
            setLeftTopPanel={no}
            leftBottomPanel="none"
            setLeftBottomPanel={no}
            rightTopPanel="none"
            setRightTopPanel={no}
            rightBottomPanel="none"
            setRightBottomPanel={no}
            leftSinglePanel="agents"
            setLeftSinglePanel={no}
            rightSinglePanel="none"
            setRightSinglePanel={no}
            leftRailLayout="single"
            setLeftRailLayout={no}
            rightRailLayout="single"
            setRightRailLayout={no}
            theme="magenta"
            setTheme={no}
            agentRailPreferences={{ view: 'regular', order: [] }}
            setAgentRailPreferences={no}
          />
        )}
      </main>
      {page === 'chat' && (
        <aside className="right-rail fixture-rail">
          <strong>Accounts</strong>
          <span>Isolated · no credentials</span>
        </aside>
      )}
      <footer className="status-bar">
        UI acceptance · browser-local synthetic API · connect-src none
      </footer>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <ConfirmProvider>
    <UnsavedChangesProvider>
      <Fixture />
    </UnsavedChangesProvider>
  </ConfirmProvider>,
);

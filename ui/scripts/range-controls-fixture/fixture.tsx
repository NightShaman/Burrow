import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatModelSelector } from '../../src/features/chat/ChatPage';
import { MinionDepthSettings } from '../../src/features/settings/MinionDepthSettings';
import { DefaultMinionModel } from '../../src/features/settings/DefaultMinionModel';
import { CuratorSettings } from '../../src/features/settings/CuratorSettings';
import { AgentDreams } from '../../src/features/settings/AgentDreams';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import { UnsavedChangesProvider } from '../../src/app/UnsavedChanges';
import type { Agent, SavedProvider } from '../../src/app/types';
import '../../src/app.css';
import './fixture.css';

const provider = {
  id: 'fixture',
  provider: 'Fixture provider',
  models: ['model'],
} as SavedProvider;
let minion = { connectionId: 'fixture', model: 'model', reasoningEffort: 'low', temperature: 0.2 };
let depth = 1;
let curator = { kind: 'external', connectionId: 'fixture', model: 'model', temperature: 0.1 };
let dreams = {
  enabled: true,
  quietDayDreams: true,
  promoteToMemory: true,
  cron: '0 4 * * *',
  timezone: null,
  prompt: 'Review retained evidence.',
  memoryEmphasis: 50,
  memoryPromptOverride: null,
  defaultMemoryPrompt: 'Preserve useful validated continuity.',
};
const requests: string[] = [];
Object.assign(window, { rangeEvidence: { requests, errors: [] } });
window.addEventListener('error', (event) =>
  (window as any).rangeEvidence.errors.push(event.message),
);
window.fetch = async (url, init) => {
  const path = String(url),
    method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  requests.push(`${method} ${path}`);
  if (path.endsWith('/minion-settings')) {
    if (method === 'PUT') depth = body.maxDepth;
    return Response.json({ ok: true, maxDepth: depth });
  }
  if (path.endsWith('/minion-model-selection')) {
    if (method === 'PUT') minion = { ...minion, ...body };
    return Response.json({ ok: true, selection: minion });
  }
  if (path === '/api/settings/curator') {
    if (method === 'PUT') curator = { ...curator, ...body };
    return Response.json({ ok: true, configured: true, selection: curator, available: true });
  }
  if (path.endsWith('/dream-settings')) {
    if (method === 'PUT') dreams = { ...dreams, ...body };
    return Response.json({ settings: dreams, effectiveModel: null });
  }
  throw new Error(`Unexpected fixture request: ${method} ${path}`);
};
function Fixture() {
  const [agent, setAgent] = useState({
    id: 'fixture',
    name: 'Fixture agent',
    provider: provider.provider,
    modelConnectionId: provider.id,
    model: 'model',
    effort: 'low',
    temperature: 0.2,
  } as Agent);
  const [theme, setTheme] = useState('smatchet');
  const [modValue, setModValue] = useState('50');
  const [locked, setLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  document.documentElement.dataset.theme = theme;
  Object.assign(window, {
    rangeSetTheme: setTheme,
    rangeSetLocked: setLocked,
    rangeSetSaving: setSaving,
  });
  return (
    <main>
      <h1>Range controls · {theme}</h1>
      <section data-control="chat">
        <h2>Chat toolbar</h2>
        <ChatModelSelector
          selected={agent}
          savedProviders={[provider]}
          updateAgent={(patch) => {
            setAgent((old) => ({ ...old, ...patch }));
            return true;
          }}
          sessions={[{ id: 'default' }]}
          sessionId="default"
          onSessionChange={() => {}}
          onNewSession={() => {}}
          onNewNamedSession={() => {}}
          onCreateGroup={() => {}}
          locked={locked}
          savingSelection={saving}
        />
      </section>
      <div className="fixture-grid settings-view">
        <section data-control="depth">
          <h2>Minion depth</h2>
          <MinionDepthSettings resourceId="fixture" />
        </section>
        <section data-control="minion">
          <h2>Minion model</h2>
          <DefaultMinionModel resourceId="fixture" savedProviders={[provider]} />
        </section>
        <section data-control="curator">
          <CuratorSettings savedProviders={[provider]} />
        </section>
        <section data-control="dreams">
          <AgentDreams agentId="fixture" savedProviders={[provider]} />
        </section>
        <section data-control="mod" className="mod-settings-mount">
          <h2>Mod range fallback</h2>
          <label className="field">
            Mod setting
            <input
              type="range"
              min="0"
              max="100"
              value={modValue}
              onChange={(e) => setModValue(e.target.value)}
            />
          </label>
          <label className="field">
            Disabled setting
            <input type="range" defaultValue="50" disabled />
          </label>
        </section>
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <ConfirmProvider>
    <UnsavedChangesProvider>
      <Fixture />
    </UnsavedChangesProvider>
  </ConfirmProvider>,
);

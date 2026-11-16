import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import { Settings } from '../../src/features/settings/SettingsPage';
import { UnsavedChangesProvider } from '../../src/app/UnsavedChanges';
const params = new URLSearchParams(location.search);
const mode = params.get('state');
const scope = params.get('scope');
const defaults = {
  maxDepth: 1,
  defaultHarness: 'burrow',
  codexModel: { connectionId: 'openai', model: 'gpt-5.3-codex' },
  claudeModel: { connectionId: 'anthropic', model: 'claude-sonnet-4-6' },
  burrowModel: null,
  codexEnabled: true,
  claudeEnabled: false,
  geminiEnabled: false,
  geminiModel: null,
};
let settings = {
  ok: true,
  ...defaults,
  overrideEnabled: mode !== 'inherit',
  profileOverrides: {},
  effective: defaults,
};
(window as any).fixtureRequests = [];
window.fetch = async (input, options) => {
  const path = String(input);
  (window as any).fixtureRequests.push({
    path,
    method: options?.method || 'GET',
    body: options?.body,
  });
  if (path.endsWith('/minion-settings')) {
    if (mode === 'loading') await new Promise(() => {});
    if (mode === 'error')
      return Response.json({ error: 'Settings temporarily unavailable' }, { status: 503 });
    if (options?.method === 'PUT') {
      if (mode === 'pending') await new Promise(() => {});
      if (mode === 'save-error')
        return Response.json({ error: 'Settings update rejected; please retry.' }, { status: 503 });
      settings = { ...settings, ...JSON.parse(String(options.body)) };
    }
    return Response.json(settings);
  }
  if (path === '/api/agents/fixture')
    return Response.json({
      ok: true,
      agent: { id: 'fixture', name: 'Fixture agent', enabled: true },
    });

  if (path === '/api/settings/model-connections')
    return Response.json({
      connections: [
        {
          id: 'google',
          provider: 'Google native',
          apiType: 'google-generative-language',
          geminiEligible: true,
          enabled: true,
          models: [{ id: 'gemini-latest', displayName: 'Gemini Latest', selected: true }],
        },
        {
          id: 'openai',
          provider: 'OpenAI team pool',
          apiType: 'openai-lb',
          enabled: true,
          codexEligible: true,
          models: [{ id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', selected: true }],
        },
        {
          id: 'anthropic',
          provider: 'Anthropic team pool',
          apiType: 'anthropic-lb',
          enabled: true,
          claudeEligible: true,
          models: [{ id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', selected: true }],
        },
      ],
    });
  if (path.includes('/api/mods/node-goblin/'))
    return Response.json({
      ok: true,
      gateways: [
        { gatewayId: 'workstation', connected: true },
        { gatewayId: 'build-server', connected: false },
      ],
    });
  if (path === '/api/setup/status') return Response.json({ ok: true, complete: true });
  if (path.includes('contributions')) return Response.json({ ok: true, contributions: [] });
  return Response.json({ ok: true });
};
const noop = () => {};
function Fixture() {
  const [tab, setTab] = React.useState(scope === 'agent' ? 'agents' : 'minions');
  const props: any = {
    tab,
    setTab,
    agents: [{ id: 'fixture', name: 'Fixture agent', avatar: '', enabled: true }],
    selected: { id: 'fixture', name: 'Fixture agent', avatar: '', enabled: true },
    savedProviders: [],
    onModelConnectionsChanged: async () => {},
    onAgentsChanged: async () => {},
    onOperatorProfileChanged: noop,
    onFirstRunComplete: noop,
    leftRailLayout: 'single',
    rightRailLayout: 'single',
    theme: 'dark',
    setTheme: noop,
    agentRailPreferences: {},
    setAgentRailPreferences: noop,
  };
  for (const side of ['left', 'right'])
    for (const slot of ['Top', 'Bottom', 'Single']) {
      props[side + slot + 'Panel'] = 'agents';
      props['set' + side[0].toUpperCase() + side.slice(1) + slot + 'Panel'] = noop;
    }
  return (
    <ConfirmProvider>
      <UnsavedChangesProvider>
        <main className="settings-mode" style={{ height: '100vh' }}>
          <Settings {...props} />
        </main>
      </UnsavedChangesProvider>
    </ConfirmProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

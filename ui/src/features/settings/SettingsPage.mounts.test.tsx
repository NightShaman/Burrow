import { useState, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Settings } from './SettingsPage';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { api } from '../../app/api';
import type { SettingsTab } from '../../app/types';
import type { ModContribution } from '../../app/apiTargets';
vi.mock('../../app/api', async (original) => ({
  ...(await original<typeof import('../../app/api')>()),
  api: vi.fn(),
}));
const { loadModSettingsContributions, mountModSettings } = vi.hoisted(() => ({
  loadModSettingsContributions: vi.fn<() => Promise<ModContribution[]>>(async () => []),
  mountModSettings: vi.fn(),
}));
vi.mock('../../app/apiTargets', () => ({
  loadModSettingsContributions,
  modContributionsChangedEvent: 'mods-changed',
}));
vi.mock('./ModSettingsHostFixture', () => ({
  settingsSections: [
    { id: 'controller', label: 'Controller & TLS' },
    { id: 'pairings', label: 'Pending pairings' },
    { id: 'gateways', label: 'Gateways' },
    { id: 'assignments', label: 'Agent assignments' },
    { id: 'operations', label: 'Operation activity' },
  ],
  mountSettings: mountModSettings,
  settingsContribution: undefined,
  createSettingsContribution: undefined,
}));
vi.mock('./SystemStatsRail', () => ({ SystemStatsRail: () => null }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  loadModSettingsContributions.mockResolvedValue([]);
});
it('mounts only the selected configuration, with no hidden duplicate reads', async () => {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/api/settings/identities') return { operator: { name: 'Test', avatar: '' } };
    if (path === '/api/settings/browser-tab') return { suffix: '' };
    if (path === '/api/settings/timezone') return { timezone: 'America/Chicago' };
    if (path === '/api/settings/ui-auth') return { auth: { mode: 'none' } };
    if (path === '/api/settings/opentelemetry')
      return {
        settings: { enabled: false, destinations: [] },
        effective: { enabled: false },
        providers: [],
      };
    return { wizardStep: 'ready' };
  });
  function Parent() {
    const [tab, setTab] = useState<SettingsTab>('general');
    return (
      <Settings
        {...({
          tab,
          setTab,
          agents: [],
          selected: { id: '', name: '' },
          savedProviders: [],
          onOperatorProfileChanged: vi.fn(),
          agentRailPreferences: { view: 'list', order: [] },
        } as unknown as ComponentProps<typeof Settings>)}
      />
    );
  }
  const { container } = render(<Parent />);
  await screen.findByDisplayValue('Test');
  expect(container.querySelector('.settings-baseline-hidden')).toBeNull();
  expect(
    container.querySelector('.settings-content-normalized[data-composition="paired"]'),
  ).toBeTruthy();
  const profile = screen
    .getByRole('heading', { name: 'Operator profile' })
    .closest('.setting-section');
  const timezone = screen
    .getByRole('heading', { name: 'Operator timezone' })
    .closest('.setting-section');
  expect(profile?.closest('.settings-prototype-configuration')).toBeTruthy();
  expect(profile?.parentElement?.classList.contains('settings-personalization-profile')).toBe(true);
  expect(timezone?.parentElement?.classList.contains('settings-personalization-profile')).toBe(
    true,
  );
  expect(screen.queryByRole('button', { name: 'Operator timezone' })).toBeNull();
  expect(
    screen.getByRole('heading', { name: 'Browser tab' }).closest('.settings-prototype-overflow'),
  ).toBeTruthy();
  expect(
    screen
      .getByRole('heading', { name: 'Appearance' })
      .closest('.settings-personalization-appearance'),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Operator profile' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Appearance' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Browser tab' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Continuity' }));
  expect(
    screen.getByRole('heading', { name: 'Continuity' }).closest('[data-composition="paired"]'),
  ).toBeTruthy();
  expect(
    screen
      .getByRole('heading', { name: 'Continuity' })
      .closest('.settings-prototype-configuration'),
  ).toBeTruthy();
  expect(
    screen.getByRole('heading', { name: 'Tiddle Signal' }).closest('.settings-prototype-overflow'),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Tiddle Signal' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Personalization' }));
  await screen.findByDisplayValue('America/Chicago');
  fireEvent.click(screen.getByRole('button', { name: /^Connections$/ }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save authentication' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(screen.getAllByRole('button', { name: 'Save authentication' })).toHaveLength(1);
  const paths = vi.mocked(api).mock.calls.map(([path]) => path);
  expect(paths.filter((path) => path === '/api/settings/ui-auth')).toHaveLength(1);
  expect(paths).not.toContain('/api/settings/mcp-connections');
  expect(paths).not.toContain('/api/settings/model-connections');
  expect(paths).not.toContain('/api/settings/browser-origin');
  expect(screen.queryByRole('button', { name: 'Save browser origin' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Browser origin' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'Check browser origin' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Browser origin' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'OpenTelemetry' }));
  await screen.findByRole('heading', { name: 'OpenTelemetry' });
  fireEvent.click(screen.getByRole('button', { name: /^Authentication$/ }));
  await screen.findByRole('button', { name: 'Save authentication' });
  expect(vi.mocked(api).mock.calls.map(([path]) => path)).not.toContain(
    '/api/settings/browser-origin',
  );
  expect(screen.queryByRole('heading', { name: 'Browser origin' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'Check browser origin' })).toBeNull();
  expect(
    screen.getByRole('button', { name: /^Authentication$/ }).getAttribute('aria-current'),
  ).toBe('page');
  // Returning to Connections must not mount the retired security settings UI.
  fireEvent.click(screen.getByRole('button', { name: /^General$/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Connections$/ }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save authentication' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(screen.queryByRole('button', { name: 'Browser origin' })).toBeNull();
  expect(
    vi.mocked(api).mock.calls.filter(([path]) => path === '/api/settings/browser-origin'),
  ).toHaveLength(0);
});
it('shows agent options from active rail selections without focusing a dropdown', () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path === '/api/settings/browser-tab'
      ? { suffix: '' }
      : path === '/api/settings/timezone'
        ? { timezone: 'America/Chicago' }
        : { wizardStep: 'ready' },
  );
  function Parent() {
    const [leftSinglePanel, setLeftSinglePanel] = useState<'agents' | 'workspace'>('agents');
    const [leftRailLayout, setLeftRailLayout] = useState<'single' | 'divided'>('single');
    return (
      <Settings
        {...({
          tab: 'general',
          setTab: vi.fn(),
          agents: [],
          selected: { id: '', name: '' },
          savedProviders: [],
          onOperatorProfileChanged: vi.fn(),
          agentRailPreferences: { view: 'regular', order: [] },
          setAgentRailPreferences: vi.fn(),
          leftSinglePanel,
          setLeftSinglePanel,
          leftRailLayout,
          setLeftRailLayout,
          leftTopPanel: 'agents',
          leftBottomPanel: 'workspace',
          rightRailLayout: 'single',
          rightSinglePanel: 'workspace',
          rightTopPanel: 'agents',
          rightBottomPanel: 'workspace',
        } as unknown as ComponentProps<typeof Settings>)}
      />
    );
  }
  render(<Parent />);
  fireEvent.click(screen.getByRole('button', { name: 'Rail panels' }));
  expect(screen.getByText('Agent panel options').closest('[data-family="rails"]')).toBeTruthy();
  fireEvent.focus(screen.getByLabelText('Right · panel'));
  expect(screen.getByText('Agent panel options')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Left · panel'), { target: { value: 'workspace' } });
  expect(screen.queryByText('Agent panel options')).toBeNull();
  expect(
    screen.getByRole('heading', { name: 'Rail Panels' }).closest('.settings-content-bounded'),
  ).toBeNull();
  const single = screen
    .getByRole('heading', { name: 'Rail Panels' })
    .closest('[data-composition="single"]');
  expect(single?.querySelectorAll(':scope > .settings-blank-column')).toHaveLength(1);
  expect(single?.firstElementChild?.classList.contains('settings-prototype-configuration')).toBe(
    true,
  );
  fireEvent.change(screen.getByLabelText('Left · layout'), { target: { value: 'divided' } });
  expect(screen.getByText('Agent panel options')).toBeTruthy();
  expect(
    screen.getByText('Agent panel options').closest('[data-composition="paired"]'),
  ).toBeTruthy();
});

it('places Skills navigation in the supplied card without duplicating it in the workspace', async () => {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/api/settings/skills') return { skills: [] };
    if (path.includes('/skills')) return { skills: [] };
    return { wizardStep: 'ready' };
  });
  const navigationTarget = document.createElement('div');
  document.body.append(navigationTarget);
  const { container, unmount } = render(
    <ConfirmProvider>
      <Settings
        {...({
          navigationTarget,
          tab: 'skills',
          setTab: vi.fn(),
          agents: [],
          selected: { id: '', name: '' },
          savedProviders: [],
          onOperatorProfileChanged: vi.fn(),
          agentRailPreferences: { view: 'regular', order: [] },
        } as unknown as ComponentProps<typeof Settings>)}
      />
    </ConfirmProvider>,
  );
  expect(navigationTarget.querySelector('nav[aria-label="Settings sections"]')).not.toBeNull();
  expect(container.querySelector('nav[aria-label="Settings sections"]')).toBeNull();
  expect(screen.getAllByRole('navigation', { name: 'Settings sections' })).toHaveLength(1);
  const layout = container.querySelector('.settings-blank-slate.has-top-navigation');
  expect(layout?.querySelectorAll(':scope > .settings-blank-column')).toHaveLength(1);
  expect(container.querySelector('.skills-settings-workspace')).toBeNull();
  expect(
    screen
      .getByRole('navigation', { name: 'Skills settings sections' })
      .closest('.settings-prototype-sections'),
  ).toBeTruthy();
  expect(
    (await screen.findByRole('heading', { name: 'Installed skills' })).closest(
      '.settings-prototype-configuration',
    ),
  ).toBeTruthy();
  expect(
    screen
      .getByRole('region', { name: 'Additional settings' })
      .classList.contains('settings-prototype-overflow'),
  ).toBe(true);
  expect(
    screen
      .getByRole('searchbox', { name: 'Search skills' })
      .closest('.settings-prototype-overflow'),
  ).toBeTruthy();
  const inventory = container.querySelector(
    '.settings-content-standard.settings-content-inventory',
  );
  expect(inventory?.getAttribute('data-composition')).toBe('inventory');
  expect(inventory?.classList.contains('settings-content-normalized')).toBe(true);
  expect(inventory?.firstElementChild?.classList.contains('settings-prototype-overflow')).toBe(
    true,
  );
  expect(inventory?.lastElementChild?.classList.contains('settings-prototype-configuration')).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Import from repository' }));
  await screen.findByRole('button', { name: 'Preview skill' });
  expect(container.querySelector('.settings-content-single')).not.toBeNull();
  expect(screen.queryByRole('region', { name: 'Additional settings' })).toBeNull();
  expect(
    screen.getByLabelText('Repository').closest('.settings-prototype-configuration'),
  ).toBeTruthy();
  expect(screen.queryByText('Sync history')).toBeNull();
  expect(screen.queryByLabelText('Search skills')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'New text skill' }));
  await screen.findByRole('button', { name: 'Create skill' });
  expect(screen.queryByLabelText('Search skills')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Installed skills' }));
  expect(screen.getByLabelText('Search skills')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open system statistics' }));
  expect(layout?.classList.contains('has-utility-panel')).toBe(true);
  expect(screen.getByRole('complementary', { name: 'System statistics' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Collapse system statistics' }));
  expect(layout?.classList.contains('has-utility-panel')).toBe(false);
  await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalled());
  unmount();
  expect(navigationTarget.childElementCount).toBe(0);
  navigationTarget.remove();
});

it('groups a mod settings contributions under one top-level tab and exposes secondary sections', async () => {
  loadModSettingsContributions.mockResolvedValue([
    {
      modId: 'burrow-switchboard',
      name: 'Switchboard',
      settings: [
        {
          id: 'status',
          navigation: { title: 'Status' },
          primary: { title: 'Status', capability: 'settingsUi' },
        },
        {
          id: 'configuration',
          navigation: { title: 'Configuration' },
          primary: { title: 'Configuration', capability: 'settingsUi' },
        },
        {
          id: 'pending-admissions',
          navigation: { title: 'Pending admissions' },
          primary: { title: 'Pending admissions', capability: 'settingsUi' },
        },
        {
          id: 'chat-mappings',
          navigation: { title: 'Chat mappings' },
          primary: { title: 'Chat mappings', capability: 'settingsUi' },
        },
      ],
    },
  ]);
  vi.mocked(api).mockImplementation(async (path) =>
    path === '/api/settings/browser-tab'
      ? { suffix: '' }
      : path === '/api/settings/timezone'
        ? { timezone: 'America/Chicago' }
        : { wizardStep: 'ready' },
  );
  function Parent() {
    const [tab, setTab] = useState<SettingsTab>('general');
    return (
      <Settings
        {...({
          tab,
          setTab,
          agents: [],
          selected: { id: '', name: '' },
          savedProviders: [],
          onOperatorProfileChanged: vi.fn(),
          agentRailPreferences: { view: 'regular', order: [] },
        } as unknown as ComponentProps<typeof Settings>)}
      />
    );
  }
  render(<Parent />);
  const switchboard = await screen.findByRole('button', { name: 'Switchboard' });
  expect(screen.getAllByRole('button', { name: 'Switchboard' })).toHaveLength(1);
  fireEvent.click(switchboard);
  const secondary = screen.getByRole('navigation', { name: 'Switchboard settings sections' });
  for (const name of ['Status', 'Configuration', 'Pending admissions', 'Chat mappings'])
    expect(
      secondary.querySelector(
        `button:nth-child(${['Status', 'Configuration', 'Pending admissions', 'Chat mappings'].indexOf(name) + 1})`,
      )?.textContent,
    ).toBe(name);
  expect(screen.getByRole('button', { name: 'Status' }).getAttribute('aria-current')).toBe('page');
  fireEvent.click(screen.getByRole('button', { name: 'Chat mappings' }));
  expect(screen.getByRole('button', { name: 'Chat mappings' }).getAttribute('aria-current')).toBe(
    'page',
  );
  expect(screen.getByRole('button', { name: 'Switchboard' }).getAttribute('aria-current')).toBe(
    'page',
  );
  fireEvent.click(screen.getByRole('button', { name: 'General' }));
  fireEvent.click(screen.getByRole('button', { name: 'Switchboard' }));
  expect(screen.getByRole('button', { name: 'Status' }).getAttribute('aria-current')).toBe('page');
});

it('uses dynamic mod sections when manifest metadata is only a top-level contribution', async () => {
  loadModSettingsContributions.mockResolvedValue([
    {
      modId: 'node-goblin',
      name: 'Node Goblin',
      settingsUrl: './ModSettingsHostFixture',
      settings: [
        {
          id: 'node-goblin',
          navigation: { title: 'Node Goblin' },
          primary: { title: 'Node Goblin', capability: 'settingsUi' },
        },
      ],
    },
  ]);
  mountModSettings.mockImplementation(
    ({ section, primary }: { section: string; primary: { replace: (node: Node) => void } }) => {
      const node = document.createElement('span');
      node.textContent = `Mounted ${section}`;
      primary.replace(node);
    },
  );
  vi.mocked(api).mockImplementation(async (path) =>
    path === '/api/settings/browser-tab'
      ? { suffix: '' }
      : path === '/api/settings/timezone'
        ? { timezone: 'America/Chicago' }
        : { wizardStep: 'ready' },
  );
  function Parent() {
    const [tab, setTab] = useState<SettingsTab>('general');
    return (
      <Settings
        {...({
          tab,
          setTab,
          agents: [],
          selected: { id: '', name: '' },
          savedProviders: [],
          onOperatorProfileChanged: vi.fn(),
          agentRailPreferences: { view: 'regular', order: [] },
        } as unknown as ComponentProps<typeof Settings>)}
      />
    );
  }
  render(
    <ConfirmProvider>
      <Parent />
    </ConfirmProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Node Goblin' }));
  const secondary = await screen.findByRole('navigation', {
    name: 'node-goblin settings sections',
  });
  await waitFor(() =>
    expect(
      Array.from(secondary.querySelectorAll('button'), (button) => button.textContent),
    ).toEqual([
      'Controller & TLS',
      'Pending pairings',
      'Gateways',
      'Agent assignments',
      'Operation activity',
    ]),
  );
  expect(await screen.findByText('Mounted controller')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Gateways' }));
  expect(await screen.findByText('Mounted gateways')).toBeTruthy();
});

it('uses the top menu with paired Personalization identity and appearance panes', async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path === '/api/settings/browser-tab'
      ? { suffix: '' }
      : path === '/api/settings/identities'
        ? { operator: { name: 'Test', avatar: '' } }
        : path === '/api/settings/timezone'
          ? { timezone: 'America/Chicago' }
          : { wizardStep: 'ready' },
  );
  const navigationTarget = document.createElement('div');
  document.body.append(navigationTarget);
  const { container, unmount } = render(
    <Settings
      {...({
        navigationTarget,
        tab: 'general',
        setTab: vi.fn(),
        agents: [],
        selected: { id: '', name: '' },
        savedProviders: [],
        onOperatorProfileChanged: vi.fn(),
        agentRailPreferences: { view: 'regular', order: [] },
      } as unknown as ComponentProps<typeof Settings>)}
    />,
  );
  await screen.findByDisplayValue('Test');
  expect(navigationTarget.querySelector('nav[aria-label="Settings sections"]')).not.toBeNull();
  expect(container.querySelector('.settings-prototype-menu')).toBeNull();
  const layout = container.querySelector('.settings-blank-slate.has-top-navigation');
  expect(layout).not.toBeNull();
  expect(layout?.querySelectorAll(':scope > .settings-blank-column')).toHaveLength(1);
  expect(container.querySelector('.settings-prototype-sections')).not.toBeNull();
  expect(container.querySelector('.settings-prototype-configuration')).not.toBeNull();
  expect(
    container.querySelector('.settings-prototype-overflow .settings-personalization-appearance'),
  ).not.toBeNull();
  expect(
    container.querySelector('.settings-content-normalized[data-composition="paired"]'),
  ).not.toBeNull();
  unmount();
  expect(navigationTarget.childElementCount).toBe(0);
  navigationTarget.remove();
});

it('navigates between separate Models and Load Balancing editors without leaking identity', async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path === '/api/settings/browser-tab'
      ? { suffix: '' }
      : path === '/api/settings/timezone'
        ? { timezone: 'America/Chicago' }
        : { wizardStep: 'ready' },
  );
  render(
    <ConfirmProvider>
      <Settings
        {...({
          tab: 'connections',
          setTab: vi.fn(),
          agents: [],
          selected: { id: '', name: '' },
          savedProviders: [],
          onModelConnectionsChanged: vi.fn(),
          agentRailPreferences: { view: 'regular', order: [] },
        } as unknown as ComponentProps<typeof Settings>)}
      />
    </ConfirmProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Models' }));
  expect(
    screen.getByRole('heading', { name: 'Models' }).closest('.settings-content-models'),
  ).toBeTruthy();
  expect(
    screen.getByRole('heading', { name: 'Models' }).closest('.settings-content-standard'),
  ).toBeNull();
  expect(
    screen.getByRole('heading', { name: 'Models' }).closest('.settings-content-normalized'),
  ).toBeNull();
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'Direct draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load Balancing' }));
  expect(
    screen
      .getByRole('heading', { name: 'Load Balancing' })
      .closest('[data-composition="inventory"]'),
  ).toBeTruthy();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('OpenAI LB');
  expect(screen.queryByLabelText('API type')).toBeNull();
  expect(screen.queryByLabelText('URL')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Models' }));
  expect((screen.getByLabelText('Provider') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('API type') as HTMLSelectElement).value).toBe(
    'openai-chat-completions',
  );
  await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalled());
});

it('scopes scheduling splits while preserving inventory/editor and Dreams portal direction', async () => {
  const agent = { id: 'hatchet', name: 'Hatchet', avatar: '', enabled: true };
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.startsWith('/api/scheduled-jobs')) return { jobs: [] };
    if (path === '/api/events/watches') return { watches: [] };
    if (path === '/api/events/settings')
      return { settings: { secretConfigured: false, webhookPath: '/api/events/github' } };
    if (path.endsWith('/dream-settings'))
      return {
        settings: {
          enabled: false,
          quietDayDreams: true,
          promoteToMemory: true,
          cron: '0 4 * * *',
          prompt: 'Dream diary',
        },
      };
    if (path === '/api/settings/timezone') return { timezone: 'America/Chicago' };
    return { wizardStep: 'ready', agent, settings: {}, documents: {}, servers: [], tools: [] };
  });
  const { container } = render(
    <ConfirmProvider>
      <Settings
        {...({
          tab: 'agents',
          setTab: vi.fn(),
          agents: [agent],
          selected: agent,
          savedProviders: [],
          onAgentsChanged: vi.fn(),
          agentRailPreferences: { view: 'regular', order: [] },
        } as unknown as ComponentProps<typeof Settings>)}
      />
    </ConfirmProvider>,
  );
  expect(container.querySelector('.settings-content-scheduling')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cron jobs' }));
  await screen.findByRole('heading', { name: 'Saved jobs' });
  const cron = container.querySelector('[data-family="cron"]');
  expect(cron?.classList.contains('settings-content-scheduling')).toBe(true);
  expect(cron?.getAttribute('data-composition')).toBe('inventory');
  expect(cron?.firstElementChild?.classList.contains('settings-prototype-overflow')).toBe(true);
  expect(
    screen.getByRole('heading', { name: 'Saved jobs' }).closest('.settings-prototype-overflow'),
  ).toBeTruthy();
  expect(screen.getByLabelText('Prompt').closest('.settings-prototype-configuration')).toBeTruthy();
  expect(cron?.classList.contains('settings-content-bounded')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Workflow events' }));
  await screen.findByLabelText('Repository');
  expect(
    container
      .querySelector('[data-family="workflow"]')
      ?.firstElementChild?.classList.contains('settings-prototype-overflow'),
  ).toBe(true);
  expect(
    screen.getByLabelText('Repository').closest('.settings-prototype-configuration'),
  ).toBeTruthy();
  expect(
    screen.getByText('GitHub webhook setup').closest('.settings-prototype-configuration'),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Dreams' }));
  await screen.findByDisplayValue('Dream diary');
  const dreams = container.querySelector('[data-family="dreams"]');
  expect(dreams?.getAttribute('data-composition')).toBe('paired');
  expect(dreams?.firstElementChild?.classList.contains('settings-prototype-configuration')).toBe(
    true,
  );
  expect(
    screen.getByLabelText('Dream prompt').closest('.settings-prototype-configuration'),
  ).toBeTruthy();
  expect(
    screen.getByRole('heading', { name: 'Dream memory' }).closest('.settings-prototype-overflow'),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open system statistics' }));
  expect(dreams?.closest('.has-utility-panel')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'MCP tools' }));
  expect(container.querySelector('.settings-content-scheduling')).toBeNull();
  expect(container.querySelector('[data-family="tools"].settings-content-bounded')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Profile documents' }));
  expect(container.querySelector('.settings-content-scheduling')).toBeNull();
  expect(
    container.querySelector('[data-family="documents"].settings-content-bounded'),
  ).toBeTruthy();
});

it('combines identity and appearance in Personalization and preserves suffix preview, autosave, and navigation', async () => {
  let suffix = 'Dev';
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === '/api/settings/browser-tab') {
      if (options?.method === 'PUT') suffix = JSON.parse(String(options.body)).suffix;
      return { suffix };
    }
    if (path === '/api/settings/identities') return { operator: { name: 'Test', avatar: '' } };
    if (path === '/api/settings/timezone') return { timezone: 'America/Chicago' };
    return { wizardStep: 'ready' };
  });
  render(
    <Settings
      {...({
        tab: 'general',
        setTab: vi.fn(),
        agents: [],
        selected: { id: '', name: '' },
        savedProviders: [],
        onOperatorProfileChanged: vi.fn(),
        agentRailPreferences: { view: 'regular', order: [] },
        theme: 'dark',
        setTheme: vi.fn(),
      } as unknown as ComponentProps<typeof Settings>)}
    />,
  );
  expect(screen.getAllByRole('button', { name: 'Personalization' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Appearance' })).toBeNull();
  await screen.findByDisplayValue('Dev');
  expect(screen.getAllByRole('heading', { name: 'Browser tab' })).toHaveLength(1);
  expect(screen.getByRole('group', { name: 'Theme' })).toBeTruthy();
  expect(screen.getByText(/Applies to everyone using this Burrow environment/)).toBeTruthy();
  const input = screen.getByLabelText('Browser tab suffix');
  fireEvent.change(input, { target: { value: ' Test lab ' } });
  expect(screen.getByText('Burrow — Test lab')).toBeTruthy();
  fireEvent.blur(input);
  await screen.findByText('Browser tab suffix saved.');
  expect(suffix).toBe('Test lab');
  expect(api).toHaveBeenCalledWith(
    '/api/settings/browser-tab',
    expect.objectContaining({ method: 'PUT', body: '{"suffix":"Test lab"}' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Trace retention' }));
  expect(screen.queryByLabelText('Browser tab suffix')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Personalization' }));
  await screen.findByDisplayValue('Test lab');
  expect(screen.getByText('Burrow — Test lab')).toBeTruthy();
  expect(
    vi
      .mocked(api)
      .mock.calls.filter(
        ([path, options]) => path === '/api/settings/browser-tab' && options?.method === 'PUT',
      ),
  ).toHaveLength(1);
});

it('keeps the empty agent setup in one left-track configuration without an empty mounted supporting pane', () => {
  vi.mocked(api).mockResolvedValue({ wizardStep: 'ready' });
  const { container } = render(
    <Settings
      {...({
        tab: 'agents',
        setTab: vi.fn(),
        agents: [],
        selected: { id: '', name: '' },
        savedProviders: [],
        agentRailPreferences: { view: 'regular', order: [] },
      } as unknown as ComponentProps<typeof Settings>)}
    />,
  );
  expect(
    screen.getByRole('heading', { name: 'Agent setup' }).closest('[data-composition="single"]'),
  ).toBeTruthy();
  expect(
    container
      .querySelector('.settings-content-normalized')
      ?.querySelectorAll(':scope > .settings-blank-column'),
  ).toHaveLength(1);
  expect(container.querySelector('.settings-prototype-overflow')).toBeNull();
});

it('uses the empty native agent editor for an only-resident catalog', async () => {
  vi.mocked(api).mockResolvedValue({ wizardStep: 'ready' });
  const resident = {
    id: 'resident-only',
    name: 'Resident Only',
    modAgent: { ownerModId: 'habitat', visibility: { agents: true, chat: true }, capabilities: {} },
  };
  render(
    <Settings
      {...({
        tab: 'agents',
        setTab: vi.fn(),
        agents: [resident],
        selected: resident,
        savedProviders: [],
        agentRailPreferences: { view: 'list', order: [] },
      } as unknown as ComponentProps<typeof Settings>)}
    />,
  );
  expect(await screen.findByText(/No agents configured yet/)).toBeTruthy();
  expect(screen.queryByLabelText('Resident Only settings sections')).toBeNull();
  expect(vi.mocked(api).mock.calls.some(([path]) => String(path).includes('/resident-only/'))).toBe(
    false,
  );
});

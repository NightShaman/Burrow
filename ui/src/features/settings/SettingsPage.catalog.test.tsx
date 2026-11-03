import { cleanup, render, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { Settings } from './SettingsPage';
import { SkillsSettings } from './SkillsSettings';
import { ModSettingsHost } from './ModSettingsHost';

vi.mock('../../app/api', async (original) => ({
  ...(await original<typeof import('../../app/api')>()),
  api: vi.fn(async () => ({ wizardStep: 'ready' })),
}));
vi.mock('../../app/apiTargets', () => ({
  loadModSettingsContributions: vi.fn(async () => [
    {
      modId: 'foreign-mod',
      name: 'Foreign mod',
      settingsUrl: '/foreign-settings.js',
      settings: [
        {
          id: 'main',
          navigation: { title: 'Main' },
          primary: { title: 'Main', capability: 'settingsUi' },
        },
      ],
    },
  ]),
  modContributionsChangedEvent: 'mods-changed',
}));
vi.mock('./SkillsSettings', () => ({ SkillsSettings: vi.fn(() => null) }));
vi.mock('./ModSettingsHost', () => ({ ModSettingsHost: vi.fn(() => null) }));
vi.mock('./SystemStatsRail', () => ({ SystemStatsRail: () => null }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const regular = { id: 'hatchet', name: 'Hatchet', enabled: true };
const resident = {
  id: 'resident',
  name: 'Resident',
  enabled: true,
  modAgent: { ownerModId: 'habitat', capabilities: {}, visibility: { agents: true, chat: false } },
};
function mount(tab: ComponentProps<typeof Settings>['tab']) {
  render(
    <Settings
      {...({
        tab,
        setTab: vi.fn(),
        agents: [regular, { id: 'disabled', name: 'Disabled', enabled: false }, resident],
        selected: resident,
        selectedAgentId: resident.id,
        savedProviders: [],
        agentRailPreferences: { view: 'list', order: [] },
      } as unknown as ComponentProps<typeof Settings>)}
    />,
  );
}
it('keeps residents out of the existing global Skills agent catalog', async () => {
  mount('skills');
  await waitFor(() => expect(SkillsSettings).toHaveBeenCalled());
  expect(vi.mocked(SkillsSettings).mock.lastCall?.[0].agents).toEqual([regular]);
});
it('keeps residents out of foreign mod host catalogs while forwarding the separate editor target', async () => {
  mount('mod-settings:foreign-mod:main');
  await waitFor(() => expect(ModSettingsHost).toHaveBeenCalled());
  expect(vi.mocked(ModSettingsHost).mock.lastCall?.[0]).toEqual(
    expect.objectContaining({
      agents: [regular],
      selectedAgentId: resident.id,
    }),
  );
});

import { describe, expect, it } from 'vitest';
import {
  ownerPanelsForAgents,
  getPanelTitle,
  ownerPanelId,
  ownerPanelModId,
  panelIds,
  panelRegistry,
  panelsForOwners,
} from './panelRegistry';

describe('panelRegistry', () => {
  it('exposes exactly the supported panel ids', () => {
    expect(panelIds).toEqual(['none', 'agents', 'workspace', 'accounts', 'system']);
    expect(panelRegistry.map(({ label }) => label)).toEqual([
      'None',
      'Agents',
      'Workspace',
      'Accounts',
      'System',
    ]);
  });

  it('uses panel titles and safely falls back for unsupported persisted ids', () => {
    expect(getPanelTitle('codex' as never)).toBe('None');
    expect(getPanelTitle('accounts')).toBe('Account Status');
    expect(getPanelTitle('agents')).toBe('Agents');
    expect(getPanelTitle('tasks' as never)).toBe('None');
  });
});

it('uses catalog owner labels for independently selectable panels', () => {
  const panels = panelsForOwners([{ modId: 'sample-mod', name: 'Sample Habitat' }]);
  expect(panels.at(-1)).toEqual({ id: 'owner-agents:sample-mod', label: 'Sample Habitat' });
  expect(ownerPanelModId(ownerPanelId('sample-mod'))).toBe('sample-mod');
  expect(getPanelTitle(ownerPanelId('sample-mod'), panels)).toBe('Sample Habitat');
  expect(ownerPanelModId('agents')).toBeNull();
});

it('retains the owner panel when its last resident moves into Agents', () => {
  const resident = {
    modAgent: {
      ownerModId: 'habitat',
      visibility: { agents: false, chat: false },
      capabilities: { brains: false, forge: false },
    },
  };
  const owners = [{ modId: 'habitat', name: 'Habitat' }];
  const before = ownerPanelsForAgents([resident], owners);
  const after = ownerPanelsForAgents(
    [
      {
        ...resident,
        modAgent: { ...resident.modAgent, visibility: { agents: true, chat: false } },
      },
    ],
    owners,
  );
  expect(after).toEqual(before);
  expect(getPanelTitle(ownerPanelId('habitat'), after)).toBe('Habitat');
});

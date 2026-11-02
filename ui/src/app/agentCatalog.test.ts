import { describe, expect, it } from 'vitest';
import {
  enabledAgents,
  isAgentEnabled,
  settingsAgents,
  chatAgents,
  capabilityAgents,
} from './agentCatalog';

describe('operational agent catalog', () => {
  it('uses registry enabled state rather than transient activity', () => {
    const disabled = { id: 'off', enabled: false, activity: 'Working' };
    const enabled = { id: 'on', enabled: true, activity: 'Disabled' };
    const catalog = [disabled, enabled];
    expect(enabledAgents(catalog)).toEqual([enabled]);
    expect(catalog).toEqual([disabled, enabled]);
  });
  it('supports older hydrated agents and empty catalogs', () => {
    expect(isAgentEnabled({ activity: 'Idle' })).toBe(true);
    expect(isAgentEnabled({ activity: 'Disabled' })).toBe(false);
    expect(enabledAgents([])).toEqual([]);
  });
});

it('projects mod surfaces without dropping historical identities', () => {
  const ordinary = { activity: 'Idle', modAgent: null };
  const hidden = {
    activity: 'Idle',
    modAgent: {
      ownerModId: 'example',
      visibility: { agents: false, chat: false },
      capabilities: { brains: false, forge: true },
    },
  };
  const catalog = [ordinary, hidden];
  expect(settingsAgents(catalog)).toEqual([ordinary]);
  expect(chatAgents(catalog)).toEqual([ordinary]);
  expect(capabilityAgents(catalog, 'brains')).toEqual([ordinary]);
  expect(capabilityAgents(catalog, 'forge')).toEqual(catalog);
  expect(enabledAgents(catalog)).toEqual(catalog);
  expect(catalog).toHaveLength(2);
});

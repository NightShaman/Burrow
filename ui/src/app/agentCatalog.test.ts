import { describe, expect, it } from 'vitest';
import { enabledAgents, isAgentEnabled } from './agentCatalog';

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

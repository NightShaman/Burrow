import { describe, expect, it } from 'vitest';
import { getPanelTitle, panelIds, panelRegistry } from './panelRegistry';

describe('panelRegistry', () => {
  it('exposes exactly the supported panel ids', () => {
    expect(panelIds).toEqual(['none', 'agents', 'workspace', 'accounts', 'system']);
    expect(panelRegistry.map(({ label }) => label)).toEqual(['None', 'Agents', 'Workspace', 'Accounts', 'System']);
  });

  it('uses panel titles and safely falls back for unsupported persisted ids', () => {
    expect(getPanelTitle('codex' as never)).toBe('None');
    expect(getPanelTitle('accounts')).toBe('Account Status');
    expect(getPanelTitle('agents')).toBe('Agents');
    expect(getPanelTitle('tasks' as never)).toBe('None');
  });
});

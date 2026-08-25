import { describe, expect, it } from 'vitest';
import { getPanelTitle, panelIds, panelRegistry } from './panelRegistry';

describe('panelRegistry', () => {
  it('exposes exactly the supported panel ids', () => {
    expect(panelIds).toEqual(['none', 'agents', 'workspace', 'codex', 'accounts', 'system']);
    expect(panelRegistry.map(({ label }) => label)).toEqual(['None', 'Agents', 'Workspace', 'Codex-LB', 'Accounts', 'System']);
  });

  it('uses the special Codex rail title and safely falls back for unsupported persisted ids', () => {
    expect(getPanelTitle('codex')).toBe('Account Status (Codex-LB)');
    expect(getPanelTitle('accounts')).toBe('Account Status');
    expect(getPanelTitle('agents')).toBe('Agents');
    expect(getPanelTitle('tasks' as never)).toBe('None');
  });
});

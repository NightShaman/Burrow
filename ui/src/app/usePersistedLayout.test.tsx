import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { usePersistedAgentSelection, usePersistedLayout, usePersistedTheme } from './usePersistedLayout';

beforeEach(() => localStorage.clear());

describe('persisted layout state', () => {
  it('loads legacy values and rewrites them as validated versioned payloads', async () => {
    localStorage.setItem('hc.theme', 'paper');
    localStorage.setItem('hc.selectedAgentId', 'node-1::smatchet');
    const theme = renderHook(() => usePersistedTheme());
    const agent = renderHook(() => usePersistedAgentSelection());

    expect(theme.result.current[0]).toBe('paper');
    expect(agent.result.current[0]).toBe('node-1::smatchet');
    await waitFor(() => expect(JSON.parse(localStorage.getItem('hc.theme') ?? '{}')).toEqual({ version: 1, value: 'paper' }));
    expect(JSON.parse(localStorage.getItem('hc.selectedAgentId') ?? '{}')).toEqual({ version: 1, value: 'node-1::smatchet' });
  });

  it('rejects invalid themes', () => {
    localStorage.setItem('hc.theme', JSON.stringify({ version: 1, value: 'ultraviolet-chaos' }));
    expect(renderHook(() => usePersistedTheme()).result.current[0]).toBe('smatchet');
  });

  it('validates legacy layout bounds and panel IDs', () => {
    localStorage.setItem('hc.rightPanelDefaultsVersion', '3');
    localStorage.setItem('hc.leftSplit', '99');
    localStorage.setItem('hc.rightSplit', '65');
    localStorage.setItem('hc.leftTopPanel', 'cursed-panel');
    const { result } = renderHook(() => usePersistedLayout());

    expect(result.current.leftSplit).toBe(40);
    expect(result.current.rightSplit).toBe(65);
    expect(result.current.leftTopPanel).toBe('agents');
  });

  it('defaults rail layouts to divided and persists a full-rail choice without touching panel selections', async () => {
    localStorage.setItem('hc.rightPanelDefaultsVersion', '3');
    const { result } = renderHook(() => usePersistedLayout());

    expect(result.current.leftRailLayout).toBe('divided');
    expect(result.current.rightRailLayout).toBe('divided');
    expect(result.current.leftTopPanel).toBe('agents');
    expect(result.current.leftBottomPanel).toBe('workspace');

    act(() => result.current.setLeftRailLayout('bottom'));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('hc.leftRailLayout') ?? '{}')).toEqual({ version: 1, value: 'bottom' }));
    expect(result.current.leftTopPanel).toBe('agents');
    expect(result.current.leftBottomPanel).toBe('workspace');
  });

});

it('keeps single selection separate from remembered divided selections and split across reload', () => {
 const hook = renderHook(() => usePersistedLayout());
 act(() => { hook.result.current.setLeftSplit(45); hook.result.current.setLeftRailLayout('single'); hook.result.current.setLeftSinglePanel('system'); });
 hook.unmount();
 const { result } = renderHook(() => usePersistedLayout());
 expect(result.current.leftSinglePanel).toBe('system');
 act(() => result.current.setLeftRailLayout('divided'));
 expect(result.current.leftTopPanel).toBe('agents');
 expect(result.current.leftBottomPanel).toBe('workspace');
 expect(result.current.leftSplit).toBe(45);
});

it.each([61, 70, 75])('roundtrips archived left-rail trigger %s through reload', (split) => {
 const hook = renderHook(() => usePersistedLayout());
 act(() => hook.result.current.setLeftSplit(split));
 hook.unmount();
 const reload = renderHook(() => usePersistedLayout());
 expect(reload.result.current.leftSplit).toBe(split);
 reload.unmount();
});
it.each([24, 76, 99])('rejects out-of-range persisted split %s on both rails', (split) => {
 localStorage.setItem('hc.leftSplit', JSON.stringify({version: 1, value: split}));
 localStorage.setItem('hc.rightSplit', JSON.stringify({version: 1, value: split}));
 const hook = renderHook(() => usePersistedLayout());
 expect(hook.result.current.leftSplit).toBe(40);
 expect(hook.result.current.rightSplit).toBe(50);
 hook.unmount();
});

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { usePersistedAgentSelection, usePersistedLayout, usePersistedTargetSelection, usePersistedTheme } from './usePersistedLayout';

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

  it('rejects invalid themes and outdated target selections', () => {
    localStorage.setItem('hc.theme', JSON.stringify({ version: 1, value: 'ultraviolet-chaos' }));
    localStorage.setItem('hc.selectedTargetId', JSON.stringify({ version: 0, value: 'node-1' }));
    const theme = renderHook(() => usePersistedTheme());
    const target = renderHook(() => usePersistedTargetSelection());

    expect(theme.result.current[0]).toBe('smatchet');
    expect(target.result.current[0]).toBe('local');
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

  it('persists state updates in versioned payloads', async () => {
    const { result } = renderHook(() => usePersistedTargetSelection());
    act(() => result.current[1]('node-1'));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('hc.selectedTargetId') ?? '{}')).toEqual({ version: 1, value: 'node-1' }));
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

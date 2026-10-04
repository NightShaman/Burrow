import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRuntimeSelection } from './useRuntimeSelection';
vi.mock('./usePersistedLayout', () => ({ usePersistedAgentSelection: () => ['', vi.fn()] }));
describe('single local runtime selection', () => { it('keeps selected agent and child stream state without runtime target selectors', () => { const { result }=renderHook(()=>useRuntimeSelection()); expect('activeTarget' in result.current).toBe(false); expect('activeTargets' in result.current).toBe(false); act(()=>result.current.selectParentStream('agent')); expect(result.current.selectedStreamId).toBe('agent'); }); });

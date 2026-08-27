import { act, renderHook, waitFor } from '@testing-library/react';
import type { Dispatch, SetStateAction } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiForTarget } from '../../app/api';
import { localApiTarget } from '../../app/apiTargets';
import type { Tab } from '../../app/types';
import { useWorkspaceFiles } from './useWorkspaceFiles';

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  apiForTarget: vi.fn(),
}));

const apiForTargetMock = vi.mocked(apiForTarget);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

const setTabs: Dispatch<SetStateAction<Tab[]>> = vi.fn();
const setActiveTabId: Dispatch<SetStateAction<string>> = vi.fn();

describe('useWorkspaceFiles', () => {
  beforeEach(() => {
    apiForTargetMock.mockReset();
  });

  it('does not let a previous agent response replace the selected agent workspace', async () => {
    const firstAgent = deferred<{ files: Array<{ path: string; type: 'file' }> }>();
    apiForTargetMock.mockImplementation(async (_target, path) => {
      if (path.includes('agentId=agent-a')) return firstAgent.promise;
      if (path.includes('agentId=agent-b')) return { files: [{ path: 'agent-b.txt', type: 'file' as const }] };
      throw new Error(`Unexpected path: ${path}`);
    });

    const { result, rerender } = renderHook(
      ({ selectedAgentId }) => useWorkspaceFiles({ selectedAgentId, targets: [localApiTarget], setTabs, setActiveTabId }),
      { initialProps: { selectedAgentId: 'agent-a' } },
    );
    await waitFor(() => expect(apiForTargetMock).toHaveBeenCalledWith(localApiTarget, expect.stringContaining('agentId=agent-a')));

    rerender({ selectedAgentId: 'agent-b' });
    await waitFor(() => expect(result.current.workspaceFiles).toEqual([{ name: 'agent-b.txt', path: 'agent-b.txt', type: 'file' }]));

    await act(async () => {
      firstAgent.resolve({ files: [{ path: 'agent-a.txt', type: 'file' }] });
      await firstAgent.promise;
    });

    expect(result.current.workspaceFiles).toEqual([{ name: 'agent-b.txt', path: 'agent-b.txt', type: 'file' }]);
  });
});

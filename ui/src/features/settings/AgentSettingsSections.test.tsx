import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiForTarget } from '../../app/api';
import type { ApiTarget } from '../../app/apiTargets';
import { AgentDreams } from './AgentDreams';
import { AgentMcpTools } from './AgentMcpTools';
import { AgentProfileDocuments } from './AgentProfileDocuments';

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  apiForTarget: vi.fn(),
}));

const apiMock = vi.mocked(apiForTarget);
const targets: ApiTarget[] = [
  { id: 'local', name: 'Local', baseUrl: '', enabled: true },
  { id: 'node-1', name: 'Node One', baseUrl: 'http://node-one:8787', enabled: true },
];

function pendingRequestSignals() {
  return apiMock.mock.calls.map(([, , init]) => init?.signal).filter((signal): signal is AbortSignal => Boolean(signal));
}

afterEach(cleanup);

describe('agent settings sections', () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation(() => new Promise(() => undefined));
  });

  it.each([
    ['profile documents', (agentId: string) => <AgentProfileDocuments agentId={agentId} targets={targets} />],
    ['dream settings', (agentId: string) => <AgentDreams agentId={agentId} targets={targets} savedProviders={[]} />],
    ['MCP grants', (agentId: string) => <AgentMcpTools agentId={agentId} targets={targets} />],
  ])('aborts obsolete %s requests when agent ownership changes', (_label, section) => {
    const view = render(section('smatchet'));
    const firstSignals = pendingRequestSignals();
    expect(firstSignals.length).toBeGreaterThan(0);
    firstSignals.forEach((signal) => expect(signal.aborted).toBe(false));

    act(() => view.rerender(section('node-1::hatchet')));

    firstSignals.forEach((signal) => expect(signal.aborted).toBe(true));
    const currentSignals = pendingRequestSignals().slice(firstSignals.length);
    expect(currentSignals.length).toBeGreaterThan(0);
    currentSignals.forEach((signal) => expect(signal.aborted).toBe(false));
  });
});

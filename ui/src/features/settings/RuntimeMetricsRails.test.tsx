import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, apiForTarget } from '../../app/api';
import { SystemPanel } from '../workspace/WorkspaceRail';
import { SystemStatsRail } from './SystemStatsRail';

vi.mock('../../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/api')>()),
  api: vi.fn(),
  apiForTarget: vi.fn(),
}));

afterEach(cleanup);

it('renders both system rails when metrics omit the retired settings database footprint', async () => {
  const metrics = {
    ok: true,
    filesystem: { totalBytes: 1000, usedBytes: 500, availableBytes: 500, error: null },
    process: { rssBytes: 1024, heapUsedBytes: 512, heapTotalBytes: 1024, externalBytes: 0, uptimeSeconds: 60, cpu: { percent: 2 } },
    load: { oneMinute: 0, fiveMinutes: 0, fifteenMinutes: 0 },
  };
  const health = { ok: true, version: 'dev', traces: { logicalBytes: 0, count: 0 } };
  vi.mocked(api).mockImplementation(async (path) => path === '/api/metrics' ? metrics : health);
  vi.mocked(apiForTarget).mockImplementation(async (_target, path) => path === '/api/metrics' ? metrics : health);
  render(<><SystemPanel target={{ id: 'local', name: 'Dev', baseUrl: '', enabled: true }} provider="Test" providerConnectionStatus="connected" /><SystemStatsRail active /></>);
  expect(await screen.findByText('Healthy')).toBeTruthy();
  expect(screen.getAllByText('Trace storage')).toHaveLength(2);
  expect(screen.getByText('Dev runtime')).toBeTruthy();
  expect(screen.queryByText('Settings database')).toBeNull();
});

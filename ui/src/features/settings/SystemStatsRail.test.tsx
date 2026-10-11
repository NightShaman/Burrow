import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { SystemStatsRail } from './SystemStatsRail';

vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows UI identity and backend provenance in the Burrow summary in system statistics', async () => {
  vi.stubGlobal('__BURROW_UI_BUILD_IDENTITY__', '1234567890abcdef');
  vi.mocked(api).mockImplementation(async path => path === '/api/health'
    ? { ok: true, version: '2026.10.11.11', releaseProvenance: { ui: 'different-packaged-ui', backend: 'abcdef0123456789', assembly: '2026.10.11.11' } }
    : { ok: true, filesystem: {}, process: { cpu: {} }, load: {} });
  render(<SystemStatsRail active />);
  await screen.findByText('abcdef0123456789');
  expect(screen.getByText('1234567890abcdef').getAttribute('title')).toBe('1234567890abcdef');
  expect(screen.queryByText('different-packaged-ui')).toBeNull();
  const summary = screen.getByText('1234567890abcdef').closest('section');
  expect(summary?.className).toBe('system-rail-summary');
  expect(summary?.textContent).toContain('Burrow');
  expect(summary?.textContent).toContain('2026.10.11.11');
  expect(summary?.textContent).toContain('abcdef0123456789');
  expect(screen.queryByText('Build information')).toBeNull();
  expect(screen.queryByText('Assembly')).toBeNull();
  expect(screen.queryByText('Storage')).toBeNull();
  expect(screen.queryByText('Trace storage')).toBeNull();
});

it('keeps missing provenance explicit without fetching while closed', async () => {
  vi.stubGlobal('__BURROW_UI_BUILD_IDENTITY__', 'development');
  vi.mocked(api).mockClear();
  const { rerender } = render(<SystemStatsRail active={false} />);
  expect(api).not.toHaveBeenCalled();
  expect(screen.getByText('Backend').nextElementSibling?.textContent).toBe('Unavailable');
  vi.mocked(api).mockImplementation(async path => path === '/api/health'
    ? { ok: true }
    : { ok: true, filesystem: {}, process: { cpu: {} }, load: {} });
  rerender(<SystemStatsRail active />);
  await waitFor(() => expect(screen.getByText('Healthy')).toBeTruthy());
  expect(screen.getByText('Backend').nextElementSibling?.textContent).toBe('Unavailable');
});

import { ConfirmProvider } from '../../app/ConfirmDialog';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render as baseRender, waitFor } from '@testing-library/react';
import { ModSettingsHost } from './ModSettingsHost';

const { mountSettings } = vi.hoisted(() => ({ mountSettings: vi.fn() }));
vi.mock('./ModSettingsHostFixture', () => ({ settingsSections: [{ id: 'vault', label: 'Vault' }], mountSettings, settingsContribution: undefined, createSettingsContribution: undefined }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); mountSettings.mockReset(); });
it('mounts locally scoped Settings API regardless of selected remote target', async () => {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('fetch', fetch);

  render(<ModSettingsHost modId="example" settingsUrl="./ModSettingsHostFixture" agents={[]} onAgentsChanged={async () => {}} navigationTarget={null} overflowTarget={null} />);
  await waitFor(() => expect(mountSettings).toHaveBeenCalled());
  const context = mountSettings.mock.calls[0][0];
  expect(context.runtimeScope).toBe('local'); expect(context.modId).toBe('example');
  await context.api('/status');
  await context.accessApi({ method: 'POST' });
  expect(fetch.mock.calls[0][0]).toBe('/api/mods/example/status');
  expect(fetch.mock.calls[0][0]).not.toContain('remote.example');
  expect(fetch.mock.calls[1][0]).toBe('/api/operator/mods/example/access');
  const response = await context.fetchContent('/api/reference/content');
  expect(response).toBeInstanceOf(Response);
  expect(fetch.mock.calls[2][0]).toBe('/api/reference/content');
  for (const path of ['https://evil.example/api/photo', '//evil.example/api/photo', '/api/../secret', '/api/%2e%2e/secret', '/api/photo#fragment']) {
    await expect(context.fetchContent(path)).rejects.toThrow('Invalid content URL');
  }
  await context.fetchContent('/api/mod-reference-images/theater/opaque/content?id=version');
  expect(fetch.mock.calls[3][0]).toBe('/api/mod-reference-images/theater/opaque/content?id=version');
  expect(fetch).toHaveBeenCalledTimes(4);
});

function render(ui: Parameters<typeof baseRender>[0]) { return baseRender(ui, { wrapper: ConfirmProvider }); }

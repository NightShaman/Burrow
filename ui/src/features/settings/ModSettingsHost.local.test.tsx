import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { ModSettingsHost } from './ModSettingsHost';
import { setActiveApiTarget } from '../../app/api';

const { mountSettings } = vi.hoisted(() => ({ mountSettings: vi.fn() }));
vi.mock('./ModSettingsHostFixture', () => ({ settingsSections: [{ id: 'vault', label: 'Vault' }], mountSettings, settingsContribution: undefined, createSettingsContribution: undefined }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setActiveApiTarget(undefined); mountSettings.mockReset(); });
it('mounts locally scoped Settings API regardless of selected remote target', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  setActiveApiTarget({ baseUrl: 'https://remote.example' } as Parameters<typeof setActiveApiTarget>[0]);
  render(<ModSettingsHost modId="example" settingsUrl="./ModSettingsHostFixture" agents={[]} onAgentsChanged={async () => {}} navigationTarget={null} overflowTarget={null} />);
  await waitFor(() => expect(mountSettings).toHaveBeenCalled());
  const context = mountSettings.mock.calls[0][0];
  expect(context.runtimeScope).toBe('local'); expect(context.modId).toBe('example');
  await context.api('/status');
  expect(fetch.mock.calls[0][0]).toBe('/api/mods/example/status');
  expect(fetch.mock.calls[0][0]).not.toContain('remote.example');
});

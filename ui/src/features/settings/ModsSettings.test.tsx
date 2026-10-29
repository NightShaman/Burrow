import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { ModsSettings } from './ModsSettings';
import * as management from './modManagementApi';

vi.mock('./modManagementApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./modManagementApi')>();
  return { ...actual, loadModManagement: vi.fn(), loadSecretReferences: vi.fn(), loadSourceRefreshConfig: vi.fn(), saveSourceRefreshConfig: vi.fn(), modManagementAction: vi.fn() };
});

const loadMock = vi.mocked(management.loadModManagement);
const loadSecretReferencesMock = vi.mocked(management.loadSecretReferences);
const loadRefreshMock = vi.mocked(management.loadSourceRefreshConfig);
const saveRefreshMock = vi.mocked(management.saveSourceRefreshConfig);

beforeEach(() => {
  loadSecretReferencesMock.mockResolvedValue([]);
  loadRefreshMock.mockResolvedValue({ enabled: true, intervalMs: 21_600_000, staleMs: 900_000 });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ModsSettings layout contract', () => {
  it('keeps selected mod configuration in column 3 and the catalog in column 4', async () => {
    loadMock.mockResolvedValue({ restartRequired: false, sources: [], mods: [
      { id: 'alpha', name: 'Alpha', status: 'installed', enabled: true, version: '1.0.0', runningVersion: '1.0.0', managedSkillVersion: '3.2.1', system: true },
      { id: 'beta', name: 'Beta', status: 'available', latestVersion: '2.0.0' },
    ] });
    const overflow = document.createElement('section');
    document.body.appendChild(overflow);
    const { container } = render(<ModsSettings section="installed" overflowTarget={overflow} />);
    await waitFor(() => expect(container.textContent).toContain('Manage installation, version, and availability'));
    expect(container.querySelector('.mod-configuration')).toBeTruthy();
    expect(container.querySelector('.mod-configuration.setting-section')).toBeTruthy();
    expect(overflow.textContent).toContain('Alpha');
    expect(screen.getByRole('button', { name: 'Manage Alpha' }).textContent).toContain('Installed · Enabled · Installed 1.0.0 · Running 1.0.0 · Managed skill 3.2.1');
    expect(screen.getByRole('button', { name: 'Manage Beta' }).textContent).not.toContain('Managed skill');
    expect(overflow.textContent).not.toContain('Core');
    expect(overflow.querySelector('.mod-system-dot')).toBeNull();
    expect(overflow.querySelector('.mod-system-badge')?.textContent).toBe('System');
    expect(overflow.querySelector('.memory-connection.selected')).toBeNull();
    expect(container.textContent).not.toContain('Beta');
    expect(screen.queryByRole('button', { name: 'Refresh catalog' })).toBeNull();
    expect(overflow.getAttribute('aria-label')).toBeNull();
    expect(overflow.querySelector('[aria-label="Mod catalog"]')?.textContent).toContain('Beta');
    expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Manage Beta' }));
    expect(screen.getByRole('button', { name: 'Manage Beta' }).getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('Beta');
    overflow.remove();
  });

  it('keeps source configuration in column 3 and configured sources in column 4', async () => {
    loadMock.mockResolvedValue({ restartRequired: false, mods: [], sources: [{ id: 'source-1', url: 'https://mods.example/catalog.json', status: 'Ready', lastCheckedAt: '2026-09-06T00:25:00Z' }] });
    const overflow = document.createElement('section');
    document.body.appendChild(overflow);
    const { container } = render(<ModsSettings section="sources" overflowTarget={overflow} />);
    await waitFor(() => expect(overflow.textContent).toContain('mods.example'));
    expect(container.querySelector('input[placeholder="https://git.example.com/team/mod.git"]')).toBeTruthy();
    expect(container.querySelector('.mod-source-configuration')).toBeTruthy();
    expect(container.querySelector('.mod-source-configuration.setting-section')).toBeTruthy();
    expect(container.textContent).not.toContain('mods.example');
    expect(overflow.textContent).toContain(`Checked ${new Date('2026-09-06T00:25:00Z').toLocaleString()}`);
    expect(overflow.textContent).not.toContain('2026-09-06T00:25:00Z');
    expect(overflow.querySelector('[aria-label="Configured mod sources"]')?.textContent).toContain('Ready');
    overflow.remove();
  });
});


describe('ModsSettings version and lifecycle truth', () => {
  it.each([
    { version: undefined, latestVersion: '2.0.0', updateAvailable: false, label: 'Reinstall' },
    { version: undefined, latestVersion: '2.0.0', updateAvailable: true, label: 'Reinstall' },
    { version: '1.0.0', latestVersion: undefined, updateAvailable: false, label: 'Reinstall' },
    { version: '1.0.0', latestVersion: '1.0.0', updateAvailable: false, label: 'Reinstall' },
    { version: '1.0.0', latestVersion: '2.0.0', updateAvailable: true, label: 'Update' },
  ])('presents known and unknown versions honestly: $version / $latestVersion / $label', async ({ label, ...versions }) => {
    loadMock.mockResolvedValue({ restartRequired: false, sources: [], mods: [
      { id: 'node-goblin', name: 'Node Goblin', status: 'installed', enabled: true, canInstall: true, ...versions },
    ] });
    vi.mocked(management.modManagementAction).mockResolvedValue({ ok: true });
    render(<ModsSettings />);
    await screen.findByRole('button', { name: label });
    const current = screen.getByLabelText('Installed version') as HTMLInputElement;
    const latest = screen.getByLabelText('Latest source version') as HTMLInputElement;
    expect(current.value).toBe(versions.version || 'Unknown');
    expect(latest.value).toBe(versions.latestVersion || 'Unknown');
    expect(current.readOnly).toBe(true);
    expect(latest.readOnly).toBe(true);
    expect(screen.queryByText('Up to date')).toBeNull();
    expect(screen.queryByLabelText('Install version')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(management.modManagementAction).toHaveBeenCalledWith(
      '/api/mod-management/node-goblin/install', { method: 'POST', body: '{}' },
    ));
    await screen.findByRole('button', { name: label });
  });

  it.each(['installed', 'available'])('honors canInstall=false for $status mods', async (status) => {
    loadMock.mockResolvedValue({ restartRequired: false, sources: [], mods: [
      { id: 'blocked', name: 'Blocked', status, canInstall: false, latestVersion: '2.0.0' },
    ] });
    render(<ModsSettings />);
    const button = await screen.findByRole('button', { name: status === 'installed' ? 'Reinstall' : 'Install' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Installed version') as HTMLInputElement).value).toBe(status === 'installed' ? 'Unknown' : 'Not installed');
    fireEvent.click(button);
    expect(management.modManagementAction).not.toHaveBeenCalled();
  });
});


describe('explicit mod activation', () => {
  const actionMock = vi.mocked(management.modManagementAction);
  const catalog = (mod: management.ModRecord): management.NormalizedModManagement => ({ restartRequired: false, sources: [], mods: [mod] });

  it.each([
    { id: 'node-goblin', name: 'Node Goblin', system: true },
    { id: 'ordinary', name: 'Ordinary mod', system: false },
  ])('installs $name disabled and enables only on a separate operator action', async (identity) => {
    const available = { ...identity, status: 'available', latestVersion: '1.0.0', canInstall: true };
    const installed = { ...available, status: 'installed', version: '1.0.0', enabled: false };
    loadMock.mockResolvedValueOnce(catalog(available))
      .mockResolvedValueOnce(catalog(installed))
      .mockResolvedValueOnce(catalog({ ...installed, enabled: true, runningVersion: '1.0.0' }))
      .mockResolvedValueOnce(catalog(installed));
    actionMock.mockResolvedValue({ ok: true });
    const overflow = document.createElement('section'); document.body.appendChild(overflow);
    const { container, unmount } = render(<ModsSettings overflowTarget={overflow} />);
    await screen.findByRole('button', { name: 'Install' });
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
    expect(screen.getByText(/All mods, including Node Goblin and system mods, start disabled/).textContent).toContain('Settings → Mods → Installed mods');
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    const enable = await screen.findByRole('button', { name: 'Enable' });
    await waitFor(() => expect((enable as HTMLButtonElement).disabled).toBe(false));
    expect(actionMock.mock.calls).toEqual([['/api/mod-management/' + identity.id + '/install', { method: 'POST', body: '{}' }]]);
    expect(overflow.textContent).toContain('Installed · Disabled');
    expect(container.textContent).toContain('Choose Enable to activate it');
    expect((screen.getByLabelText('Running version') as HTMLInputElement).value).toBe('Not running');
    expect(overflow.querySelector('.model-actions')).toBeNull();
    fireEvent.click(enable);
    const disable = await screen.findByRole('button', { name: 'Disable' });
    await waitFor(() => expect((disable as HTMLButtonElement).disabled).toBe(false));
    expect(actionMock).toHaveBeenNthCalledWith(2, '/api/mod-management/' + identity.id + '/enable', { method: 'POST' });
    expect(overflow.textContent).toContain('Installed · Enabled');
    expect((screen.getByLabelText('Running version') as HTMLInputElement).value).toBe('1.0.0');
    expect(screen.queryByText(/Choose Enable to activate it/)).toBeNull();
    fireEvent.click(disable);
    await screen.findByRole('button', { name: 'Enable' });
    expect(actionMock).toHaveBeenNthCalledWith(3, '/api/mod-management/' + identity.id + '/disable', { method: 'POST' });
    expect(overflow.textContent).toContain('Installed · Disabled');
    unmount(); overflow.remove();
  });

  it.each([true, false])('preserves backend enabled=%s after reinstall without a follow-up activation call', async (enabled) => {
    const mod = { id: 'node-goblin', name: 'Node Goblin', system: true, status: 'installed', enabled, version: '1.0.0' };
    loadMock.mockResolvedValue(catalog(mod));
    actionMock.mockResolvedValue({ ok: true });
    render(<ModsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reinstall' }));
    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(2));
    await screen.findByRole('button', { name: enabled ? 'Disable' : 'Enable' });
    expect(actionMock.mock.calls).toEqual([['/api/mod-management/node-goblin/install', { method: 'POST', body: '{}' }]]);
    expect(screen.getByRole('button', { name: 'Manage Node Goblin' }).textContent).toContain(enabled ? 'Installed · Enabled' : 'Installed · Disabled');
  });

  it('keeps disabled state while enable is pending and when backend enable fails', async () => {
    loadMock.mockResolvedValue(catalog({ id: 'node-goblin', name: 'Node Goblin', system: true, status: 'installed', enabled: false }));
    let reject!: (error: Error) => void;
    actionMock.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    render(<ModsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    expect(screen.getByRole('button', { name: 'Manage Node Goblin' }).textContent).toContain('Installed · Disabled');
    expect(screen.getAllByRole('button', { name: 'Working…' }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
    reject(new Error('Activation failed'));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('Activation failed');
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manage Node Goblin' }).textContent).toContain('Installed · Disabled');
    expect(actionMock).toHaveBeenCalledTimes(1);
  });
});


describe('Git mod sources', () => {
  it('edits automatic checks in friendly units and saves exact milliseconds', async () => {
    loadMock.mockResolvedValue({ restartRequired: false, mods: [], sources: [], sourceRefresh: { enabled: true, intervalMs: 21_600_000, staleMs: 900_000, refreshing: false, failures: 0 } });
    saveRefreshMock.mockImplementation(async config => config);
    render(<ModsSettings section="automatic-checks" />);
    const enabled = await screen.findByRole('checkbox', { name: 'Enable background source checks' });
    expect((screen.getByLabelText('Check every') as HTMLInputElement).value).toBe('6');
    expect((screen.getByLabelText('Check interval unit') as HTMLSelectElement).value).toBe('hours');
    expect((screen.getByLabelText('Consider source stale after') as HTMLInputElement).value).toBe('15');
    fireEvent.click(enabled);
    await waitFor(() => expect((enabled as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Check every')!, { target: { value: '1.5' } });
    fireEvent.blur(screen.getByLabelText('Check every'));
    await waitFor(() => expect((enabled as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Stale threshold unit'), { target: { value: 'seconds' } });
    await waitFor(() => expect((enabled as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Consider source stale after')!, { target: { value: '90' } });
    fireEvent.blur(screen.getByLabelText('Consider source stale after'));
    await waitFor(() => expect(saveRefreshMock).toHaveBeenCalledWith({ enabled: false, intervalMs: 5_400_000, staleMs: 90_000 }));
  });

  it('preserves millisecond precision and surfaces save failures', async () => {
    loadMock.mockResolvedValue({ restartRequired: false, mods: [], sources: [] });
    loadSecretReferencesMock.mockResolvedValue([]);
    loadRefreshMock.mockResolvedValue({ enabled: true, intervalMs: 1_234, staleMs: 5_678 });
    saveRefreshMock.mockRejectedValue(new Error('refresh settings unavailable'));
    render(<ModsSettings section="automatic-checks" />);
    await screen.findByRole('checkbox', { name: 'Enable background source checks' });
    expect((screen.getByLabelText('Check every') as HTMLInputElement).value).toBe('1234');
    expect((screen.getByLabelText('Check interval unit') as HTMLSelectElement).value).toBe('milliseconds');
    fireEvent.change(screen.getByLabelText('Check every'), { target: { value: '1235' } });
    fireEvent.blur(screen.getByLabelText('Check every'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('refresh settings unavailable'));
    expect((screen.getByLabelText('Check every') as HTMLInputElement).value).toBe('1235');
    expect(saveRefreshMock).toHaveBeenCalledWith({ enabled: true, intervalMs: 1235, staleMs: 5678 });
  });

  it('rejects durations that do not resolve to positive safe integer milliseconds', async () => {
    loadMock.mockResolvedValue({ restartRequired: false, mods: [], sources: [] });
    render(<ModsSettings section="automatic-checks" />);
    await screen.findByRole('checkbox', { name: 'Enable background source checks' });
    fireEvent.change(screen.getByLabelText('Check every')!, { target: { value: '0.0001' } });
    fireEvent.change(screen.getByLabelText('Check interval unit'), { target: { value: 'seconds' } });
    fireEvent.blur(screen.getByLabelText('Check every'));
    expect(screen.getByRole('alert').textContent).toContain('positive whole durations');
    expect(saveRefreshMock).not.toHaveBeenCalled();
  });

  it('selects an existing source into column 3, allows recheck and credential replacement without exposing existing secrets', async () => {
    const url = 'https://git.example.com/existing.git';
    loadMock.mockResolvedValue({ restartRequired: false, mods: [], sources: [{ id: 'existing', url, status: 'ready' }] });
    vi.mocked(management.modManagementAction).mockResolvedValue({ ok: true });
    const overflow = document.createElement('section');
    document.body.appendChild(overflow);
    const { container, unmount } = render(<ModsSettings section="sources" overflowTarget={overflow} />);
    await screen.findByRole('button', { name: `Edit ${url}` });
    fireEvent.click(screen.getByRole('button', { name: `Edit ${url}` }));
    expect(container.textContent).toContain('Selected mod source');
    const sourceUrl = screen.getByLabelText('Git repository URL') as HTMLInputElement;
    expect(sourceUrl.value).toBe(url);
    expect(sourceUrl.readOnly).toBe(true);
    const secret = screen.getByLabelText('Password or access token (optional)') as HTMLInputElement;
    expect(secret.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Update source' }));
    await waitFor(() => expect(management.modManagementAction).toHaveBeenCalledWith('/api/mod-management/sources', { method: 'POST', body: JSON.stringify({ url }) }));
    expect(screen.queryByRole('button', { name: 'Save automatic checks' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New source' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `Edit ${url}` }));
    expect(sourceUrl.value).toBe('');
    expect(screen.getByRole('button', { name: 'Add source' })).toBeTruthy();
    unmount(); overflow.remove();
  });

  it('shows, preserves, replaces, and explicitly removes an existing stored credential without exposing it', async () => {
    const url = 'https://git.example.com/private.git';
    const configured = { restartRequired: false, mods: [], sources: [{ id: 'private', url, status: 'ready', credential: { configured: true } }] };
    const removed = { restartRequired: false, mods: [], sources: [{ id: 'private', url, status: 'ready', credential: { configured: false } }] };
    loadMock.mockResolvedValueOnce(configured).mockResolvedValueOnce(configured).mockResolvedValueOnce(removed);
    vi.mocked(management.modManagementAction).mockResolvedValue({ ok: true });
    render(<ModsSettings section="sources" />);
    fireEvent.click(await screen.findByRole('button', { name: `Edit ${url}` }));
    expect(screen.getByText('Stored credential configured')).toBeTruthy();
    expect(screen.getByText('Leave the password or token empty to keep using it.')).toBeTruthy();
    expect((screen.getByLabelText('Password or access token (optional)') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).not.toContain('{{gss:');

    fireEvent.click(screen.getByRole('button', { name: 'Update source' }));
    await waitFor(() => expect(management.modManagementAction).toHaveBeenNthCalledWith(1, '/api/mod-management/sources', {
      method: 'POST', body: JSON.stringify({ url }),
    }));
    expect(screen.getByText('Stored credential configured')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove stored credential' }));
    await waitFor(() => expect(management.modManagementAction).toHaveBeenNthCalledWith(2, '/api/mod-management/sources/private/credential', { method: 'DELETE' }));
    await waitFor(() => expect(screen.queryByText('Stored credential configured')).toBeNull());
  });

  it('keeps automatic source checks separate from source editing and inventory', async () => {
    loadMock.mockResolvedValue({ restartRequired: false, mods: [], sources: [{ id: 'x', url: 'https://git.example.com/x.git' }] });
    const overflow = document.createElement('section'); document.body.appendChild(overflow);
    const { container, unmount } = render(<ModsSettings section="automatic-checks" overflowTarget={overflow} />);
    await screen.findByRole('checkbox', { name: 'Enable background source checks' });
    expect(container.textContent).toContain('Automatic source checks');
    expect(container.querySelector('[aria-label="Configured mod sources"]')).toBeNull();
    expect(overflow.textContent).not.toContain('git.example.com');
    expect(screen.queryByRole('button', { name: 'Add source' })).toBeNull();
    unmount(); overflow.remove();
  });

  it('submits a public Git URL without auth and clears on success', async () => {
    loadMock.mockResolvedValue({ restartRequired: false, mods: [], sources: [] });
    vi.mocked(management.modManagementAction).mockResolvedValue({ ok: true });
    render(<ModsSettings section="sources" />);
    fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: ' https://git.example.com/public/mod.git ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(management.modManagementAction).toHaveBeenCalledWith('/api/mod-management/sources', { method: 'POST', body: JSON.stringify({ url: 'https://git.example.com/public/mod.git' }) }));
    await waitFor(() => expect((screen.getByLabelText('Git repository URL') as HTMLInputElement).value).toBe(''));
    expect(screen.getByText(/version-tagged releases containing burrow.mod.json/)).toBeTruthy();
    expect(screen.getByText(/configure keys and host trust on the Core service account/)).toBeTruthy();
  });

  it('submits HTTPS credentials, masks and wipes secret on success and unmount', async () => {
    loadMock.mockResolvedValue({ restartRequired: false, mods: [], sources: [] });
    vi.mocked(management.modManagementAction).mockResolvedValue({ ok: true });
    const { unmount } = render(<ModsSettings section="sources" />);
    const secret = screen.getByLabelText('Password or access token (optional)') as HTMLInputElement;
    expect(secret.type).toBe('password');
    expect(secret.value).toBe('');
    fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'https://git.example.com/private.git' } });
    fireEvent.change(screen.getByLabelText('Private repository username (optional)'), { target: { value: 'alice' } });
    fireEvent.change(secret, { target: { value: 'private-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(management.modManagementAction).toHaveBeenCalledWith('/api/mod-management/sources', { method: 'POST', body: JSON.stringify({ url: 'https://git.example.com/private.git', auth: { username: 'alice', token: 'private-token' } }) }));
    await waitFor(() => expect(secret.value).toBe(''));
    expect((screen.getByLabelText('Private repository username (optional)') as HTMLInputElement).value).toBe('');
    fireEvent.change(secret, { target: { value: 'second-secret' } });
    unmount();
    expect(secret.value).toBe('');
  });

  it('keeps successful submission distinct from a failed catalog reload', async () => {
    loadMock.mockResolvedValueOnce({ restartRequired: false, mods: [], sources: [] }).mockRejectedValueOnce(new Error('catalog offline'));
    vi.mocked(management.modManagementAction).mockResolvedValue({ ok: true });
    render(<ModsSettings section="sources" />);
    fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'https://git.example.com/new.git' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Source added, but the catalog could not be refreshed'));
    expect(screen.getByRole('alert').textContent).not.toContain('credentials');
    expect((screen.getByLabelText('Git repository URL') as HTMLInputElement).value).toBe('');
  });

  it('shows a retained failed source with its discovery error after POST rejects', async () => {
    const url = 'https://git.example.com/broken.git';
    loadMock.mockResolvedValueOnce({ restartRequired: false, mods: [], sources: [] })
      .mockResolvedValueOnce({ restartRequired: false, mods: [], sources: [{ id: 'bad', url, status: 'failed', error: 'mod_source_authentication_failed' }] });
    vi.mocked(management.modManagementAction).mockRejectedValue(new Error('mod_source_authentication_failed'));
    render(<ModsSettings section="sources" />);
    fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: url } });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Source saved, but discovery failed'));
    expect(screen.getByRole('alert').textContent).toContain('mod_source_authentication_failed');
    expect(screen.getByText(url)).toBeTruthy();
    expect(screen.getByText(/failed · mod_source_authentication_failed/)).toBeTruthy();
    expect((screen.getByLabelText('Git repository URL') as HTMLInputElement).value).toBe(url);
  });

  it('allows token-only HTTPS authentication using the backend default username', async () => {
    loadMock.mockResolvedValue({ restartRequired: false, mods: [], sources: [] });
    vi.mocked(management.modManagementAction).mockResolvedValue({ ok: true });
    render(<ModsSettings section="sources" />);
    fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'https://git.example.com/private.git' } });
    fireEvent.change(screen.getByLabelText('Password or access token (optional)'), { target: { value: 'secret-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(management.modManagementAction).toHaveBeenCalledWith('/api/mod-management/sources', {
      method: 'POST', body: JSON.stringify({ url: 'https://git.example.com/private.git', auth: { token: 'secret-token' } }),
    }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('rejects SSH credentials and retains entries after a failed request', async () => {
    loadMock.mockResolvedValue({ restartRequired: false, mods: [], sources: [] });
    vi.mocked(management.modManagementAction).mockRejectedValue(new Error('secret-containing server error'));
    render(<ModsSettings section="sources" />);
    const url = screen.getByLabelText('Git repository URL') as HTMLInputElement;
    const username = screen.getByLabelText('Private repository username (optional)') as HTMLInputElement;
    const secret = screen.getByLabelText('Password or access token (optional)') as HTMLInputElement;
    fireEvent.change(url, { target: { value: 'git@git.example.com:private.git' } });
    fireEvent.change(username, { target: { value: 'alice' } });
    fireEvent.change(secret, { target: { value: 'private-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    expect(screen.getByRole('alert').textContent).toContain('only for HTTPS');
    expect(management.modManagementAction).not.toHaveBeenCalled();
    fireEvent.change(url, { target: { value: 'https://git.example.com/private.git' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not add mod source'));
    expect(screen.getByRole('alert').textContent).not.toContain('secret-containing');
    expect(secret.value).toBe('private-token');
  });

  it('discovers and selects a stored reference on demand without exposing a button wall', async () => {
    const reference = '{{gss:00000000-0000-4000-8000-000000000000/token}}';
    loadMock.mockResolvedValue({ restartRequired: false, mods: [], sources: [] });
    loadSecretReferencesMock.mockResolvedValue([
      { reference: '{{gss:11111111-0000-4000-8000-000000000000/token}}', label: 'GitLab — Other team', type: 'token', username: 'oauth2', service: 'GitLab' },
      { reference, label: 'GitHub — NightShaman PAT', type: 'token', username: 'oauth2', service: 'GitHub', url: 'https://github.com/NightShaman' },
    ]);
    vi.mocked(management.modManagementAction).mockResolvedValue({ ok: true });
    render(<ModsSettings section="sources" />);
    const browse = await screen.findByRole('button', { name: 'Browse stored credentials' });
    expect(screen.queryByRole('option')).toBeNull();
    fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'https://github.com/NightShaman/private.git' } });
    fireEvent.click(browse);
    const search = screen.getByRole('combobox', { name: 'Search stored credentials' });
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      expect.stringContaining('GitHub — NightShaman PAT'),
      expect.stringContaining('GitLab — Other team'),
    ]);
    fireEvent.change(search, { target: { value: 'nightshaman' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.queryByRole('listbox', { name: 'Stored credentials' })).toBeNull();
    expect(screen.getByText('GitHub — NightShaman PAT')).toBeTruthy();
    expect(screen.queryByText(reference)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(management.modManagementAction).toHaveBeenCalledWith('/api/mod-management/sources', {
      method: 'POST', body: JSON.stringify({ url: 'https://github.com/NightShaman/private.git', auth: { username: 'oauth2', token: reference } }),
    }));
  });

  it('opens discovery when typing a reference prefix and supports keyboard navigation at scale', async () => {
    loadMock.mockResolvedValue({ restartRequired: false, mods: [], sources: [] });
    loadSecretReferencesMock.mockResolvedValue(Array.from({ length: 120 }, (_, index) => ({
      reference: `{{gss:00000000-0000-4000-8000-${String(index).padStart(12, '0')}/token}}`,
      label: `Credential ${String(index).padStart(3, '0')}`,
      type: index === 119 ? 'private-key' : 'token',
      service: index % 2 ? 'GitHub' : 'GitLab',
    })));
    render(<ModsSettings section="sources" />);
    const secret = screen.getByLabelText('Password or access token (optional)');
    await screen.findByRole('button', { name: 'Browse stored credentials' });
    fireEvent.change(secret, { target: { value: '{{' } });
    const search = screen.getByRole('combobox', { name: 'Search stored credentials' });
    expect(screen.getAllByRole('option')).toHaveLength(100);
    expect(screen.getByText('Showing 100 of 119. Refine your search.')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'Credential 118' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByText('Credential 118')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear Credential 118' }));
    expect(screen.queryByText('Credential 118')).toBeNull();
  });

  it('clears a pasted known credential reference from both the chip and submitted auth', async () => {
    const reference = '{{gss:00000000-0000-4000-8000-000000000000/token}}';
    loadMock.mockResolvedValue({ restartRequired: false, mods: [], sources: [] });
    loadSecretReferencesMock.mockResolvedValue([{ reference, label: 'Repository token', type: 'token', username: 'oauth2' }]);
    vi.mocked(management.modManagementAction).mockResolvedValue({ ok: true });
    render(<ModsSettings section="sources" />);
    await screen.findByRole('button', { name: 'Browse stored credentials' });
    fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'https://git.example.com/private.git' } });
    const secret = screen.getByLabelText('Password or access token (optional)') as HTMLInputElement;
    fireEvent.change(secret, { target: { value: reference } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear Repository token' }));
    expect(screen.queryByText('Repository token')).toBeNull();
    expect(secret.value).toBe('');
    expect(document.activeElement).toBe(secret);
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(management.modManagementAction).toHaveBeenCalledWith('/api/mod-management/sources', {
      method: 'POST', body: JSON.stringify({ url: 'https://git.example.com/private.git' }),
    }));
  });

  it('preserves a pasted raw secret reference even when it is not in discovery metadata', async () => {
    loadMock.mockResolvedValue({ restartRequired: false, mods: [], sources: [] });
    vi.mocked(management.modManagementAction).mockResolvedValue({ ok: true });
    render(<ModsSettings section="sources" />);
    const reference = '{{gss:ffffffff-0000-4000-8000-000000000000/token}}';
    fireEvent.change(screen.getByLabelText('Git repository URL'), { target: { value: 'https://git.example.com/private.git' } });
    fireEvent.change(screen.getByLabelText('Password or access token (optional)'), { target: { value: reference } });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() => expect(management.modManagementAction).toHaveBeenCalledWith('/api/mod-management/sources', {
      method: 'POST', body: JSON.stringify({ url: 'https://git.example.com/private.git', auth: { token: reference } }),
    }));
  });

});

function LeaveChecks({ leave }: { leave: () => void }) {
  const navigate = useUnsavedNavigation();
  return <button onClick={() => navigate(leave)}>Leave checks</button>;
}

describe('automatic-check autosave guard', () => {
  beforeEach(() => {
    loadMock.mockResolvedValue({ restartRequired: false, mods: [], sources: [] });
    saveRefreshMock.mockImplementation(async config => config);
  });

  it('does not write on load, unchanged blur, or an equivalent duration', async () => {
    render(<ModsSettings section="automatic-checks" />);
    const interval = await screen.findByLabelText('Check every');
    fireEvent.blur(interval);
    fireEvent.change(interval, { target: { value: '6.0' } });
    fireEvent.blur(interval);
    expect(saveRefreshMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Save automatic checks' })).toBeNull();
  });

  it.each([
    { label: 'Check every', unitLabel: 'Check interval unit', initial: '6', unit: 'minutes', expected: { enabled: true, intervalMs: 120_000, staleMs: 900_000 } },
    { label: 'Consider source stale after', unitLabel: 'Stale threshold unit', initial: '15', unit: 'seconds', expected: { enabled: true, intervalMs: 21_600_000, staleMs: 2_000 } },
  ])('keeps $label and its unit one focus scope before committing the chosen unit', async ({ label, unitLabel, initial, unit, expected }) => {
    let resolve!: (config: management.SourceRefreshConfig) => void;
    saveRefreshMock.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(<><ModsSettings section="automatic-checks" /><button>Outside durations</button></>);
    const input = await screen.findByLabelText(label) as HTMLInputElement;
    const select = screen.getByLabelText(unitLabel) as HTMLSelectElement;
    expect(input.value).toBe(initial);
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '2' } });

    // Native focus() emits blur/focusout with relatedTarget, as Tab or a
    // pointer focus transfer would, before the select's change event.
    fireEvent.pointerDown(select);
    fireEvent.mouseDown(select);
    act(() => select.focus());
    fireEvent.mouseUp(select);
    fireEvent.click(select);
    expect(saveRefreshMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(select);
    expect(select.disabled).toBe(false);

    fireEvent.change(select, { target: { value: unit } });
    expect(saveRefreshMock.mock.calls).toEqual([[expected]]);
    await act(async () => resolve(expected));
    await waitFor(() => expect(select.disabled).toBe(false));
    act(() => screen.getByRole('button', { name: 'Outside durations' }).focus());
    expect(saveRefreshMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'Check every', unitLabel: 'Check interval unit', expected: { enabled: true, intervalMs: 7_200_000, staleMs: 900_000 } },
    { label: 'Consider source stale after', unitLabel: 'Stale threshold unit', expected: { enabled: true, intervalMs: 21_600_000, staleMs: 120_000 } },
  ])('commits $label when focus leaves through the unit without a unit change', async ({ label, unitLabel, expected }) => {
    render(<><ModsSettings section="automatic-checks" /><button>Outside durations</button></>);
    const input = await screen.findByLabelText(label);
    const select = screen.getByLabelText(unitLabel);
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '2' } });
    act(() => select.focus());
    expect(saveRefreshMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(select);
    act(() => screen.getByRole('button', { name: 'Outside durations' }).focus());
    expect(saveRefreshMock.mock.calls).toEqual([[expected]]);
    await screen.findByText('Automatic source checks saved.');
  });

  it.each([
    { label: 'Check every', unitLabel: 'Check interval unit', expected: { enabled: true, intervalMs: 7_200_000, staleMs: 900_000 } },
    { label: 'Consider source stale after', unitLabel: 'Stale threshold unit', expected: { enabled: true, intervalMs: 21_600_000, staleMs: 120_000 } },
  ])('keeps reverse unit-to-number focus internal and saves $label on native blur', async ({ label, unitLabel, expected }) => {
    render(<ModsSettings section="automatic-checks" />);
    const input = await screen.findByLabelText(label) as HTMLInputElement;
    const select = screen.getByLabelText(unitLabel);
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '2' } });
    act(() => select.focus());
    act(() => input.focus());
    expect(saveRefreshMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    act(() => input.blur());
    expect(saveRefreshMock.mock.calls).toEqual([[expected]]);
    await screen.findByText('Automatic source checks saved.');
  });

  it('blocks navigation while saving and preserves a failed draft for guard Save and retry', async () => {
    let reject!: (cause: Error) => void;
    saveRefreshMock.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const leave = vi.fn();
    render(<UnsavedChangesProvider><ModsSettings section="automatic-checks" /><LeaveChecks leave={leave} /></UnsavedChangesProvider>);
    const enabled = await screen.findByRole('checkbox');
    fireEvent.click(enabled);
    expect((enabled as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Leave checks'));
    expect(leave).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await act(async () => reject(new Error('offline')));
    expect((enabled as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('alert').textContent).toContain('offline');
    expect(screen.getByRole('button', { name: 'Retry saving automatic checks' })).toBeTruthy();
    fireEvent.click(screen.getByText('Leave checks'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
    expect(saveRefreshMock).toHaveBeenCalledTimes(2);
    expect(saveRefreshMock).toHaveBeenLastCalledWith({ enabled: false, intervalMs: 21_600_000, staleMs: 900_000 });
  });

  it('does not leave when guard Save fails; Discard restores the confirmed baseline', async () => {
    saveRefreshMock.mockRejectedValue(new Error('offline'));
    const leave = vi.fn();
    render(<UnsavedChangesProvider><ModsSettings section="automatic-checks" /><LeaveChecks leave={leave} /></UnsavedChangesProvider>);
    const interval = await screen.findByLabelText('Check every');
    fireEvent.change(interval, { target: { value: '2' } });
    expect(saveRefreshMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Leave checks'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(leave).not.toHaveBeenCalled();
    expect((interval as HTMLInputElement).value).toBe('2');
    fireEvent.click(screen.getByText('Leave checks'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(leave).toHaveBeenCalledTimes(1);
    expect((interval as HTMLInputElement).value).toBe('6');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps invalid drafts guarded without issuing a write', async () => {
    const leave = vi.fn();
    render(<UnsavedChangesProvider><ModsSettings section="automatic-checks" /><LeaveChecks leave={leave} /></UnsavedChangesProvider>);
    const interval = await screen.findByLabelText('Check every');
    fireEvent.change(interval, { target: { value: '' } });
    fireEvent.blur(interval);
    fireEvent.click(screen.getByText('Leave checks'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('alert').textContent).toContain('positive whole durations');
    expect(saveRefreshMock).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  });

  it('clears a failure when toggled back to baseline without writing again', async () => {
    saveRefreshMock.mockRejectedValue(new Error('offline'));
    const leave = vi.fn();
    render(<UnsavedChangesProvider><ModsSettings section="automatic-checks" /><LeaveChecks leave={leave} /></UnsavedChangesProvider>);
    const enabled = await screen.findByRole('checkbox');
    fireEvent.click(enabled);
    await screen.findByRole('alert');
    fireEvent.click(enabled);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry saving automatic checks' })).toBeNull();
    expect(screen.queryByText('Automatic source checks saved.')).toBeNull();
    expect(saveRefreshMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Leave checks'));
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('offers retry after a write failure and adopts the confirmed server response', async () => {
    saveRefreshMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ enabled: false, intervalMs: 7_200_000, staleMs: 60_000 });
    render(<ModsSettings section="automatic-checks" />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry saving automatic checks' }));
    await screen.findByText('Automatic source checks saved.');
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false));
    expect((screen.getByLabelText('Check every') as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('Consider source stale after') as HTMLInputElement).value).toBe('1');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveRefreshMock).toHaveBeenCalledTimes(2);
  });

  it('does not treat a failed catalog reload as an unconfirmed settings write', async () => {
    loadMock.mockResolvedValueOnce({ restartRequired: false, mods: [], sources: [] }).mockRejectedValueOnce(new Error('catalog offline'));
    const leave = vi.fn();
    render(<UnsavedChangesProvider><ModsSettings section="automatic-checks" /><LeaveChecks leave={leave} /></UnsavedChangesProvider>);
    fireEvent.click(await screen.findByRole('checkbox'));
    await screen.findByText('Automatic source checks saved.');
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false));
    expect(screen.getByRole('alert').textContent).toContain('saved, but the catalog could not be refreshed');
    fireEvent.click(screen.getByText('Leave checks'));
    expect(leave).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry saving automatic checks' })).toBeNull();
  });

  it('does not expose editable defaults after a failed read, and retries safely', async () => {
    loadRefreshMock.mockRejectedValueOnce(new Error('read offline'));
    render(<ModsSettings section="automatic-checks" />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByLabelText('Check every')).toBeNull();
    expect(saveRefreshMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry settings' }));
    await screen.findByRole('checkbox');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(saveRefreshMock).not.toHaveBeenCalled();
  });

  it('ignores an obsolete read after leaving and reopening the section', async () => {
    let resolve!: (config: management.SourceRefreshConfig) => void;
    loadRefreshMock.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const { rerender } = render(<ModsSettings section="automatic-checks" />);
    rerender(<ModsSettings section="installed" />);
    rerender(<ModsSettings section="automatic-checks" />);
    await screen.findByRole('checkbox');
    await act(async () => resolve({ enabled: false, intervalMs: 1000, staleMs: 1000 }));
    expect((screen.getByLabelText('Check every') as HTMLInputElement).value).toBe('6');
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  });
});

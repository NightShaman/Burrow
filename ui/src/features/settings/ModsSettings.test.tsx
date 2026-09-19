import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModsSettings } from './ModsSettings';
import * as management from './modManagementApi';

vi.mock('./modManagementApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./modManagementApi')>();
  return { ...actual, loadModManagement: vi.fn(), modManagementAction: vi.fn() };
});

const loadMock = vi.mocked(management.loadModManagement);

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ModsSettings layout contract', () => {
  it('keeps selected mod configuration in column 3 and the catalog in column 4', async () => {
    loadMock.mockResolvedValue({ restartRequired: false, sources: [], mods: [
      { id: 'alpha', name: 'Alpha', status: 'installed', enabled: true, version: '1.0.0', system: true },
      { id: 'beta', name: 'Beta', status: 'available', latestVersion: '2.0.0' },
    ] });
    const overflow = document.createElement('section');
    document.body.appendChild(overflow);
    const { container } = render(<ModsSettings section="installed" overflowTarget={overflow} />);
    await waitFor(() => expect(container.textContent).toContain('Manage installation, version, and availability'));
    expect(container.querySelector('.mod-configuration')).toBeTruthy();
    expect(container.querySelector('.mod-configuration.setting-section')).toBeTruthy();
    expect(overflow.textContent).toContain('Alpha');
    expect(overflow.textContent).not.toContain('Core');
    expect(overflow.querySelector('[aria-label="System mod"]')).toBeTruthy();
    expect(overflow.querySelector('.memory-connection.selected')).toBeNull();
    expect(container.textContent).not.toContain('Beta');
    expect(screen.queryByRole('button', { name: 'Refresh catalog' })).toBeNull();
    expect(overflow.getAttribute('aria-label')).toBeNull();
    expect(overflow.querySelector('[aria-label="Mod catalog"]')?.textContent).toContain('Beta');
    fireEvent.click(screen.getAllByRole('button', { name: 'Manage' })[1]);
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
    const current = screen.getByLabelText('Current version') as HTMLInputElement;
    const latest = screen.getByLabelText('Latest version') as HTMLInputElement;
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
    expect((screen.getByLabelText('Current version') as HTMLInputElement).value).toBe(status === 'installed' ? 'Unknown' : 'Not installed');
    fireEvent.click(button);
    expect(management.modManagementAction).not.toHaveBeenCalled();
  });
});


describe('Git mod sources', () => {
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
});

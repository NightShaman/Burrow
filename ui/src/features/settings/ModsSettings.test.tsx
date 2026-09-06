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
    expect(container.querySelector('input[placeholder="https://example.invalid/mods.json"]')).toBeTruthy();
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

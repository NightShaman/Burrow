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
    expect(container.querySelector('.mod-configuration.setting-section')).toBeNull();
    expect(overflow.textContent).toContain('Alpha');
    expect(overflow.textContent).not.toContain('Core');
    expect(overflow.querySelector('[aria-label="System mod"]')).toBeTruthy();
    expect(overflow.querySelector('.memory-connection.selected')).toBeNull();
    expect(container.textContent).not.toContain('Beta');
    expect(overflow.getAttribute('aria-label')).toBeNull();
    expect(overflow.querySelector('[aria-label="Mod catalog"]')?.textContent).toContain('Beta');
    fireEvent.click(screen.getAllByRole('button', { name: 'Manage' })[1]);
    expect(container.textContent).toContain('Beta');
    overflow.remove();
  });

  it('keeps source configuration in column 3 and configured sources in column 4', async () => {
    loadMock.mockResolvedValue({ restartRequired: false, mods: [], sources: [{ id: 'source-1', url: 'https://mods.example/catalog.json', status: 'Ready' }] });
    const overflow = document.createElement('section');
    document.body.appendChild(overflow);
    const { container } = render(<ModsSettings section="sources" overflowTarget={overflow} />);
    await waitFor(() => expect(overflow.textContent).toContain('mods.example'));
    expect(container.querySelector('input[placeholder="https://example.invalid/mods.json"]')).toBeTruthy();
    expect(container.querySelector('.mod-source-configuration')).toBeTruthy();
    expect(container.querySelector('.mod-source-configuration.setting-section')).toBeNull();
    expect(container.textContent).not.toContain('mods.example');
    expect(overflow.querySelector('[aria-label="Configured mod sources"]')?.textContent).toContain('Ready');
    overflow.remove();
  });
});

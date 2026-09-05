import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { ApiTokensSettings } from './ApiTokensSettings';

vi.mock('../../app/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../app/api')>()), api: vi.fn() }));
const apiMock = vi.mocked(api);
afterEach(cleanup);

describe('ApiTokensSettings', () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue({ ok: true, supportedScopes: ['diagnostics:read'], tokens: [] });
  });

  it('loads metadata and creates a token with a one-time reveal', async () => {
    render(<ConfirmProvider><ApiTokensSettings /></ConfirmProvider>);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/settings/api-tokens'));
    fireEvent.change(screen.getByLabelText('Token name'), { target: { value: 'Dashboard' } });
    apiMock.mockResolvedValueOnce({ ok: true, token: { id: 'tok-1', name: 'Dashboard', scopes: ['diagnostics:read'], token: 'secret-once', createdAt: '2026-01-01T00:00:00Z' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create API token' }));
    expect(await screen.findByDisplayValue('secret-once')).toBeTruthy();
    expect(screen.getByText(/shown only once/i)).toBeTruthy();
    expect(localStorage.getItem('secret-once')).toBeNull();
  });

  it('revokes a token through the DELETE contract', async () => {
    apiMock.mockResolvedValueOnce({ ok: true, supportedScopes: ['diagnostics:read'], tokens: [{ id: 'tok-1', name: 'Old token', scopes: ['diagnostics:read'], revokedAt: null }] });
    render(<ConfirmProvider><ApiTokensSettings /></ConfirmProvider>);
    expect(await screen.findByText('Old token')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/settings/api-tokens/tok-1', { method: 'DELETE' }));
    expect(await screen.findByText(/Revoked/)).toBeTruthy();
  });
});

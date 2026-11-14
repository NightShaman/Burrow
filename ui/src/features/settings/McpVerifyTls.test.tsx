import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { UnsavedChangesProvider } from '../../app/UnsavedChanges';
import { McpConnections } from './McpConnections';

vi.mock('../../app/api', async (original) => ({
  ...(await original<typeof import('../../app/api')>()),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.mocked(api).mockReset();
});
const connection = {
  id: 'technitium',
  name: 'Technitium',
  transport: 'http',
  lifecycle: 'ephemeral',
  baseUrl: 'https://dns.example.test/mcp',
  command: null,
  args: [],
  tools: [],
  apiKeyConfigured: true,
  headerNames: ['X-Token'],
  environmentVariables: [],
  enabled: true,
};
function mount() {
  render(
    <ConfirmProvider>
      <UnsavedChangesProvider>
        <McpConnections />
      </UnsavedChangesProvider>
    </ConfirmProvider>,
  );
}
const toggle = () =>
  screen.getByRole('switch', { name: 'Verify TLS certificate' }) as HTMLInputElement;
const writes = () => vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'POST');
const saved = () => JSON.parse(String(writes()[0]?.[1]?.body));
async function edit(verifyTls?: boolean) {
  vi.mocked(api).mockResolvedValue({
    connections: [{ ...connection, ...(verifyTls === undefined ? {} : { verifyTls }) }],
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Technitium' }));
}

describe('MCP TLS certificate verification', () => {
  it('defaults new HTTP connections on, saves true, and resets to on after saving false', async () => {
    vi.mocked(api).mockResolvedValue({ connections: [] });
    mount();
    await screen.findByText('No MCP servers saved yet.');
    expect(toggle().checked).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New MCP' } });
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: connection.baseUrl },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add MCP server' }));
    await waitFor(() => expect(saved().verifyTls).toBe(true));
    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(''));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New MCP' } });
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: connection.baseUrl },
    });
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Add MCP server' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(JSON.parse(String(writes()[1][1]?.body)).verifyTls).toBe(false);
    await waitFor(() => expect(toggle().checked).toBe(true));
  });

  it.each([undefined, true, false])(
    'loads saved %s without creating a dirty draft, and preserves it on unrelated saves',
    async (value) => {
      await edit(value);
      expect(toggle().checked).toBe(value !== false);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Edit Technitium' }));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(saved().verifyTls).toBe(value !== false));
      expect(saved().headers).toEqual({ 'X-Token': null });
      expect(saved()).not.toHaveProperty('apiKey');
    },
  );

  it('warns only while off; toggle-only edits use the shared dirty guard and discard restores on', async () => {
    await edit();
    fireEvent.click(toggle());
    const warning = screen.getByRole('status');
    expect(warning.textContent).toContain('impersonated');
    expect(toggle().getAttribute('aria-describedby')).toBe(warning.id);
    expect(writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(toggle().checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(toggle().checked).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('saves false, reads it back on reopening, then allows re-enabling verification', async () => {
    let current = { ...connection, verifyTls: true };
    vi.mocked(api).mockImplementation(async (_path, init) => {
      if (init?.method === 'POST') current = { ...current, ...JSON.parse(String(init.body)) };
      return { connections: [current] } as never;
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Technitium' }));
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add MCP server' })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Technitium' }));
    expect(toggle().checked).toBe(false);
    fireEvent.click(toggle());
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(current.verifyTls).toBe(true));
  });

  it('retains off draft on failed save and saved-but-refresh-failed; locks toggle during save and refresh retry', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ connections: [connection] })
      .mockRejectedValueOnce(new Error('save offline'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Technitium' }));
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByRole('alert')).textContent).toContain('save offline');
    expect(toggle().checked).toBe(false);
    let resolve!: (value: unknown) => void;
    vi.mocked(api)
      .mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      )
      .mockRejectedValueOnce(new Error('refresh offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(toggle().disabled).toBe(true);
    resolve({ ok: true });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('saved, but could not refresh'),
    );
    expect(toggle().disabled).toBe(true);
    expect(toggle().checked).toBe(false);
    vi.mocked(api).mockResolvedValue({ connections: [{ ...connection, verifyTls: false }] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    await waitFor(() => expect(toggle().disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Technitium' }));
    expect(toggle().checked).toBe(false);
  });

  it('hides HTTP policy for stdio, omits it from stdio writes, and restores the draft on switching back', async () => {
    await edit(false);
    fireEvent.change(screen.getByLabelText('Transport'), { target: { value: 'stdio' } });
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.change(screen.getByLabelText('Transport'), { target: { value: 'http' } });
    expect(toggle().checked).toBe(false);
    fireEvent.change(screen.getByLabelText('Transport'), { target: { value: 'stdio' } });
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(saved().command).toBe('npx'));
    expect(saved()).not.toHaveProperty('verifyTls');
  });

  it('discovery still uses saved ID without saving a changed TLS draft and preserves it on error', async () => {
    await edit(false);
    fireEvent.click(toggle());
    vi.mocked(api).mockRejectedValueOnce(new Error('discovery failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Discover tools' }));
    expect((await screen.findByRole('alert')).textContent).toContain('discovery failed');
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe('/api/settings/mcp-connections/discover');
    expect(saved()).toEqual({ connectionId: connection.id });
    expect(toggle().checked).toBe(true);
  });
});

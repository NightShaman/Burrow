import { describe, expect, it } from 'vitest';
import { serializeEnvironmentVariables } from './McpConnections';

describe('serializeEnvironmentVariables', () => {
  it('sends a newly entered MCP secret', () => {
    expect(serializeEnvironmentVariables([{ name: 'BW_SESSION', value: 'opaque-session-token', configured: false }])).toEqual([
      { name: 'BW_SESSION', value: 'opaque-session-token' },
    ]);
  });

  it('omits blank new rows while retaining configured rows without their secret', () => {
    expect(serializeEnvironmentVariables([
      { name: '', value: '', configured: false },
      { name: 'NEW_SECRET', value: '', configured: false },
      { name: 'EXISTING_SECRET', value: '', configured: true },
    ])).toEqual([{ name: 'EXISTING_SECRET' }]);
  });
});


import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { api } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { isModManagedMcpConnection, McpConnections } from './McpConnections';

vi.mock('../../app/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../app/api')>()), api: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(api).mockReset(); });

describe('mod-managed MCP providers', () => {
  it('identifies mod-managed connections by server-reported transport alone', () => {
    expect(isModManagedMcpConnection({ transport: 'mod' })).toBe(true);
    expect(isModManagedMcpConnection({ transport: 'http' })).toBe(false);
  });
});

describe('MCP server inventory', () => {
  it('renders stdio arguments as a styled multiline settings control', async () => {
    vi.mocked(api).mockResolvedValue({ connections: [] });
    render(<ConfirmProvider><McpConnections /></ConfirmProvider>);
    fireEvent.change(screen.getByLabelText('Transport'), { target: { value: 'stdio' } });
    const argumentsField = screen.getByLabelText('Arguments') as HTMLTextAreaElement;
    expect(argumentsField.classList.contains('mcp-arguments')).toBe(true);
    expect(argumentsField.rows).toBe(4);
    fireEvent.change(argumentsField, { target: { value: '-y\nserver-name' } });
    expect(argumentsField.value).toBe('-y\nserver-name');
  });

  it('shows mod-owned providers as read-only without edit, discover, or delete controls', async () => {
    vi.mocked(api).mockResolvedValue({ connections: [{ id: 'mod.lore', name: 'Lore tools', transport: 'mod', lifecycle: 'keep_alive', baseUrl: 'mod://lore', args: [], apiKeyConfigured: false, environmentVariables: [], tools: [{ name: 'search' }] }] });
    render(<ConfirmProvider><McpConnections /></ConfirmProvider>);
    expect(await screen.findByText('Mod managed · Read only')).toBeTruthy();
    expect(screen.getByText(/Managed by mod/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit Lore tools' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discover tools' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Lore tools' })).toBeNull();
  });

  it('opens a column-4 server card in the column-3 editor without Edit or Diagnose', async () => {
    vi.mocked(api).mockResolvedValue({ connections: [
      { id: 'alpha', name: 'Alpha', transport: 'http', lifecycle: 'ephemeral', baseUrl: 'https://alpha.example/mcp', args: [], apiKeyConfigured: false, environmentVariables: [], tools: [] },
      { id: 'beta', name: 'Beta', transport: 'http', lifecycle: 'keep_alive', baseUrl: 'https://beta.example/mcp', args: [], apiKeyConfigured: false, environmentVariables: [], tools: [] },
    ] });
    const overflow = document.createElement('section');
    document.body.appendChild(overflow);
    const { container } = render(<ConfirmProvider><McpConnections overflowTarget={overflow} /></ConfirmProvider>);
    await waitFor(() => expect(overflow.textContent).toContain('Beta'));
    expect(container.textContent).not.toContain('Beta');
    expect(overflow.querySelectorAll('.memory-connection')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Diagnose' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Beta' }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Beta');
    expect((screen.getByLabelText('Server URL') as HTMLInputElement).value).toBe('https://beta.example/mcp');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit Beta' }).getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.memory-connection-list')).toBeNull();
    overflow.remove();
  });
});

it('keeps environment name focus and row identity while typing and deleting a preceding row', async () => {
 vi.mocked(api).mockResolvedValue({ connections: [] });
 render(<ConfirmProvider><McpConnections /></ConfirmProvider>);
 fireEvent.change(screen.getByLabelText('Transport'), { target: { value: 'stdio' } });
 fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
 fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
 const first = screen.getByLabelText('Environment variable 1 name');
 first.focus(); fireEvent.change(first, { target: { value: 'B' } });
 expect(document.activeElement).toBe(first);
 fireEvent.change(first, { target: { value: 'BW_SESSION' } });
 const second = screen.getByLabelText('Environment variable 2 name');
 fireEvent.change(second, { target: { value: 'SECOND' } });
 fireEvent.click(screen.getByRole('button', { name: /Remove.*BW_SESSION/ }));
 expect(screen.getByLabelText('Environment variable 1 name')).toBe(second);
});

describe('MCP inventory failures', () => {
  it('does not describe a failed initial read as an empty inventory; retry recovers', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ connections: [] });
    render(<ConfirmProvider><McpConnections /></ConfirmProvider>);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('offline'));
    expect(screen.queryByText('No MCP servers saved yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No MCP servers saved yet.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retains draft and reports saved-but-refresh-failed, disabling duplicate save until retry', async () => {
    vi.mocked(api).mockResolvedValueOnce({ connections: [] }).mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('refresh offline')).mockResolvedValueOnce({ connections: [] });
    render(<ConfirmProvider><McpConnections /></ConfirmProvider>);
    await screen.findByText('No MCP servers saved yet.');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Draft' } });
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://example.test/mcp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add MCP server' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('saved, but could not refresh'));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Draft');
    expect((screen.getByRole('button', { name: 'Add MCP server' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(''));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('MCP save lifecycle audit', () => {
  const connection = { id: 'reference', name: 'Reference MCP', transport: 'http', lifecycle: 'ephemeral', baseUrl: 'https://reference.invalid/mcp', args: [], apiKeyConfigured: false, environmentVariables: [], tools: [] };
  async function editReference() {
    render(<ConfirmProvider><McpConnections /></ConfirmProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Reference MCP' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Changed MCP' } });
  }

  it('retains the selected editor and draft after a failed mutation', async () => {
    vi.mocked(api).mockResolvedValueOnce({ connections: [connection] }).mockRejectedValueOnce(new Error('offline'));
    await editReference();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not save MCP connection: offline');
    expect(screen.getByDisplayValue('Changed MCP')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit Reference MCP' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('locks editor and selection during save, prevents repeat submit, and resets only after refresh', async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>(done => { resolve = done; });
    vi.mocked(api).mockResolvedValueOnce({ connections: [connection] }).mockReturnValueOnce(pending).mockResolvedValue({ connections: [{ ...connection, name: 'Changed MCP' }] });
    await editReference();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const saving = screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement;
    expect(saving.disabled).toBe(true);
    expect((screen.getByLabelText('Name') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Edit Reference MCP' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(saving);
    expect(vi.mocked(api)).toHaveBeenCalledTimes(2);
    resolve({ ok: true });
    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(''));
    expect(screen.getByRole('button', { name: 'Edit Changed MCP' })).toBeTruthy();
  });

  it('discovery uses the saved id, not the editor draft, and preserves that draft', async () => {
    vi.mocked(api).mockResolvedValue({ connections: [connection] });
    await editReference();
    fireEvent.click(screen.getByRole('button', { name: 'Discover tools' }));
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledTimes(3));
    const mutation = vi.mocked(api).mock.calls.find(([path]) => path.endsWith('/discover'));
    expect(JSON.parse(String(mutation?.[1]?.body))).toEqual({ connectionId: 'reference' });
    expect(screen.getByDisplayValue('Changed MCP')).toBeTruthy();
    expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
});

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

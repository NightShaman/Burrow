import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { AgentMcpTools } from './AgentMcpTools';

vi.mock('../../app/api', async original => ({ ...(await original<typeof import('../../app/api')>()), api: vi.fn() }));
const apiMock = vi.mocked(api);

const connection = {
  id: 'server', name: 'Server', transport: 'http' as const, baseUrl: 'http://server', command: null, args: [], enabled: true, apiKeyConfigured: false,
  tools: [{ name: 'alpha' }, { name: 'beta' }],
};

function Destination() {
  const navigate = useUnsavedNavigation();
  return <button onClick={() => navigate(() => document.body.setAttribute('data-left', 'yes'))}>Leave settings</button>;
}

function putBodies() {
  return apiMock.mock.calls
    .filter(([path, init]) => path.endsWith('/mcp-tools') && init?.method === 'PUT')
    .map(([, init]) => JSON.parse(init!.body as string));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

afterEach(() => { cleanup(); vi.resetAllMocks(); document.body.removeAttribute('data-left'); });

it('autosaves a tool toggle as the complete accepted grant set without a Save button', async () => {
  apiMock.mockImplementation((path, init) => {
    if (init?.method === 'PUT') return Promise.resolve({ ok: true, agentId: 'smatchet', ...JSON.parse(init.body as string) });
    if (path === '/api/settings/mcp-connections') return Promise.resolve({ connections: [connection] });
    return Promise.resolve({ tools: [{ connectionId: 'server', toolName: 'alpha', enabled: true }] });
  });
  render(<AgentMcpTools agentId="smatchet" />);

  const beta = await screen.findByRole('checkbox', { name: 'beta' });
  expect(screen.queryByRole('button', { name: 'Save MCP tools' })).toBeNull();
  fireEvent.click(beta);

  await waitFor(() => expect(putBodies()).toEqual([{ tools: [
    { connectionId: 'server', toolName: 'alpha', enabled: true },
    { connectionId: 'server', toolName: 'beta', enabled: true },
  ] }]));
  await waitFor(() => expect((beta as HTMLInputElement).disabled).toBe(false));
});

it('keeps a failed grant draft guarded, saves an unrelated toggle from the accepted set, and retries only the failed change', async () => {
  let writes = 0;
  apiMock.mockImplementation((path, init) => {
    if (init?.method === 'PUT') return ++writes === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ ok: true, agentId: 'smatchet', ...JSON.parse(init.body as string) });
    if (path === '/api/settings/mcp-connections') return Promise.resolve({ connections: [connection] });
    return Promise.resolve({ tools: [{ connectionId: 'server', toolName: 'alpha', enabled: true }] });
  });
  render(<UnsavedChangesProvider><AgentMcpTools agentId="smatchet" /><Destination /></UnsavedChangesProvider>);

  const alpha = await screen.findByRole('checkbox', { name: 'alpha' });
  const beta = screen.getByRole('checkbox', { name: 'beta' });
  fireEvent.click(alpha);
  await screen.findByText('Could not save MCP tools: offline');
  expect((alpha as HTMLInputElement).checked).toBe(false);

  fireEvent.click(screen.getByText('Leave settings'));
  expect(screen.getByText('Unsaved changes')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
  expect(document.body.getAttribute('data-left')).toBeNull();
  expect((alpha as HTMLInputElement).checked).toBe(false);

  fireEvent.click(beta);
  await waitFor(() => expect(putBodies()).toHaveLength(2));
  expect(putBodies()[1]).toEqual({ tools: [
    { connectionId: 'server', toolName: 'alpha', enabled: true },
    { connectionId: 'server', toolName: 'beta', enabled: true },
  ] });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry failed MCP tool changes' }).getAttribute('disabled')).toBeNull());

  fireEvent.click(screen.getByRole('button', { name: 'Retry failed MCP tool changes' }));
  await waitFor(() => expect(putBodies()).toHaveLength(3));
  expect(putBodies()[2]).toEqual({ tools: [{ connectionId: 'server', toolName: 'beta', enabled: true }] });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry failed MCP tool changes' })).toBeNull());
});

it('resumes navigation queued behind an acknowledged grant autosave', async () => {
  const write = deferred<{ ok: true; agentId: string; tools: { connectionId: string; toolName: string; enabled: boolean }[] }>();
  apiMock.mockImplementation((path, init) => {
    if (init?.method === 'PUT') return write.promise;
    if (path === '/api/settings/mcp-connections') return Promise.resolve({ connections: [connection] });
    return Promise.resolve({ tools: [] });
  });
  render(<UnsavedChangesProvider><AgentMcpTools agentId="smatchet" /><Destination /></UnsavedChangesProvider>);
  fireEvent.click(await screen.findByRole('checkbox', { name: 'beta' }));
  fireEvent.click(screen.getByText('Leave settings'));
  expect(document.body.getAttribute('data-left')).toBeNull();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  await act(async () => write.resolve({ ok: true, agentId: 'smatchet', tools: [{ connectionId: 'server', toolName: 'beta', enabled: true }] }));
  await waitFor(() => expect(document.body.getAttribute('data-left')).toBe('yes'));
  expect(putBodies()).toHaveLength(1);
});

it('does not let an old agent autosave completion take ownership of the current agent draft', async () => {
  const oldSave = deferred<object>();
  apiMock.mockImplementation((path, init) => {
    if (init?.method === 'PUT') return oldSave.promise;
    if (path === '/api/settings/mcp-connections') return Promise.resolve({ connections: [connection] });
    return Promise.resolve({ tools: [] });
  });
  const view = render(<AgentMcpTools agentId="a" />);
  const beta = await screen.findByRole('checkbox', { name: 'beta' });
  fireEvent.click(beta);
  await waitFor(() => expect(putBodies()).toHaveLength(1));

  view.rerender(<AgentMcpTools agentId="node-1::b" />);
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'beta' }) as HTMLInputElement).disabled).toBe(false));
  expect((screen.getByRole('checkbox', { name: 'beta' }) as HTMLInputElement).checked).toBe(false);
  await act(async () => { oldSave.resolve({ ok: true, agentId: 'a', tools: [{ connectionId: 'server', toolName: 'beta', enabled: true }] }); });
  expect((screen.getByRole('checkbox', { name: 'beta' }) as HTMLInputElement).checked).toBe(false);
});

it('preserves enabled and disabled undiscovered grants and historical mod grants across toggles and retry', async () => {
  const preserved = [
    { connectionId: 'server', toolName: 'undiscovered', enabled: true },
    { connectionId: 'server', toolName: 'disabled-undiscovered', enabled: false },
    { connectionId: 'missing-server', toolName: 'hidden', enabled: true },
    { connectionId: 'missing-server', toolName: 'disabled-hidden', enabled: false },
    { connectionId: 'mod', toolName: 'managed', enabled: false },
  ];
  let writes = 0;
  apiMock.mockImplementation((path, init) => {
    if (init?.method === 'PUT') {
      if (++writes === 1) return Promise.reject(new Error('offline'));
      return Promise.resolve({ ok: true, agentId: 'smatchet', tools: JSON.parse(init.body as string).tools.toReversed().map((tool: object) => ({ ...tool, connectionName: 'Backend name' })) });
    }
    if (path === '/api/settings/mcp-connections') return Promise.resolve({ connections: [connection, { ...connection, id: 'mod', transport: 'mod', tools: [{ name: 'managed', availability: 'mod-authorized' }] }] });
    return Promise.resolve({ tools: [...preserved, { connectionId: 'server', toolName: 'alpha', enabled: true }] });
  });
  render(<UnsavedChangesProvider><AgentMcpTools agentId="smatchet" /><Destination /></UnsavedChangesProvider>);
  const beta = await screen.findByRole('checkbox', { name: 'beta' });
  fireEvent.click(beta);
  await screen.findByText('Could not save MCP tools: offline');
  fireEvent.click(screen.getByRole('button', { name: 'Retry failed MCP tool changes' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry failed MCP tool changes' })).toBeNull());
  fireEvent.click(screen.getByRole('checkbox', { name: /Clear all/ }));
  await waitFor(() => expect(putBodies()).toHaveLength(3));
  expect(putBodies()[0]).toEqual({ tools: [...preserved,
    { connectionId: 'server', toolName: 'alpha', enabled: true },
    { connectionId: 'server', toolName: 'beta', enabled: true },
  ] });
  expect(putBodies()[1]).toEqual(putBodies()[0]);
  expect(putBodies()[2]).toEqual({ tools: preserved });
  await waitFor(() => expect((beta as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(screen.getByText('Leave settings'));
  expect(document.body.getAttribute('data-left')).toBe('yes');
});

it.each([
  ['empty object', {}],
  ['null', null],
  ['ok-only', { ok: true }],
  ['wrong agent', { ok: true, agentId: 'other', tools: [{ connectionId: 'server', toolName: 'beta', enabled: true }] }],
  ['negative acknowledgement', { ok: false, agentId: 'smatchet', tools: [{ connectionId: 'server', toolName: 'beta', enabled: true }] }],
  ['missing tools', { ok: true, agentId: 'smatchet' }],
  ['malformed row', { ok: true, agentId: 'smatchet', tools: [{ connectionId: 'server', toolName: 'beta', enabled: 'true' }] }],
  ['mismatched grant set', { ok: true, agentId: 'smatchet', tools: [] }],
  ['wrong tool', { ok: true, agentId: 'smatchet', tools: [{ connectionId: 'server', toolName: 'alpha', enabled: true }] }],
  ['wrong enabled value', { ok: true, agentId: 'smatchet', tools: [{ connectionId: 'server', toolName: 'beta', enabled: false }] }],
])('treats a malformed 200 (%s) as failure, retaining the draft, error, navigation guard and retry', async (_name, response) => {
  let writes = 0;
  apiMock.mockImplementation((path, init) => {
    if (init?.method === 'PUT') return Promise.resolve(++writes === 1 ? response : { ok: true, agentId: 'smatchet', ...JSON.parse(init.body as string) });
    if (path === '/api/settings/mcp-connections') return Promise.resolve({ connections: [connection] });
    return Promise.resolve({ tools: [] });
  });
  render(<UnsavedChangesProvider><AgentMcpTools agentId="smatchet" /><Destination /></UnsavedChangesProvider>);
  const beta = await screen.findByRole('checkbox', { name: 'beta' });
  fireEvent.click(beta);
  await screen.findByText('Could not save MCP tools: Invalid MCP tool save acknowledgement. Retry the change.');
  expect((beta as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByText('Leave settings'));
  expect(screen.getByText('Unsaved changes')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
  expect(document.body.getAttribute('data-left')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry failed MCP tool changes' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(putBodies()).toEqual([
    { tools: [{ connectionId: 'server', toolName: 'beta', enabled: true }] },
    { tools: [{ connectionId: 'server', toolName: 'beta', enabled: true }] },
  ]);
  fireEvent.click(screen.getByText('Leave settings'));
  expect(document.body.getAttribute('data-left')).toBe('yes');
});

it('does not advance the accepted set after a malformed acknowledgement before another toggle', async () => {
  let writes = 0;
  apiMock.mockImplementation((path, init) => {
    if (init?.method === 'PUT') return Promise.resolve(++writes === 1 ? {} : { ok: true, agentId: 'smatchet', ...JSON.parse(init.body as string) });
    if (path === '/api/settings/mcp-connections') return Promise.resolve({ connections: [connection] });
    return Promise.resolve({ tools: [{ connectionId: 'server', toolName: 'alpha', enabled: true }] });
  });
  render(<AgentMcpTools agentId="smatchet" />);
  fireEvent.click(await screen.findByRole('checkbox', { name: 'alpha' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('checkbox', { name: 'beta' }));
  await waitFor(() => expect(putBodies()).toHaveLength(2));
  expect(putBodies()[1]).toEqual({ tools: [
    { connectionId: 'server', toolName: 'alpha', enabled: true },
    { connectionId: 'server', toolName: 'beta', enabled: true },
  ] });
  await screen.findByText('Could not save some MCP tool changes. Retry them before leaving settings.');
});

it('accepts the backend resource agent ID for a qualified agent and rejects acknowledgements dropping preserved rows', async () => {
  const hidden = { connectionId: 'server', toolName: 'undiscovered', enabled: false };
  let writes = 0;
  apiMock.mockImplementation((path, init) => {
    if (init?.method === 'PUT') {
      const tools = JSON.parse(init.body as string).tools;
      return Promise.resolve({ ok: true, agentId: 'smatchet', tools: ++writes === 1 ? tools.filter((tool: { toolName: string }) => tool.toolName !== 'undiscovered') : tools });
    }
    if (path === '/api/settings/mcp-connections') return Promise.resolve({ connections: [connection] });
    return Promise.resolve({ tools: [hidden] });
  });
  render(<AgentMcpTools agentId="node-1::smatchet" />);
  fireEvent.click(await screen.findByRole('checkbox', { name: 'beta' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Retry failed MCP tool changes' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(putBodies()).toEqual(Array(2).fill({ tools: [hidden, { connectionId: 'server', toolName: 'beta', enabled: true }] }));
  expect(apiMock.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([path]) => path)).toEqual(Array(2).fill('/api/agents/smatchet/mcp-tools'));
});

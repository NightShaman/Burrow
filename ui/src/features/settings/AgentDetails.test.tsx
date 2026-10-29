import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import type { Agent } from '../../app/types';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { AgentSettings } from './AgentSettings';
import { optimizeAvatar } from './OperatorProfile';

vi.mock('../../app/api', () => ({ api: vi.fn() }));
vi.mock('./OperatorProfile', () => ({ optimizeAvatar: vi.fn() }));
vi.mock('./DefaultMinionModel', () => ({ DefaultMinionModel: () => null }));
vi.mock('./MinionDepthSettings', () => ({ MinionDepthSettings: () => null }));
const agent = { id: 'ui-a', resourceId: 'node::a', name: 'Alpha', avatar: 'data:image/png;base64,AA', enabled: true, activity: 'Idle' } as Agent;
const registryOnlyAgent = { ...agent, id: 'ui-empty', resourceId: 'node::empty', name: 'Registry only', avatar: 'R' } as Agent;
const name = () => screen.getByLabelText('Displayed name') as HTMLInputElement;
const writes = () => vi.mocked(api).mock.calls.map(([path, init]) => ({ path, method: init?.method, body: JSON.parse(init?.body as string) }));
let registry = { id: agent.resourceId!, name: agent.name, enabled: true };
let identity = { id: agent.resourceId!, name: agent.name, avatar: agent.avatar };
function accepted(_path: string, init?: RequestInit) {
  const body = JSON.parse(init?.body as string);
  if (init?.method === 'PATCH') {
    registry = { ...registry, ...body };
    return { ok: true, agent: { ...registry } };
  }
  identity = { ...identity, ...body };
  return { ok: true, agents: [{ id: 'other', name: 'Other', avatar: '' }, { ...identity }] };
}
function acceptWrites() { vi.mocked(api).mockImplementation(async (path, init) => accepted(path, init)); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function Leave({ leave }: { leave: () => void }) {
  const navigate = useUnsavedNavigation();
  return <button onClick={() => navigate(leave)}>Leave</button>;
}
function Form({ selected = agent, changed = async () => {}, leave = () => {} }: { selected?: Agent; changed?: () => Promise<void>; leave?: () => void }) {
  return <ConfirmProvider><UnsavedChangesProvider><AgentSettings selected={selected} savedProviders={[]} onAgentsChanged={changed} section="details" /><Leave leave={leave} /></UnsavedChangesProvider></ConfirmProvider>;
}
beforeEach(() => { registry = { id: agent.resourceId!, name: agent.name, enabled: true }; identity = { id: agent.resourceId!, name: agent.name, avatar: agent.avatar }; acceptWrites(); vi.mocked(optimizeAvatar).mockResolvedValue('data:image/webp;base64,BB'); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('validates names on blur, trims once, and never writes while typing or for an unchanged value', async () => {
  render(<Form />);
  expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  fireEvent.change(name(), { target: { value: '   ' } });
  expect(api).not.toHaveBeenCalled();
  fireEvent.blur(name());
  expect(screen.getByRole('alert').textContent).toContain('needs a display name');
  expect(api).not.toHaveBeenCalled();
  fireEvent.change(name(), { target: { value: '  Beta  ' } });
  fireEvent.blur(name());
  fireEvent.blur(name());
  await screen.findByText('Agent details saved.');
  expect(name().value).toBe('Beta');
  expect(writes()).toEqual([
    { path: '/api/agents/node%3A%3Aa', method: 'PATCH', body: { name: 'Beta' } },
    { path: '/api/settings/identities', method: 'PUT', body: { kind: 'agent', id: 'node::a', name: 'Beta' } },
  ]);
  fireEvent.blur(name());
  expect(api).toHaveBeenCalledTimes(2);
});

it('enabled is an independent PATCH and even keyboard blur towards it cannot commit an unfinished name', async () => {
  render(<Form />);
  fireEvent.change(name(), { target: { value: 'unfinished' } });
  const enabled = screen.getByRole('checkbox', { name: 'Enabled' });
  fireEvent.blur(name(), { relatedTarget: enabled });
  fireEvent.click(enabled);
  await screen.findByText('Agent details saved.');
  expect(writes()).toEqual([{ path: '/api/agents/node%3A%3Aa', method: 'PATCH', body: { enabled: false } }]);
  expect(name().value).toBe('unfinished');
  fireEvent.click(screen.getByText('Leave'));
  expect(screen.getByText('Unsaved changes')).toBeTruthy();
  fireEvent.click(screen.getByText('Discard'));
  expect(name().value).toBe('Alpha');
  expect(enabled).toHaveProperty('checked', false);
});

it('creates a complete identity on the first registry-only write, then preserves field-scoped identity updates', async () => {
  registry = { id: registryOnlyAgent.resourceId!, name: registryOnlyAgent.name, enabled: true };
  identity = { id: registryOnlyAgent.resourceId!, name: registryOnlyAgent.name, avatar: '' };
  const { container } = render(<Form selected={registryOnlyAgent} />);
  expect(container.querySelector('.agent-avatar-preview img')).toBeNull();
  fireEvent.change(name(), { target: { value: 'Named identity' } });
  fireEvent.blur(name());
  await screen.findByText('Agent details saved.');
  expect(writes()).toEqual([
    { path: '/api/agents/node%3A%3Aempty', method: 'PATCH', body: { name: 'Named identity' } },
    { path: '/api/settings/identities', method: 'PUT', body: { kind: 'agent', id: 'node::empty', name: 'Named identity', avatar: '' } },
  ]);
  fireEvent.change(name(), { target: { value: 'Named again' } });
  fireEvent.blur(name());
  await waitFor(() => expect(name().disabled).toBe(false));
  expect(writes().slice(2)).toEqual([
    { path: '/api/agents/node%3A%3Aempty', method: 'PATCH', body: { name: 'Named again' } },
    { path: '/api/settings/identities', method: 'PUT', body: { kind: 'agent', id: 'node::empty', name: 'Named again' } },
  ]);
});

it('first avatar write for an empty identity includes the accepted registry name', async () => {
  registry = { id: registryOnlyAgent.resourceId!, name: registryOnlyAgent.name, enabled: true };
  identity = { id: registryOnlyAgent.resourceId!, name: registryOnlyAgent.name, avatar: '' };
  const { container } = render(<Form selected={registryOnlyAgent} />);
  fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
  await screen.findByText('Agent details saved.');
  expect(writes()).toEqual([{
    path: '/api/settings/identities', method: 'PUT',
    body: { kind: 'agent', id: 'node::empty', name: 'Registry only', avatar: 'data:image/webp;base64,BB' },
  }]);
});

it('immediately saves avatar selection, paste, and removal with the accepted name, not an invalid draft', async () => {
  const { container } = render(<Form />);
  fireEvent.change(name(), { target: { value: ' ' } });
  const input = container.querySelector('input[type=file]')!;
  fireEvent.change(input, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
  await screen.findByText('Agent details saved.');
  expect(writes()).toEqual([{ path: '/api/settings/identities', method: 'PUT', body: { kind: 'agent', id: 'node::a', avatar: 'data:image/webp;base64,BB' } }]);
  expect(name().value).toBe(' ');
  fireEvent.click(screen.getByText('Remove image'));
  await waitFor(() => expect(name().disabled).toBe(false));
  expect(writes()[1].body).toEqual({ kind: 'agent', id: 'node::a', avatar: '' });
  vi.mocked(optimizeAvatar).mockResolvedValue('data:image/webp;base64,CC');
  fireEvent.paste(screen.getByLabelText('Agent avatar image'), { clipboardData: { items: [{ type: 'image/png', getAsFile: () => new File(['y'], 'paste.png', { type: 'image/png' }) }] } });
  await waitFor(() => expect(writes()).toHaveLength(3));
  await waitFor(() => expect(name().disabled).toBe(false));
  expect(writes()[2].body.avatar).toBe('data:image/webp;base64,CC');
});

it('keeps failed drafts guarded through Stay, a failed guard retry, and a successful explicit retry', async () => {
  vi.mocked(api).mockRejectedValue(new Error('denied'));
  const leave = vi.fn();
  render(<Form leave={leave} />);
  fireEvent.change(name(), { target: { value: 'Beta' } });
  fireEvent.blur(name());
  await screen.findByText('Could not save agent: denied');
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByText('Stay'));
  expect(name().value).toBe('Beta');
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
  expect(leave).not.toHaveBeenCalled();
  expect(name().value).toBe('Beta');
  expect(api).toHaveBeenCalledTimes(4);
  acceptWrites();
  fireEvent.click(screen.getByText('Retry saving agent'));
  await screen.findByText('Agent details saved.');
  fireEvent.click(screen.getByText('Leave'));
  expect(leave).toHaveBeenCalledOnce();
  expect(api).toHaveBeenCalledTimes(6);
});

it('guard Save persists an unblurred draft exactly once; blur plus navigation cannot duplicate pending saves', async () => {
  const pending = deferred<object>();
  vi.mocked(api).mockImplementation((path, init) => pending.promise.then(() => accepted(path, init)));
  const leave = vi.fn();
  render(<Form leave={leave} />);
  fireEvent.change(name(), { target: { value: 'Beta' } });
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  fireEvent.blur(name());
  fireEvent.click(screen.getByText('Leave'));
  expect(api).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve({}));
  expect(leave).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText('Leave'));
  expect(leave).toHaveBeenCalledTimes(2);
  expect(api).toHaveBeenCalledTimes(2);
});

it('does not unlock partial saves until every request settles and retains the draft on partial failure', async () => {
  const pending = deferred<object>();
  vi.mocked(api).mockImplementation((path, init) => init?.method === 'PATCH' ? Promise.reject(new Error('partial')) : pending.promise.then(() => accepted(path, init)));
  render(<Form />);
  fireEvent.change(name(), { target: { value: 'Beta' } });
  fireEvent.blur(name());
  await act(async () => {});
  expect(name().disabled).toBe(true);
  await act(async () => pending.resolve({}));
  expect(name().disabled).toBe(false);
  expect(name().value).toBe('Beta');
  expect(screen.getByRole('alert').textContent).toContain('partial');
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByText('Discard'));
  expect(name().value).toBe('Beta');
  expect(screen.queryByText('Retry saving agent')).toBeNull();
});

it('ignores old save success and errors after changing owners, including resource-only identity changes', async () => {
  const pending = deferred<object>();
  vi.mocked(api).mockImplementation((path, init) => pending.promise.then(() => accepted(path, init)));
  const changed = vi.fn(async () => {});
  const view = render(<Form changed={changed} />);
  fireEvent.change(name(), { target: { value: 'Beta' } });
  fireEvent.blur(name());
  view.rerender(<Form selected={{ ...agent, resourceId: 'node::b', name: 'Bravo' }} changed={changed} />);
  await act(async () => pending.resolve({}));
  expect(name().value).toBe('Bravo');
  expect(changed).not.toHaveBeenCalled();
  expect(screen.queryByText('Agent details saved.')).toBeNull();
  const failure = deferred<object>();
  vi.mocked(api).mockReturnValue(failure.promise);
  fireEvent.change(name(), { target: { value: 'Another' } });
  fireEvent.blur(name());
  view.rerender(<Form selected={{ ...agent, id: 'c', name: 'Charlie' }} changed={changed} />);
  await act(async () => failure.reject(new Error('obsolete')));
  expect(name().value).toBe('Charlie');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('ignores optimized images after owner change or unmount, without writing or refreshing', async () => {
  const pending = deferred<string>();
  vi.mocked(optimizeAvatar).mockReturnValue(pending.promise);
  const changed = vi.fn(async () => {});
  const view = render(<Form changed={changed} />);
  fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
  expect(screen.getByText('Processing agent avatar…')).toBeTruthy();
  view.rerender(<Form selected={{ ...agent, id: 'b', name: 'Bravo' }} changed={changed} />);
  await act(async () => pending.resolve('data:image/png;base64,OLD'));
  expect(api).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  expect(name().value).toBe('Bravo');
  const second = deferred<string>();
  vi.mocked(optimizeAvatar).mockReturnValue(second.promise);
  fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
  view.unmount();
  await act(async () => second.resolve('data:image/png;base64,OLD'));
  expect(api).not.toHaveBeenCalled();
});

it('retries an avatar failure independently of an invalid name and preserves it through unrelated enabled saves', async () => {
  vi.mocked(api).mockRejectedValue(new Error('avatar denied'));
  render(<Form />);
  fireEvent.change(name(), { target: { value: ' ' } });
  fireEvent.click(screen.getByText('Remove image'));
  await screen.findByText('Could not save agent: avatar denied');
  acceptWrites();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
  await screen.findByText('Agent details saved.');
  expect(screen.getByText('Retry saving agent')).toBeTruthy();
  fireEvent.click(screen.getByText('Retry saving agent'));
  await waitFor(() => expect(name().disabled).toBe(false));
  expect(writes().map(write => write.body)).toEqual([
    { kind: 'agent', id: 'node::a', avatar: '' },
    { enabled: false },
    { kind: 'agent', id: 'node::a', avatar: '' },
  ]);
  expect(name().value).toBe(' ');
  expect(screen.queryByText('Retry saving agent')).toBeNull();
});

it('publishes accepted baselines before refresh and retries only the latest catalog callback after refresh failure', async () => {
  const pending = deferred<object>();
  const catalog = deferred<void>();
  vi.mocked(api).mockImplementation((path, init) => pending.promise.then(() => accepted(path, init)));
  const oldChanged = vi.fn(async () => {});
  const changed = vi.fn(() => catalog.promise);
  const leave = vi.fn();
  const view = render(<Form changed={oldChanged} leave={leave} />);
  fireEvent.change(name(), { target: { value: '  Beta  ' } });
  fireEvent.blur(name());
  view.rerender(<Form selected={{ ...agent }} changed={changed} leave={leave} />);
  await act(async () => pending.resolve({}));
  expect(oldChanged).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledOnce();
  expect(name().value).toBe('Beta');
  expect(name().disabled).toBe(true);
  await act(async () => catalog.reject(new Error('refresh failed')));
  expect(screen.getByRole('alert').textContent).toContain('Could not refresh agents: refresh failed');
  expect(screen.queryByText('Retry saving agent')).toBeNull();
  fireEvent.change(name(), { target: { value: 'unfinished' } });
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByText('Discard'));
  expect(name().value).toBe('Beta');
  const latestChanged = vi.fn(async () => {});
  view.rerender(<Form changed={latestChanged} leave={leave} />);
  fireEvent.click(screen.getByText('Retry refreshing agents'));
  await waitFor(() => expect(screen.queryByText('Retry refreshing agents')).toBeNull());
  expect(latestChanged).toHaveBeenCalledOnce();
  expect(api).toHaveBeenCalledTimes(2);
  fireEvent.blur(name());
  fireEvent.click(screen.getByText('Leave'));
  expect(leave).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Unsaved changes')).toBeNull();
  expect(api).toHaveBeenCalledTimes(2);
});

for (const rejectedMethod of ['PATCH', 'PUT']) {
  it(`retries only the failed ${rejectedMethod} after a partial name save`, async () => {
    vi.mocked(api).mockImplementation((path, init) => init?.method === rejectedMethod ? Promise.reject(new Error('partial')) : Promise.resolve(accepted(path, init)));
    const changed = vi.fn(async () => {});
    const leave = vi.fn();
    render(<Form changed={changed} leave={leave} />);
    fireEvent.change(name(), { target: { value: 'Beta' } });
    fireEvent.blur(name());
    await screen.findByText('Could not save agent: partial');
    expect(changed).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('Leave'));
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByText('Stay'));
    acceptWrites();
    fireEvent.click(screen.getByText('Retry saving agent'));
    await screen.findByText('Agent details saved.');
    expect(writes().map(write => write.method)).toEqual(['PATCH', 'PUT', rejectedMethod]);
    fireEvent.click(screen.getByText('Leave'));
    expect(leave).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledTimes(2);
  });
}

it('uses each endpoint’s accepted name for unrelated updates after partial acceptance', async () => {
  vi.mocked(api).mockImplementation((path, init) => init?.method === 'PATCH' ? Promise.reject(new Error('name denied')) : Promise.resolve(accepted(path, init)));
  render(<Form />);
  fireEvent.change(name(), { target: { value: 'Beta' } });
  fireEvent.blur(name());
  await screen.findByText('Could not save agent: name denied');
  acceptWrites();
  fireEvent.click(screen.getByText('Remove image'));
  await screen.findByText('Agent details saved.');
  expect(writes()[2].body).toEqual({ kind: 'agent', id: 'node::a', avatar: '' });
  expect(screen.getByText('Retry saving agent')).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
  await waitFor(() => expect(name().disabled).toBe(false));
  expect(writes()[3].body).toEqual({ enabled: false });
  fireEvent.click(screen.getByText('Retry saving agent'));
  await waitFor(() => expect(screen.queryByText('Retry saving agent')).toBeNull());
  expect(writes()[4].body).toEqual({ name: 'Beta' });
  expect(writes()).toHaveLength(5);
});

it('does not copy a name accepted by PATCH into an unrelated identity update after PUT failed', async () => {
  vi.mocked(api).mockImplementation((path, init) => init?.method === 'PUT' ? Promise.reject(new Error('identity denied')) : Promise.resolve(accepted(path, init)));
  render(<Form />);
  fireEvent.change(name(), { target: { value: 'Beta' } });
  fireEvent.blur(name());
  await screen.findByText('Could not save agent: identity denied');
  acceptWrites();
  fireEvent.click(screen.getByText('Remove image'));
  await screen.findByText('Agent details saved.');
  expect(writes()[2].body).toEqual({ kind: 'agent', id: 'node::a', avatar: '' });
  fireEvent.click(screen.getByText('Retry saving agent'));
  await waitFor(() => expect(screen.queryByText('Retry saving agent')).toBeNull());
  expect(writes()[3].body).toEqual({ kind: 'agent', id: 'node::a', name: 'Beta' });
  expect(writes()).toHaveLength(4);
});

it('accumulates avatar and enabled failures and retries both without committing an invalid unrelated name', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('avatar denied')).mockRejectedValueOnce(new Error('enabled denied'));
  render(<Form />);
  fireEvent.change(name(), { target: { value: ' ' } });
  fireEvent.click(screen.getByText('Remove image'));
  await screen.findByText('Could not save agent: avatar denied');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
  await screen.findByText('Could not save agent: avatar denied; enabled denied');
  acceptWrites();
  fireEvent.click(screen.getByText('Retry saving agent'));
  await waitFor(() => expect(screen.queryByText('Retry saving agent')).toBeNull());
  expect(writes()).toEqual([
    { path: '/api/settings/identities', method: 'PUT', body: { kind: 'agent', id: 'node::a', avatar: '' } },
    { path: '/api/agents/node%3A%3Aa', method: 'PATCH', body: { enabled: false } },
    { path: '/api/agents/node%3A%3Aa', method: 'PATCH', body: { enabled: false } },
    { path: '/api/settings/identities', method: 'PUT', body: { kind: 'agent', id: 'node::a', avatar: '' } },
  ]);
  expect(name().value).toBe(' ');
});

it('suppresses a pending save callback after unmount', async () => {
  const pending = deferred<object>();
  vi.mocked(api).mockImplementation((path, init) => pending.promise.then(() => accepted(path, init)));
  const changed = vi.fn(async () => {});
  const view = render(<Form changed={changed} />);
  fireEvent.change(name(), { target: { value: 'Beta' } });
  fireEvent.blur(name());
  view.unmount();
  await act(async () => pending.resolve({}));
  expect(changed).not.toHaveBeenCalled();
});

it('resumes the first navigation after blur autosave without a second click or duplicate mutation', async () => {
  const pending = deferred<object>();
  vi.mocked(api).mockImplementation((path, init) => pending.promise.then(() => accepted(path, init)));
  const leave = vi.fn();
  render(<Form leave={leave} />);
  fireEvent.change(name(), { target: { value: 'Beta' } });
  fireEvent.blur(name());
  fireEvent.click(screen.getByText('Leave'));
  expect(screen.queryByText('Unsaved changes')).toBeNull();
  expect(leave).not.toHaveBeenCalled();
  expect(api).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve({}));
  expect(leave).toHaveBeenCalledOnce();
  expect(api).toHaveBeenCalledTimes(2);
});

it('reports avatar processing errors without a write and permits a fresh selection', async () => {
  vi.mocked(optimizeAvatar).mockRejectedValue(new Error('bad image'));
  const { container } = render(<Form />);
  const input = container.querySelector('input[type=file]')!;
  const file = new File(['x'], 'a.png', { type: 'image/png' });
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByText('bad image');
  expect(api).not.toHaveBeenCalled();
  expect(name().disabled).toBe(false);
  vi.mocked(optimizeAvatar).mockResolvedValue('data:image/png;base64,NEW');
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByText('Agent details saved.');
  expect(writes()).toHaveLength(1);
});

it('guard Save retries only the unaccepted endpoint and allows navigation despite a subsequent refresh failure', async () => {
  vi.mocked(api).mockImplementation((path, init) => init?.method === 'PUT' ? Promise.reject(new Error('identity denied')) : Promise.resolve(accepted(path, init)));
  const changed = vi.fn(async () => {});
  const leave = vi.fn();
  render(<Form changed={changed} leave={leave} />);
  fireEvent.change(name(), { target: { value: 'Beta' } });
  fireEvent.blur(name());
  await screen.findByText('Could not save agent: identity denied');
  acceptWrites();
  changed.mockRejectedValueOnce(new Error('catalog offline'));
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(leave).toHaveBeenCalledOnce());
  expect(writes().map(write => write.method)).toEqual(['PATCH', 'PUT', 'PUT']);
  expect(screen.queryByText('Retry saving agent')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('Could not refresh agents: catalog offline');
});

it('discard after a mixed guard Save retains accepted name/enabled changes but abandons the failed avatar', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('avatar denied'));
  const leave = vi.fn();
  render(<Form leave={leave} />);
  fireEvent.click(screen.getByText('Remove image'));
  await screen.findByText('Could not save agent: avatar denied');
  vi.mocked(api).mockRejectedValueOnce(new Error('enabled denied'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
  await screen.findByText('Could not save agent: avatar denied; enabled denied');
  fireEvent.change(name(), { target: { value: 'Beta' } });
  vi.mocked(api).mockImplementation((path, init) => init?.method === 'PUT' ? Promise.reject(new Error('identity denied')) : Promise.resolve(accepted(path, init)));
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await screen.findByText('Could not save agent: identity denied');
  expect(leave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByText('Discard'));
  expect(leave).toHaveBeenCalledOnce();
  expect(name().value).toBe('Beta');
  expect(screen.getByRole('checkbox', { name: 'Enabled' })).toHaveProperty('checked', false);
  expect(screen.getByText('Remove image')).toBeTruthy();
  expect(screen.queryByText('Retry saving agent')).toBeNull();
  expect(api).toHaveBeenCalledTimes(4);
  fireEvent.click(screen.getByText('Leave'));
  expect(leave).toHaveBeenCalledTimes(2);
});

for (const endpoint of ['registry', 'identity'] as const) {
  const valid = endpoint === 'registry'
    ? { ok: true, agent: { id: agent.resourceId, name: 'Alpha', enabled: false } }
    : { ok: true, agents: [{ id: agent.resourceId, name: 'Alpha', avatar: '' }] };
  const malformed: unknown[] = [
    undefined, null, {}, 'not json', { ok: true }, { ...valid, ok: false }, { ...valid, ok: 'true' },
    endpoint === 'registry'
      ? { ok: true, agent: { id: agent.id, name: 'Alpha', enabled: false } }
      : { ok: true, agents: [{ id: agent.id, name: 'Alpha', avatar: '' }] },
    endpoint === 'registry'
      ? { ok: true, agent: { id: agent.resourceId, name: 'Alpha', enabled: 'false' } }
      : { ok: true, agents: [{ id: agent.resourceId, name: 'Alpha', avatar: null }] },
    endpoint === 'registry'
      ? { ok: true, agent: { id: agent.resourceId, enabled: false } }
      : { ok: true, agents: [{ id: agent.resourceId, avatar: '' }] },
  ];
  it.each(malformed)(`rejects malformed ${endpoint} ACK %# without refresh, cleanup, or draft loss`, async response => {
    vi.mocked(api).mockResolvedValue(response);
    const changed = vi.fn(async () => {});
    const leave = vi.fn();
    const view = render(<Form changed={changed} leave={leave} />);
    if (endpoint === 'registry') fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
    else fireEvent.click(screen.getByText('Remove image'));
    await screen.findByText(/Invalid agent .* acknowledgement/);
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByText('Agent details saved.')).toBeNull();
    expect(screen.getByText('Retry saving agent')).toBeTruthy();
    if (endpoint === 'registry') expect(screen.getByRole('checkbox', { name: 'Enabled' })).toHaveProperty('checked', false);
    else expect(view.container.querySelector('.agent-avatar-preview img')).toBeNull();
    fireEvent.click(screen.getByText('Leave'));
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByText('Stay'));
    acceptWrites();
    fireEvent.click(screen.getByText('Retry saving agent'));
    await screen.findByText('Agent details saved.');
    expect(api).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('Leave'));
    expect(leave).toHaveBeenCalledOnce();
  });
}

it('opening the unsaved modal suppresses name blur autosave until Save is chosen', async () => {
  const leave = vi.fn();
  render(<Form leave={leave} />);
  name().focus();
  fireEvent.change(name(), { target: { value: 'Beta' } });
  fireEvent.click(screen.getByText('Leave'));
  const modal = await screen.findByRole('alertdialog', { name: 'Unsaved changes' });
  expect(api).not.toHaveBeenCalled();
  expect(name().value).toBe('Beta');
  fireEvent.click(modal.querySelector('button.primary')!);
  await waitFor(() => expect(leave).toHaveBeenCalledOnce());
  expect(api).toHaveBeenCalledTimes(2);
});

it('does not trim away a name draft or navigate on malformed acknowledgements', async () => {
  vi.mocked(api).mockResolvedValue({ ok: true });
  const changed = vi.fn(async () => {});
  const leave = vi.fn();
  render(<Form changed={changed} leave={leave} />);
  fireEvent.change(name(), { target: { value: '  Beta  ' } });
  fireEvent.blur(name());
  fireEvent.click(screen.getByText('Leave'));
  await screen.findByText('Unsaved changes');
  expect(name().value).toBe('  Beta  ');
  expect(changed).not.toHaveBeenCalled();
  expect(leave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Discard'));
  expect(name().value).toBe('Alpha');
});

it('uses accepted response values for the draft, discard baseline, and subsequent no-op saves', async () => {
  vi.mocked(api).mockImplementation(async (_path, init) => init?.method === 'PATCH'
    ? { ok: true, agent: { id: agent.resourceId, name: 'Canonical', enabled: true } }
    : { ok: true, agents: [{ id: agent.resourceId, name: 'Canonical', avatar: 'data:image/png;base64,SERVER' }] });
  const leave = vi.fn();
  const view = render(<Form leave={leave} />);
  fireEvent.change(name(), { target: { value: 'Requested' } });
  fireEvent.blur(name());
  await screen.findByText('Agent details saved.');
  expect(name().value).toBe('Canonical');
  fireEvent.blur(name());
  expect(api).toHaveBeenCalledTimes(2);
  // The server may normalize an avatar or reject a boolean change by returning
  // its actual accepted value. Neither submitted value becomes the baseline.
  fireEvent.click(screen.getByText('Remove image'));
  await waitFor(() => expect(name().disabled).toBe(false));
  expect(view.container.querySelector('.agent-avatar-preview img')?.getAttribute('src')).toBe('data:image/png;base64,SERVER');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
  await waitFor(() => expect(name().disabled).toBe(false));
  expect(screen.getByRole('checkbox', { name: 'Enabled' })).toHaveProperty('checked', true);
  fireEvent.change(name(), { target: { value: 'unfinished' } });
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByText('Discard'));
  expect(name().value).toBe('Canonical');
  expect(view.container.querySelector('.agent-avatar-preview img')?.getAttribute('src')).toBe('data:image/png;base64,SERVER');
});

for (const malformedMethod of ['PATCH', 'PUT']) {
  it(`retains endpoint baselines after malformed ${malformedMethod}, Discard, and an unrelated guard Save`, async () => {
    vi.mocked(api).mockImplementation(async (path, init) => init?.method === malformedMethod ? { ok: true } : accepted(path, init));
    const changed = vi.fn(async () => {});
    const leave = vi.fn();
    render(<Form changed={changed} leave={leave} />);
    fireEvent.change(name(), { target: { value: 'Beta' } });
    fireEvent.blur(name());
    await screen.findByText(/Invalid agent .* acknowledgement/);
    expect(changed).toHaveBeenCalledOnce(); // only the valid endpoint accepts
    fireEvent.click(screen.getByText('Leave'));
    fireEvent.click(screen.getByText('Discard'));
    expect(name().value).toBe('Beta'); // accepted endpoint cannot be undone
    expect(screen.queryByText('Retry saving agent')).toBeNull();
    // Force an avatar draft so guard Save must run. It must not reconcile the
    // abandoned rename on either endpoint, in either divergence direction.
    vi.mocked(api).mockResolvedValue({});
    fireEvent.click(screen.getByText('Remove image'));
    await screen.findByText(/Invalid agent identity acknowledgement/);
    acceptWrites();
    fireEvent.click(screen.getByText('Leave'));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(leave).toHaveBeenCalledTimes(2));
    expect(writes().slice(2)).toEqual([
      { path: '/api/settings/identities', method: 'PUT', body: { kind: 'agent', id: agent.resourceId, avatar: '' } },
      { path: '/api/settings/identities', method: 'PUT', body: { kind: 'agent', id: agent.resourceId, avatar: '' } },
    ]);
  });
}

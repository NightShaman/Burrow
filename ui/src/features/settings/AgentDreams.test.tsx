import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { AgentDreams } from './AgentDreams';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('loads only configuration, without recent activity/history fetches or polling', async () => {
  vi.mocked(api).mockImplementation(async path => {
    if (!path.endsWith('/dream-settings')) throw new Error(`Unexpected request: ${path}`);
    return { settings: { enabled: true, cron: '0 4 * * *', timezone: null, prompt: 'Dream diary' } };
  });
  vi.useFakeTimers();
  try {
    const view = render(<AgentDreams agentId="node::agent/name" savedProviders={[]} />);
    await act(async () => {});
    expect(screen.getByLabelText('Dream prompt')).toHaveProperty('disabled', false);
    expect(screen.queryByText('Recent activity')).toBeNull();
    expect(screen.queryByLabelText('Recent dream activity')).toBeNull();
    expect(screen.getByRole('button', { name: 'Preview memories' })).toHaveProperty('disabled', false);
    await act(async () => { vi.advanceTimersByTime(45000); });
    expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual(['/api/agents/agent%2Fname/dream-settings']);
    view.rerender(<AgentDreams agentId="other" savedProviders={[]} />);
    await act(async () => {});
    expect(screen.getByLabelText('Dream prompt')).toHaveProperty('disabled', false);
    expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual(['/api/agents/agent%2Fname/dream-settings', '/api/agents/other/dream-settings']);
  } finally { vi.useRealTimers(); }
});

it('defaults legacy settings to quiet-day dreaming and persists explicit opt-out and opt-in', async () => {
  const settings = { enabled: true, cron: '0 4 * * *', timezone: null, prompt: 'Dream diary' };
  vi.mocked(api).mockImplementation(async (path, init) => path.includes('dream-settings') ? { settings: init?.body ? JSON.parse(init.body as string) : settings } : { receipts: [] });
  render(<AgentDreams agentId="nigel" savedProviders={[]} />);
  const toggle = screen.getByRole('checkbox', { name: 'Dream on quiet days' }) as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  expect(toggle.checked).toBe(true);
  for (const value of [false, true]) {
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.checked).toBe(value);
    const save = vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT').at(-1)!;
    expect(JSON.parse(save[1]!.body as string).quietDayDreams).toBe(value);
  }
});
it('keeps quiet-day settings owned by the selected agent across delayed saves and reload', async () => {
  let resolveSave!: (value: unknown) => void;
  const settings = (quietDayDreams: boolean) => ({ enabled: true, quietDayDreams, cron: '0 4 * * *', timezone: null, prompt: 'Dream diary' });
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (init?.method === 'PUT') return new Promise(resolve => { resolveSave = resolve; });
    return path.includes('dream-settings') ? { settings: settings(!path.includes('/b/')) } : { receipts: [] };
  });
  const view = render(<AgentDreams agentId="a" savedProviders={[]} />);
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Dream on quiet days' }) as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Dream on quiet days' }));
  view.rerender(<AgentDreams agentId="b" savedProviders={[]} />);
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Dream on quiet days' }) as HTMLInputElement).checked).toBe(false));
  await act(async () => resolveSave({ settings: settings(true) }));
  expect((screen.getByRole('checkbox', { name: 'Dream on quiet days' }) as HTMLInputElement).checked).toBe(false);
  view.unmount();
  render(<AgentDreams agentId="b" savedProviders={[]} />);
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Dream on quiet days' }) as HTMLInputElement).disabled).toBe(false));
  expect((screen.getByRole('checkbox', { name: 'Dream on quiet days' }) as HTMLInputElement).checked).toBe(false);
});

it('defaults legacy settings to promotion dreaming and persists explicit opt-out and opt-in', async () => {
  const settings = { enabled: true, cron: '0 4 * * *', timezone: null, prompt: 'Dream diary' };
  vi.mocked(api).mockImplementation(async (path, init) => path.includes('dream-settings') ? { settings: init?.body ? JSON.parse(init.body as string) : settings } : { receipts: [] });
  render(<AgentDreams agentId="nigel" savedProviders={[]} />);
  const toggle = screen.getByRole('checkbox', { name: 'Promote Dreams to memory' }) as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  expect(toggle.checked).toBe(true);
  for (const value of [false, true]) {
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.checked).toBe(value);
    const save = vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT').at(-1)!;
    expect(JSON.parse(save[1]!.body as string).promoteToMemory).toBe(value);
  }
});
it('keeps promotion settings owned by the selected agent across delayed saves and reload', async () => {
  let resolveSave!: (value: unknown) => void;
  const settings = (promoteToMemory: boolean) => ({ enabled: true, promoteToMemory, cron: '0 4 * * *', timezone: null, prompt: 'Dream diary' });
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (init?.method === 'PUT') return new Promise(resolve => { resolveSave = resolve; });
    return path.includes('dream-settings') ? { settings: settings(!path.includes('/b/')) } : { receipts: [] };
  });
  const view = render(<AgentDreams agentId="a" savedProviders={[]} />);
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Promote Dreams to memory' }) as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Promote Dreams to memory' }));
  view.rerender(<AgentDreams agentId="b" savedProviders={[]} />);
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Promote Dreams to memory' }) as HTMLInputElement).checked).toBe(false));
  await act(async () => resolveSave({ settings: settings(true) }));
  expect((screen.getByRole('checkbox', { name: 'Promote Dreams to memory' }) as HTMLInputElement).checked).toBe(false);
  view.unmount();
  render(<AgentDreams agentId="b" savedProviders={[]} />);
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Promote Dreams to memory' }) as HTMLInputElement).disabled).toBe(false));
  expect((screen.getByRole('checkbox', { name: 'Promote Dreams to memory' }) as HTMLInputElement).checked).toBe(false);
});

it('defaults memory emphasis to Balanced and saves overrides without changing the diary prompt', async () => {
  const settings = { enabled: true, cron: '0 4 * * *', timezone: null, prompt: 'Diary stays unchanged', defaultMemoryPrompt: 'Balanced memory instructions' };
  vi.mocked(api).mockImplementation(async (path, init) => path.includes('dream-settings') ? { settings: { ...settings, ...(init?.body ? JSON.parse(init.body as string) : {}) } } : { receipts: [] });
  render(<AgentDreams agentId="nigel" savedProviders={[]} />);
  const slider = screen.getByRole('slider', { name: 'Memory emphasis' }) as HTMLInputElement;
  await waitFor(() => expect(slider.disabled).toBe(false));
  expect(slider.value).toBe('50');
  const prompt = screen.getByRole('textbox', { name: 'Memory prompt override' }) as HTMLTextAreaElement;
  expect(prompt.value).toBe('Balanced memory instructions');
  fireEvent.pointerDown(slider, { pointerId: 1 });
  fireEvent.change(slider, { target: { value: '100' } });
  expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  fireEvent.pointerUp(slider, { pointerId: 1 });
  await waitFor(() => expect(slider.disabled).toBe(false));
  expect(JSON.parse(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT')[0][1]!.body as string)).toMatchObject({ memoryEmphasis: 100, memoryPromptOverride: null, prompt: 'Diary stays unchanged' });
  fireEvent.change(prompt, { target: { value: 'Custom grounded expression' } });
  expect(screen.getByText('Custom override active')).toBeTruthy();
  fireEvent.blur(prompt);
  await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2));
  expect(JSON.parse(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT')[1][1]!.body as string)).toMatchObject({ memoryEmphasis: 100, memoryPromptOverride: 'Custom grounded expression', prompt: 'Diary stays unchanged' });
  fireEvent.click(screen.getByRole('button', { name: 'Revert to default' }));
  await waitFor(() => expect(slider.disabled).toBe(false));
  expect(prompt.value).toBe('Balanced memory instructions');
  expect(screen.getByText('Default prompt')).toBeTruthy();
  expect(JSON.parse(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT').at(-1)![1]!.body as string).memoryPromptOverride).toBeNull();
});

const memorySettings = { enabled: true, cron: '0 4 * * *', timezone: null, prompt: 'Unchanged diary', memoryEmphasis: 50, memoryPromptOverride: null, defaultMemoryPrompt: 'Balanced memory instructions' };
const sample = { ok: true, memories: [{ title: 'Grounded memory', content: '<script>Not HTML</script>\nSecond line', sourceRefs: ['session:real-source:1'] }], sourceToken: 'same-sample', sourceCount: 2, generatedAt: '2026-10-26T13:00:00Z', evidenceScope: 'Recent validated extraction checkpoints', persisted: false };
function memoryApi(preview: (init?: RequestInit) => unknown = () => sample) {
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path.includes('/dream-memory/preview')) return preview(init);
    return path.includes('dream-settings') ? { settings: { ...memorySettings, ...(init?.method === 'PUT' ? JSON.parse(init.body as string) : {}) } } : { receipts: [] };
  });
}
const previewCalls = () => vi.mocked(api).mock.calls.filter(([path]) => path.includes('/dream-memory/preview'));
async function readyMemory() {
  const slider = screen.getByRole('slider', { name: 'Memory emphasis' }) as HTMLInputElement;
  await waitFor(() => expect(slider.disabled).toBe(false));
  return slider;
}
it('previews only explicitly, never saves, reuses sources across edits, and clears stale results', async () => {
  memoryApi();
  render(<AgentDreams agentId="nigel" savedProviders={[]} />);
  const slider = await readyMemory();
  fireEvent.change(slider, { target: { value: '75' } });
  expect(previewCalls()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Preview memories' }));
  expect(await screen.findByText('Grounded memory')).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
  expect(JSON.parse(previewCalls()[0][1]!.body as string)).toEqual({ memoryEmphasis: 75, memoryPromptOverride: null });
  fireEvent.change(screen.getByRole('textbox', { name: 'Memory prompt override' }), { target: { value: '' } });
  expect(screen.queryByText('Grounded memory')).toBeNull();
  expect(screen.getByText('Custom override active')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Preview memories' }));
  await screen.findByText('Grounded memory');
  expect(JSON.parse(previewCalls()[1][1]!.body as string)).toEqual({ memoryEmphasis: 75, memoryPromptOverride: '', sourceToken: 'same-sample' });
  expect(vi.mocked(api).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
});
it('requires explicit new sample after token expiry, and keeps Save independent', async () => {
  let count = 0;
  memoryApi(() => { if (++count === 2) throw new Error('dream_memory_preview_source_token_invalid'); return sample; });
  render(<AgentDreams agentId="nigel" savedProviders={[]} />);
  await readyMemory();
  fireEvent.click(screen.getByRole('button', { name: 'Preview memories' }));
  await screen.findByText('Grounded memory');
  fireEvent.click(screen.getByRole('button', { name: 'Preview memories' }));
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: 'Preview memories' }) as HTMLButtonElement).disabled).toBe(true);
  expect(previewCalls()).toHaveLength(2);
  expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Preview new sample' }));
  await screen.findByText('Grounded memory');
  expect(JSON.parse(previewCalls()[2][1]!.body as string).sourceToken).toBeUndefined();
});
it('ignores delayed previews after an edit or agent switch and resets source identity', async () => {
  let resolve!: (value: unknown) => void;
  memoryApi(() => new Promise(r => { resolve = r; }));
  const view = render(<AgentDreams agentId="a" savedProviders={[]} />);
  const slider = await readyMemory();
  fireEvent.click(screen.getByRole('button', { name: 'Preview memories' }));
  fireEvent.change(slider, { target: { value: '0' } });
  await act(async () => resolve(sample));
  expect(screen.queryByText('Grounded memory')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Preview memories' }));
  view.rerender(<AgentDreams agentId="b" savedProviders={[]} />);
  await readyMemory();
  await act(async () => resolve(sample));
  expect(screen.queryByText('Grounded memory')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Preview new sample' })).toBeNull();
});
it('shows empty sources and model errors without regenerating', async () => {
  let fail = false;
  memoryApi(() => { if (fail) throw new Error('dream_model_not_configured'); return { ...sample, sourceCount: 0, memories: [] }; });
  render(<AgentDreams agentId="a" savedProviders={[]} />);
  await readyMemory();
  fireEvent.click(screen.getByRole('button', { name: 'Preview memories' }));
  await screen.findByText('No eligible extracted source material is available. No model request was made.');
  fail = true;
  fireEvent.click(screen.getByRole('button', { name: 'Preview memories' }));
  expect((await screen.findByRole('alert')).textContent).toContain('dream_model_not_configured');
  expect(previewCalls()).toHaveLength(2);
});


const completeSettings = { enabled: true, quietDayDreams: true, promoteToMemory: true, cron: '0 4 * * *', timezone: null, prompt: 'Accepted diary', modelConnectionId: null, model: null, memoryEmphasis: 50, memoryPromptOverride: null, defaultMemoryPrompt: 'Default memory' };
const dreamPuts = () => vi.mocked(api).mock.calls.filter(([path, init]) => path.includes('/dream-settings') && init?.method === 'PUT');
function completeApi(write: (body: Record<string, unknown>) => unknown = body => ({ settings: body })) {
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path.includes('/dream-memory/preview')) return sample;
    if (init?.method === 'PUT') return write(JSON.parse(init.body as string));
    return { settings: completeSettings };
  });
}
it('autosaves toggles and complete model selections from the accepted payload only', async () => {
  completeApi();
  const providers = [{ id: 'provider', provider: 'Provider', apiType: '', url: '', apiKey: '', models: ['model'] }];
  render(<AgentDreams agentId="agent/name" savedProviders={providers} />);
  const prompt = await screen.findByRole('textbox', { name: 'Dream prompt' });
  await waitFor(() => expect((prompt as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(prompt, { target: { value: 'Unrelated dirty prompt' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enable scheduled dreaming' }));
  await waitFor(() => expect(dreamPuts()).toHaveLength(1));
  expect(dreamPuts()[0][0]).toBe('/api/agents/agent%2Fname/dream-settings');
  expect(JSON.parse(dreamPuts()[0][1]!.body as string)).toEqual({
    enabled: false, quietDayDreams: true, promoteToMemory: true, cron: '0 4 * * *', prompt: 'Accepted diary', modelConnectionId: null, model: null, memoryEmphasis: 50, memoryPromptOverride: null,
  });
  await waitFor(() => expect((prompt as HTMLTextAreaElement).disabled).toBe(false));
  expect((prompt as HTMLTextAreaElement).value).toBe('Unrelated dirty prompt');
  fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: 'provider' } });
  await waitFor(() => expect(dreamPuts()).toHaveLength(2));
  expect(JSON.parse(dreamPuts()[1][1]!.body as string)).toMatchObject({ enabled: false, prompt: 'Accepted diary', modelConnectionId: 'provider', model: 'model' });
  expect((prompt as HTMLTextAreaElement).value).toBe('Unrelated dirty prompt');
});
it('validates complete text scope on blur without writing and preserves the invalid draft', async () => {
  completeApi();
  render(<AgentDreams agentId="a" savedProviders={[]} />);
  const cron = await screen.findByRole('textbox', { name: 'Cron' });
  await waitFor(() => expect((cron as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(cron, { target: { value: 'invalid cron' } });
  fireEvent.blur(cron);
  expect((await screen.findByRole('alert')).textContent).toContain('valid five-field cron');
  expect((cron as HTMLInputElement).value).toBe('invalid cron');
  expect(dreamPuts()).toHaveLength(0);
});
it('retains a failed field draft, retries only that field, and keeps unrelated edits dirty', async () => {
  let attempts = 0;
  completeApi(body => { if (++attempts === 1) throw new Error('offline'); return { settings: body }; });
  render(<AgentDreams agentId="a" savedProviders={[]} />);
  const prompt = await screen.findByRole('textbox', { name: 'Dream prompt' });
  await waitFor(() => expect((prompt as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(prompt, { target: { value: 'Unrelated dirty prompt' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Dream on quiet days' }));
  expect((await screen.findByRole('alert')).textContent).toContain('offline');
  expect((screen.getByRole('checkbox', { name: 'Dream on quiet days' }) as HTMLInputElement).checked).toBe(false);
  fireEvent.change(prompt, { target: { value: 'Newer unrelated prompt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving dream settings' }));
  await waitFor(() => expect(dreamPuts()).toHaveLength(2));
  expect(JSON.parse(dreamPuts()[1][1]!.body as string)).toMatchObject({ quietDayDreams: false, prompt: 'Accepted diary' });
  expect((prompt as HTMLTextAreaElement).value).toBe('Newer unrelated prompt');
});
it('commits memory emphasis once per completed interaction and preview never flushes another draft', async () => {
  completeApi();
  render(<AgentDreams agentId="a" savedProviders={[]} />);
  const slider = await readyMemory();
  const prompt = screen.getByRole('textbox', { name: 'Dream prompt' });
  fireEvent.change(prompt, { target: { value: 'Dirty diary' } });
  fireEvent.pointerDown(slider, { pointerId: 7 });
  fireEvent.change(slider, { target: { value: '60' } });
  fireEvent.change(slider, { target: { value: '75' } });
  expect(dreamPuts()).toHaveLength(0);
  fireEvent.pointerUp(slider, { pointerId: 7 });
  await waitFor(() => expect(dreamPuts()).toHaveLength(1));
  expect(JSON.parse(dreamPuts()[0][1]!.body as string)).toMatchObject({ memoryEmphasis: 75, prompt: 'Accepted diary' });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Preview memories' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Preview memories' }));
  await waitFor(() => expect(vi.mocked(api).mock.calls.some(([path]) => path.includes('/dream-memory/preview'))).toBe(true));
  expect(dreamPuts()).toHaveLength(1);
});
it('ignores a stale failed autosave after owner switch and reload', async () => {
  let rejectOld!: (cause: unknown) => void;
  vi.mocked(api).mockImplementation((path, init) => {
    if (init?.method === 'PUT') return new Promise((_resolve, reject) => { rejectOld = reject; });
    return Promise.resolve({ settings: { ...completeSettings, prompt: path.includes('/b/') ? 'Agent B' : 'Agent A' } });
  });
  const view = render(<AgentDreams agentId="a" savedProviders={[]} />);
  await screen.findByDisplayValue('Agent A');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enable scheduled dreaming' }));
  view.rerender(<AgentDreams agentId="b" savedProviders={[]} />);
  await screen.findByDisplayValue('Agent B');
  await act(async () => { rejectOld(new Error('old failure')); });
  expect(screen.queryByText(/old failure/)).toBeNull();
  expect((screen.getByRole('textbox', { name: 'Dream prompt' }) as HTMLTextAreaElement).value).toBe('Agent B');
});

function LeaveDreams({ onLeave }: { onLeave: () => void }) {
  const navigate = useUnsavedNavigation();
  return <button onClick={() => navigate(onLeave)}>Leave Dreams</button>;
}
it('does not blur-save a focused Dream field when the unsaved modal takes focus', async () => {
  completeApi();
  const leave = vi.fn();
  render(<UnsavedChangesProvider><AgentDreams agentId="a" savedProviders={[]} /><LeaveDreams onLeave={leave} /></UnsavedChangesProvider>);
  const prompt = await screen.findByRole('textbox', { name: 'Dream prompt' });
  await waitFor(() => expect((prompt as HTMLTextAreaElement).disabled).toBe(false));
  act(() => prompt.focus());
  fireEvent.change(prompt, { target: { value: 'Keep this focused draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Leave Dreams' }));
  expect(await screen.findByRole('alertdialog')).toBeTruthy();
  expect(dreamPuts()).toHaveLength(0);
  expect((prompt as HTMLTextAreaElement).value).toBe('Keep this focused draft');
  fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
  expect(leave).not.toHaveBeenCalled();
});

it('guards an uncommitted invalid field and Discard restores the accepted settings without a write', async () => {
  completeApi();
  const leave = vi.fn();
  render(<UnsavedChangesProvider><AgentDreams agentId="a" savedProviders={[]} /><LeaveDreams onLeave={leave} /></UnsavedChangesProvider>);
  const cron = await screen.findByRole('textbox', { name: 'Cron' });
  await waitFor(() => expect((cron as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(cron, { target: { value: 'invalid cron' } });
  fireEvent.click(screen.getByRole('button', { name: 'Leave Dreams' }));
  expect(screen.getByText('Unsaved changes')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
  expect((cron as HTMLInputElement).value).toBe('invalid cron');
  fireEvent.click(screen.getByRole('button', { name: 'Leave Dreams' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect(leave).toHaveBeenCalledTimes(1);
  expect((cron as HTMLInputElement).value).toBe('0 4 * * *');
  expect(dreamPuts()).toHaveLength(0);
});

it('accumulates independent failed scopes and retries all of them without unrelated drafts', async () => {
  let fail = true;
  completeApi(body => { if (fail) throw new Error('offline'); return { settings: body }; });
  render(<AgentDreams agentId="a" savedProviders={[]} />);
  await readyMemory();
  const prompt = screen.getByRole('textbox', { name: 'Dream prompt' });
  fireEvent.change(prompt, { target: { value: 'Unrelated unsaved diary' } });
  for (const name of ['Dream on quiet days', 'Promote Dreams to memory', 'Enable scheduled dreaming']) {
    fireEvent.click(screen.getByRole('checkbox', { name }));
    await screen.findByRole('button', { name: 'Retry saving dream settings' });
  }
  expect(dreamPuts()).toHaveLength(3);
  // Each independent write still starts from the accepted settings, not the
  // earlier failed drafts. Retry is the explicit action that combines them.
  expect(JSON.parse(dreamPuts()[2][1]!.body as string)).toMatchObject({ enabled: false, quietDayDreams: true, promoteToMemory: true, prompt: 'Accepted diary' });
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving dream settings' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry saving dream settings' })).toBeNull());
  expect(dreamPuts()).toHaveLength(4);
  expect(JSON.parse(dreamPuts()[3][1]!.body as string)).toMatchObject({ enabled: false, quietDayDreams: false, promoteToMemory: false, prompt: 'Accepted diary' });
  expect((prompt as HTMLTextAreaElement).value).toBe('Unrelated unsaved diary');
});

// jsdom does not implement Tab's native focus movement or touch focus. Perform
// that browser default explicitly, preserving the real order: pointer/key down,
// blur/focus (with relatedTarget), pointer/key up, then activation. Unlike
// fireEvent.click alone this catches blur saves that disable the target first.
function focusAction(from: HTMLElement, target: HTMLElement, input: 'keyboard' | 'touch') {
  if (input === 'keyboard') fireEvent.keyDown(from, { key: 'Tab' });
  else fireEvent.pointerDown(target, { pointerId: 1, pointerType: 'touch' });
  act(() => target.focus());
  if (input === 'keyboard') fireEvent.keyUp(target, { key: 'Tab' });
  else fireEvent.pointerUp(target, { pointerId: 1, pointerType: 'touch' });
}
function activateAction(target: HTMLElement, input: 'keyboard' | 'touch') {
  if (input === 'keyboard') fireEvent.keyDown(target, { key: ' ' });
  if (input === 'keyboard') fireEvent.keyUp(target, { key: ' ' });
  act(() => target.click());
}

it.each(['keyboard', 'touch'] as const)('keeps previews no-save through %s focus/blur and activation, including new samples', async input => {
  completeApi();
  render(<AgentDreams agentId="a" savedProviders={[]} />);
  await readyMemory();
  const prompt = screen.getByRole('textbox', { name: 'Memory prompt override' }) as HTMLTextAreaElement;
  for (const name of ['Preview memories', 'Preview new sample']) {
    act(() => prompt.focus());
    fireEvent.change(prompt, { target: { value: `Draft for ${name}` } });
    const button = screen.getByRole('button', { name }) as HTMLButtonElement;
    focusAction(prompt, button, input);
    expect(button.disabled).toBe(false);
    expect(dreamPuts()).toHaveLength(0);
    activateAction(button, input);
    await screen.findByText('Grounded memory');
    expect(dreamPuts()).toHaveLength(0);
    expect(prompt.value).toBe(`Draft for ${name}`);
    expect(JSON.parse(previewCalls().at(-1)![1]!.body as string).memoryPromptOverride).toBe(`Draft for ${name}`);
  }
  expect(previewCalls()).toHaveLength(2);
  expect(JSON.parse(previewCalls()[1][1]!.body as string).sourceToken).toBeUndefined();
});

it.each(['keyboard', 'touch'] as const)('does not let %s blur save a text draft before an independent toggle', async input => {
  completeApi();
  render(<AgentDreams agentId="a" savedProviders={[]} />);
  await readyMemory();
  const prompt = screen.getByRole('textbox', { name: 'Dream prompt' }) as HTMLTextAreaElement;
  act(() => prompt.focus());
  fireEvent.change(prompt, { target: { value: 'Keep this diary draft' } });
  const toggle = screen.getByRole('checkbox', { name: 'Dream on quiet days' }) as HTMLInputElement;
  focusAction(prompt, toggle, input);
  expect(dreamPuts()).toHaveLength(0);
  expect(toggle.disabled).toBe(false);
  activateAction(toggle, input);
  await waitFor(() => expect(toggle.disabled).toBe(false));
  expect(dreamPuts()).toHaveLength(1);
  expect(JSON.parse(dreamPuts()[0][1]!.body as string)).toMatchObject({ quietDayDreams: false, prompt: 'Accepted diary' });
  expect(toggle.checked).toBe(false);
  expect(prompt.value).toBe('Keep this diary draft');
});

it.each(['keyboard', 'touch'] as const)('keeps a pending emphasis draft out of writes when %s focus moves to preview', async input => {
  completeApi();
  render(<AgentDreams agentId="a" savedProviders={[]} />);
  const slider = await readyMemory();
  act(() => slider.focus());
  fireEvent.change(slider, { target: { value: '75' } });
  const button = screen.getByRole('button', { name: 'Preview memories' });
  focusAction(slider, button, input);
  activateAction(button, input);
  await screen.findByText('Grounded memory');
  expect(dreamPuts()).toHaveLength(0);
  expect(JSON.parse(previewCalls()[0][1]!.body as string).memoryEmphasis).toBe(75);
  // A later ordinary focus/blur is not a continuation of the abandoned
  // interaction; it must not unexpectedly flush the previewed draft either.
  act(() => slider.focus());
  act(() => slider.blur());
  expect(dreamPuts()).toHaveLength(0);
});

it('still autosaves text when focus leaves for an ordinary editor', async () => {
  completeApi();
  render(<AgentDreams agentId="a" savedProviders={[]} />);
  await readyMemory();
  const prompt = screen.getByRole('textbox', { name: 'Dream prompt' });
  act(() => prompt.focus());
  fireEvent.change(prompt, { target: { value: 'Commit this diary' } });
  focusAction(prompt, screen.getByRole('textbox', { name: 'Cron' }), 'keyboard');
  await waitFor(() => expect(dreamPuts()).toHaveLength(1));
  expect(JSON.parse(dreamPuts()[0][1]!.body as string).prompt).toBe('Commit this diary');
});

it('retains older failed scopes after an unrelated successful save and failed retry', async () => {
  let fail = true;
  completeApi(body => { if (fail) throw new Error('offline'); return { settings: body }; });
  render(<AgentDreams agentId="a" savedProviders={[]} />);
  await readyMemory();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Dream on quiet days' }));
  await screen.findByRole('button', { name: 'Retry saving dream settings' });
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving dream settings' }));
  await screen.findByRole('button', { name: 'Retry saving dream settings' });
  fail = false;
  const promotion = screen.getByRole('checkbox', { name: 'Promote Dreams to memory' }) as HTMLInputElement;
  fireEvent.click(promotion);
  await waitFor(() => expect(promotion.disabled).toBe(false));
  expect(screen.getByRole('button', { name: 'Retry saving dream settings' })).toBeTruthy();
  expect(JSON.parse(dreamPuts()[2][1]!.body as string)).toMatchObject({ quietDayDreams: true, promoteToMemory: false });
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving dream settings' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry saving dream settings' })).toBeNull());
  expect(JSON.parse(dreamPuts()[3][1]!.body as string)).toMatchObject({ quietDayDreams: false, promoteToMemory: false });
});

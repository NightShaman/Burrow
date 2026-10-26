import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { AgentDreams } from './AgentDreams';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function show(receipts: unknown[]) {
  vi.mocked(api).mockImplementation(async (path) => path.includes('dream-settings') ? { settings: { enabled: true, cron: '0 4 * * *', timezone: 'UTC', prompt: '' } } : { receipts });
  render(<AgentDreams agentId="nigel" savedProviders={[]} />);
}
it('shows phase, provider, model, HTTP status and provider message as plain text', async () => {
  show([{ runId: 'new', status: 'failed', phases: [{ phase: 'rem', modelResponses: [{ ok: false, provider: 'anthropic', model: 'opus', status: '400', error: '<script>Invalid model</script>' }, { ok: true, provider: 'anthropic', model: 'good', status: '200' }] }] }]);
  expect(await screen.findByText('rem · anthropic · opus · HTTP 400 · <script>Invalid model</script>')).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
  expect(screen.queryByText(/HTTP 200/)).toBeNull();
});
it('falls back to older phase errors and preserves top-level interruption errors', async () => {
  show([{ runId: 'old', status: 'failed', phases: [{ phase: 'light', extractionError: 'dream_model_empty_response', diaryError: 'dream_model_empty_response' }, { phase: 'deep', diaryError: 'diary_failed' }] }, { runId: 'stop', status: 'interrupted', error: 'Runtime stopped' }]);
  expect(await screen.findByText('light · dream_model_empty_response')).toBeTruthy();
  expect(screen.getByText('deep · diary_failed')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toBe('Runtime stopped');
});
it('uses older phase errors when a failed response has no provider message', async () => {
  show([{ runId: 'legacy', status: 'partial', phases: [{ phase: 'deep', extractionError: 'extraction_failed', modelResponses: [{ ok: false, provider: 'anthropic', status: null, error: null }] }] }]);
  expect(await screen.findByText('deep · anthropic · extraction_failed')).toBeTruthy();
});

it('defaults legacy settings to quiet-day dreaming and persists explicit opt-out and opt-in', async () => {
  const settings = { enabled: true, cron: '0 4 * * *', timezone: null, prompt: '' };
  vi.mocked(api).mockImplementation(async (path, init) => path.includes('dream-settings') ? { settings: init?.body ? JSON.parse(init.body as string) : settings } : { receipts: [] });
  render(<AgentDreams agentId="nigel" savedProviders={[]} />);
  const toggle = screen.getByRole('checkbox', { name: 'Dream on quiet days' }) as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  expect(toggle.checked).toBe(true);
  for (const value of [false, true]) {
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save dream settings' }));
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.checked).toBe(value);
    const save = vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT').at(-1)!;
    expect(JSON.parse(save[1]!.body as string).quietDayDreams).toBe(value);
  }
});
it('keeps quiet-day settings owned by the selected agent across delayed saves and reload', async () => {
  let resolveSave!: (value: unknown) => void;
  const settings = (quietDayDreams: boolean) => ({ enabled: true, quietDayDreams, cron: '0 4 * * *', timezone: null, prompt: '' });
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (init?.method === 'PUT') return new Promise(resolve => { resolveSave = resolve; });
    return path.includes('dream-settings') ? { settings: settings(!path.includes('/b/')) } : { receipts: [] };
  });
  const view = render(<AgentDreams agentId="a" savedProviders={[]} />);
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Dream on quiet days' }) as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Save dream settings' }));
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
  const settings = { enabled: true, cron: '0 4 * * *', timezone: null, prompt: '' };
  vi.mocked(api).mockImplementation(async (path, init) => path.includes('dream-settings') ? { settings: init?.body ? JSON.parse(init.body as string) : settings } : { receipts: [] });
  render(<AgentDreams agentId="nigel" savedProviders={[]} />);
  const toggle = screen.getByRole('checkbox', { name: 'Promote Dreams to memory' }) as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  expect(toggle.checked).toBe(true);
  for (const value of [false, true]) {
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save dream settings' }));
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.checked).toBe(value);
    const save = vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT').at(-1)!;
    expect(JSON.parse(save[1]!.body as string).promoteToMemory).toBe(value);
  }
});
it('keeps promotion settings owned by the selected agent across delayed saves and reload', async () => {
  let resolveSave!: (value: unknown) => void;
  const settings = (promoteToMemory: boolean) => ({ enabled: true, promoteToMemory, cron: '0 4 * * *', timezone: null, prompt: '' });
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (init?.method === 'PUT') return new Promise(resolve => { resolveSave = resolve; });
    return path.includes('dream-settings') ? { settings: settings(!path.includes('/b/')) } : { receipts: [] };
  });
  const view = render(<AgentDreams agentId="a" savedProviders={[]} />);
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Promote Dreams to memory' }) as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Save dream settings' }));
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
  fireEvent.change(slider, { target: { value: '100' } });
  fireEvent.change(prompt, { target: { value: 'Custom grounded expression' } });
  expect(screen.getByText('Custom override active')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save dream settings' }));
  await waitFor(() => expect(slider.disabled).toBe(false));
  const save = vi.mocked(api).mock.calls.find(([, init]) => init?.method === 'PUT')!;
  expect(JSON.parse(save[1]!.body as string)).toMatchObject({ memoryEmphasis: 100, memoryPromptOverride: 'Custom grounded expression', prompt: 'Diary stays unchanged' });
  fireEvent.click(screen.getByRole('button', { name: 'Revert to default' }));
  expect(prompt.value).toBe('Balanced memory instructions');
  expect(screen.getByText('Default prompt')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save dream settings' }));
  await waitFor(() => expect(slider.disabled).toBe(false));
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
  fireEvent.click(screen.getByRole('button', { name: 'Save dream settings' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Save dream settings' }) as HTMLButtonElement).disabled).toBe(false));
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

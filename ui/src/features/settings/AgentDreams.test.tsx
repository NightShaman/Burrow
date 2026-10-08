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

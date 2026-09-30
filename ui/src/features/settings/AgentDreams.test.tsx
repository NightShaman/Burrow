import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { apiForTarget } from '../../app/api';
import { AgentDreams } from './AgentDreams';
vi.mock('../../app/api', () => ({ apiForTarget: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function show(receipts: unknown[]) {
  vi.mocked(apiForTarget).mockImplementation(async (_target, path) => path.includes('dream-settings') ? { settings: { enabled: true, cron: '0 4 * * *', timezone: 'UTC', prompt: '' } } : { receipts });
  render(<AgentDreams agentId="nigel" targets={[{ id: 'local', name: 'Local', baseUrl: '', enabled: true }]} savedProviders={[]} />);
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

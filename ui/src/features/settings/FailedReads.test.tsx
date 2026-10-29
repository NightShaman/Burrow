import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { api } from '../../app/api';
import { ExecutionBoundaries } from './ExecutionBoundaries';
import { AuthenticationSettings } from './AuthenticationSettings';
import { RetentionSettings } from './RetentionSettings';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
for (const [Component, save, result] of [
 [ExecutionBoundaries, 'Save boundaries', { boundaries: { hardBlocks: [] } }],
 [() => <AuthenticationSettings />, 'Save authentication', { auth: { mode: 'none' } }],
 [RetentionSettings, 'Apply policy', { ok: true, policy: { version: 1, enabled: false, traceMaxAgeDays: null, traceMaxBytes: null, intervalMinutes: 1440 }, state: {}, plan: { ok: true, dryRun: true, retention: {}, counts: { deleteTraces: 0, deleteTraceBytes: 0 } } }],
] as const) it(`${save} fails closed and retries`, async () => {
 vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockImplementation(async (_path, init) =>
   Component === RetentionSettings && init?.method === 'PUT'
     ? { ok: true, policy: JSON.parse(init.body as string), state: {} }
     : result);
 render(<ConfirmProvider><Component /></ConfirmProvider>);
 await screen.findByRole('alert');
 const button = screen.getByRole('button', { name: save });
 expect((button as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(button); expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
 if (Component === RetentionSettings) {
   await waitFor(() => expect((screen.getByLabelText('Maximum age (days)') as HTMLInputElement).disabled).toBe(false));
   expect((button as HTMLButtonElement).disabled).toBe(true); // Applying an unchanged policy is a no-op.
   fireEvent.change(screen.getByLabelText('Maximum age (days)'), { target: { value: '30' } });
 }
 await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(button);
 await waitFor(() => expect(vi.mocked(api).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
 if (Component === RetentionSettings) {
   await screen.findByText('Retention policy applied. Managed trace cleanup is disabled.');
   expect((button as HTMLButtonElement).disabled).toBe(true);
   expect(screen.queryByRole('alert')).toBeNull();
 }
});

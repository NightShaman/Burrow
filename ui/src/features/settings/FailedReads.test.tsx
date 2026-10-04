import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { ExecutionBoundaries } from './ExecutionBoundaries';
import { AuthenticationSettings } from './AuthenticationSettings';
import { RetentionSettings } from './RetentionSettings';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
for (const [Component, save, result] of [
 [ExecutionBoundaries, 'Save boundaries', { boundaries: { hardBlocks: [] } }],
 [AuthenticationSettings, 'Save authentication', { auth: { mode: 'none' } }],
 [RetentionSettings, 'Save policy', { policy: { enabled: false } }],
] as const) it(`${save} fails closed and retries`, async () => {
 vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(result);
 render(<Component />);
 await screen.findByRole('alert');
 const button = screen.getByRole('button', { name: save });
 expect((button as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(button); expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
 await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(button);
 await waitFor(() => expect(vi.mocked(api).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
});

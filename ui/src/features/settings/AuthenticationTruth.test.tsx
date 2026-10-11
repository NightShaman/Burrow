import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { AuthenticationSettings } from './AuthenticationSettings';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('shows the effective environment mode separately from saved mode', async () => {
 vi.mocked(api).mockResolvedValue({ auth: { mode: 'none' }, effective: { mode: 'trusted-proxy', source: 'environment' } });
 render(<AuthenticationSettings showBrowserOrigin={false} />);
 await screen.findByText(/Effective authentication: Trusted Proxy/);
 expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('none');
 expect(screen.getByText(/Saving changes the preference, not the active override/)).toBeTruthy();
});
it('describes blank TTL as 12 hours and reconciles the normalized saved TTL', async () => {
 vi.mocked(api).mockResolvedValueOnce({ auth: { mode: 'basic', basic: { username: 'test', sessionTtlSeconds: 5400 } } }).mockResolvedValue({ auth: { mode: 'basic', basic: { sessionTtlSeconds: 43200 } }, effective: { mode: 'basic', source: 'database' } });
 render(<AuthenticationSettings showBrowserOrigin={false} />);
 const ttl = await screen.findByLabelText('Session TTL (hours)') as HTMLInputElement;
 expect(ttl.value).toBe('1.5');
 expect(ttl.placeholder).toBe('Leave blank for 12 hours');
 fireEvent.change(ttl, { target: { value: '' } });
 fireEvent.click(screen.getByRole('button', { name: 'Save authentication' }));
 await waitFor(() => expect(ttl.value).toBe('12'));
 expect(JSON.parse(vi.mocked(api).mock.calls[1][1]?.body as string).basic.sessionTtlSeconds).toBeNull();
});

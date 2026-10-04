import { useEffect, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ReauthGate } from './ReauthGate';
vi.mock('./LoginPage', () => ({ LoginPage: ({ onAuthenticated }: { onAuthenticated: () => void }) => <button type="button" onClick={onAuthenticated}>Reauthenticate</button> }));
it('FE056 opens overlay after 401 without unmounting workspace draft state', async () => {
 const unmount = vi.fn();
 function DraftOwner() { const [draft, setDraft] = useState(''); useEffect(() => { return () => unmount(); }, []); return <input aria-label="Message draft" value={draft} onChange={event => setDraft(event.target.value)} />; }
 render(<ReauthGate><DraftOwner /></ReauthGate>);
 const input = screen.getByRole('textbox', { name: 'Message draft' });
 fireEvent.change(input, { target: { value: 'Keep this unsent draft' } });
 window.dispatchEvent(new Event('burrow:auth-required'));
 await screen.findByRole('button', { name: 'Reauthenticate' });
 expect(screen.getByRole('textbox', { name: 'Message draft' })).toBe(input);
 expect((input as HTMLInputElement).value).toBe('Keep this unsent draft');
 expect(unmount).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button', { name: 'Reauthenticate' }));
 await waitFor(() => expect(screen.queryByRole('button', { name: 'Reauthenticate' })).toBeNull());
 expect(unmount).not.toHaveBeenCalled();
});

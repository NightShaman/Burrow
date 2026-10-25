import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { OperatorProfile } from './OperatorProfile';

vi.mock('../../app/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../app/api')>()), api: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(api).mockReset(); });
const profile = { name: 'Reference operator', avatar: '' };
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(done => { resolve = done; });
  return { promise, resolve };
};

async function openProfile(onSaved = vi.fn()) {
  render(<OperatorProfile onSaved={onSaved} />);
  await screen.findByDisplayValue(profile.name);
  return onSaved;
}

describe('Operator profile save lifecycle audit', () => {
  it('treats a malformed profile response as a failed load without corrupting the saved baseline', async () => {
    vi.mocked(api).mockResolvedValue({ wizardStep: 'ready' });
    render(<OperatorProfile onSaved={vi.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Invalid operator profile response');
    expect((screen.getByRole('button', { name: 'Save profile' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('keeps an unsuccessful load distinct from an editable profile and retries', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ operator: profile });
    render(<OperatorProfile onSaved={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'Save profile' }) as HTMLButtonElement).disabled).toBe(true);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load');
    fireEvent.click(screen.getByRole('button', { name: 'Retry operator profile' }));
    await screen.findByDisplayValue(profile.name);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('rejects blank names locally without discarding the entered draft', async () => {
    vi.mocked(api).mockResolvedValue({ operator: profile });
    await openProfile();
    fireEvent.change(screen.getByLabelText('Displayed name'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(screen.getByRole('alert').textContent).toContain('cannot be empty');
    expect((screen.getByLabelText('Displayed name') as HTMLInputElement).value).toBe('  ');
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
  });

  it('preserves failed-save drafts, reports failure, and allows retry', async () => {
    vi.mocked(api).mockResolvedValueOnce({ operator: profile }).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true });
    const onSaved = await openProfile();
    fireEvent.change(screen.getByLabelText('Displayed name'), { target: { value: 'Changed operator' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not save');
    expect(screen.getByDisplayValue('Changed operator')).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ name: 'Changed operator', avatar: '' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('locks fields and prevents repeated save while the mutation is pending', async () => {
    const pending = deferred();
    vi.mocked(api).mockResolvedValueOnce({ operator: profile }).mockReturnValueOnce(pending.promise);
    const onSaved = await openProfile();
    fireEvent.change(screen.getByLabelText('Displayed name'), { target: { value: 'Changed operator' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    const saving = screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement;
    expect(saving.disabled).toBe(true);
    expect((screen.getByLabelText('Displayed name') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(saving);
    expect(vi.mocked(api)).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve({ ok: true }));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('does not publish a late save result after unmount', async () => {
    const pending = deferred();
    vi.mocked(api).mockResolvedValueOnce({ operator: profile }).mockReturnValueOnce(pending.promise);
    const onSaved = vi.fn();
    const view = render(<OperatorProfile onSaved={onSaved} />);
    await screen.findByDisplayValue(profile.name);
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    view.unmount();
    await act(async () => pending.resolve({ ok: true }));
    expect(onSaved).not.toHaveBeenCalled();
  });
});

import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { OperatorProfile } from './OperatorProfile';

vi.mock('../../app/api', async importOriginal => ({ ...(await importOriginal<typeof import('../../app/api')>()), api: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(api).mockReset(); vi.unstubAllGlobals(); });
const profile = { name: 'Reference operator', avatar: '' };
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(done => { resolve = done; });
  return { promise, resolve };
};

async function openProfile(onSaved = vi.fn(), loaded = profile) {
  render(<OperatorProfile onSaved={onSaved} />);
  await screen.findByDisplayValue(loaded.name);
  return onSaved;
}

function expectLastProfileWrite(expected: { name: string; avatar: string }) {
  expect(api).toHaveBeenLastCalledWith('/api/settings/identities', expect.objectContaining({
    method: 'PUT',
    body: JSON.stringify({ kind: 'operator', id: 'default', ...expected }),
  }));
}

function installImageOptimization(avatar = 'data:image/webp;base64,bmV3') {
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:avatar'), revokeObjectURL });
  class LoadedImage {
    naturalWidth = 64;
    naturalHeight = 64;
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal('Image', LoadedImage);
  const drawImage = vi.fn();
  const originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
    const element = originalCreateElement(tagName, options);
    if (tagName === 'canvas') {
      Object.defineProperty(element, 'getContext', { value: () => ({ drawImage }) });
      Object.defineProperty(element, 'toDataURL', { value: () => avatar });
    }
    return element;
  }) as typeof document.createElement);
  return { avatar, revokeObjectURL };
}

describe('Operator profile autosave lifecycle audit', () => {
  it('treats a malformed profile response as a failed load without corrupting the saved baseline', async () => {
    vi.mocked(api).mockResolvedValue({ wizardStep: 'ready' });
    render(<OperatorProfile onSaved={vi.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Invalid operator profile response');
    expect((screen.getByLabelText('Displayed name') as HTMLInputElement).disabled).toBe(true);
  });

  it('keeps an unsuccessful load distinct from an editable profile and retries', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ operator: profile });
    render(<OperatorProfile onSaved={vi.fn()} />);
    expect((screen.getByLabelText('Displayed name') as HTMLInputElement).disabled).toBe(true);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load');
    fireEvent.click(screen.getByRole('button', { name: 'Retry operator profile' }));
    await screen.findByDisplayValue(profile.name);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('autosaves a trimmed valid name on blur without including a competing avatar draft', async () => {
    const accepted = { name: 'Changed operator', avatar: profile.avatar };
    vi.mocked(api).mockResolvedValueOnce({ operator: profile }).mockResolvedValueOnce({ ok: true, operator: accepted });
    const onSaved = await openProfile();
    const input = screen.getByLabelText('Displayed name');
    fireEvent.change(input, { target: { value: '  Changed operator  ' } });
    fireEvent.blur(input);
    await screen.findByText('Operator name saved.');
    expectLastProfileWrite(accepted);
    expect((input as HTMLInputElement).value).toBe(accepted.name);
    expect(onSaved).toHaveBeenCalledWith(accepted);
  });

  it('rejects blank names on blur without discarding the draft or issuing a PUT', async () => {
    vi.mocked(api).mockResolvedValue({ operator: profile });
    await openProfile();
    const input = screen.getByLabelText('Displayed name');
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert').textContent).toContain('cannot be empty');
    expect((input as HTMLInputElement).value).toBe('  ');
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
  });

  it('preserves a failed name draft, reports failure, and retries it explicitly', async () => {
    vi.mocked(api).mockResolvedValueOnce({ operator: profile }).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, operator: { ...profile, name: 'Changed operator' } });
    const onSaved = await openProfile();
    const input = screen.getByLabelText('Displayed name');
    fireEvent.change(input, { target: { value: 'Changed operator' } });
    fireEvent.blur(input);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not save');
    expect((input as HTMLInputElement).value).toBe('Changed operator');
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving operator profile' }));
    await screen.findByText('Operator name saved.');
    expect(onSaved).toHaveBeenCalledWith({ name: 'Changed operator', avatar: '' });
  });

  it('autosaves an optimized avatar change with the accepted name counterpart', async () => {
    const image = installImageOptimization();
    const accepted = { name: profile.name, avatar: image.avatar };
    vi.mocked(api).mockResolvedValueOnce({ operator: profile }).mockResolvedValueOnce({ ok: true, operator: accepted });
    const onSaved = await openProfile();
    const file = new File(['avatar'], 'operator.png', { type: 'image/png' });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await screen.findByText('Operator avatar saved.');
    expectLastProfileWrite(accepted);
    expect((screen.getByLabelText('Avatar image') as HTMLInputElement).value).toBe('operator.png');
    expect(onSaved).toHaveBeenCalledWith(accepted);
    expect(image.revokeObjectURL).toHaveBeenCalledWith('blob:avatar');
  });

  it.each(['choose', 'paste'])('autosaves a %s avatar with the accepted name while a blank name remains unfinished', async action => {
    const image = installImageOptimization();
    const accepted = { name: profile.name, avatar: image.avatar };
    vi.mocked(api).mockResolvedValueOnce({ operator: profile }).mockResolvedValueOnce({ ok: true, operator: accepted });
    const onSaved = await openProfile();
    const input = screen.getByLabelText('Displayed name');
    fireEvent.change(input, { target: { value: '  ' } });
    const file = new File(['avatar'], 'operator.png', { type: 'image/png' });
    if (action === 'choose') {
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    } else {
      fireEvent.paste(screen.getByLabelText('Avatar image'), {
        clipboardData: { items: [{ type: file.type, getAsFile: () => file }] },
      });
    }
    await screen.findByText('Operator avatar saved.');
    expectLastProfileWrite(accepted);
    expect(onSaved).toHaveBeenCalledWith(accepted);
    expect((input as HTMLInputElement).value).toBe('  ');
    fireEvent.blur(input);
    expect(screen.getByRole('alert').textContent).toContain('cannot be empty');
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('retries a failed avatar removal independently of a blank unfinished name', async () => {
    const loaded = { ...profile, avatar: 'data:image/png;base64,b2xk' };
    vi.mocked(api).mockResolvedValueOnce({ operator: loaded }).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, operator: profile });
    const onSaved = await openProfile(vi.fn(), loaded);
    const input = screen.getByLabelText('Displayed name');
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not save');
    expectLastProfileWrite(profile);
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving operator profile' }));
    await screen.findByText('Operator avatar saved.');
    expectLastProfileWrite(profile);
    expect(onSaved).toHaveBeenCalledWith(profile);
    expect((input as HTMLInputElement).value).toBe('  ');
  });

  it('autosaves avatar removal and restores the failed removal draft for retry', async () => {
    const loaded = { ...profile, avatar: 'data:image/png;base64,b2xk' };
    vi.mocked(api).mockResolvedValueOnce({ operator: loaded }).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, operator: profile });
    const onSaved = await openProfile(vi.fn(), loaded);
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not save');
    expect(screen.queryByRole('button', { name: 'Remove image' })).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving operator profile' }));
    await screen.findByText('Operator avatar saved.');
    expectLastProfileWrite(profile);
    expect(onSaved).toHaveBeenCalledWith(profile);
  });

  it('uses the accepted counterpart when avatar removal interrupts a focused name draft', async () => {
    const loaded = { ...profile, avatar: 'data:image/png;base64,b2xk' };
    const accepted = { name: loaded.name, avatar: '' };
    vi.mocked(api).mockResolvedValueOnce({ operator: loaded }).mockResolvedValueOnce({ ok: true, operator: accepted });
    const onSaved = await openProfile(vi.fn(), loaded);
    const input = screen.getByLabelText('Displayed name');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Unsaved name' } });
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Remove image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    await screen.findByText('Operator avatar saved.');
    expectLastProfileWrite(accepted);
    expect((input as HTMLInputElement).value).toBe('Unsaved name');
    expect(onSaved).toHaveBeenCalledWith(accepted);
  });

  it('locks fields and prevents repeated mutation while saving', async () => {
    const pending = deferred();
    vi.mocked(api).mockResolvedValueOnce({ operator: profile }).mockReturnValueOnce(pending.promise);
    const onSaved = await openProfile();
    const input = screen.getByLabelText('Displayed name');
    fireEvent.change(input, { target: { value: 'Changed operator' } });
    fireEvent.blur(input);
    await screen.findByText('Saving operator profile…');
    expect((input as HTMLInputElement).disabled).toBe(true);
    fireEvent.blur(input);
    expect(vi.mocked(api)).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve({ ok: true, operator: { ...profile, name: 'Changed operator' } }));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('does not publish a late save result after unmount', async () => {
    const pending = deferred();
    vi.mocked(api).mockResolvedValueOnce({ operator: profile }).mockReturnValueOnce(pending.promise);
    const onSaved = vi.fn();
    const view = render(<OperatorProfile onSaved={onSaved} />);
    const input = await screen.findByDisplayValue(profile.name);
    fireEvent.change(input, { target: { value: 'Changed operator' } });
    fireEvent.blur(input);
    view.unmount();
    await act(async () => pending.resolve({ ok: true, operator: { ...profile, name: 'Changed operator' } }));
    expect(onSaved).not.toHaveBeenCalled();
  });
});

function LeaveProfile() {
  const navigate = useUnsavedNavigation();
  return <button onClick={() => navigate(() => document.body.setAttribute('data-profile-left', 'yes'))}>Leave profile</button>;
}
function mountGuardedProfile(onSaved = vi.fn()) {
  document.body.removeAttribute('data-profile-left');
  render(<UnsavedChangesProvider><OperatorProfile onSaved={onSaved} /><LeaveProfile /></UnsavedChangesProvider>);
  return onSaved;
}

describe('Operator profile acknowledged saves and independent failures', () => {
  it.each([undefined, null, '', [], {}, { ok: true }, { ok: false, operator: profile },
    { operator: profile }, { ok: true, operator: { name: 12, avatar: '' } },
    { ok: true, operator: { name: 'Changed', avatar: null } },
  ])('rejects malformed save acknowledgement %j without publishing or clearing the draft', async response => {
    vi.mocked(api).mockResolvedValueOnce({ operator: profile }).mockResolvedValueOnce(response)
      .mockResolvedValueOnce({ ok: true, operator: { ...profile, name: 'Changed' } });
    const onSaved = mountGuardedProfile();
    const input = await screen.findByDisplayValue(profile.name);
    fireEvent.change(input, { target: { value: 'Changed' } });
    fireEvent.blur(input);
    expect((await screen.findByRole('alert')).textContent).toContain('Invalid operator profile save response');
    expect(input).toHaveProperty('value', 'Changed');
    expect(onSaved).not.toHaveBeenCalled();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Leave profile' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving operator profile' }));
    await screen.findByText('Operator name saved.');
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({ ...profile, name: 'Changed' });
    expectLastProfileWrite({ ...profile, name: 'Changed' });
  });

  it('uses server-accepted snapshot values for display, callback and discard baseline', async () => {
    const accepted = { name: 'Server accepted', avatar: 'data:image/png;base64,YQ==' };
    vi.mocked(api).mockResolvedValueOnce({ operator: profile }).mockResolvedValueOnce({ ok: true, operator: { id: 'default', ...accepted }, agents: [] });
    const onSaved = mountGuardedProfile();
    const input = await screen.findByDisplayValue(profile.name);
    fireEvent.change(input, { target: { value: 'Client request' } });
    fireEvent.blur(input);
    await screen.findByText('Operator name saved.');
    expect(input).toHaveProperty('value', accepted.name);
    expect(document.querySelector('.agent-avatar-preview img')).toHaveProperty('src', accepted.avatar);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(accepted);
    fireEvent.change(input, { target: { value: 'Another draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Leave profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(input).toHaveProperty('value', accepted.name);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it.each(['name', 'avatar'] as const)('accumulates failures when %s fails first and retries both fields together', async first => {
    const loaded = { ...profile, avatar: 'data:image/png;base64,b2xk' };
    const accepted = { name: 'Changed', avatar: '' };
    vi.mocked(api).mockResolvedValueOnce({ operator: loaded })
      .mockRejectedValueOnce(new Error(`${first} offline`))
      .mockRejectedValueOnce(new Error('other offline'))
      .mockResolvedValueOnce({ ok: true, operator: accepted });
    const onSaved = await openProfile(vi.fn(), loaded);
    const input = screen.getByLabelText('Displayed name');
    const failName = () => { fireEvent.change(input, { target: { value: 'Changed' } }); fireEvent.blur(input); };
    const failAvatar = () => fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    (first === 'name' ? failName : failAvatar)();
    await screen.findByRole('alert');
    (first === 'name' ? failAvatar : failName)();
    await screen.findByText(/other offline/);
    expect(screen.getByRole('alert').textContent).toContain(`${first} offline`);
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving operator profile' }));
    await screen.findByText('Operator profile saved.');
    expectLastProfileWrite(accepted);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(accepted);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps an avatar failure actionable after an unrelated successful name save and no-op blur', async () => {
    const loaded = { ...profile, avatar: 'data:image/png;base64,b2xk' };
    const renamed = { ...loaded, name: 'Changed' };
    vi.mocked(api).mockResolvedValueOnce({ operator: loaded }).mockRejectedValueOnce(new Error('avatar offline'))
      .mockResolvedValueOnce({ ok: true, operator: renamed })
      .mockResolvedValueOnce({ ok: true, operator: { ...renamed, avatar: '' } });
    const onSaved = await openProfile(vi.fn(), loaded);
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    await screen.findByRole('alert');
    const input = screen.getByLabelText('Displayed name');
    fireEvent.change(input, { target: { value: 'Changed' } }); fireEvent.blur(input);
    await screen.findByText('Operator name saved.');
    expect(screen.getByRole('alert').textContent).toContain('avatar offline');
    fireEvent.change(input, { target: { value: ' Changed ' } }); fireEvent.blur(input);
    expect(api).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('alert').textContent).toContain('avatar offline');
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving operator profile' }));
    await screen.findByText('Operator avatar saved.');
    expectLastProfileWrite({ ...renamed, avatar: '' });
    expect(onSaved).toHaveBeenLastCalledWith({ ...renamed, avatar: '' });
  });

  it('preserves a failed name and its draft when avatar processing fails', async () => {
    vi.mocked(api).mockResolvedValueOnce({ operator: profile }).mockRejectedValueOnce(new Error('name offline'));
    await openProfile();
    const input = screen.getByLabelText('Displayed name');
    fireEvent.change(input, { target: { value: 'Changed' } }); fireEvent.blur(input);
    await screen.findByRole('alert');
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(['text'], 'bad.txt', { type: 'text/plain' })] } });
    await screen.findByText(/Choose or paste an image file/);
    expect(screen.getByRole('alert').textContent).toContain('name offline');
    expect(screen.getByRole('button', { name: 'Retry saving operator profile' })).toBeTruthy();
    expect(input).toHaveProperty('value', 'Changed');
    expect(api).toHaveBeenCalledTimes(2);
  });

  it.each(['change', 'paste', 'file', 'remove'] as const)('skips name blur for keyboard/touch focus moving to %s avatar controls', async action => {
    const image = installImageOptimization();
    const loaded = { ...profile, avatar: 'data:image/png;base64,b2xk' };
    const accepted = { ...loaded, avatar: action === 'remove' ? '' : image.avatar };
    vi.mocked(api).mockResolvedValueOnce({ operator: loaded }).mockResolvedValueOnce({ ok: true, operator: accepted });
    const onSaved = await openProfile(vi.fn(), loaded);
    const input = screen.getByLabelText('Displayed name');
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'Unfinished name' } });
    const target = action === 'change' ? screen.getByRole('button', { name: 'Change' })
      : action === 'remove' ? screen.getByRole('button', { name: 'Remove image' })
        : action === 'paste' ? screen.getByLabelText('Avatar image') : document.querySelector('input[type="file"]')! as HTMLElement;
    // No mouseDown suppression: focus() supplies the browser's relatedTarget.
    act(() => target.focus());
    expect(api).toHaveBeenCalledTimes(1);
    expect(input).toHaveProperty('disabled', false);
    const file = new File(['avatar'], 'new.png', { type: 'image/png' });
    if (action === 'remove') fireEvent.click(target);
    else if (action === 'paste') fireEvent.paste(target, { clipboardData: { items: [{ type: file.type, getAsFile: () => file }] } });
    else {
      if (action === 'change') fireEvent.click(target);
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    }
    await screen.findByText('Operator avatar saved.');
    expectLastProfileWrite(accepted);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(accepted);
    expect(input).toHaveProperty('value', 'Unfinished name');
  });
});

describe('Operator profile remaining failed scopes', () => {
  it('keeps a failed name actionable after successful avatar removal, retrying only that name with the accepted avatar', async () => {
    const loaded = { ...profile, avatar: 'data:image/png;base64,b2xk' };
    vi.mocked(api).mockResolvedValueOnce({ operator: loaded }).mockRejectedValueOnce(new Error('name offline'))
      .mockResolvedValueOnce({ ok: true, operator: profile })
      .mockResolvedValueOnce({ ok: true, operator: { ...profile, name: 'Changed' } });
    const onSaved = await openProfile(vi.fn(), loaded);
    const input = screen.getByLabelText('Displayed name');
    fireEvent.change(input, { target: { value: 'Changed' } }); fireEvent.blur(input);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    await screen.findByText('Operator avatar saved.');
    expect(screen.getByRole('alert').textContent).toContain('name offline');
    expect(input).toHaveProperty('value', 'Changed');
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(profile);
    const retry = screen.getByRole('button', { name: 'Retry saving operator profile' });
    act(() => input.focus());
    act(() => retry.focus());
    expect(api).toHaveBeenCalledTimes(3);
    fireEvent.click(retry);
    await screen.findByText('Operator name saved.');
    expectLastProfileWrite({ ...profile, name: 'Changed' });
    expect(onSaved).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not erase a retryable avatar draft when a replacement image fails processing', async () => {
    const loaded = { ...profile, avatar: 'data:image/png;base64,b2xk' };
    vi.mocked(api).mockResolvedValueOnce({ operator: loaded }).mockRejectedValueOnce(new Error('avatar offline'))
      .mockResolvedValueOnce({ ok: true, operator: profile });
    await openProfile(vi.fn(), loaded);
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    await screen.findByRole('alert');
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(['text'], 'bad.txt', { type: 'text/plain' })] } });
    await screen.findByText(/Choose or paste an image file/);
    expect(screen.getByRole('alert').textContent).toContain('avatar offline');
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving operator profile' }));
    await screen.findByText('Operator avatar saved.');
    expectLastProfileWrite(profile);
  });

  it('guard Save includes both remaining drafts after independent failures and stays if the ACK is invalid', async () => {
    const loaded = { ...profile, avatar: 'data:image/png;base64,b2xk' };
    const accepted = { name: 'Changed', avatar: '' };
    vi.mocked(api).mockResolvedValueOnce({ operator: loaded })
      .mockRejectedValueOnce(new Error('name offline')).mockRejectedValueOnce(new Error('avatar offline'))
      .mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true, operator: accepted });
    const onSaved = mountGuardedProfile();
    const input = await screen.findByDisplayValue(loaded.name);
    fireEvent.change(input, { target: { value: 'Changed' } }); fireEvent.blur(input);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    await screen.findByText(/avatar offline/);
    fireEvent.click(screen.getByRole('button', { name: 'Leave profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Invalid operator profile save response/);
    expectLastProfileWrite(accepted);
    expect(document.body.getAttribute('data-profile-left')).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Leave profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Operator profile saved.');
    expect(document.body.getAttribute('data-profile-left')).toBe('yes');
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(accepted);
  });
});

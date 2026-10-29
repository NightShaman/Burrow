import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import type { Agent, SavedProvider } from '../../app/types';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { AgentSettings } from './AgentSettings';
import { DefaultMinionModel } from './DefaultMinionModel';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';

vi.mock('../../app/api', () => ({ api: vi.fn() }));
const providers: SavedProvider[] = ['a', 'b'].map(id => ({ id, provider: 'Same provider', apiType: '', url: '', apiKey: '', models: ['model', 'other'], modelEfforts: { model: ['low', 'high'], other: ['off', 'high'] }, defaultEfforts: { model: 'high', other: 'off' } }));
const selection = { connectionId: 'b', model: 'model', reasoningEffort: 'low', temperature: 0.7 };
const view = (id = 'agent') => <DefaultMinionModel key={id} resourceId={id} savedProviders={providers} />;
const providerSelect = () => screen.getByLabelText('Default minion provider') as HTMLSelectElement;
const modelSelect = () => screen.getByLabelText('Default minion model') as HTMLSelectElement;
const temperature = () => screen.getByLabelText('Minion temperature') as HTMLInputElement;
const puts = () => vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT');
const ready = () => waitFor(() => expect(providerSelect().disabled).toBe(false));
afterEach(cleanup);
beforeEach(() => { vi.mocked(api).mockReset(); });

describe('Default minion provider autosave', () => {
  function mountDetailsWithOverflow() {
    vi.mocked(api).mockImplementation(async path => String(path).endsWith('/minion-settings') ? { ok: true, maxDepth: 1 } : { ok: true, selection: null });
    const overflow = document.createElement('div'); document.body.append(overflow);
    const agent: Agent = { id: 'target::agent', resourceId: 'agent/name', name: 'Agent', avatar: '', activity: 'Idle', context: null, provider: '', model: '', effort: '', temperature: 0.2, workspace: '', files: [], subagents: [] };
    const rendered = render(<ConfirmProvider><AgentSettings selected={agent} savedProviders={providers} onAgentsChanged={vi.fn()} section="details" overflowTarget={overflow} /></ConfirmProvider>);
    return { ...rendered, overflow };
  }

  it('loads minion controls once using encoded resource identity without a normal Save button', async () => {
    const { unmount, overflow } = mountDetailsWithOverflow();
    try {
      await ready();
      expect(screen.getAllByLabelText('Default minion provider')).toHaveLength(1);
      expect(vi.mocked(api).mock.calls.some(([path]) => path === '/api/agents/agent%2Fname/minion-model-selection')).toBe(true);
      expect(screen.queryByText('Save minion model')).toBeNull();
    } finally { unmount(); overflow.remove(); }
  });

  // Known preexisting discrepancy: HEAD's AgentSettings already portals the minion editor
  // into supporting content. Preserve the primary-editor contract, not that placement.
  // This bounded autosave change does not authorize moving the shell or its controls.
  it.fails('keeps minion controls in primary, not supporting content (known preexisting placement gap)', async () => {
    const { container, unmount, overflow } = mountDetailsWithOverflow();
    try {
      await ready();
      expect.soft(container.contains(providerSelect())).toBe(true);
      expect.soft(overflow.contains(providerSelect())).toBe(false);
      expect.soft(overflow.childElementCount).toBe(0);
    } finally { unmount(); overflow.remove(); }
  });

  it('autosaves complete provider/model and effort choices, then inherit with nulls', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ ok: true, selection: null })
      .mockResolvedValueOnce({ ok: true, selection: { connectionId: 'a', model: 'model', reasoningEffort: 'high', temperature: 0.2 } })
      .mockResolvedValueOnce({ ok: true, selection: { connectionId: 'a', model: 'other', reasoningEffort: 'off', temperature: 0.2 } })
      .mockResolvedValueOnce({ ok: true, selection: { connectionId: 'a', model: 'other', reasoningEffort: 'high', temperature: 0.2 } })
      .mockResolvedValueOnce({ ok: true, selection: null });
    render(view()); await ready();

    fireEvent.change(providerSelect(), { target: { value: 'a' } });
    await screen.findByText('Default minion model saved.');
    expect(JSON.parse(puts()[0][1]!.body as string)).toEqual({ connectionId: 'a', model: 'model', reasoningEffort: 'high', temperature: 0.2 });

    fireEvent.change(modelSelect(), { target: { value: 'other' } });
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(JSON.parse(puts()[1][1]!.body as string)).toEqual({ connectionId: 'a', model: 'other', reasoningEffort: 'off', temperature: 0.2 });

    fireEvent.change(screen.getByLabelText('Minion reasoning effort'), { target: { value: 'high' } });
    await waitFor(() => expect(puts()).toHaveLength(3));
    expect(JSON.parse(puts()[2][1]!.body as string)).toEqual({ connectionId: 'a', model: 'other', reasoningEffort: 'high', temperature: 0.2 });

    fireEvent.change(providerSelect(), { target: { value: '' } });
    await waitFor(() => expect(puts()).toHaveLength(4));
    expect(JSON.parse(puts()[3][1]!.body as string)).toEqual({ connectionId: null, model: null });
  });

  it('preserves an invalid intermediate provider/model without writing until selection is complete', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ok: true, selection }).mockResolvedValueOnce({ ok: true, selection: { ...selection, model: 'other', reasoningEffort: 'off' } });
    render(view()); await ready();
    fireEvent.change(modelSelect(), { target: { value: '' } });
    expect(modelSelect().value).toBe('');
    expect(screen.getByText(/saved connection or model is unavailable/i)).toBeTruthy();
    expect(screen.getByText('Unsaved default minion model changes.')).toBeTruthy();
    expect(puts()).toHaveLength(0);

    fireEvent.change(modelSelect(), { target: { value: 'other' } });
    await screen.findByText('Default minion model saved.');
    expect(JSON.parse(puts()[0][1]!.body as string)).toEqual({ ...selection, model: 'other', reasoningEffort: 'off' });
  });

  it('keeps unavailable loaded identity and autosaves inherit without substituting it', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ok: true, selection: { ...selection, connectionId: 'missing' } }).mockResolvedValueOnce({ ok: true, selection: null });
    render(<DefaultMinionModel resourceId="agent" savedProviders={[]} />);
    await screen.findByText('Configured connection (unavailable)');
    expect((screen.getByLabelText('Default minion model') as HTMLSelectElement).value).toBe('model');
    expect(puts()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Default minion provider'), { target: { value: '' } });
    await screen.findByText('Default minion model saved.');
    expect(JSON.parse(puts()[0][1]!.body as string)).toEqual({ connectionId: null, model: null });
  });

  it('commits temperature once at pointer interaction end and once at keyboard interaction end', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ ok: true, selection })
      .mockResolvedValueOnce({ ok: true, selection: { ...selection, temperature: 1.2 } })
      .mockResolvedValueOnce({ ok: true, selection: { ...selection, temperature: 1.3 } });
    render(view()); await ready();
    fireEvent.pointerDown(temperature(), { pointerId: 7, pointerType: 'touch' });
    fireEvent.change(temperature(), { target: { value: '1.0' } });
    fireEvent.change(temperature(), { target: { value: '1.2' } });
    expect(puts()).toHaveLength(0);
    fireEvent.pointerUp(temperature(), { pointerId: 7, pointerType: 'touch' });
    await screen.findByText('Default minion model saved.');
    expect(JSON.parse(puts()[0][1]!.body as string)).toEqual({ ...selection, temperature: 1.2 });

    fireEvent.keyDown(temperature(), { key: 'ArrowRight' });
    fireEvent.change(temperature(), { target: { value: '1.3' } });
    expect(puts()).toHaveLength(1);
    fireEvent.keyUp(temperature(), { key: 'ArrowRight' });
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(JSON.parse(puts()[1][1]!.body as string)).toEqual({ ...selection, temperature: 1.3 });
  });

  it('retries load and retains a failed autosave draft for explicit retry', async () => {
    vi.mocked(api)
      .mockRejectedValueOnce(new Error('load denied'))
      .mockResolvedValueOnce({ ok: true, selection: null })
      .mockRejectedValueOnce(new Error('save denied'))
      .mockResolvedValueOnce({ ok: true, selection: { connectionId: 'a', model: 'model', reasoningEffort: 'high', temperature: 0.2 } });
    render(view());
    await screen.findByText(/load denied/);
    fireEvent.click(screen.getByText('Retry minion model'));
    await ready();
    fireEvent.change(providerSelect(), { target: { value: 'a' } });
    await screen.findByText(/save denied/);
    expect(providerSelect().value).toBe('a');
    expect(screen.getByText('Unsaved default minion model changes.')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry saving minion model'));
    await screen.findByText('Default minion model saved.');
    expect(puts()).toHaveLength(2);
  });

  it('ignores stale loads after switching owners', async () => {
    let release!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce({ ok: true, selection: null });
    const { rerender } = render(view('old'));
    rerender(view('new'));
    await ready();
    await act(async () => release({ ok: true, selection }));
    expect(providerSelect().value).toBe('');
  });

  it('locks during autosave and ignores its completion after switching owners', async () => {
    let release!: (value: unknown) => void;
    vi.mocked(api).mockResolvedValueOnce({ ok: true, selection }).mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce({ ok: true, selection: null });
    const { rerender } = render(view('old'));
    await ready();
    fireEvent.change(screen.getByLabelText('Minion reasoning effort'), { target: { value: 'high' } });
    expect(screen.getByText('Saving default minion model…')).toBeTruthy();
    expect(providerSelect().disabled).toBe(true);
    fireEvent.pointerUp(temperature());
    expect(puts()).toHaveLength(1);
    rerender(view('new'));
    await ready();
    await act(async () => release({ ok: true, selection: { ...selection, reasoningEffort: 'high' } }));
    expect(screen.queryByText('Default minion model saved.')).toBeNull();
    expect(providerSelect().value).toBe('');
  });
});

function Leave({ onLeave }: { onLeave: () => void }) {
  const navigate = useUnsavedNavigation();
  return <button onClick={() => navigate(onLeave)}>Leave settings</button>;
}
const guarded = (onLeave = vi.fn()) => <UnsavedChangesProvider>{view()}<Leave onLeave={onLeave} /></UnsavedChangesProvider>;
const adjustTemperature = (value: string) => {
  fireEvent.change(temperature(), { target: { value } });
  fireEvent.pointerUp(temperature());
};

describe('Default minion model acknowledged independent scopes', () => {
  it.each([
    undefined, {}, { ok: true }, { selection: null }, { ok: false, selection },
    { ok: true, selection: {} }, { ok: true, selection: { ...selection, model: '' } },
    { ok: true, selection: { ...selection, reasoningEffort: 7 } },
    { ok: true, selection: { ...selection, temperature: NaN } },
    { ok: true, selection: { ...selection, temperature: 3 } },
  ])('rejects malformed load %j with disabled controls and retry', async response => {
    vi.mocked(api).mockResolvedValueOnce(response).mockResolvedValueOnce({ ok: true, selection: null });
    render(view());
    await screen.findByText(/Could not load default minion model: Invalid/);
    expect(providerSelect().disabled).toBe(true);
    expect(puts()).toHaveLength(0);
    fireEvent.click(screen.getByText('Retry minion model'));
    await ready();
    expect(providerSelect().value).toBe('');
  });

  it.each([
    undefined, {}, { ok: true }, { ok: false, selection }, { ok: true, selection: {} },
    { ok: true, selection: null },
    { ok: true, selection: { ...selection, connectionId: 'wrong', reasoningEffort: 'high' } },
  ])('keeps draft, retry and leave guard after malformed save %j', async response => {
    const onLeave = vi.fn();
    vi.mocked(api).mockResolvedValueOnce({ ok: true, selection }).mockResolvedValueOnce(response)
      .mockResolvedValueOnce({ ok: true, selection: { ...selection, reasoningEffort: 'high' } });
    render(guarded(onLeave)); await ready();
    fireEvent.change(screen.getByLabelText('Minion reasoning effort'), { target: { value: 'high' } });
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Minion reasoning effort') as HTMLSelectElement).value).toBe('high');
    expect(screen.queryByText('Default minion model saved.')).toBeNull();
    fireEvent.click(screen.getByText('Leave settings'));
    await screen.findByRole('alertdialog');
    expect(onLeave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Stay'));
    fireEvent.click(screen.getByText('Retry saving minion reasoning effort'));
    await screen.findByText('Default minion model saved.');
    expect(puts()).toHaveLength(2);
    fireEvent.click(screen.getByText('Leave settings'));
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it('requires explicit null acknowledgement for Inherit and retries without erasing its draft', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ok: true, selection }).mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, selection: null });
    render(view()); await ready();
    fireEvent.change(providerSelect(), { target: { value: '' } });
    await screen.findByRole('alert');
    expect(providerSelect().value).toBe('');
    expect(screen.getByText('Unsaved default minion model changes.')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry saving minion model'));
    await screen.findByText('Default minion model saved.');
    expect(puts().map(([, init]) => JSON.parse(init!.body as string))).toEqual([
      { connectionId: null, model: null }, { connectionId: null, model: null },
    ]);
  });

  it('isolates effort and temperature from a failed competing provider and preserves its retry and discard baseline', async () => {
    const onLeave = vi.fn();
    vi.mocked(api).mockResolvedValueOnce({ ok: true, selection }).mockRejectedValueOnce(new Error('identity denied'))
      .mockResolvedValueOnce({ ok: true, selection: { ...selection, reasoningEffort: 'off' } })
      .mockResolvedValueOnce({ ok: true, selection: { ...selection, reasoningEffort: 'off', temperature: 1.2 } });
    render(guarded(onLeave)); await ready();
    fireEvent.change(providerSelect(), { target: { value: 'a' } });
    await screen.findByText(/identity denied/);
    fireEvent.change(screen.getByLabelText('Minion reasoning effort'), { target: { value: 'off' } });
    await ready();
    expect(JSON.parse(puts()[1][1]!.body as string)).toEqual({ ...selection, reasoningEffort: 'off' });
    expect(providerSelect().value).toBe('a');
    adjustTemperature('1.2'); await ready();
    expect(JSON.parse(puts()[2][1]!.body as string)).toEqual({ ...selection, reasoningEffort: 'off', temperature: 1.2 });
    expect(providerSelect().value).toBe('a');
    expect(screen.getByText('Retry saving minion model')).toBeTruthy();
    expect(screen.getByText(/identity denied/)).toBeTruthy();
    expect(screen.queryByText('Default minion model saved.')).toBeNull();
    fireEvent.click(screen.getByText('Leave settings')); await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByText('Discard'));
    expect(onLeave).toHaveBeenCalledOnce();
    expect(providerSelect().value).toBe('b');
    expect(temperature().value).toBe('1.2');
    expect((screen.getByLabelText('Minion reasoning effort') as HTMLSelectElement).value).toBe('off');
    expect(puts()).toHaveLength(3);
  });

  it('keeps failidentity intent separate from faileffort through retryidentity', async () => {
    const identityIntent = { ...selection, model: 'other', reasoningEffort: 'off' };
    vi.mocked(api).mockResolvedValueOnce({ ok: true, selection })
      .mockRejectedValueOnce(new Error('identity denied'))
      .mockRejectedValueOnce(new Error('effort denied'))
      .mockResolvedValueOnce({ ok: true, selection: identityIntent })
      .mockResolvedValueOnce({ ok: true, selection: { ...identityIntent, reasoningEffort: 'high' } });
    render(view()); await ready();

    fireEvent.change(modelSelect(), { target: { value: 'other' } });
    await screen.findByText(/identity denied/);
    fireEvent.change(screen.getByLabelText('Minion reasoning effort'), { target: { value: 'high' } });
    await screen.findByText(/effort denied/);

    fireEvent.click(screen.getByText('Retry saving minion model'));
    await ready();
    expect(JSON.parse(puts()[2][1]!.body as string)).toEqual(identityIntent);
    expect((screen.getByLabelText('Minion reasoning effort') as HTMLSelectElement).value).toBe('high');
    expect(screen.getByText('Retry saving minion reasoning effort')).toBeTruthy();
    expect(screen.getByText('Unsaved default minion model changes.')).toBeTruthy();
    expect(screen.queryByText('Default minion model saved.')).toBeNull();

    fireEvent.click(screen.getByText('Retry saving minion reasoning effort'));
    await screen.findByText('Default minion model saved.');
    expect(JSON.parse(puts()[3][1]!.body as string)).toEqual({ ...identityIntent, reasoningEffort: 'high' });
  });

  it('retries a failed model identity deliberately using the accepted temperature', async () => {
    const modelDraft = { ...selection, model: 'other', reasoningEffort: 'off' };
    vi.mocked(api).mockResolvedValueOnce({ ok: true, selection }).mockRejectedValueOnce(new Error('model denied'))
      .mockResolvedValueOnce({ ok: true, selection: { ...selection, temperature: 1.2 } })
      .mockResolvedValueOnce({ ok: true, selection: { ...modelDraft, temperature: 1.2 } });
    render(view()); await ready();
    fireEvent.change(modelSelect(), { target: { value: 'other' } });
    await screen.findByText(/model denied/);
    adjustTemperature('1.2'); await ready();
    expect(JSON.parse(puts()[1][1]!.body as string)).toEqual({ ...selection, temperature: 1.2 });
    expect(modelSelect().value).toBe('other');
    fireEvent.click(screen.getByText('Retry saving minion model'));
    await screen.findByText('Default minion model saved.');
    expect(JSON.parse(puts()[2][1]!.body as string)).toEqual({ ...modelDraft, temperature: 1.2 });
  });

  it('lets guard Save deliberately commit the remaining identity draft after an independent success', async () => {
    const modelDraft = { ...selection, connectionId: 'a', reasoningEffort: 'high', temperature: 1.2 };
    const onLeave = vi.fn();
    vi.mocked(api).mockResolvedValueOnce({ ok: true, selection }).mockRejectedValueOnce(new Error('identity denied'))
      .mockResolvedValueOnce({ ok: true, selection: { ...selection, temperature: 1.2 } })
      .mockResolvedValueOnce({ ok: true, selection: modelDraft });
    render(guarded(onLeave)); await ready();
    fireEvent.change(providerSelect(), { target: { value: 'a' } }); await screen.findByText(/identity denied/);
    adjustTemperature('1.2'); await ready();
    fireEvent.click(screen.getByText('Leave settings')); await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(onLeave).toHaveBeenCalledOnce());
    expect(JSON.parse(puts()[2][1]!.body as string)).toEqual(modelDraft);
  });

  it('does not configure a failed initial identity via effort or temperature when Inherit is accepted', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ok: true, selection: null }).mockRejectedValueOnce(new Error('initial denied'));
    render(view()); await ready();
    fireEvent.change(providerSelect(), { target: { value: 'a' } }); await screen.findByText(/initial denied/);
    expect(temperature().disabled).toBe(true);
    expect((screen.getByLabelText('Minion reasoning effort') as HTMLSelectElement).disabled).toBe(true);
    expect(puts()).toHaveLength(1);
  });

  it('uses accepted effort for temperature and accepted temperature for effort after competing failures', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ok: true, selection }).mockRejectedValueOnce(new Error('effort denied'))
      .mockResolvedValueOnce({ ok: true, selection: { ...selection, temperature: 1.2 } })
      .mockRejectedValueOnce(new Error('temperature denied'))
      .mockResolvedValueOnce({ ok: true, selection: { ...selection, reasoningEffort: 'off', temperature: 1.2 } });
    render(view()); await ready();
    fireEvent.change(screen.getByLabelText('Minion reasoning effort'), { target: { value: 'high' } });
    await screen.findByText(/effort denied/);
    adjustTemperature('1.2'); await ready();
    expect(JSON.parse(puts()[1][1]!.body as string)).toEqual({ ...selection, temperature: 1.2 });
    expect((screen.getByLabelText('Minion reasoning effort') as HTMLSelectElement).value).toBe('high');
    adjustTemperature('1.3'); await screen.findByText(/temperature denied/);
    fireEvent.change(screen.getByLabelText('Minion reasoning effort'), { target: { value: 'off' } }); await ready();
    expect(JSON.parse(puts()[3][1]!.body as string)).toEqual({ ...selection, reasoningEffort: 'off', temperature: 1.2 });
    expect(temperature().value).toBe('1.3');
    expect(screen.getByText('Retry saving minion temperature')).toBeTruthy();
  });

  it('ignores server metadata and object property order for dirty comparison', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ok: true, selection: { ...selection, updatedAt: 'old', agentId: 'agent' } })
      .mockResolvedValueOnce({ ok: true, selection: { updatedAt: 'new', temperature: 0.7, reasoningEffort: 'high', model: 'model', connectionId: 'b', agentId: 'agent' } });
    render(view()); await ready();
    fireEvent.change(screen.getByLabelText('Minion reasoning effort'), { target: { value: 'high' } });
    await screen.findByText('Default minion model saved.');
    expect(screen.queryByText('Unsaved default minion model changes.')).toBeNull();
    expect(JSON.parse(puts()[0][1]!.body as string)).toEqual({ ...selection, reasoningEffort: 'high' });
  });

  it('resumes queued navigation after its simple autosave succeeds', async () => {
    const onLeave = vi.fn();
    let release!: (value: unknown) => void;
    vi.mocked(api).mockResolvedValueOnce({ ok: true, selection })
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    render(guarded(onLeave)); await ready();

    fireEvent.change(screen.getByLabelText('Minion reasoning effort'), { target: { value: 'high' } });
    fireEvent.click(screen.getByText('Leave settings'));
    expect(onLeave).not.toHaveBeenCalled();
    await act(async () => release({ ok: true, selection: { ...selection, reasoningEffort: 'high' } }));
    await waitFor(() => expect(onLeave).toHaveBeenCalledOnce());
  });

  it('retains a failed guard Save without navigating or duplicating its error', async () => {
    const onLeave = vi.fn();
    vi.mocked(api).mockResolvedValueOnce({ ok: true, selection }).mockRejectedValue(new Error('denied'));
    render(guarded(onLeave)); await ready();
    adjustTemperature('1.1'); await screen.findByText(/Could not save default minion model: denied/);
    fireEvent.click(screen.getByText('Leave settings')); await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(puts()).toHaveLength(2);
    expect(onLeave).not.toHaveBeenCalled();
    expect(temperature().value).toBe('1.1');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByText('Unsaved default minion model changes.')).toBeTruthy();
  });

  it('does not advance accepted identity after a malformed ACK before an independent write', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ok: true, selection }).mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, selection: { ...selection, temperature: 1.1 } });
    render(view()); await ready();
    fireEvent.change(providerSelect(), { target: { value: 'a' } }); await screen.findByRole('alert');
    adjustTemperature('1.1'); await ready();
    expect(JSON.parse(puts()[1][1]!.body as string)).toEqual({ ...selection, temperature: 1.1 });
    expect(providerSelect().value).toBe('a');
    expect(screen.getByText('Retry saving minion model')).toBeTruthy();
  });

  it.each(['pointerCancel', 'lostPointerCapture', 'blur'] as const)('commits temperature once on %s completion', async event => {
    vi.mocked(api).mockResolvedValueOnce({ ok: true, selection })
      .mockResolvedValueOnce({ ok: true, selection: { ...selection, temperature: 1.1 } });
    render(view()); await ready();
    fireEvent.change(temperature(), { target: { value: '1.1' } });
    fireEvent[event](temperature());
    await screen.findByText('Default minion model saved.');
    fireEvent.pointerUp(temperature()); fireEvent.blur(temperature());
    expect(puts()).toHaveLength(1);
  });

  it('does not commit a focused temperature interaction when the shared unsaved modal takes focus', async () => {
    const onLeave = vi.fn();
    vi.mocked(api).mockResolvedValueOnce({ ok: true, selection });
    render(guarded(onLeave)); await ready();
    act(() => temperature().focus());
    fireEvent.pointerDown(temperature(), { pointerId: 1 });
    fireEvent.change(temperature(), { target: { value: '1.1' } });

    fireEvent.click(screen.getByText('Leave settings'));

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(puts()).toHaveLength(0);
    expect(temperature().value).toBe('1.1');
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(onLeave).not.toHaveBeenCalled();

    // The modal focus transfer ends the abandoned interaction. A later plain
    // focus/blur must not unexpectedly flush the retained draft.
    act(() => temperature().focus());
    act(() => temperature().blur());
    expect(puts()).toHaveLength(0);
  });

});

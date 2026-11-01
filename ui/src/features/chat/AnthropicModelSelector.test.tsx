import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, SavedProvider } from '../../app/types';
import { ChatModelSelector, Chat } from './ChatPage';
const provider: SavedProvider = { id: 'native', provider: 'Native', apiType: 'anthropic-messages', url: '', apiKey: '', models: ['native', 'manual'], modelEfforts: { native: ['low', 'high', 'xhigh'] }, connectionModels: [{ id: 'native', thinkingModes: ['default', 'adaptive', 'between_tools'], thinkingEfforts: { default: ['low', 'high', 'max'], adaptive: ['low', 'high', 'max'], between_tools: ['low', 'high'] } }, { id: 'manual', thinkingModes: ['default', 'disabled', 'enabled'], thinkingEfforts: { default: [], disabled: [], enabled: [] } }] };
const agent = { id: 'a', name: 'Agent', provider: 'Native', model: 'native', effort: 'off', thinkingMode: null, temperature: 0.2, avatar: '', context: null, activity: '', workspace: '', files: [], subagents: [] } satisfies Agent;
const props = { selected: agent as Agent, savedProviders: [provider], updateAgent: vi.fn(), sessions: [{ id: 'default' }], sessionId: 'default', onSessionChange: vi.fn(), onNewSession: vi.fn(), onNewNamedSession: vi.fn(), onCreateGroup: vi.fn() };
afterEach(cleanup);
describe('native chat/main selector', () => {
  it('retains unsupported legacy Off visibly and editable without saving or running on mount', () => {
    const updateAgent = vi.fn(), onSelectionBlockedChange = vi.fn();
    render(<ChatModelSelector {...props} updateAgent={updateAgent} onSelectionBlockedChange={onSelectionBlockedChange} />);
    const select = screen.getByRole('combobox', { name: 'Thinking' }) as HTMLSelectElement;
    expect(select.value).toBe(''); expect(select.selectedOptions[0].text).toBe('Legacy · Off (unsupported)');
    expect(select.disabled).toBe(false); expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('cannot disable');
    expect(updateAgent).not.toHaveBeenCalled(); expect(onSelectionBlockedChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole('option', { name: 'Disabled' })).toBeNull();
  });
  it('saves mode and effort as one intent, interpreting off as Default without changing raw effort', async () => {
    const updateAgent = vi.fn().mockResolvedValue(true);
    const view = render(<ChatModelSelector {...props} updateAgent={updateAgent} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Thinking' }), { target: { value: 'adaptive' } });
    await waitFor(() => expect(updateAgent).toHaveBeenCalledWith({ thinkingMode: 'adaptive', effort: 'off' }));
    view.rerender(<ChatModelSelector {...props} selected={{ ...agent, thinkingMode: 'adaptive' }} updateAgent={updateAgent} />);
    expect((screen.getByRole('combobox', { name: 'Effort' }) as HTMLSelectElement).selectedOptions[0].text).toBe('Default');
  });
  it('retains incompatible effort and stages a mode until its counterpart is deliberately corrected', async () => {
    const updateAgent = vi.fn().mockResolvedValue(true), blocked = vi.fn();
    render(<ChatModelSelector {...props} selected={{ ...agent, thinkingMode: 'adaptive', effort: 'max' }} updateAgent={updateAgent} onSelectionBlockedChange={blocked} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Thinking' }), { target: { value: 'between_tools' } });
    expect(updateAgent).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'Effort' })).toHaveProperty('value', 'max');
    expect(screen.getByRole('option', { name: 'Unavailable · max' })).toBeTruthy();
    expect(blocked).toHaveBeenLastCalledWith(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'Effort' }), { target: { value: 'high' } });
    await waitFor(() => expect(updateAgent).toHaveBeenCalledWith({ thinkingMode: 'between_tools', effort: 'high' }));
  });
  it('keeps a failed mode draft and offers retry, without accepting a different choice', async () => {
    const updateAgent = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<ChatModelSelector {...props} updateAgent={updateAgent} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Thinking' }), { target: { value: 'adaptive' } });
    await screen.findByRole('button', { name: 'Retry model selection' });
    expect(screen.getByRole('combobox', { name: 'Thinking' })).toHaveProperty('value', 'adaptive');
    fireEvent.click(screen.getByRole('button', { name: 'Retry model selection' }));
    await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(2));
    expect(updateAgent.mock.calls[1][0]).toEqual({ thinkingMode: 'adaptive', effort: 'off' });
  });
  it('locks mode controls during a save and ignores failure from a departed owner', async () => {
    let release!: (value: boolean) => void;
    const updateAgent = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    const result = render(<ChatModelSelector {...props} updateAgent={updateAgent} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Thinking' }), { target: { value: 'adaptive' } });
    expect(screen.getByRole('combobox', { name: 'Thinking' })).toHaveProperty('disabled', true);
    result.rerender(<ChatModelSelector {...props} selected={{ ...agent, id: 'b', thinkingMode: 'default' }} updateAgent={updateAgent} />);
    await act(async () => { release(false); });
    expect(screen.queryByRole('button', { name: 'Retry model selection' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Thinking' })).toHaveProperty('value', 'default');
  });
  it('places tuning on its own line inside the existing toolbar and preserves session controls', () => {
    render(<ChatModelSelector {...props} selected={{ ...agent, thinkingMode: 'default' }} />);
    const mode = screen.getByRole('combobox', { name: 'Thinking' });
    expect(mode.closest('.model-tuning-controls')?.parentElement?.className).toContain('workspace-toolbar');
    expect(screen.getByRole('combobox', { name: 'Model' }).closest('.model-tuning-controls')).toBeNull();
    expect(screen.getByRole('button', { name: 'Group Chat' }).closest('.model-tuning-controls')).toBeNull();
  });
  it('offers Manual only when the server advertises it and selects explicit defaults on a deliberate model switch', () => {
    const updateAgent = vi.fn(); render(<ChatModelSelector {...props} updateAgent={updateAgent} />);
    expect(screen.queryByRole('option', { name: 'Manual' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'manual' } });
    expect(updateAgent).toHaveBeenCalledWith({ provider: 'Native', model: 'manual', thinkingMode: 'default', effort: 'off' });
  });
  it('leaves other providers without native controls', () => {
    render(<ChatModelSelector {...props} selected={{ ...agent, provider: 'Other' }} savedProviders={[{ ...provider, provider: 'Other', apiType: 'openai-responses' }]} />);
    expect(screen.queryByRole('combobox', { name: 'Thinking' })).toBeNull();
    expect(screen.getByRole('option', { name: 'off' })).toBeTruthy();
  });
  it('does not send a draft while its displayed model choice is unaccepted', () => {
    const onSend = vi.fn();
    render(<Chat selected={agent} parent={agent} operator={{ name: 'Operator', avatar: '' }} draft="Retain me" setDraft={vi.fn()} attached={[]} onAttach={vi.fn()} onRemoveAttachment={vi.fn()} isNewSession={false} turns={[]} isLoading={false} error="" isSending={false} activeRunId="" liveProgress={[]} liveAnswer="" onSend={onSend} onCancel={vi.fn()} selectionBlocked />);
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', true);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled(); expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', 'Retain me');
  });
});


it('locks old-model tuning throughout a pending identity save, so it cannot merge into the new model', async () => {
 let release!: (value: boolean) => void;
 const updateAgent=vi.fn(()=>new Promise<boolean>(resolve=>{release=resolve;})), blocked=vi.fn();
 render(<ChatModelSelector {...props} selected={{...agent,thinkingMode:'adaptive',effort:'max'}} updateAgent={updateAgent} onSelectionBlockedChange={blocked} />);
 fireEvent.change(screen.getByRole('combobox',{name:'Model'}),{target:{value:'manual'}});
 expect(updateAgent).toHaveBeenCalledWith({provider:'Native',model:'manual',thinkingMode:'default',effort:'off'});
 expect(screen.getByRole('combobox',{name:'Thinking'})).toHaveProperty('disabled',true);
 expect(screen.getByRole('combobox',{name:'Effort'})).toHaveProperty('disabled',true);
 fireEvent.change(screen.getByRole('combobox',{name:'Effort'}),{target:{value:'high'}});
 expect(updateAgent).toHaveBeenCalledTimes(1);expect(blocked).toHaveBeenLastCalledWith(true);
 await act(async()=>release(false));
 await screen.findByRole('button',{name:'Retry model selection'});
});
it('retains the exact pending draft and retry after an owner round-trip', async () => {
 let release!: (value: boolean) => void;
 const updateAgent=vi.fn(()=>new Promise<boolean>(resolve=>{release=resolve;})), blocked=vi.fn();
 const view=render(<ChatModelSelector {...props} selected={{...agent,thinkingMode:'default'}} updateAgent={updateAgent} onSelectionBlockedChange={blocked} />);
 fireEvent.change(screen.getByRole('combobox',{name:'Thinking'}),{target:{value:'adaptive'}});
 view.rerender(<ChatModelSelector {...props} selected={{...agent,id:'b',thinkingMode:'default'}} updateAgent={updateAgent} onSelectionBlockedChange={blocked} />);
 expect(screen.getByRole('combobox',{name:'Thinking'})).toHaveProperty('value','default');
 view.rerender(<ChatModelSelector {...props} selected={{...agent,thinkingMode:'default'}} updateAgent={updateAgent} onSelectionBlockedChange={blocked} />);
 expect(screen.getByRole('combobox',{name:'Thinking'})).toHaveProperty('value','adaptive');
 expect(screen.getByRole('combobox',{name:'Thinking'})).toHaveProperty('disabled',true);expect(blocked).toHaveBeenLastCalledWith(true);
 await act(async()=>release(false));await screen.findByRole('button',{name:'Retry model selection'});
 expect(screen.getByRole('combobox',{name:'Thinking'})).toHaveProperty('value','adaptive');expect(blocked).toHaveBeenLastCalledWith(true);
});
it('uses native controls and legacy Off validation for an Anthropic pool', () => {
 render(<ChatModelSelector {...props} savedProviders={[{...provider,apiType:'anthropic-lb'}]} />);
 expect(screen.getByRole('combobox',{name:'Thinking'}).getAttribute('aria-invalid')).toBe('true');
 expect(screen.getByRole('option',{name:'Adaptive'})).toBeTruthy();
});

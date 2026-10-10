import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentToolbar } from './AgentToolbar';
import { api } from '../../app/api';
vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const callbacks = () => ({ onSelect: vi.fn(), onAgentsChanged: vi.fn(async () => {}), onModelConnectionsChanged: vi.fn(async () => {}), onOperatorProfileChanged: vi.fn(), onFirstRunComplete: vi.fn() });
async function mount(props = callbacks()) {
 let view!: ReturnType<typeof render>;
 await act(async () => { view = render(<AgentToolbar agents={[]} selectedId="" firstRun {...props} />); });
 return { view, props };
}
function fill() {
 fireEvent.click(screen.getByText('Start fresh'));
 fireEvent.change(screen.getByPlaceholderText('Your name'), { target: { value: 'Original operator' } });
 fireEvent.click(screen.getByText('Next'));
 fireEvent.change(screen.getByPlaceholderText('Luna'), { target: { value: 'Original agent' } });
 fireEvent.click(screen.getByText('Next'));
 fireEvent.change(screen.getByPlaceholderText('Who is this agent?'), { target: { value: 'Original soul' } });
 fireEvent.click(screen.getByText('Next'));
}
const writes = () => vi.mocked(api).mock.calls.filter(([path]) => path === '/api/setup/operation').map(([, options]) => JSON.parse(String(options?.body)));
it('real wizard retains submission while delayed, blocks duplicate sends, and ignores callbacks after unmount', async () => {
 let resolve!: (value: { agent: { id: string } }) => void;
 vi.mocked(api).mockImplementation(path => path === '/api/setup/operation' ? new Promise(r => { resolve = r; }) : Promise.resolve({ connections: [] }));
 const { view, props } = await mount(); fill();
 fireEvent.click(screen.getByText('Skip / Finish'));
 const payload = writes()[0];
 expect(payload.documents).toEqual([
  { kind: 'SOUL', markdown: 'Original soul' },
  ...['RULES', 'ORIENTATION', 'PREFERENCES', 'TOOLS', 'DREAM_MEMORY'].map(kind => ({ kind, markdown: '' })),
 ]);
 expect(JSON.parse(localStorage.getItem('hc.setupOperation')!)).toEqual(payload);
 expect(screen.getByText('Creating…').hasAttribute('disabled')).toBe(true);
 fireEvent.click(screen.getByText('Creating…'));
 expect(writes()).toHaveLength(1);
 view.unmount();
 await act(async () => { resolve({ agent: { id: payload.agent.id } }); });
 for (const callback of Object.values(props)) expect(callback).not.toHaveBeenCalled();
 expect(localStorage.getItem('hc.setupOperation')).toBeNull();
});
it('real wizard reloads a lost-response submission and retries its exact original payload despite edits', async () => {
 vi.mocked(api).mockImplementation(async path => {
  if (path === '/api/setup/operation') throw new Error('response lost');
  return { connections: [] };
 });
 const first = await mount(); fill();
 await act(async () => { fireEvent.click(screen.getByText('Skip / Finish')); });
 const original = writes()[0];
 expect(screen.getByRole('alert').textContent).toContain('Retry to recover the original submission');
 expect(JSON.parse(localStorage.getItem('hc.setupOperation')!)).toEqual(original);
 first.view.unmount();
 const second = await mount();
 expect(screen.getByText('Choose a model')).toBeTruthy();
 fireEvent.click(screen.getByText('Back'));
 expect((screen.getByPlaceholderText('Who is this agent?') as HTMLTextAreaElement).value).toBe('Original soul');
 fireEvent.change(screen.getByPlaceholderText('Who is this agent?'), { target: { value: 'Edited soul' } });
 fireEvent.click(screen.getByText('Back'));
 expect((screen.getByPlaceholderText('Luna') as HTMLInputElement).value).toBe('Original agent');
 fireEvent.change(screen.getByPlaceholderText('Luna'), { target: { value: 'Edited agent' } });
 fireEvent.click(screen.getByText('Next')); fireEvent.click(screen.getByText('Next'));
 vi.mocked(api).mockImplementation(async path => path === '/api/setup/operation' ? { agent: { id: original.agent.id } } : { connections: [] });
 await act(async () => { fireEvent.click(screen.getByText('Skip / Finish')); });
 expect(writes()).toEqual([original, original]);
 expect(second.props.onOperatorProfileChanged).toHaveBeenCalledWith(original.operator);
 expect(second.props.onSelect).toHaveBeenCalledWith(original.agent.id);
 expect(second.props.onAgentsChanged).toHaveBeenCalledTimes(1);
 expect(second.props.onModelConnectionsChanged).toHaveBeenCalledTimes(1);
 expect(localStorage.getItem('hc.setupOperation')).toBeNull();
 expect(screen.getByText('You magnificent thing.')).toBeTruthy();
});
it('real wizard reports unavailable durable storage without sending an unrecoverable write', async () => {
 vi.mocked(api).mockResolvedValue({ connections: [] });
 await mount(); fill();
 vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded'); });
 await act(async () => { fireEvent.click(screen.getByText('Skip / Finish')); });
 expect(writes()).toHaveLength(0);
 expect(screen.getByRole('alert').textContent).toContain('quota exceeded');
 expect(screen.getByText('Skip / Finish').hasAttribute('disabled')).toBe(false);
});
it('first run works without randomUUID and retries the retained payload after a lost response', async () => {
 vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
 expect(typeof crypto.randomUUID).toBe('undefined');
 vi.mocked(api).mockImplementation(async path => {
  if (path === '/api/setup/operation') throw new Error('response lost');
  return { connections: [] };
 });
 await mount(); fill();
 await act(async () => { fireEvent.click(screen.getByText('Skip / Finish')); });
 const original = writes()[0];
 expect(original.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 await act(async () => { fireEvent.click(screen.getByText('Skip / Finish')); });
 expect(writes()).toEqual([original, original]);
 expect(screen.getByRole('alert').textContent).toContain('Retry to recover the original submission');
});
it('payload generation failure does not claim an original submission was sent', async () => {
 vi.mocked(api).mockResolvedValue({ connections: [] });
 await mount(); fill();
 vi.spyOn(crypto, 'randomUUID').mockImplementation(() => { throw new Error('randomness unavailable'); });
 await act(async () => { fireEvent.click(screen.getByText('Skip / Finish')); });
 expect(writes()).toHaveLength(0);
 expect(localStorage.getItem('hc.setupOperation')).toBeNull();
 expect(screen.getByRole('alert').textContent).toContain('randomness unavailable');
 expect(screen.getByRole('alert').textContent).not.toContain('Retry to recover');
});

it('repairs only the old five-kind retained submission durably and retries with its original identity', async () => {
 const original = {
  operationId: 'retained-pre-fix-id', operator: { name: 'Saved operator', avatar: 'operator-avatar' },
  agent: { id: 'saved-agent', name: 'Saved agent', enabled: true }, agentIdentity: { avatar: 'agent-avatar' },
  documents: ['SOUL', 'RULES', 'ORIENTATION', 'TOOLS', 'DREAM_MEMORY'].map(kind => ({ kind, markdown: `Saved ${kind}` })),
  modelSelection: { connectionId: 'saved-connection', model: 'saved-model' },
 };
 const repaired = { ...original, documents: [
  ...original.documents.slice(0, 3), { kind: 'PREFERENCES', markdown: '' }, ...original.documents.slice(3),
 ] };
 localStorage.setItem('hc.setupOperation', JSON.stringify(original));
 vi.mocked(api).mockImplementation(async path => {
  if (path === '/api/setup/operation') {
   expect(JSON.parse(localStorage.getItem('hc.setupOperation')!)).toEqual(repaired);
   throw new Error('response lost');
  }
  return { connections: [] };
 });
 const first = await mount();
 await act(async () => { fireEvent.click(screen.getByText('Skip / Finish')); });
 expect(writes()).toEqual([repaired]);
 first.view.unmount();
 const second = await mount();
 vi.mocked(api).mockImplementation(async path => path === '/api/setup/operation' ? { agent: { id: original.agent.id } } : { connections: [] });
 await act(async () => { fireEvent.click(screen.getByText('Skip / Finish')); });
 expect(writes()).toEqual([repaired, repaired]);
 expect(second.props.onSelect).toHaveBeenCalledWith(original.agent.id);
 expect(localStorage.getItem('hc.setupOperation')).toBeNull();
});
it('does not send a legacy repair when durable persistence fails', async () => {
 const original = { operationId: 'old-id', operator: { name: 'Operator', avatar: '' },
  agent: { id: 'agent', name: 'Agent', enabled: true }, agentIdentity: { avatar: '' },
  documents: ['SOUL', 'RULES', 'ORIENTATION', 'TOOLS', 'DREAM_MEMORY'].map(kind => ({ kind, markdown: '' })) };
 localStorage.setItem('hc.setupOperation', JSON.stringify(original));
 vi.mocked(api).mockResolvedValue({ connections: [] });
 await mount();
 vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded'); });
 await act(async () => { fireEvent.click(screen.getByText('Skip / Finish')); });
 expect(writes()).toHaveLength(0);
 expect(JSON.parse(localStorage.getItem('hc.setupOperation')!)).toEqual(original);
 expect(screen.getByRole('alert').textContent).toContain('quota exceeded');
});

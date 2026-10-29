import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import type { Agent } from '../../app/types';
import { AgentSettings } from './AgentSettings';
import { MinionDepthSettings } from './MinionDepthSettings';

vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(api).mockReset(); });
const slider = () => screen.getByRole('slider', { name: 'Maximum minion depth' }) as HTMLInputElement;
const ready = () => waitFor(() => expect(slider().disabled).toBe(false));
const view = (id: string) => <MinionDepthSettings key={id} resourceId={id} />;
function Leave({ onLeave }: { onLeave: () => void }) {
  const navigate = useUnsavedNavigation();
  return <button onClick={() => navigate(onLeave)}>Leave</button>;
}

describe('Per-agent minion depth', () => {
  it.each([0, 1, 2])('loads depth %s and autosaves on commit using encoded resource identity', async depth => {
    vi.mocked(api).mockResolvedValueOnce({ ok: true, maxDepth: depth }).mockResolvedValueOnce({ ok: true, maxDepth: (depth + 1) % 3 });
    render(view('agent/name'));
    expect(slider().value).toBe('1');
    expect(slider().disabled).toBe(true);
    await ready();
    expect(slider().value).toBe(String(depth));
    const marks = slider().parentElement?.querySelector('.minion-depth-marks');
    expect(marks?.textContent).toBe('012');
    expect(marks?.getAttribute('aria-hidden')).toBe('true');
    expect(slider().min).toBe('0'); expect(slider().max).toBe('2'); expect(slider().step).toBe('1');
    expect(api).toHaveBeenCalledWith('/api/agents/agent%2Fname/minion-settings', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    fireEvent.change(slider(), { target: { value: String((depth + 1) % 3) } });
    await screen.findByText('Minion depth saved.');
    expect(api).toHaveBeenLastCalledWith('/api/agents/agent%2Fname/minion-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxDepth: (depth + 1) % 3 }) });
    expect(screen.queryByText('Unsaved minion depth changes.')).toBeNull();
  });

  it('retries a failed load without treating the default as loaded; retains drafts after failed saves', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, maxDepth: 1 }).mockRejectedValueOnce(new Error('denied'));
    render(view('agent'));
    await screen.findByText('Could not load minion depth: offline');
    expect(slider().disabled).toBe(true);
    fireEvent.click(screen.getByText('Retry minion depth'));
    await ready();
    fireEvent.change(slider(), { target: { value: '2' } });
    await screen.findByText('Could not save minion depth: denied');
    expect(slider().value).toBe('2');
    expect(screen.getByText('Unsaved minion depth changes.')).toBeTruthy();
    expect(screen.queryByText('Minion depth saved.')).toBeNull();
  });

  it('does not accept unsuccessful or malformed response payloads as saved settings', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ok: false, maxDepth: 1 }).mockResolvedValueOnce({ ok: true, maxDepth: 1 }).mockResolvedValueOnce({ ok: true, maxDepth: 3 });
    render(view('agent'));
    await screen.findByText('Could not load minion depth: Invalid minion settings response');
    fireEvent.click(screen.getByText('Retry minion depth'));
    await ready();
    fireEvent.change(slider(), { target: { value: '2' } });
    await screen.findByText('Could not save minion depth: Invalid minion settings response');
    expect(slider().value).toBe('2');
    expect(screen.queryByText('Minion depth saved.')).toBeNull();
  });

  it('ignores a stale load after switching agents', async () => {
    let release!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce({ ok: true, maxDepth: 0 });
    const { rerender } = render(view('old'));
    rerender(view('new'));
    await ready();
    await act(async () => release({ ok: true, maxDepth: 2 }));
    expect(slider().value).toBe('0');
  });

  it('blocks duplicate saves while pending and ignores stale save completion after switching agents', async () => {
    let release!: (value: unknown) => void;
    vi.mocked(api).mockResolvedValueOnce({ ok: true, maxDepth: 1 }).mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce({ ok: true, maxDepth: 0 });
    const { rerender } = render(view('old'));
    await ready();
    fireEvent.change(slider(), { target: { value: '2' } });
    expect(screen.getByText('Saving minion depth…')).toBeTruthy(); expect(slider().disabled).toBe(true);
    fireEvent.pointerUp(slider());
    expect(api).toHaveBeenCalledTimes(2);
    rerender(view('new'));
    await ready();
    await act(async () => release({ ok: true, maxDepth: 2 }));
    expect(slider().value).toBe('0');
    expect(screen.queryByText('Minion depth saved.')).toBeNull();
  });

  it('guards unsaved navigation: Stay retains the draft and Discard restores without PUT', async () => {
    vi.mocked(api).mockResolvedValue({ ok: true, maxDepth: 1 });
    const leave = vi.fn();
    render(<UnsavedChangesProvider><MinionDepthSettings resourceId="agent" /><Leave onLeave={leave} /></UnsavedChangesProvider>);
    await ready();
    fireEvent.pointerDown(slider()); fireEvent.change(slider(), { target: { value: '0' } });
    fireEvent.click(screen.getByText('Leave'));
    fireEvent.click(screen.getByText('Stay'));
    expect(slider().value).toBe('0'); expect(leave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Leave'));
    fireEvent.click(screen.getByText('Discard'));
    expect(slider().value).toBe('1'); expect(leave).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('cancels guarded navigation on failed Save and permits it after successful Save', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ok: true, maxDepth: 1 }).mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce({ ok: true, maxDepth: 2 });
    const leave = vi.fn();
    render(<UnsavedChangesProvider><MinionDepthSettings resourceId="agent" /><Leave onLeave={leave} /></UnsavedChangesProvider>);
    await ready();
    fireEvent.pointerDown(slider()); fireEvent.change(slider(), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Leave'));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await screen.findByText('Could not save minion depth: denied');
    expect(leave).not.toHaveBeenCalled(); expect(slider().value).toBe('2');
    fireEvent.click(screen.getByText('Leave'));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Unsaved minion depth changes.')).toBeNull();
  });

  it('mounts in the existing minion section and resets when target scope changes with the same resourceId', async () => {
    let release!: (value: unknown) => void;
    let loads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (String(path).endsWith('/minion-settings')) {
        if (++loads === 1) return new Promise(resolve => { release = resolve; });
        return { ok: true, maxDepth: 0 };
      }
      return { selection: null };
    });
    const agent: Agent = { id: 'target-a::agent', resourceId: 'agent/name', name: 'Agent', avatar: '', activity: 'Idle', context: null, provider: '', model: '', effort: '', temperature: 0.2, workspace: '', files: [], subagents: [] };
    const form = (selected: Agent) => <ConfirmProvider><AgentSettings selected={selected} savedProviders={[]} onAgentsChanged={vi.fn()} section="details" /></ConfirmProvider>;
    const { rerender } = render(form(agent));
    expect(screen.getByRole('heading', { name: 'Minion settings' }).parentElement?.contains(slider())).toBe(true);
    rerender(form({ ...agent, id: 'target-b::agent' }));
    await ready();
    await act(async () => release({ ok: true, maxDepth: 2 }));
    expect(slider().value).toBe('0');
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/api/agents/agent%2Fname/minion-settings')).toHaveLength(2);
  });
});

it('loads without mutation and commits one pointer adjustment with accepted response baseline', async () => {
 vi.mocked(api).mockResolvedValueOnce({ok:true,maxDepth:1}).mockResolvedValueOnce({ok:true,maxDepth:0});
 render(<MinionDepthSettings resourceId="a/b" />); await ready(); expect(api).toHaveBeenCalledTimes(1);
 fireEvent.pointerDown(slider()); fireEvent.change(slider(), {target:{value:'0'}}); fireEvent.change(slider(), {target:{value:'2'}}); expect(api).toHaveBeenCalledTimes(1);
 fireEvent.pointerUp(slider()); await screen.findByText('Minion depth saved.'); expect(slider().value).toBe('0');
 expect(api).toHaveBeenLastCalledWith('/api/agents/a%2Fb/minion-settings',expect.objectContaining({body:'{"maxDepth":2}'}));
});
it('commits keyboard on keyup and preserves failed value for guarded retry', async () => {
 vi.mocked(api).mockResolvedValueOnce({ok:true,maxDepth:1}).mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce({ok:true,maxDepth:2}); const leave=vi.fn();
 render(<UnsavedChangesProvider><MinionDepthSettings resourceId="a"/><Leave onLeave={leave}/></UnsavedChangesProvider>); await ready();
 fireEvent.keyDown(slider(),{key:'ArrowRight'}); fireEvent.change(slider(),{target:{value:'2'}}); expect(api).toHaveBeenCalledTimes(1); fireEvent.keyUp(slider(),{key:'ArrowRight'});
 await screen.findByText('Could not save minion depth: denied'); expect(slider().value).toBe('2');
 fireEvent.click(screen.getByText('Leave')); fireEvent.click(screen.getByRole('button',{name:'Save'})); await waitFor(()=>expect(leave).toHaveBeenCalledOnce());
});
it('isolates late save from another agent and locks while saving', async () => {
 let release!: (value: unknown) => void; vi.mocked(api).mockResolvedValueOnce({ok:true,maxDepth:1}).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;})).mockResolvedValueOnce({ok:true,maxDepth:0});
 const {rerender}=render(<MinionDepthSettings key="a" resourceId="a"/>); await ready(); fireEvent.change(slider(),{target:{value:'2'}}); expect(slider().disabled).toBe(true);
 rerender(<MinionDepthSettings key="b" resourceId="b"/>); await ready(); await act(async()=>release({ok:true,maxDepth:2})); expect(slider().value).toBe('0'); expect(screen.queryByText('Minion depth saved.')).toBeNull();
});

it.each(['pointerCancel', 'lostPointerCapture', 'blur'] as const)('commits a touch adjustment once on %s', async end => {
 vi.mocked(api).mockResolvedValueOnce({ok:true,maxDepth:1}).mockResolvedValueOnce({ok:true,maxDepth:2});
 render(view('touch')); await ready();
 fireEvent.pointerDown(slider(), {pointerId:7,pointerType:'touch'}); fireEvent.change(slider(),{target:{value:'2'}});
 expect(api).toHaveBeenCalledTimes(1);
 fireEvent[end](slider(), {pointerId:7,pointerType:'touch'}); fireEvent.pointerUp(slider(),{pointerId:7,pointerType:'touch'});
 await screen.findByText('Minion depth saved.'); expect(api).toHaveBeenCalledTimes(2);
});
it('does not commit no-op or an escaped keyboard adjustment on subsequent blur', async () => {
 vi.mocked(api).mockResolvedValue({ok:true,maxDepth:1}); render(view('a')); await ready();
 fireEvent.pointerDown(slider(),{pointerId:1,pointerType:'touch'}); fireEvent.pointerUp(slider(),{pointerId:1,pointerType:'touch'});
 fireEvent.keyDown(slider(),{key:'ArrowRight'}); fireEvent.change(slider(),{target:{value:'2'}}); fireEvent.keyDown(slider(),{key:'Escape'}); fireEvent.blur(slider());
 expect(slider().value).toBe('1'); expect(api).toHaveBeenCalledTimes(1);
});
it('resets active interaction when resource changes without remount', async () => {
 vi.mocked(api).mockResolvedValueOnce({ok:true,maxDepth:1}).mockResolvedValueOnce({ok:true,maxDepth:0}).mockResolvedValueOnce({ok:true,maxDepth:2});
 const {rerender}=render(<MinionDepthSettings resourceId="a"/>); await ready(); fireEvent.pointerDown(slider(),{pointerId:2,pointerType:'touch'}); fireEvent.change(slider(),{target:{value:'2'}});
 rerender(<MinionDepthSettings resourceId="b"/>); await ready(); fireEvent.change(slider(),{target:{value:'2'}}); await screen.findByText('Minion depth saved.'); expect(api).toHaveBeenCalledTimes(3);
});

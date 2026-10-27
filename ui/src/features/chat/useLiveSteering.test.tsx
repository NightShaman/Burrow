import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { isChatRunNotFoundError, useLiveSteering } from './useLiveSteering';
vi.mock('../../app/api', () => ({api: vi.fn()}));
const input = {id: 'durable-1', status: 'pending', message: 'change direction', createdAt: '2026-10-10'};
it('recognizes only the exact unknown-run 404 used for normal-send reconciliation', () => {
 const missing = Object.assign(new Error('chat_run_not_found'), {status: 404});
 expect(isChatRunNotFoundError(missing)).toBe(true);
 expect(isChatRunNotFoundError(Object.assign(new Error('chat_run_not_found'), {status: 503}))).toBe(false);
 expect(isChatRunNotFoundError(Object.assign(new Error('other_not_found'), {status: 404}))).toBe(false);
});
beforeEach(() => {vi.clearAllMocks(); vi.mocked(api).mockResolvedValue({steering: []});});
it('submits to the existing run and merges durable acceptance without starting chat', async () => {
 const {result, unmount} = renderHook(() => useLiveSteering('agent', 'session', 'run'));
 await waitFor(() => expect(api).toHaveBeenCalled());
 vi.mocked(api).mockResolvedValueOnce({steering: input});
 await act(async () => {await result.current.submit('change direction', []);});
 expect(result.current.inputs).toEqual([input]);
 const [path, request] = vi.mocked(api).mock.calls.filter(([, request]) => request?.method === 'POST').at(-1)!;
 expect(path).toBe('/api/chat/run/steer');
 expect(JSON.parse(request!.body as string)).toMatchObject({agentId: 'agent', sessionId: 'session', message: 'change direction', idempotencyKey: expect.any(String)});
 unmount();
});
it('retains the retry identity on rejection and exposes no pretend accepted message', async () => {
 const {result, unmount} = renderHook(() => useLiveSteering('agent', 'session', 'run'));
 await waitFor(() => expect(api).toHaveBeenCalled());
 vi.mocked(api).mockRejectedValueOnce(new Error('404'));
 await act(async () => {await expect(result.current.submit('change direction', [])).rejects.toThrow('404');});
 const first = JSON.parse(vi.mocked(api).mock.calls.filter(([, request]) => request?.method === 'POST').at(-1)![1]!.body as string);
 expect(result.current.inputs).toEqual([]);
 vi.mocked(api).mockResolvedValueOnce({steering: {...input, status: 'follow_up'}});
 await act(async () => {await result.current.submit('change direction', []);});
 const second = JSON.parse(vi.mocked(api).mock.calls.filter(([, request]) => request?.method === 'POST').at(-1)![1]!.body as string);
 expect(second.idempotencyKey).toBe(first.idempotencyKey);
 expect(result.current.inputs[0].status).toBe('follow_up'); unmount();
});
it('does not leak a late acceptance into another session', async () => {
 const {result, rerender, unmount} = renderHook(({session}) => useLiveSteering('agent', session, 'run'), {initialProps: {session:'one'}});
 await waitFor(() => expect(api).toHaveBeenCalled());
 let resolve!: (value: unknown) => void;
 vi.mocked(api).mockImplementationOnce(() => new Promise(r => {resolve = r;}) as ReturnType<typeof api>);
 let pending!: ReturnType<typeof result.current.submit>;
 act(() => {pending = result.current.submit('change direction', []);});
 rerender({session:'two'});
 await act(async () => {resolve({steering:input}); expect(await pending).toBeNull();});
 expect(result.current.inputs).toEqual([]); unmount();
});
it('ignores old A visit acceptance after A→B→A', async () => {
 const {result,rerender,unmount} = renderHook(({session}) => useLiveSteering('agent',session,'run'),{initialProps:{session:'A'}});
 await waitFor(()=>expect(api).toHaveBeenCalled());
 let resolve!: (v: unknown)=>void;
 vi.mocked(api).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}) as ReturnType<typeof api>);
 let old!: ReturnType<typeof result.current.submit>;
 act(()=>{old=result.current.submit('old',[]);});
 rerender({session:'B'});rerender({session:'A'});
 await act(async()=>{resolve({steering:input});expect(await old).toBeNull();});
 expect(result.current.inputs).toEqual([]);unmount();
});

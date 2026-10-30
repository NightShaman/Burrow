import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Archive } from './ArchivePage';
import { archiveRepository, type ArchivePage } from './archiveRepository';
import type { ArchiveDetail, ArchiveSession, ContinuityCard, ContinuityCardGroup } from './archiveTypes';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function card(id: string, title: string): ContinuityCard {
  return { id, kind: 'continuity', agentId: 'smatchet', agentName: 'Smatchet', title, summary: `${title} summary`, firstSeen: '2026-08-20T00:00:00Z', lastSeen: '2026-08-21T00:00:00Z', recurrence: 2 };
}

function detail(value: ContinuityCard): ContinuityCardGroup {
  return { card: value, history: [], nextCursor: null, hasMore: false } as ContinuityCardGroup;
}

function collectionPage<T>(items: T[]): ArchivePage<T> { return { items, nextCursor: null, hasMore: false }; }

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); window.localStorage.clear(); });

describe('Archive detail selection', () => {
  it('sends selected local day and agent as server filters for chat and dreams', async () => {
    // Freeze only Date: async rendering and waitFor must retain real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 15, 12));
    const sessions = vi.spyOn(archiveRepository, 'listSessions').mockResolvedValue(collectionPage([]));
    vi.spyOn(archiveRepository, 'listContinuityCards').mockResolvedValue(collectionPage([]));
    const availability = vi.spyOn(archiveRepository, 'listCalendarAvailability').mockImplementation(async (kind, month, agentId) => ({ ok: true, kind, month, dates: agentId ? [`${month}-12`] : [`${month}-29`] }));
    const testAgents = [{ id: 'smatchet', name: 'Smatchet', avatar: '', activity: '', context: null, provider: '', model: '', effort: '', temperature: 0, workspace: '', files: [], subagents: [] }];
    const dreams = vi.spyOn(archiveRepository, 'listDreams').mockResolvedValue(collectionPage([]));
    render(<Archive repository={archiveRepository} agents={testAgents} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Select 2026-09-29, has archived records' }));
    await waitFor(() => expect(sessions).toHaveBeenCalledWith('', expect.any(AbortSignal), null, '2026-09-29', undefined));
    expect(availability).toHaveBeenCalledWith('sessions', expect.stringMatching(/^\d{4}-\d{2}$/), undefined, expect.any(AbortSignal));
    const agentSelect = screen.getByRole('combobox', { name: 'Filter by agent' });
    Object.defineProperty(agentSelect, 'options', { configurable: true, value: [{ value: '' }, { value: 'smatchet' }] });
    fireEvent.change(agentSelect, { target: { value: 'smatchet' } });
    await waitFor(() => expect(availability).toHaveBeenLastCalledWith('sessions', expect.stringMatching(/^\d{4}-\d{2}$/), 'smatchet', expect.any(AbortSignal)));

    fireEvent.click(screen.getByRole('button', { name: /Dreams/ }));
    await waitFor(() => expect(dreams).toHaveBeenCalledWith(expect.any(AbortSignal), null, undefined, 'smatchet', ''));
  });

  it('does not let a slower previous Tiddle request replace the current card', async () => {
    const firstCard = card('first', 'First card');
    const secondCard = card('second', 'Second card');
    const firstRequest = deferred<ContinuityCardGroup>();
    const secondRequest = deferred<ContinuityCardGroup>();

    vi.spyOn(archiveRepository, 'listContinuityCards').mockResolvedValue(collectionPage([firstCard, secondCard]));
    vi.spyOn(archiveRepository, 'listDreams').mockResolvedValue(collectionPage([]));
    vi.spyOn(archiveRepository, 'listSessions').mockResolvedValue(collectionPage([]));
    vi.spyOn(archiveRepository, 'loadContinuityCard').mockImplementation((selected) => selected.id === 'first' ? firstRequest.promise : secondRequest.promise);

    render(<Archive repository={archiveRepository} agents={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /Tiddle/ }));
    await screen.findByRole('button', { name: /First card/ });

    fireEvent.click(screen.getByRole('button', { name: /First card/ }));
    fireEvent.click(screen.getByRole('button', { name: /Second card/ }));
    await act(async () => secondRequest.resolve(detail(secondCard)));
    await screen.findByRole('heading', { level: 2, name: 'Second card' });
    await act(async () => firstRequest.resolve(detail(firstCard)));

    await waitFor(() => expect(screen.queryByRole('heading', { level: 2, name: 'First card' })).toBeNull());
    expect(screen.getByRole('heading', { level: 2, name: 'Second card' })).toBeTruthy();
  });
});


describe('Paginated chat history', () => {
  const session = (id: string): ArchiveSession => ({ id, sessionId: id, agentId: 'smatchet', agentName: 'Smatchet', title: id, summary: '', archived: true } as ArchiveSession);
  const page = (text: string, hasMore: boolean, nextCursor: string | null = null): ArchiveDetail => ({ session: { turns: [{ role: 'user', content: text, ts: text }] }, hasMore, nextCursor, historyStatus: 'complete' });
  it('loads earlier turns, preserves loaded history on failure, and shows the beginning', async () => {
    vi.spyOn(archiveRepository, 'listContinuityCards').mockResolvedValue(collectionPage([]));
    vi.spyOn(archiveRepository, 'listDreams').mockResolvedValue(collectionPage([]));
    vi.spyOn(archiveRepository, 'listSessions').mockResolvedValue(collectionPage([session('one')]));
    const load = vi.spyOn(archiveRepository, 'loadSession').mockResolvedValueOnce(page('new', true, 'older')).mockResolvedValueOnce(page('old', false));
    render(<Archive repository={archiveRepository} agents={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: /one.*turns/i }));
    await screen.findByText('new');
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await screen.findByText('old');
    expect(screen.getByText('new')).toBeTruthy();
    expect(screen.getByText('Beginning of retained history')).toBeTruthy();
    expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'one' }), expect.any(AbortSignal), 'older', undefined);
  });
  it('does not let a late older page enter the next selected conversation', async () => {
    vi.spyOn(archiveRepository, 'listContinuityCards').mockResolvedValue(collectionPage([]));
    vi.spyOn(archiveRepository, 'listDreams').mockResolvedValue(collectionPage([]));
    vi.spyOn(archiveRepository, 'listSessions').mockResolvedValue(collectionPage([session('one'), session('two')]));
    const old = deferred<ArchiveDetail>();
    vi.spyOn(archiveRepository, 'loadSession').mockImplementation((selected, _signal, before) => before ? old.promise : Promise.resolve(page(selected.sessionId, selected.sessionId === 'one', selected.sessionId === 'one' ? 'older' : null)));
    render(<Archive repository={archiveRepository} agents={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: /one.*turns/i }));
    await screen.findByRole('button', { name: 'Load earlier messages' });
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    fireEvent.click(screen.getByRole('button', { name: /two.*turns/i }));
    await act(async () => old.resolve(page('intruder', false)));
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'two' })).toBeTruthy());
    expect(screen.queryByText('intruder')).toBeNull();
  });
});

it('passes selected agent filter through the local archive repository', async () => {
  const sessions = vi.spyOn(archiveRepository, 'listSessions').mockResolvedValue(collectionPage([]));
  vi.spyOn(archiveRepository, 'listDreams').mockResolvedValue(collectionPage([]));
  vi.spyOn(archiveRepository, 'listContinuityCards').mockResolvedValue(collectionPage([]));
  vi.spyOn(archiveRepository, 'listCalendarAvailability').mockImplementation(async (kind, month) => ({ ok: true, kind, month, dates: [] }));
  const agent = { id: 'same', name: 'Local' } as any;
  render(<Archive agents={[agent]} repository={archiveRepository} />);
  fireEvent.change(screen.getByLabelText('Filter by agent'), { target: { value: agent.id } });
  await waitFor(() => expect(sessions).toHaveBeenLastCalledWith('', expect.anything(), null, undefined, 'same'));
});

it.each(['kind', 'search', 'unmount'])('FE-022 aborts pending chat pagination on %s', async (change) => {
  const pending = deferred<ArchivePage<ArchiveSession>>();
  const session = { agentId: 'a', sessionId: 's', id: 's', title: 'Scope session', summary: '', archived: true } as ArchiveSession;
  const list = vi.spyOn(archiveRepository, 'listSessions').mockImplementation((_q, _signal, cursor) => cursor ? pending.promise : Promise.resolve({ items: [session], nextCursor: 'next', hasMore: true }));
  vi.spyOn(archiveRepository, 'listDreams').mockResolvedValue(collectionPage([]));
  vi.spyOn(archiveRepository, 'listContinuityCards').mockResolvedValue(collectionPage([]));
  vi.spyOn(archiveRepository, 'listCalendarAvailability').mockResolvedValue({ ok: true, kind: 'sessions', month: '2026-09', dates: [] });
  const view = render(<Archive repository={archiveRepository} agents={[]} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Load more conversations' }));
  const signal = list.mock.calls.at(-1)?.[1];
  if (change === 'kind') fireEvent.click(screen.getByRole('button', { name: /Dreams/ }));
  if (change === 'search') fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'changed' } });
  if (change === 'unmount') view.unmount();
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(collectionPage([session])));
});

it('FE-023 displays cold loading, failure, retry and successful empty states', async () => {
  const pending = deferred<ArchivePage<ArchiveSession>>();
  const list = vi.spyOn(archiveRepository, 'listSessions').mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('Archive offline')).mockResolvedValue(collectionPage([]));
  vi.spyOn(archiveRepository, 'listDreams').mockResolvedValue(collectionPage([]));
  vi.spyOn(archiveRepository, 'listContinuityCards').mockResolvedValue(collectionPage([]));
  vi.spyOn(archiveRepository, 'listCalendarAvailability').mockResolvedValue({ ok: true, kind: 'sessions', month: '2026-09', dates: [] });
  render(<Archive repository={archiveRepository} agents={[]} />);
  expect(await screen.findByText('Loading conversations…')).toBeTruthy();
  await act(async () => pending.resolve(collectionPage([])));
  expect(await screen.findByText('No conversations match this shelf.')).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'new' } });
  expect(await screen.findByText('Archive offline')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry conversations' }));
  expect(await screen.findByText('No conversations match this shelf.')).toBeTruthy();
  expect(list).toHaveBeenCalledTimes(3);
});

it('FE-023 keeps scoped cache visibly stale on failed revalidation and retries', async () => {
  const { archiveQueryCacheKey, writeArchiveSessionCache } = await import('./archiveCache');
  writeArchiveSessionCache(archiveQueryCacheKey({ target: 'local', agent: '', query: '', date: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, kind: 'chat' }), []);
  vi.spyOn(archiveRepository, 'listSessions').mockRejectedValueOnce(new Error('Revalidation offline')).mockResolvedValue(collectionPage([]));
  vi.spyOn(archiveRepository, 'listContinuityCards').mockResolvedValue(collectionPage([]));
  vi.spyOn(archiveRepository, 'listCalendarAvailability').mockResolvedValue({ ok: true, kind: 'sessions', month: '2026-09', dates: [] });
  render(<Archive repository={archiveRepository} agents={[]} />);
  expect(await screen.findByText('Revalidation offline')).toBeTruthy();
  expect(screen.getByText('Showing stale cached conversations while revalidating.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry conversations' }));
  await waitFor(() => expect(screen.queryByText('Showing stale cached conversations while revalidating.')).toBeNull());
});

it('FE022 agent switch rejects late pagination rows in the rendered shelf', async () => {
  const pending = deferred<ArchivePage<ArchiveSession>>();
  const item = (id:string) => ({agentId:'a',sessionId:id,id,title:id,summary:'',archived:true} as ArchiveSession);
  const list = vi.spyOn(archiveRepository,'listSessions').mockImplementation((_q,_signal,cursor,_date,owner) => cursor ? pending.promise : Promise.resolve({items:[item(owner ? 'Current owner' : 'Old owner')],nextCursor: owner ? null : 'next',hasMore:!owner}));
  vi.spyOn(archiveRepository,'listContinuityCards').mockResolvedValue(collectionPage([]));
  vi.spyOn(archiveRepository,'listCalendarAvailability').mockResolvedValue({ok:true,kind:'sessions',month:'2026-09',dates:[]});
  render(<Archive repository={archiveRepository} agents={[{id:'b',name:'B'} as any]} />);
  fireEvent.click(await screen.findByRole('button',{name:'Load more conversations'}));
  const signal = list.mock.calls.at(-1)?.[1];
  fireEvent.change(screen.getByLabelText('Filter by agent'),{target:{value:'b'}});
  await screen.findByText('Current owner');
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(collectionPage([item('Stale intruder')])));
  expect(screen.queryByText('Stale intruder')).toBeNull();
  expect(screen.queryByText('Old owner')).toBeNull();
});

describe('BCA03 shelf-owned retry and status', () => {
  function shelves() {
    const sessions = vi.spyOn(archiveRepository, 'listSessions').mockResolvedValue(collectionPage([]));
    const dreams = vi.spyOn(archiveRepository, 'listDreams').mockResolvedValue(collectionPage([]));
    const tiddle = vi.spyOn(archiveRepository, 'listContinuityCards').mockResolvedValue(collectionPage([]));
    vi.spyOn(archiveRepository, 'listCalendarAvailability').mockImplementation(async (kind, month) => ({ ok: true, kind, month, dates: [] }));
    return { sessions, dreams, tiddle };
  }

  it.each([
    ['chat', 'Retry conversations', 'No conversations match this shelf.'],
    ['dreams', 'Retry dreams', 'No dreams match this shelf.'],
    ['tiddle', 'Retry warm cards', 'No warm cards match this shelf.'],
  ] as const)('retries only the failed %s shelf and uses its own empty state', async (kind, retry, empty) => {
    const lists = shelves();
    render(<Archive agents={[]} repository={archiveRepository} />);
    await screen.findByText('No conversations match this shelf.');
    const list = kind === 'chat' ? lists.sessions : kind === 'dreams' ? lists.dreams : lists.tiddle;
    list.mockRejectedValueOnce(new Error(`${kind} offline`));
    if (kind === 'chat') fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'fail' } });
    else fireEvent.click(screen.getByRole('button', { name: kind === 'dreams' ? /Dreams/ : /Tiddle/ }));
    const button = await screen.findByRole('button', { name: retry });
    const counts = [lists.sessions.mock.calls.length, lists.dreams.mock.calls.length, lists.tiddle.mock.calls.length];
    fireEvent.click(button);
    expect(await screen.findByText(empty)).toBeTruthy();
    expect([lists.sessions.mock.calls.length, lists.dreams.mock.calls.length, lists.tiddle.mock.calls.length])
      .toEqual(counts.map((count, index) => count + (index === ['chat', 'dreams', 'tiddle'].indexOf(kind) ? 1 : 0)));
    expect(screen.queryByRole('alert')).toBeNull();
    if (kind !== 'chat') expect(screen.queryByText('No conversations match this shelf.')).toBeNull();
  });

  it.each(['dreams', 'tiddle'] as const)('does not carry cached Chat status into %s or accept its late failure', async (kind) => {
    const { archiveQueryCacheKey, writeArchiveSessionCache } = await import('./archiveCache');
    writeArchiveSessionCache(archiveQueryCacheKey({ target: 'local', agent: '', query: '', date: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, kind: 'chat' }), []);
    const lists = shelves();
    let reject!: (error: Error) => void;
    lists.sessions.mockReturnValueOnce(new Promise((_, no) => { reject = no; }));
    render(<Archive agents={[]} repository={archiveRepository} />);
    await waitFor(() => expect(lists.sessions).toHaveBeenCalledOnce());
    expect(screen.getByText('Showing stale cached conversations while revalidating.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: kind === 'dreams' ? /Dreams/ : /Tiddle/ }));
    await screen.findByText(kind === 'dreams' ? 'No dreams match this shelf.' : 'No warm cards match this shelf.');
    await act(async () => reject(new Error('late Chat failure')));
    expect(lists.sessions.mock.calls[0][1]?.aborted).toBe(true);
    expect(screen.queryByText('late Chat failure')).toBeNull();
    expect(screen.queryByText('Showing stale cached conversations while revalidating.')).toBeNull();
    expect(screen.queryByText('Loading conversations…')).toBeNull();
  });

  it.each(['dreams', 'tiddle'] as const)('aborts failed %s revalidation when switching shelves', async (kind) => {
    const lists = shelves();
    render(<Archive agents={[]} repository={archiveRepository} />);
    await screen.findByText('No conversations match this shelf.');
    const list = kind === 'dreams' ? lists.dreams : lists.tiddle;
    list.mockRejectedValueOnce(new Error('First failure'));
    fireEvent.click(screen.getByRole('button', { name: kind === 'dreams' ? /Dreams/ : /Tiddle/ }));
    const retry = await screen.findByRole('button', { name: kind === 'dreams' ? 'Retry dreams' : 'Retry warm cards' });
    let reject!: (error: Error) => void;
    if (kind === 'dreams') lists.dreams.mockReturnValueOnce(new Promise((_, no) => { reject = no; }));
    else lists.tiddle.mockReturnValueOnce(new Promise((_, no) => { reject = no; }));
    fireEvent.click(retry);
    const signal = kind === 'dreams' ? lists.dreams.mock.calls.at(-1)![0] : lists.tiddle.mock.calls.at(-1)![1];
    fireEvent.click(screen.getByRole('button', { name: /^Chat/ }));
    await screen.findByText('No conversations match this shelf.');
    await act(async () => reject(new Error('Late shelf failure')));
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByText('Late shelf failure')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

it('owns reader lifetime by filter scope, even if an aborted detail rejects late', async () => {
  const pending = deferred<ArchiveDetail>();
  const item = { id: 's', sessionId: 's', agentId: 'a', title: 'Selected conversation', archived: true } as ArchiveSession;
  vi.spyOn(archiveRepository, 'listSessions').mockResolvedValue(collectionPage([item]));
  vi.spyOn(archiveRepository, 'listCalendarAvailability').mockImplementation(async (kind, month) => ({ ok: true, kind, month, dates: [] }));
  const load = vi.spyOn(archiveRepository, 'loadSession').mockReturnValue(pending.promise);
  render(<Archive repository={archiveRepository} agents={[]} />);
  fireEvent.click(await screen.findByRole('button', { name: /Selected conversation.*turns/i }));
  const signal = load.mock.calls[0][1];
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'different scope' } });
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve({ turns: [{ role: 'user', content: 'Late detail intruder' }] }));
  expect(screen.queryByText('Late detail intruder')).toBeNull();
  expect(screen.queryByRole('heading', { level: 2, name: 'Selected conversation' })).toBeNull();
});

it('prefetches navigation counts and still drops selection on leaving and returning', async () => {
  const dreams = vi.spyOn(archiveRepository, 'listDreams').mockResolvedValue(collectionPage([]));
  const cards = vi.spyOn(archiveRepository, 'listContinuityCards').mockResolvedValue(collectionPage([]));
  const item = { id: 's', sessionId: 's', agentId: 'a', title: 'Selected conversation', archived: true } as ArchiveSession;
  vi.spyOn(archiveRepository, 'listSessions').mockResolvedValue(collectionPage([item]));
  vi.spyOn(archiveRepository, 'listCalendarAvailability').mockImplementation(async (kind, month) => ({ ok: true, kind, month, dates: [] }));
  vi.spyOn(archiveRepository, 'loadSession').mockResolvedValue({ turns: [{ role: 'user', content: 'Reader body' }] });
  render(<Archive repository={archiveRepository} agents={[]} />);
  fireEvent.click(await screen.findByRole('button', { name: /Selected conversation.*turns/i }));
  await screen.findByText('Reader body');
  expect(dreams).toHaveBeenCalledTimes(1); expect(cards).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: /^Dreams\s*0$/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Tiddle\s*0$/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Dreams/ }));
  await screen.findByText('No dreams match this shelf.');
  expect(cards).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: /^Chat/ }));
  await screen.findByRole('button', { name: /Selected conversation.*turns/i });
  expect(screen.queryByText('Reader body')).toBeNull();
});

it.each(['dreams', 'tiddle'] as const)('aborts %s pagination on filter-owner replacement and ignores late rows', async kind => {
  const dream = { agentId: 'a', agentName: 'A', day: '2026-10-15', timezone: 'UTC', phases: Object.fromEntries(['light', 'deep', 'rem'].map(phase => [phase, { diaryCount: 0, attemptCount: 0 }])), otherDiaries: { diaryCount: 0 }, cycleAttempts: { count: 1, latestStatus: 'failed' } } as any;
  const tiddle = card('c', 'Card fixture');
  const pending = deferred<any>();
  vi.spyOn(archiveRepository, 'listSessions').mockResolvedValue(collectionPage([]));
  const dreams = vi.spyOn(archiveRepository, 'listDreams').mockImplementation((_signal, cursor) => cursor ? pending.promise : Promise.resolve({ items: [dream], nextCursor: 'next', hasMore: true }));
  const cards = vi.spyOn(archiveRepository, 'listContinuityCards').mockImplementation((_agent, _signal, cursor) => cursor ? pending.promise : Promise.resolve({ items: [tiddle], nextCursor: 'next', hasMore: true }));
  vi.spyOn(archiveRepository, 'listCalendarAvailability').mockImplementation(async (kind, month) => ({ ok: true, kind, month, dates: [] }));
  render(<Archive repository={archiveRepository} agents={[]} />);
  fireEvent.click(screen.getByRole('button', { name: kind === 'dreams' ? /Dreams/ : /Tiddle/ }));
  fireEvent.click(await screen.findByRole('button', { name: kind === 'dreams' ? 'Load more dreams' : 'Load more cards' }));
  const signal = kind === 'dreams' ? dreams.mock.calls.at(-1)![0] : cards.mock.calls.at(-1)![1];
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'new owner' } });
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(collectionPage(kind === 'dreams' ? [{ ...dream, id: 'intruder', agentName: 'Intruder' }] : [card('intruder', 'Intruder card')])));
  expect(screen.queryByRole('button', { name: /Intruder/ })).toBeNull();
});

it('filters agent choices without filtering archive records or attribution', async () => {
  const base = { avatar: '', activity: 'Idle', context: null, provider: '', model: '', effort: '', temperature: 0, workspace: '', files: [], subagents: [] };
  vi.spyOn(archiveRepository, 'listSessions').mockResolvedValue(collectionPage([{ agentId:'off', agentName:'Disabled colleague', sessionId:'history', title:'Disabled history', turnCount:1, updatedAt:'2026-10-11T00:00:00Z' } as ArchiveSession]));
  vi.spyOn(archiveRepository, 'listCalendarAvailability').mockResolvedValue({ ok:true, kind:'sessions', month:'2026-10', dates:[] });
  const { rerender } = render(<Archive repository={archiveRepository} agents={[
    { ...base, id:'off', name:'Disabled colleague', enabled:false },
    { ...base, id:'on', name:'Available colleague', enabled:true },
  ]} />);
  expect(screen.queryByRole('option', { name:'Disabled colleague' })).toBeNull();
  expect(screen.getByRole('option', { name:'Available colleague' })).toBeTruthy();
  expect(await screen.findByRole('button', { name:/Disabled colleague.*Disabled history/ })).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name:'Filter by agent' }), { target:{ value:'on' } });
  rerender(<Archive repository={archiveRepository} agents={[{ ...base, id:'on', name:'Available colleague', enabled:false }]} />);
  await waitFor(() => expect((screen.getByRole('combobox', { name:'Filter by agent' }) as HTMLSelectElement).value).toBe(''));
});

it('loads all navigation badges before their shelves are clicked', async () => {
  vi.spyOn(archiveRepository, 'listSessions').mockResolvedValue(collectionPage([]));
  vi.spyOn(archiveRepository, 'listDreams').mockResolvedValue(collectionPage([{} as any, {} as any]));
  vi.spyOn(archiveRepository, 'listContinuityCards').mockResolvedValue(collectionPage([card('a', 'A')]));
  vi.spyOn(archiveRepository, 'listCalendarAvailability').mockImplementation(async (kind, month) => ({ ok: true, kind, month, dates: [] }));
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => new Response(JSON.stringify(String(input).includes('/task-board/tasks') ? { tasks: [{ archived: true }, { archived: false }, { archived: true }] } : String(input).includes('/task-board/projects') ? { projects: [] } : { mods: [] }), { headers: { 'content-type': 'application/json' } }));
  render(<Archive repository={archiveRepository} agents={[]} />);
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /^Dreams\s*2$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Tiddle\s*1$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Tasks\s*2$/ })).toBeTruthy();
  });
  expect(fetch).toHaveBeenCalled();
  expect(screen.queryByRole('region', { name: 'Archived tasks' })).toBeNull();
});

// These requests deliberately ignore cancellation and settle after unmount:
// owner cleanup must abort the signal, not depend on a cooperative repository.
describe('Archive page-owned pending reads', () => {
  it.each(['calendar', 'first-list', 'detail', 'loadEarlier'] as const)('aborts pending %s on page unmount', async (stage) => {
    const pending = deferred<any>();
    const item = { id: 'owned', sessionId: 'owned', agentId: 'a', title: 'Owned conversation', archived: true } as ArchiveSession;
    const loaded: ArchiveDetail = { turns: [{ role: 'user', content: 'Loaded newest message' }], hasMore: true, nextCursor: 'earlier' };
    const calendar = vi.spyOn(archiveRepository, 'listCalendarAvailability').mockImplementation(async (kind, month) => ({ ok: true, kind, month, dates: [] }));
    const list = vi.spyOn(archiveRepository, 'listSessions').mockResolvedValue(collectionPage([item]));
    const load = vi.spyOn(archiveRepository, 'loadSession').mockResolvedValue(loaded);
    vi.spyOn(archiveRepository, 'listDreams').mockResolvedValue(collectionPage([]));
    vi.spyOn(archiveRepository, 'listContinuityCards').mockResolvedValue(collectionPage([]));
    if (stage === 'calendar') calendar.mockReturnValue(pending.promise);
    if (stage === 'first-list') list.mockReturnValue(pending.promise);
    if (stage === 'detail') load.mockReturnValue(pending.promise);
    const view = render(<Archive agents={[]} repository={archiveRepository} />);
    if (stage === 'detail' || stage === 'loadEarlier') {
      fireEvent.click(await screen.findByRole('button', { name: /Owned conversation.*turns/i }));
      if (stage === 'loadEarlier') {
        await screen.findByText('Loaded newest message');
        load.mockReturnValueOnce(pending.promise);
        fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
        expect(load.mock.calls.at(-1)?.[2]).toBe('earlier');
      }
      await waitFor(() => expect(load).toHaveBeenCalledTimes(stage === 'detail' ? 1 : 2));
    }
    if (stage === 'first-list') await waitFor(() => expect(list).toHaveBeenCalledOnce());
    const signal = stage === 'calendar' ? calendar.mock.calls[0][3] : stage === 'first-list' ? list.mock.calls[0][1] : load.mock.calls.at(-1)?.[1];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(stage === 'calendar' ? { ok: true, kind: 'sessions', month: calendar.mock.calls[0][1], dates: [] } : stage === 'first-list' ? collectionPage([item]) : loaded));
    expect(screen.queryByRole('heading', { name: 'Archive' })).toBeNull();
    expect(screen.queryByText('Loaded newest message')).toBeNull();
  });
});

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

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear(); });

describe('Archive detail selection', () => {
  it('sends selected UTC day and agent as server filters for chat and dreams', async () => {
    const sessions = vi.spyOn(archiveRepository, 'listSessions').mockResolvedValue(collectionPage([]));
    vi.spyOn(archiveRepository, 'listContinuityCards').mockResolvedValue(collectionPage([]));
    const availability = vi.spyOn(archiveRepository, 'listCalendarAvailability').mockImplementation(async (kind, month, agentId) => ({ ok: true, kind, month, dates: agentId ? [`${month}-12`] : [`${month}-29`] }));
    const testAgents = [{ id: 'smatchet', name: 'Smatchet', avatar: '', activity: '', context: null, provider: '', model: '', effort: '', temperature: 0, workspace: '', files: [], subagents: [] }];
    const dreams = vi.spyOn(archiveRepository, 'listDreams').mockResolvedValue(collectionPage([]));
    render(<Archive agents={testAgents} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Select 2026-09-29, has archived records' }));
    await waitFor(() => expect(sessions).toHaveBeenCalledWith('', expect.any(AbortSignal), null, '2026-09-29', undefined));
    expect(availability).toHaveBeenCalledWith('sessions', expect.stringMatching(/^\d{4}-\d{2}$/), undefined, expect.any(AbortSignal));
    const agentSelect = screen.getByRole('combobox', { name: 'Filter by agent' });
    Object.defineProperty(agentSelect, 'options', { configurable: true, value: [{ value: '' }, { value: 'smatchet' }] });
    fireEvent.change(agentSelect, { target: { value: 'smatchet' } });
    await waitFor(() => expect(availability).toHaveBeenLastCalledWith('sessions', expect.stringMatching(/^\d{4}-\d{2}$/), 'smatchet', expect.any(AbortSignal)));

    fireEvent.click(screen.getByRole('button', { name: /Dreams/ }));
    await waitFor(() => expect(dreams).toHaveBeenCalledWith(expect.any(AbortSignal), null, '2026-09-29', undefined));
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

    render(<Archive agents={[]} />);
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
    render(<Archive agents={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: /one.*turns/i }));
    await screen.findByText('new');
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await screen.findByText('old');
    expect(screen.getByText('new')).toBeTruthy();
    expect(screen.getByText('Beginning of retained history')).toBeTruthy();
    expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'one' }), expect.any(AbortSignal), 'older');
  });
  it('does not let a late older page enter the next selected conversation', async () => {
    vi.spyOn(archiveRepository, 'listContinuityCards').mockResolvedValue(collectionPage([]));
    vi.spyOn(archiveRepository, 'listDreams').mockResolvedValue(collectionPage([]));
    vi.spyOn(archiveRepository, 'listSessions').mockResolvedValue(collectionPage([session('one'), session('two')]));
    const old = deferred<ArchiveDetail>();
    vi.spyOn(archiveRepository, 'loadSession').mockImplementation((selected, _signal, before) => before ? old.promise : Promise.resolve(page(selected.sessionId, selected.sessionId === 'one', selected.sessionId === 'one' ? 'older' : null)));
    render(<Archive agents={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: /one.*turns/i }));
    await screen.findByRole('button', { name: 'Load earlier messages' });
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    fireEvent.click(screen.getByRole('button', { name: /two.*turns/i }));
    await act(async () => old.resolve(page('intruder', false)));
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'two' })).toBeTruthy());
    expect(screen.queryByText('intruder')).toBeNull();
  });
});

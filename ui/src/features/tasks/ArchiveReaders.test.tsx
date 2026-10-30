import { describe, expect, it } from 'vitest';
import { archiveTurnText } from './ArchiveReaders';

const names = new Map([
  ['hatchet', 'Hatchet'],
  ['smatchet', 'Smatchet'],
  ['guido', 'Guido'],
]);

describe('archive transcript attribution', () => {
  it('uses each message sender in group and peer conversations', () => {
    expect(archiveTurnText({ role: 'agent', content: 'Backend report', metadata: { fromAgentId: 'hatchet' } }, 'Smatchet', names, 'Rob')).toContain('## Hatchet');
    expect(archiveTurnText({ role: 'agent', content: 'Frontend report', metadata: { fromAgentId: 'smatchet', fromAgentName: 'Smatchet' } }, 'Hatchet', names, 'Rob')).toContain('## Smatchet');
    expect(archiveTurnText({ role: 'agent', content: 'Newspaper report', metadata: { fromAgentId: 'guido' } }, 'Hatchet', names, 'Rob')).toContain('## Guido');
  });

  it('uses the configured operator name and preserves markdown content', () => {
    const copied = archiveTurnText({ role: 'user', content: 'Run:\n```sh\nnpm test\n```' }, 'Smatchet', names, 'Goblin King');
    expect(copied).toBe('## Goblin King\n\nRun:\n```sh\nnpm test\n```');
  });

  it('falls back honestly for single-agent and unknown senders', () => {
    expect(archiveTurnText({ role: 'assistant', content: 'Hello' }, 'Smatchet', names, 'Rob')).toBe('## Smatchet\n\nHello');
    expect(archiveTurnText({ role: 'agent', content: 'Unknown', metadata: { fromAgentId: 'new-goblin' } }, 'Smatchet', names, 'Rob')).toBe('## new-goblin\n\nUnknown');
    expect(archiveTurnText({ role: 'assistant', content: 'Anonymous' }, '', new Map(), '')).toBe('## Agent\n\nAnonymous');
  });

  it('attributes delegated user turns to their parent agent when identified', () => {
    expect(archiveTurnText({ role: 'user', content: 'Task', metadata: { parentAgentId: 'hatchet' } }, 'Minion', names, 'Rob')).toBe('## Hatchet\n\nTask');
  });
});

import { cleanup, render, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { ChatArchiveReader } from './ArchiveReaders';
import type { ArchiveSession } from './archiveTypes';
afterEach(cleanup);

it('FE-024 renders sender identities consistently with copied turns, including ordinary controls', () => {
  const session: ArchiveSession = { agentId: 'smatchet', agentName: 'Smatchet', sessionId: 'owned-fixture', id: 'owned-fixture', title: 'Fixture', summary: '', turnCount: 4, chatTurnCount: 4, createdAt: null, updatedAt: null, archived: true, archivedAt: null, kind: null, lastRole: null, lastRunId: null };
  const turns = [
    { role: 'agent', content: 'Peer', metadata: { fromAgentId: 'hatchet' } },
    { role: 'user', content: 'Delegated', metadata: { parentAgentId: 'guido' } },
    { role: 'user', content: 'Ordinary operator' },
    { role: 'assistant', content: 'Ordinary assistant' },
  ];
  const { container } = render(<ChatArchiveReader session={session} detail={{ turns }} loading={false} error="" earlierLoading={false} earlierError="" historyUnavailable={false} onLoadEarlier={() => {}} onRestart={() => {}} agentNames={names} operatorName="Rob" />);
  expect([...container.querySelectorAll('.archive-turn-meta strong')].map(n => n.textContent)).toEqual(['Hatchet', 'Guido', 'Rob', 'Smatchet']);
  turns.forEach((turn, i) => expect(archiveTurnText(turn, 'Smatchet', names, 'Rob')).toContain(`## ${['Hatchet', 'Guido', 'Rob', 'Smatchet'][i]}`));
});

it('FE024 recipient metadata never replaces sender in rendered or actual clipboard output', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText}});
  Object.defineProperty(window, 'isSecureContext', {configurable:true, value:true});
  const session = {agentId:'smatchet',agentName:'Smatchet',sessionId:'peer',id:'peer',title:'Peer',summary:'',turnCount:1,chatTurnCount:1,createdAt:null,updatedAt:null,archived:true,archivedAt:null,kind:null,lastRole:null,lastRunId:null} as ArchiveSession;
  const turn = {role:'agent',content:'Sender report',metadata:{fromAgentId:'hatchet',toAgentId:'smatchet'}};
  const {container} = render(<ChatArchiveReader session={session} detail={{turns:[turn]}} loading={false} error="" earlierLoading={false} earlierError="" historyUnavailable={false} onLoadEarlier={() => {}} onRestart={() => {}} agentNames={names} operatorName="Rob" />);
  expect(container.querySelector('.archive-turn-meta strong')?.textContent).toBe('Hatchet');
  fireEvent.click(screen.getByRole('button',{name:'Copy loaded chat as Markdown'}));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('## Hatchet\n\nSender report'));
});


it('FE-025 renders attachment-only and generated-artifact turns instead of dropping empty text', () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([109, 101, 100, 105, 97]), { status: 200, headers: { 'content-type': 'image/png' } })));
  const session = {agentId:'smatchet',agentName:'Smatchet',sessionId:'media',id:'media',title:'Media',summary:'',turnCount:2,chatTurnCount:2,createdAt:null,updatedAt:null,archived:true,archivedAt:null,kind:null,lastRole:null,lastRunId:null} as ArchiveSession;
  const turns = [
    { role: 'user', content: '', metadata: { attachments: [{ name: 'photo.png', type: 'image/png', artifactPath: 'artifacts/photo.png' }] } },
    { role: 'assistant', content: '', metadata: { outputArtifacts: [{ kind: 'image', name: 'generated.png', mimeType: 'image/png', storageReference: 'generated/generated.png' }] } },
  ];
  const { container } = render(<ChatArchiveReader session={session} detail={{ turns }} loading={false} error="" earlierLoading={false} earlierError="" historyUnavailable={false} onLoadEarlier={() => {}} onRestart={() => {}} agentNames={names} operatorName="Rob" />);
  expect(container.querySelectorAll('.message-attachment-card')).toHaveLength(1);
  expect(container.querySelectorAll('.generated-artifact')).toHaveLength(1);
  expect(container.textContent).toContain('photo.png');
  expect(container.textContent).toContain('generated.png');
  expect(archiveTurnText(turns[0], 'Smatchet', names, 'Rob')).toContain('Attachment: photo.png');
  expect(archiveTurnText(turns[1], 'Smatchet', names, 'Rob')).toContain('Generated image: generated.png');
});

it('renders and copies workflow-event speakers with a fallback, preserving ordinary operator attribution', () => {
  const session = { agentId: 'smatchet', agentName: 'Smatchet', sessionId: 'workflow', id: 'workflow', title: 'Workflow', summary: '', turnCount: 3, chatTurnCount: 3, createdAt: null, updatedAt: null, archived: true, archivedAt: null, kind: null, lastRole: null, lastRunId: null } as ArchiveSession;
  const turns: import('../../app/api').SessionTurn[] = [
    { role: 'user', content: 'CI finished', metadata: { source: 'workflow-event', completionEvent: { workflow: 'CI' }, parentAgentId: 'hatchet' } },
    { role: 'user', content: 'Unknown workflow finished', metadata: { source: 'workflow-event' } },
    { role: 'user', content: 'Operator followup' },
  ];
  const { container } = render(<ChatArchiveReader session={session} detail={{ turns }} loading={false} error="" earlierLoading={false} earlierError="" historyUnavailable={false} onLoadEarlier={() => {}} onRestart={() => {}} agentNames={names} operatorName="Rob" />);
  const speakers = ['GitHub · CI', 'GitHub · workflow event', 'Rob'];
  expect([...container.querySelectorAll('.archive-turn-meta strong')].map(node => node.textContent)).toEqual(speakers);
  turns.forEach((turn, index) => expect(archiveTurnText(turn, 'Smatchet', names, 'Rob')).toBe(`## ${speakers[index]}\n\n${turn.content}`));
});

it('does not invent a sender for archived delegation with no parent ID', () => {
  expect(archiveTurnText({ role: 'user', content: 'Task', metadata: { kind: 'subagent-delegated-task' } }, 'Minion', names, 'Rob')).toBe('## Parent agent\n\nTask');
});

import { archiveSessionContext, archiveSessionTitle, archiveSessionTimestamp } from './ArchiveReaders';

describe('archive session recognition', () => {
  const uuid = 'a7d3544a-4528-4a93-a439-e8285b04a201';
  const base = { sessionId: uuid, title: uuid, archivedAt: '2026-10-30T03:00:00Z', updatedAt: '2026-10-29T22:00:00Z', createdAt: null } as ArchiveSession;
  it('uses proven default origin and the archive time, including minutes', () => {
    const session = { ...base, sourceSessionId: 'default' };
    expect(archiveSessionTitle(session)).toBe(`Default · ${archiveSessionTimestamp(session)}`);
    expect(archiveSessionContext(session)).toBe(`From Default · ${archiveSessionTimestamp(session)}`);
    expect(archiveSessionTimestamp(session)).toMatch(/\d+:\d{2}/);
    expect(archiveSessionTitle(session)).not.toContain(uuid);
  });
  it('never guesses default origin for legacy UUIDs', () => {
    expect(archiveSessionTitle(base)).toBe(`Conversation · ${archiveSessionTimestamp(base)}`);
    expect(archiveSessionContext(base)).not.toContain('Default');
  });
  it('preserves descriptive titles while retaining origin in metadata', () => {
    const session = { ...base, title: 'Archive investigation', sourceSessionId: 'default' };
    expect(archiveSessionTitle(session)).toBe('Archive investigation');
    expect(archiveSessionContext(session)).toContain('From Default');
  });
  it('distinguishes same-day reset snapshots by time and handles absent dates', () => {
    const session = { ...base, title: 'default · Reset', archiveSnapshot: 'reset', sourceSessionId: 'default' };
    expect(archiveSessionTitle(session)).toContain('Default · Reset');
    expect(archiveSessionTitle(session)).not.toBe(archiveSessionTitle({ ...session, archivedAt: '2026-10-30T03:05:00Z' }));
    expect(archiveSessionTitle({ ...base, archivedAt: null, updatedAt: null })).toBe('Conversation · No date');
  });
});

it('renders the same proven origin and timestamp in shelf and selected reader without UUID-only labels', async () => {
  const { ChatArchiveShelf } = await import('./ChatArchiveShelf');
  const uuid = 'a7d3544a-4528-4a93-a439-e8285b04a201';
  const session = { agentId: 'smatchet', agentName: 'Smatchet', id: uuid, sessionId: uuid, title: uuid, sourceSessionId: 'default', archivedAt: '2026-10-30T03:01:00Z', summary: 'Ordinary chat', archived: true } as ArchiveSession;
  const repository = { listSessions: vi.fn().mockResolvedValue({ items: [session], nextCursor: null, hasMore: false }), loadSession: vi.fn().mockResolvedValue({ turns: [{ role: 'user', content: 'Retained ordinary chat' }], hasMore: false }) };
  const { container } = render(<ChatArchiveShelf archiveRepository={repository as unknown as import('./archiveRepository').ArchiveRepository} selectedAgent="" selectedDate="" search="" queryKey="proven-default-regression" onCount={() => {}} agentNames={names} operatorName="Goblin King" />);
  const card = await screen.findByRole('button', { name: /From Default/ });
  expect(card.textContent).not.toContain(uuid);
  fireEvent.click(card);
  await screen.findByText('Retained ordinary chat');
  expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(archiveSessionTitle(session));
  expect(container.querySelector('.archive-reader-toolbar')?.textContent).toContain(archiveSessionContext(session));
  expect(repository.loadSession.mock.calls[0][0].sessionId).toBe(uuid);
});

it('keeps historical Default cards and binds initial/earlier transcript pages to the selected date', async () => {
  const { ChatArchiveShelf } = await import('./ChatArchiveShelf');
  const historical = { agentId: 'hatchet', agentName: 'Hatchet', sessionId: 'default', id: 'historical-default', title: 'Default', summary: 'Historical ordinary conversation', updatedAt: '2026-10-30T03:00:00Z', matchedDate: '2026-09-12', archived: false, turnCount: 12 } as ArchiveSession;
  const loadSession = vi.fn().mockResolvedValueOnce({ turns: [{role: 'user', content: 'Historical day message'}], hasMore: true, nextCursor: 'older' }).mockResolvedValueOnce({ turns: [{role: 'assistant', content: 'Earlier that same day'}], hasMore: false }).mockResolvedValueOnce({ turns: [] });
  const repo = { listSessions: vi.fn().mockResolvedValue({items: [historical], hasMore: false, nextCursor: null}), loadSession } as unknown as import('./archiveRepository').ArchiveRepository;
  const props = { archiveRepository: repo, selectedAgent: '', selectedDate: '2026-09-12', search: '', queryKey: 'historical-day-fixture', onCount: () => {}, agentNames: names, operatorName: 'Rob' };
  const view = render(<ChatArchiveShelf {...props} />);
  fireEvent.click(await screen.findByRole('button', {name: /Historical ordinary conversation/}));
  await screen.findByText('Historical day message');
  expect(loadSession.mock.calls[0][3]).toBe('2026-09-12');
  fireEvent.click(screen.getByRole('button', {name: /Load earlier/}));
  await screen.findByText('Earlier that same day');
  expect(loadSession.mock.calls[1][2]).toBe('older');
  expect(loadSession.mock.calls[1][3]).toBe('2026-09-12');
  view.rerender(<ChatArchiveShelf {...props} selectedDate="2026-09-13" queryKey="historical-day-fixture-next" />);
  await screen.findByText(/No retained messages on 2026-09-13/);
  expect(loadSession.mock.calls[2][3]).toBe('2026-09-13');
});

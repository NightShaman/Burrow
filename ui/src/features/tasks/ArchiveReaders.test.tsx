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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['media'], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } })));
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

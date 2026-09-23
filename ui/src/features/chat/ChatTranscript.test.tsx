import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Agent, Subagent } from '../../app/types';
import type { SessionTurn } from '../../app/api';
import { ChatTranscript } from './ChatTranscript';

afterEach(cleanup);
const child: Subagent = { id: 'child', name: 'Child', avatar: 'C', activity: '', context: null, stream: 'child' };
const parent: Agent = { id: 'hatchet', name: 'Hatchet', avatar: 'H', activity: '', context: null, provider: '', model: '', effort: '', temperature: 1, workspace: '', files: [], subagents: [child] };
function show(turns: SessionTurn[], selected: Agent | Subagent = child) {
  return render(<ChatTranscript selected={selected} parent={parent} operator={{ name: 'Rob', avatar: 'R' }} isNewSession={false} turns={turns} isLoading={false} error="" isSending={false} activeRunId="" liveProgress={[]} liveAnswer="" />);
}
const message = (content: string, metadata?: SessionTurn['metadata']): SessionTurn => ({ type: 'message', role: 'user', content, metadata });
it('labels a child conversation as a Minion stream without changing its internal metadata', () => {
  show([message('Visible conversation')]);
  expect(screen.getByText('Minion stream')).toBeTruthy();
});
it('hides modern and legacy generated context without altering stored turns or hiding operator followups', () => {
  const turns = [message('runtime prompt', { kind: 'subagent-runtime-context' }), message('legacy prompt', { kind: 'subagent-task' }), message('debug prompt', { visibility: 'debug', promptEligible: false }), { ...message('debug event'), type: 'debug' }, message('Actual followup')];
  const before = JSON.stringify(turns);
  show(turns);
  for (const text of ['runtime prompt', 'legacy prompt', 'debug prompt', 'debug event']) expect(screen.queryByText(text)).toBeNull();
  expect(screen.getByLabelText('Rob avatar')).toBeTruthy();
  expect(screen.getByText('Actual followup')).toBeTruthy();
  expect(JSON.stringify(turns)).toBe(before);
});
it.each([{ kind: 'subagent-delegated-task', parentAgentId: 'hatchet' }, { workerProfile: 'frontend', subagentId: 'child' }])('attributes delegated tasks to the known parent: %j', (metadata) => {
  show([message('**Delegated task**', metadata), message('Operator followup')]);
  expect(screen.getByLabelText('Hatchet avatar')).toBeTruthy();
  expect(screen.getAllByLabelText('Rob avatar')).toHaveLength(1);
  expect(screen.getByText('Delegated task').tagName).toBe('STRONG');
});
it('uses Parent agent when attribution is unavailable, never the operator', () => {
  show([message('Task', { kind: 'subagent-delegated-task' })], parent);
  expect(screen.getByLabelText('Parent agent avatar')).toBeTruthy();
  expect(screen.queryByLabelText('Rob avatar')).toBeNull();
});
it('honors explicit parent identity rather than the workspace parent', () => {
  show([message('Task', { kind: 'subagent-delegated-task', parentAgentId: 'smatchet' })]);
  expect(screen.getByLabelText('smatchet avatar')).toBeTruthy();
  expect(screen.queryByLabelText('Hatchet avatar')).toBeNull();
});
it('preserves safe Markdown and line breaks in actual child replies', () => {
  const { container } = show([{ type: 'message', role: 'assistant', content: '## Result\n\n**Done**\nNext line\n\n- Verified\n\n<script>alert(1)</script>' }]);
  expect(screen.getByRole('heading', { name: 'Result' })).toBeTruthy();
  expect(screen.getByText('Done').tagName).toBe('STRONG');
  expect(container.querySelector('br')).toBeTruthy();
  expect(container.querySelector('li')?.textContent).toBe('Verified');
  expect(container.querySelector('script')).toBeNull();
});

it('renders a fenced code block alongside a semantic GFM table without changing copy controls', () => {
  const { container } = show([{ type: 'message', role: 'assistant', content: '| Mod owns | Core provides |\n|:---|---:|\n| Encrypted storage | Agent identity |\n\n```text\n| literal | code |\n```' }]);
  const table = screen.getByRole('table');
  expect(table.querySelectorAll('th')).toHaveLength(2);
  expect(table.querySelector('tbody tr')?.textContent).toBe('Encrypted storageAgent identity');
  expect(table.parentElement?.getAttribute('role')).toBe('region');
  expect(table.parentElement?.tabIndex).toBe(0);
  expect(container.querySelector('pre code')?.textContent).toContain('| literal | code |');
  expect(screen.getByRole('button', { name: 'Copy code block' })).toBeTruthy();
});

it('renders tables in live assistant text as well as saved messages', () => {
  render(<ChatTranscript selected={parent} parent={parent} operator={{ name: 'Rob', avatar: 'R' }} isNewSession={false} turns={[]} isLoading={false} error="" isSending activeRunId="run-1" liveProgress={[]} liveAnswer={'| A | B |\n|---|---|\n| one | two |'} />);
  expect(screen.getByRole('table').querySelector('td')?.textContent).toBe('one');
});

it('copies only a fenced code block without its Markdown fence or surrounding message', async () => {
  const copied: string[] = [];
  const execCommand = vi.fn(() => {
    copied.push(document.querySelector<HTMLTextAreaElement>('body > textarea')?.value ?? '');
    return true;
  });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
  show([{ type: 'message', role: 'assistant', content: 'Run this:\n\n```bash\necho "goblin"\nprintf "done"\n```\n\nThen continue.' }]);

  expect(screen.getByText('Run this:')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Copy code block' }));

  await waitFor(() => expect(screen.getByRole('button', { name: 'Copy code block' }).textContent).toContain('Copied'));
  expect(copied).toEqual(['echo "goblin"\nprintf "done"']);
});

it('does not add a code copy button for inline code', () => {
  show([{ type: 'message', role: 'assistant', content: 'Use `npm run build` here.' }]);
  expect(screen.queryByRole('button', { name: 'Copy code block' })).toBeNull();
});

it('shows an externally started task run before its first persisted chat turn', () => {
  render(<ChatTranscript selected={parent} parent={parent} operator={{ name: 'Rob', avatar: 'R' }} isNewSession={false} turns={[]} isLoading={false} error="" isSending activeRunId="task-run" activeToolActivity={{ runId: 'task-run', items: [{ id: 'tool-1', label: 'Inspect status', status: 'pending' }] }} liveProgress={[{ id: 'thought-1', text: 'Checking the runtime.', ts: '2026-09-15T12:00:00.000Z', status: 'streaming' }]} liveAnswer="" runtimeUserMessage="Inspect task destination" a2aActivities={[{ id: 'a2a-1', status: 'running', parentAgentId: 'hatchet', recipient: { agentId: 'minion' }, progress: [] }]} />);
  expect(screen.getByText('Inspect task destination')).toBeTruthy();
  expect(screen.getByText('Checking the runtime.')).toBeTruthy();
  expect(screen.getAllByText('Inspect status')).toHaveLength(2);
  expect(screen.getByLabelText('Agent-to-agent activity')).toBeTruthy();
});

it('renders spawn_subagent as Spawn Minion without mutating stored tool evidence', () => {
  const activity = { runId: 'run-1', items: [{ id: 'spawn-1', label: 'spawn_subagent', status: 'ok' as const }] };
  show([{ type: 'message', role: 'assistant', content: 'Delegated.', metadata: { toolActivity: activity } }]);
  expect(screen.getByText('Spawn Minion')).toBeTruthy();
  expect(activity.items[0].label).toBe('spawn_subagent');
});

it('uses the Minion label for live tool activity too', () => {
  render(<ChatTranscript selected={parent} parent={parent} operator={{ name: 'Rob', avatar: 'R' }} isNewSession={false} turns={[]} isLoading={false} error="" isSending activeRunId="run-1" activeToolActivity={{ runId: 'run-1', items: [{ id: 'spawn-1', label: 'spawn_subagent', status: 'pending' }] }} liveProgress={[]} liveAnswer="" />);
  expect(screen.getAllByText('Spawn Minion')).toHaveLength(2);
});

it('places spawn activity before subsequent progress in live and persisted assistant turns', () => {
  const activity = { runId: 'run-1', items: [{ id: 'spawn', label: 'spawn_subagent', status: 'ok' as const }] };
  const progress = { items: [{ id: 'later', text: 'Waiting for model continuation', ts: '2026-09-19T12:00:00Z' }], status: 'complete' as const };
  const { container, rerender } = render(<ChatTranscript selected={parent} parent={parent} operator={{ name: 'Rob', avatar: 'R' }} isNewSession={false} turns={[]} isLoading={false} error="" isSending activeRunId="run-1" activeToolActivity={activity} liveProgress={progress.items} liveAnswer="" />);
  const order = () => Array.from(container.querySelectorAll('.message-content > .tool-activity, .message-content > .run-progress')).map((node) => node.classList.contains('tool-activity') ? 'spawn' : 'progress');
  expect(order()).toEqual(['spawn', 'progress']);
  rerender(<ChatTranscript selected={parent} parent={parent} operator={{ name: 'Rob', avatar: 'R' }} isNewSession={false} turns={[{ type: 'message', role: 'assistant', content: 'Done', runId: 'run-1', metadata: { toolActivity: activity, progress } }]} isLoading={false} error="" isSending={false} activeRunId="" liveProgress={[]} liveAnswer="" />);
  expect(order()).toEqual(['spawn', 'progress']);
});


it('keeps an image visible while the send is pending, then loads the durable artifact after refresh', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob(['image bytes'], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } }));
  const objectUrl = vi.fn(() => 'blob:stored-image');
  const revoke = vi.fn();
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = objectUrl;
  URL.revokeObjectURL = revoke;
  try {
    const pending = message('What is this?', { attachments: [{ index: 0, name: 'memory.png', type: 'image/png', preview: 'data:image/png;base64,YQ==' }] });
    const { rerender } = show([pending], parent);
    expect(screen.getByRole('img', { name: 'memory.png' }).getAttribute('src')).toBe('data:image/png;base64,YQ==');
    const persisted = message('What is this?', { attachments: [{ index: 0, name: 'memory.png', type: 'image/png', artifactPath: 'artifacts/attachments/2026-image.png' }] });
    rerender(<ChatTranscript selected={parent} parent={parent} operator={{ name: 'Rob', avatar: 'R' }} isNewSession={false} turns={[persisted]} isLoading={false} error="" isSending={false} activeRunId="" liveProgress={[]} liveAnswer="" attachmentAgentId="hatchet" />);
    await waitFor(() => expect(screen.getByRole('img', { name: 'memory.png' }).getAttribute('src')).toBe('blob:stored-image'));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/attachments/hatchet/artifacts/attachments/2026-image.png');
    rerender(<ChatTranscript selected={parent} parent={parent} operator={{ name: 'Rob', avatar: 'R' }} isNewSession={false} turns={[]} isLoading={false} error="" isSending={false} activeRunId="" liveProgress={[]} liveAnswer="" />);
    expect(revoke).toHaveBeenCalledWith('blob:stored-image');
  } finally {
    fetchMock.mockRestore(); URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
  }
});

it('keeps filename fallback for non-images and inaccessible images', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
  try {
    show([message('Files', { attachments: [
      { name: 'notes.txt', type: 'text/plain', artifactPath: 'artifacts/attachments/notes.txt' },
      { name: 'expired.png', type: 'image/png', artifactPath: 'artifacts/attachments/expired.png' },
    ] })], parent);
    await waitFor(() => expect(screen.getByText('expired.png')).toBeTruthy());
    expect(screen.getByText('notes.txt')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'expired.png' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { fetchMock.mockRestore(); }
});

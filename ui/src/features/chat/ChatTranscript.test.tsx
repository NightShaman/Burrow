import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
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

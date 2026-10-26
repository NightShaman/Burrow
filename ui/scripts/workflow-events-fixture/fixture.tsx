import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentWorkflowEvents, type WorkflowWatch } from '../../src/features/settings/AgentWorkflowEvents';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import { UnsavedChangesProvider } from '../../src/app/UnsavedChanges';
import { ChatTranscript } from '../../src/features/chat/ChatTranscript';
import { ChatArchiveReader } from '../../src/features/tasks/ArchiveReaders';
import { projectChatActivity } from '../../src/features/chat/chatActivityProjection';
import type { Agent } from '../../src/app/types';
import '../../src/app.css';
const at = '2026-10-26T15:00:00Z';
let watches: WorkflowWatch[] = [{ id: 'fixture-watch', agentId: 'hatchet', repository: 'GoblinKingdom/Burrow', workflow: 'CI and release assembly with a realistic longer workflow name', sessionId: 'ci-releases', instruction: 'Inspect the completed run, report failures, and summarize assembly artifacts.', enabled: true }];
const events = ['pending', 'running', 'succeeded', 'failed', 'interrupted'].map((status, index) => ({ watchId: 'fixture-watch', ...watches[0], status, id: `event-${index}`, runId: `${123456789 + index}`, runAttempt: 2, headSha: 'a'.repeat(40), conclusion: index === 2 ? 'failure' : 'success', url: `https://github.com/GoblinKingdom/Burrow/actions/runs/${123456789 + index}`, completedAt: at, createdAt: at, chatRunId: `fixture-run-${index}`, result: index === 2 ? 'Workflow failure investigated and reported.' : null, error: index === 3 ? 'Agent provider unavailable. No handling result was produced.' : index === 4 ? 'Interrupted during restart; review the destination session.' : null }));
window.fetch = async (input, init) => {
  const url = String(input); const method = init?.method || 'GET'; let body: unknown;
  if (url.includes('/api/events/watches')) {
    if (method === 'POST') { const draft = JSON.parse(String(init?.body)); const watch = { ...draft, id: draft.id || `fixture-${Date.now()}` }; watches = [watch, ...watches.filter(w => w.id !== watch.id)]; body = { ok: true, watch }; }
    else if (method === 'DELETE') { watches = watches.filter(w => !url.endsWith(`/${w.id}`)); body = { ok: true }; }
    else body = { ok: true, watches };
  } else if (url.includes('/api/events?')) body = { ok: true, events };
  else throw new Error(`Unexpected local fixture request ${url}`);
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
};
const agent: Agent = { id: 'hatchet', name: 'Hatchet', avatar: 'H', activity: '', context: null, provider: '', model: '', effort: '', temperature: 1, workspace: '', files: [], subagents: [] };
const completionEvent = { id: 'event-1', repository: 'GoblinKingdom/Burrow', workflow: 'CI and release assembly', runId: '123', runAttempt: 2, headSha: 'a'.repeat(40), conclusion: 'failure', url: 'https://github.com/GoblinKingdom/Burrow/actions/runs/123' };
const metadata = { source: 'workflow-event' as const, completionEvent };
const turns = [{ type: 'message', role: 'user', content: 'Inspect this completed GitHub workflow and report its outcome.', metadata }, { type: 'message', role: 'user', content: 'Actual operator followup: keep the report concise.' }];
function Fixture() {
  const [overflow, setOverflow] = useState<HTMLElement | null>(null);
  const [view, setView] = useState('Watches');
  const runtime = projectChatActivity({ ok: true, runs: [{ runId: 'event-run', agentId: 'hatchet', sessionId: 'ci-releases', status: 'running', source: 'workflow-event', completionEvent, latestUserMessage: turns[0].content }] }, { agentId: 'hatchet', sessionId: 'ci-releases', isChildSession: false, hadRuns: false, now: 0 }).runtimeRun!;
  return <><header style={{ padding: 12, display: 'flex', gap: 16, flexWrap: 'wrap' }}><strong>Local fixture · no runtime reads or writes</strong><label>View <select value={view} onChange={e => setView(e.target.value)}>{['Watches', 'Live chat', 'Saved chat', 'Archive'].map(v => <option key={v}>{v}</option>)}</select></label></header>{view === 'Watches' ? <main className="settings-blank-slate has-top-navigation has-agent-selector" style={{ height: 'calc(100vh - 58px)' }}><div className="settings-prototype-agent-selector">Hatchet · agent destination</div><section className="settings-blank-column settings-prototype-sections"><nav className="settings-prototype-section-items"><button>Cron jobs</button><button className="active">Workflow events</button></nav></section><section className="settings-blank-column settings-prototype-configuration"><AgentWorkflowEvents agentId="hatchet" overflowTarget={overflow} /></section><section className="settings-blank-column settings-prototype-overflow" ref={setOverflow} /></main> : <main style={{ height: 'calc(100vh - 58px)', maxWidth: 1000, margin: 'auto', display: 'flex', flexDirection: 'column' }}>{view === 'Archive' ? <ChatArchiveReader session={{ agentId: 'hatchet', agentName: 'Hatchet', sessionId: 'ci-releases', title: 'CI releases' }} detail={{ turns }} loading={false} error="" earlierLoading={false} earlierError="" historyUnavailable={false} onLoadEarlier={() => {}} onRestart={() => {}} operatorName="Goblin King" /> : <ChatTranscript selected={agent} parent={agent} operator={{ name: 'Goblin King', avatar: 'G' }} isNewSession={false} turns={view === 'Saved chat' ? turns : []} isLoading={false} error="" isSending={view === 'Live chat'} activeRunId="event-run" runtimeUserMessage={view === 'Live chat' ? runtime.latestUserMessage : ''} runtimeUserMessageMetadata={runtime.userMessageMetadata} liveProgress={[]} liveAnswer={view === 'Live chat' ? 'Inspecting the completed workflow.' : ''} />}</main>}</>;
}
createRoot(document.getElementById('root')!).render(<ConfirmProvider><UnsavedChangesProvider><Fixture /></UnsavedChangesProvider></ConfirmProvider>);

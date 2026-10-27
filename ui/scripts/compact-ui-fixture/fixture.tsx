import React, { useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Chat } from '../../src/features/chat/ChatPage';
import { useChatSession } from '../../src/features/chat/useChatSession';
import { useChatRun } from '../../src/features/chat/useChatRun';
import { useRuntimeAgents } from '../../src/app/useRuntimeAgents';
import { AgentsPanel } from '../../src/features/workspace/WorkspaceRail';
import type { SavedProvider } from '../../src/app/types';
import type { SessionTurn } from '../../src/app/api';
import '../../src/app.css';
import './fixture.css';

// The route contract lives in this browser, never on an API server. This
// synthetic backend persists separately from the real UI's conversation cache.
const storageKey = 'compact-fixture.backend.v1';
type Database = { percent: number; turns: SessionTurn[] };
const initial: Database = { percent: 82, turns: [{ type: 'message', role: 'user', content: 'Keep the release acceptance checklist in this conversation.', ts: '2026-10-26T12:00:00Z' }, { type: 'message', role: 'assistant', content: 'The checklist is ready. Compact this session when you need more context capacity.', ts: '2026-10-26T12:00:01Z' }] };
let database: Database = JSON.parse(localStorage.getItem(storageKey) || 'null') || initial;
const save = () => localStorage.setItem(storageKey, JSON.stringify(database));
const evidence = { requests: [] as { path: string; method: string; at: number; body: unknown }[], events: [] as { type: string; at: number }[], unexpected: [] as string[], compactionCallbacks: 0, terminalAt: 0, completedAt: 0 };
const agent = { id: 'fixture', name: 'Fixture agent', avatar: 'F', enabled: true };
let pending: { controller: ReadableStreamDefaultController<Uint8Array>; runId: string; sessionId: string } | null = null;
const encoder = new TextEncoder();
function emit(type: string, data = {}) {
  if (!pending) throw new Error('No pending fixture stream');
  evidence.events.push({ type, at: performance.now() });
  pending.controller.enqueue(encoder.encode(JSON.stringify({ type, runId: pending.runId, sessionId: pending.sessionId, ts: new Date().toISOString(), data }) + '\n'));
}
function complete(outcome: 'success' | 'noop' | 'failure' = 'success') {
  if (!pending) throw new Error('No pending fixture run');
  const runId = pending.runId;
  let answer = '';
  if (outcome === 'failure') {
    answer = '[model_error: Fixture compaction failed.]';
    emit('context.compaction.failed', { reason: 'fixture_failure' });
  } else {
    database.percent = outcome === 'success' ? 14 : database.percent;
    save();
    evidence.completedAt = performance.now();
    emit('context.compaction.completed', { compressed: outcome === 'success', ...(outcome === 'noop' ? { reason: 'no_eligible_messages' } : {}) });
    answer = outcome === 'success' ? 'Context compacted. Summary saved; recent turns remain available.' : 'No context eligible for compaction.';
  }
  database.turns.push({ type: 'message', role: 'assistant', content: answer, runId, ts: new Date().toISOString() });
  save();
  // Back-to-back completion and terminal records deliberately exercise the
  // race: meter refresh must not depend on an extra React live-stage effect.
  emit(outcome === 'failure' ? 'run.failed' : 'run.completed', { response: { ok: outcome !== 'failure', answerText: outcome === 'failure' ? 'Fixture compaction failed.' : answer } });
  evidence.terminalAt = performance.now();
  pending.controller.close(); pending = null;
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
window.fetch = (async (input: string | URL | Request, options: RequestInit = {}) => {
  const path = String(input);
  const method = options.method || 'GET';
  const body = options.body ? JSON.parse(String(options.body)) : null;
  evidence.requests.push({ path, method, body, at: performance.now() });
  if (path === '/api/chat' && method === 'POST') {
    if (body.agentId !== 'fixture' || body.sessionId !== 'default' || body.message !== '/compact' || pending) throw new Error('Invalid fixture chat request');
    database.turns.push({ type: 'message', role: 'user', content: body.message, runId: body.runId, ts: new Date().toISOString() }); save();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { pending = { controller, runId: body.runId, sessionId: body.sessionId }; }, cancel() { pending = null; } });
    emit('run.started'); emit('context.compaction.started');
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  }
  if (path === '/api/agents') return json({ agents: [agent] });
  if (path === '/api/agents/overview' && method === 'POST') {
    if (body.sessions.fixture !== 'default') throw new Error('Wrong overview session');
    return json({ agents: [{ agent, identity: null, sessionId: 'default', selection: null, status: { agents: [{ agentId: 'fixture', sessionId: 'default', status: 'idle' }] }, contexts: { default: { context: { percent: database.percent, estimatedTokens: database.percent * 1000, capacityTokens: 100000, pressure: database.percent > 75 ? 'watch' : 'normal', source: 'fixture' }, compaction: { active: true, rawRecentTurnCount: 2 } } } }] });
  }
  if (path === '/api/sessions?agentId=fixture') return json({ sessions: [{ id: 'default' }] });
  if (path === '/api/sessions/default?agentId=fixture') return json({ session: { id: 'default', turns: database.turns } });
  if (path.startsWith('/api/chat/runs/active?')) return json({ ok: true, runs: [], subagents: [], a2a: [] });
  if (path.startsWith('/api/chat/inputs?')) return json({ generation: 1, inputs: [] });
  if (/^\/api\/chat\/[^/]+\/steering\?/.test(path)) return json({ steering: [] });
  if (path.startsWith('/api/task-board/conversation-project?')) return json({ ok: true, project: null });
  if (path === '/api/task-board/projects') return json({ projects: [] });
  evidence.unexpected.push(`${method} ${path}`);
  throw new Error(`Unmocked request blocked: ${method} ${path}`);
}) as typeof fetch;
Object.assign(window, { compactFixture: { evidence, complete, getDatabase: () => database, hasPending: () => Boolean(pending) } });

function Fixture() {
  const [selectedAgentId, setSelectedAgentId] = useState('fixture');
  const [, setSelectedStreamId] = useState('fixture');
  const session = useChatSession(selectedAgentId);
  const runtimeProviders = useRef<SavedProvider[]>([]);
  const onNoAgents = useCallback(() => {}, []);
  const runtime = useRuntimeAgents({ selectedAgentId, setSelectedAgentId, parentSessionIdForAgent: session.parentSessionIdForAgent, runtimeProviders, setSelectedStreamId, onNoAgents, reportError: session.reportError });
  const selected = runtime.agents.find(a => a.id === selectedAgentId);
  const run = useChatRun({ selectedAgentId, selected, savedProviders: [], session, setAgentActivity: (id, activity) => runtime.setAgents(all => all.map(a => a.id === id ? { ...a, activity } : a)), onCompactionFinished: () => { evidence.compactionCallbacks++; void runtime.refreshAgents(); } });
  if (!selected) return <p>Loading isolated fixture…</p>;
  return <main className="compact-acceptance">
    <header><h1>/compact acceptance</h1><p>Isolated route fixture · synthetic data · no live backend</p></header>
    <aside><AgentsPanel agents={runtime.agents} selectedStreamId={selectedAgentId} expandedAgents={new Set()} onToggleAgent={() => {}} onSelectAgent={() => {}} onSelectSubagent={() => {}} /></aside>
    <section className="fixture-chat workspace"><Chat selected={selected} parent={selected} operator={{ name: 'Fixture operator', avatar: 'O' }} draft={session.draft} setDraft={session.setDraft} attached={session.attached} onAttach={() => {}} onRemoveAttachment={session.removeAttachment} isNewSession={session.isNewSession} turns={session.turns} isLoading={session.isLoadingConversation} error={session.chatError} isSending={Boolean(run.activeRunId)} steeringReady={false} activeRunId={run.activeRunId} liveProgress={run.liveProgress} liveAnswer={run.liveAnswer} liveStage={run.liveStage} onSend={run.sendMessage} onCancel={run.cancelRun} selectedAgentId={selectedAgentId} resourceAgentId="fixture" sessionId={session.sessionId} /></section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

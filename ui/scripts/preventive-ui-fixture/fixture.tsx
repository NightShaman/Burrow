import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Archive } from '../../src/features/tasks/ArchivePage';
import { createArchiveRepository } from '../../src/features/tasks/archiveRepository';
import { AgentToolbar } from '../../src/features/settings/AgentToolbar';
import { useChatSession } from '../../src/features/chat/useChatSession';
import { writeConversationCache } from '../../src/features/chat/chatConversationCache';
import '../../src/app.css';
// All API calls are intercepted locally; CSP additionally denies network.
const requests: string[] = [];
const lifecycle: string[] = [];
const setupBodies: string[] = [];
let loseSetupResponse = true;
let runActive = true;
const item = (id: string) => ({ agentId: 'fixture', sessionId: id, id, title: id, summary: 'Local fixture only', archived: true });
const sessions = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}` }));
writeConversationCache(Object.fromEntries(sessions.map(s => [`fixture:${s.id}`, [{ role: 'user', content: `Cached ${s.id}` }]])));
const fakeRequest = async (path: string, options?: RequestInit): Promise<any> => {
  requests.push(path);
  if (path === '/api/mods') return { mods: [] };
  if (path.startsWith('/api/archive/calendar?')) { const q = new URLSearchParams(path.split('?')[1]); return { ok: true, kind: q.get('kind'), month: q.get('month'), dates: [] }; }
  if (path.startsWith('/api/archive/sessions?')) {
    const q = new URLSearchParams(path.split('?')[1]);
    if (q.has('cursor')) return new Promise((resolve) => { options?.signal?.addEventListener('abort', () => lifecycle.push('pagination aborted'), { once: true }); setTimeout(() => resolve({ sessions: [item('late intruder')], nextCursor: null, hasMore: false }), 1500); });
    if (q.get('q') === 'fail') throw new Error('Fixture archive offline');
    return { sessions: [item('Fixture conversation')], nextCursor: 'next', hasMore: true };
  }
  if (path.startsWith('/api/archive/sessions/')) return { turns: [{ role: 'user', content: 'Fixture reader text', ts: '2026-10-15T00:00:00Z' }], hasMore: false };
  if (path.startsWith('/api/archive/dreams?')) return { entries: [], nextCursor: null, hasMore: false };
  if (path.startsWith('/api/archive/continuity/cards?')) return { cards: [], nextCursor: null, hasMore: false };
  if (path === '/api/agents') return { agent: { id: JSON.parse(String(options?.body)).id } };
  if (path === '/api/settings/model-connections') return { connections: [] };
  if (path === '/api/setup/operation') {
    setupBodies.push(String(options?.body));
    if (loseSetupResponse) { loseSetupResponse = false; throw new Error('Fixture setup response lost'); }
    return { agent: { id: JSON.parse(String(options?.body)).agent.id } };
  }
  if (path.startsWith('/api/sessions?')) return { sessions };
  if (path.startsWith('/api/chat/runs/active?')) {
    const q = new URLSearchParams(path.split('?')[1]);
    return { ok: true, runs: runActive && q.get('sessionId') === 's0' ? [{ runId: 'recovered', agentId: 'fixture', sessionId: 's0', status: 'running', latestUserMessage: 'Fixture external work', answerText: 'Partial fixture answer', progress: [{ type: 'model.dispatched', data: { modelCall: 1 } }] }] : [] };
  }
  if (path === '/api/chat/recovered/cancel') { runActive = false; return { ok: true }; }
  if (path.startsWith('/api/sessions/')) { const id = decodeURIComponent(path.split('/')[3].split('?')[0]); return { session: { id, turns: [{ role: 'user', content: `Loaded ${id}` }, ...(!runActive && id === 's0' ? [{ role: 'assistant', content: 'Terminal fixture answer', runId: 'recovered' }] : [])] } }; }
  throw new Error(`Unexpected fixture request ${path}`);
};
window.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
  try { return new Response(JSON.stringify(await fakeRequest(String(url), options)), { status: 200, headers: { 'content-type': 'application/json' } }); }
  catch (error) { return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Fixture error' }), { status: 503, headers: { 'content-type': 'application/json' } }); }
}) as typeof fetch;
const repository = createArchiveRepository(fakeRequest);
function ChatFixture() {
  const chat = useChatSession('fixture');
  return <section><h2>Recovered chat</h2><label>Fixture session<select value={chat.sessionId} onChange={e => chat.selectSession(e.target.value)}>{sessions.map(s => <option key={s.id}>{s.id}</option>)}</select></label><label>Draft<input value={chat.draft} onChange={e => chat.setDraft(e.target.value)} /></label><p>Session: {chat.sessionId}; activity: {chat.runtimeRun?.runId || 'none'}; stage: {chat.runtimeRun?.stage || 'none'}</p>{chat.runtimeRun && <button onClick={() => void chat.cancelRuntimeRun(chat.runtimeRun!)}>Stop recovered fixture run</button>}<p>{chat.runtimeRun?.answerText}</p>{chat.turns.map((turn, i) => <p key={i}>{String(turn.content)}</p>)}</section>;
}
function Fixture() {
  const [view, setView] = useState('Archive');
  const [result, setResult] = useState('No creation');
  const [refreshFails, setRefreshFails] = useState(true);
  return <div style={{ padding: 16 }}><nav aria-label="Fixture views">{['Archive', 'Creation', 'Setup', 'Chat'].map(name => <button key={name} onClick={() => setView(name)}>{name}</button>)}</nav><p>Isolated fixture — no backend/network; 100 synthetic chat sessions</p><p role="status">{result}</p>{view === 'Archive' ? <Archive agents={[]} repository={repository} /> : view === 'Chat' ? <ChatFixture /> : <AgentToolbar key={view} agents={[]} selectedId="" firstRun={view === 'Setup'} onSelect={id => setResult(`Selected ${id}`)} onAgentsChanged={async () => { if (view === 'Creation' && refreshFails) { setRefreshFails(false); throw new Error('Fixture registry refresh failed'); } }} onModelConnectionsChanged={async () => {}} onFirstRunComplete={() => setResult('Setup finale completed')} onSetupComplete={async () => {}} />}</div>;
}
Object.assign(window, { fixtureEvidence: { requests, lifecycle, setupBodies } });
createRoot(document.getElementById('root')!).render(<Fixture />);

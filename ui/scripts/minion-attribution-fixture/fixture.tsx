import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatTranscript } from '../../src/features/chat/ChatTranscript';
import { projectChatActivity } from '../../src/features/chat/chatActivityProjection';
import type { Agent, Subagent } from '../../src/app/types';
import '../../src/app.css';
const portrait = (color: string, letter: string) => `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="12" fill="${color}"/><text x="32" y="43" font-size="36" text-anchor="middle" fill="white">${letter}</text></svg>`)}`;
const child: Subagent = { id: 'child', name: 'Layout minion', avatar: 'M', stream: 'child-session', activity: '', context: null };
function Fixture() {
  const [name, setName] = useState('Hatchet');
  const [state, setState] = useState('Pending');
  const parent: Agent = { id: name.toLowerCase(), name, avatar: portrait(name === 'Hatchet' ? '#008e83' : '#d946ef', name[0]), activity: '', context: null, provider: '', model: '', effort: '', temperature: 1, workspace: '', files: [], subagents: [child] };
  const runtime = projectChatActivity({ ok: true, runs: [], subagents: [{ id: child.id, agentId: parent.id, sessionId: child.stream, runId: 'child-run', purpose: 'Inspect the minion transcript. Check attribution, spacing, and long content before handing the result back.', status: 'running' }] }, { agentId: parent.id, sessionId: child.stream, isChildSession: true, hadRuns: false, now: 0 }).runtimeRun!;
  const saved = state === 'Saved';
  return <main style={{ height: '100vh', maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column' }}><header className="workspace-toolbar" style={{ display: 'flex', gap: 16, padding: 16 }}><label>Parent <select value={name} onChange={e => setName(e.target.value)}><option>Hatchet</option><option>Smatchet</option></select></label><label>State <select value={state} onChange={e => setState(e.target.value)}><option>Pending</option><option>Live</option><option>Saved</option></select></label></header><ChatTranscript selected={child} parent={parent} operator={{ name: 'Goblin King', avatar: portrait('#665e22', 'G') }} isNewSession={false} turns={saved ? [{ type: 'message', role: 'user', runId: runtime.runId, content: runtime.latestUserMessage, metadata: runtime.userMessageMetadata }, { type: 'message', role: 'user', content: 'Actual operator followup: keep the existing layout.' }, { type: 'message', role: 'assistant', content: '**Verified.** The delegating parent owns the instructions; operator followups retain their own identity.' }] : []} isLoading={false} error="" isSending={state === 'Live'} activeRunId={runtime.runId} liveProgress={[]} liveAnswer={state === 'Live' ? 'Checking the rendered transcript and parent attribution.' : ''} runtimeUserMessage={runtime.latestUserMessage} runtimeUserMessageMetadata={runtime.userMessageMetadata} /></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

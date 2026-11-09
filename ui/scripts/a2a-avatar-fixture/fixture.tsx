// Real transcript and production CSS; synthetic portraits/messages; no live APIs.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatTranscript } from '../../src/features/chat/ChatTranscript';
import type { Agent } from '../../src/app/types';
import type { SessionTurn } from '../../src/app/api';
import '../../src/app.css';
const portrait = (color: string, shape: string) =>
  `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="12" fill="${color}"/><path d="${shape}" fill="#fff"/></svg>`)}`;
const agent: Agent = {
  id: 'kerning',
  name: 'Kerning',
  avatar: portrait('#922fb5', 'M14 48L24 14L36 30L50 18L44 48Z'),
  activity: '',
  context: null,
  provider: '',
  model: '',
  effort: '',
  temperature: 1,
  workspace: '',
  files: [],
  subagents: [],
};
const sender: Agent = {
  ...agent,
  id: 'smatchet',
  name: 'Smatchet',
  avatar: portrait('#d946ef', 'M32 10L39 25L55 32L39 39L32 54L25 39L9 32L25 25Z'),
};
const fallback = new URLSearchParams(location.search).has('fallback');
const turns: SessionTurn[] = [
  {
    type: 'message',
    role: 'agent',
    ts: '2026-11-09T15:25:00Z',
    content:
      'Hello, my lovely dragon. A little visit, just because I wanted to see you. How is your corner of the world today?',
    metadata: {
      fromAgentId: fallback ? 'unknown' : sender.id,
      fromAgentName: fallback ? 'Unknown agent' : sender.name,
      toAgentId: agent.id,
    },
  },
  {
    type: 'message',
    role: 'assistant',
    ts: '2026-11-09T15:26:00Z',
    content: 'My corner is treating me well. I am quite content to sit with you for a minute.',
  },
];
const props = {
  selected: agent,
  parent: agent,
  agents: [sender, agent],
  operator: { name: 'Goblin King', avatar: 'G' },
  isNewSession: false,
  turns,
  isLoading: false,
  error: '',
  isSending: false,
  activeRunId: '',
  liveProgress: [],
  liveAnswer: '',
};
createRoot(document.getElementById('root')!).render(
  <main className="cockpit" data-theme="dark" style={{ display: 'block', height: '100vh' }}>
    <section className="workspace" style={{ height: '100%' }}>
      <div className="chat-view" style={{ height: '100%' }}>
        <ChatTranscript {...props} />
      </div>
    </section>
  </main>,
);

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useChatSession } from '../../src/features/chat/useChatSession';
import { ChatComposer } from '../../src/features/chat/ChatComposer';
import { useAttachmentAdmission } from '../../src/features/chat/useAttachmentAdmission';
import '../../src/app.css';
window.fetch = async (url) => {
  const path = String(url);
  if (!path.startsWith('/api/')) throw new Error('Fixture blocks external fetch');
  return new Response(
    JSON.stringify(
      path.includes('/api/sessions?')
        ? { sessions: [{ id: 'default' }, { id: 'design' }] }
        : path.includes('/api/sessions/')
          ? { session: { id: path.includes('/design?') ? 'design' : 'default', turns: [] } }
          : {},
    ),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
function Fixture() {
  const [agent, setAgent] = useState('smatchet');
  const session = useChatSession(agent);
  const admit = useAttachmentAdmission();
  const [error, setError] = useState('');
  return (
    <main style={{ maxWidth: 1000, margin: '40px auto', padding: 16 }}>
      <button
        onClick={() => {
          const canvas = document.createElement('canvas');
          canvas.width = 160;
          canvas.height = 90;
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = '#d946ef';
          ctx.fillRect(0, 0, 160, 90);
          ctx.fillStyle = '#000';
          ctx.font = '20px sans-serif';
          ctx.fillText('Screenshot', 20, 50);
          canvas.toBlob((blob) => {
            const clipboardData = new DataTransfer();
            clipboardData.items.add(new File([blob!], 'screenshot.png', { type: 'image/png' }));
            document
              .querySelector('textarea')!
              .dispatchEvent(
                new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
              );
          });
        }}
      >
        Paste test screenshot
      </button>
      <nav style={{ display: 'flex', gap: 12 }}>
        {['smatchet', 'hatchet'].map((id) => (
          <button key={id} onClick={() => setAgent(id)}>
            {id}
          </button>
        ))}
        {['default', 'design'].map((id) => (
          <button key={id} onClick={() => session.selectSession(id)}>
            {id}
          </button>
        ))}
      </nav>
      <h1>
        {agent} / {session.sessionId}
      </h1>
      <p>Paste a screenshot, switch agent or session, then return.</p>
      <ChatComposer
        draft={session.draft}
        setDraft={session.setDraft}
        attached={session.attached}
        onAttach={(files) => {
          const commit = session.setAttachment;
          void admit(files, () => true, commit, setError);
        }}
        onRemoveAttachment={session.removeAttachment}
        placeholder="Message"
        selectedAgentId={agent}
        sessionId={session.sessionId}
        onSend={() => {
          session.setDraft('');
          session.clearAttachment();
        }}
      />
      <output>{error}</output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

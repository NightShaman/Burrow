import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import { ChatMessage } from '../../src/features/chat/ChatMessage';

createRoot(document.getElementById('root')!).render(
  <main className="transcript" style={{ maxWidth: 900, margin: '40px auto', padding: 24 }}>
    <ChatMessage
      side="operator"
      name="Goblin King"
      avatar="K"
      time="Now"
      text="Keep Burrow open when I follow a link, please."
    />
    <ChatMessage
      side="agent"
      name="Smatchet"
      avatar="S"
      time="Now"
      text={
        '[Open CODEX](http://10.10.20.105:9726/ "Goblin CODEX")\n\nhttps://example.com\n\n[Local preview](/scripts/chat-links-fixture/index.html?destination=1)\n\n`https://example.com/not-a-link`'
      }
    />
  </main>,
);

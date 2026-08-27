import type { Agent } from '../../app/types';

type SessionComposer = {
  isOpen: boolean;
  isCreating: boolean;
  name: string;
  error: string;
  close: () => void;
  setName: (name: string) => void;
  create: () => Promise<void>;
};

type GroupComposer = {
  isOpen: boolean;
  isCreating: boolean;
  name: string;
  setName: (name: string) => void;
  agentIds: string[];
  error: string;
  close: () => void;
  toggleAgent: (agentId: string) => void;
  create: () => Promise<void>;
};

export function ChatComposerDialogs({ agents, session, group }: { agents: Agent[]; session: SessionComposer; group: GroupComposer }) {
  return <>
    {group.isOpen && <div className="session-dialog-backdrop" role="presentation" onMouseDown={group.close}>
      <section className="session-dialog group-dialog" role="dialog" aria-modal="true" aria-labelledby="new-group-title" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><span className="eyebrow">CHAT</span><h2 id="new-group-title">New group chat</h2></div><button className="session-dialog-close" type="button" aria-label="Close new group chat" onClick={group.close} disabled={group.isCreating}>×</button></header>
        <form onSubmit={(event) => { event.preventDefault(); void group.create(); }}>
          <label htmlFor="new-group-name">Group name</label>
          <input id="new-group-name" autoFocus value={group.name} onChange={(event) => group.setName(event.target.value)} placeholder="Design review" maxLength={80} disabled={group.isCreating} />
          <fieldset><legend>Participants</legend>{agents.map((agent) => <label key={agent.id}><input type="checkbox" checked={group.agentIds.includes(agent.id)} onChange={() => group.toggleAgent(agent.id)} disabled={group.isCreating} />{agent.name}</label>)}</fieldset>
          {group.error && <p className="session-dialog-error" role="alert">{group.error}</p>}
          <footer><button className="secondary" type="button" onClick={group.close} disabled={group.isCreating}>Cancel</button><button className="primary" type="submit" disabled={group.isCreating}>{group.isCreating ? 'Creating…' : 'Create group chat'}</button></footer>
        </form>
      </section>
    </div>}
    {session.isOpen && <div className="session-dialog-backdrop" role="presentation" onMouseDown={session.close}>
      <section className="session-dialog" role="dialog" aria-modal="true" aria-labelledby="new-session-title" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><span className="eyebrow">SESSIONS</span><h2 id="new-session-title">New session</h2></div><button className="session-dialog-close" type="button" aria-label="Close new session" onClick={session.close} disabled={session.isCreating}>×</button></header>
        <form onSubmit={(event) => { event.preventDefault(); void session.create(); }}>
          <label htmlFor="new-session-name">Session name</label>
          <input id="new-session-name" autoFocus value={session.name} onChange={(event) => session.setName(event.target.value)} placeholder="planning" maxLength={80} disabled={session.isCreating} />
          {session.error && <p className="session-dialog-error" role="alert">{session.error}</p>}
          <footer><button className="secondary" type="button" onClick={session.close} disabled={session.isCreating}>Cancel</button><button className="primary" type="submit" disabled={session.isCreating || !session.name.trim()}>{session.isCreating ? 'Creating…' : 'Create session'}</button></footer>
        </form>
      </section>
    </div>}
  </>;
}

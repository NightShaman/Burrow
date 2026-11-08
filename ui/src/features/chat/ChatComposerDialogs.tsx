import { chatAgents } from '../../app/agentCatalog';
import { AccessibleModal } from '../../app/AccessibleModal';
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
  rooms: Array<{ id: string; name: string; participantAgentIds: string[] }>;
  deleteTarget?: { id: string; name: string } | null;
  isDeleting?: boolean;
  deleteError?: string;
  requestDelete?: (room: { id: string; name: string }) => void;
  cancelDelete?: () => void;
  deleteGroup?: () => Promise<void>;
  roomsLoading: boolean;
  roomsError: string;
  openExisting: (room: { id: string; name: string }) => void;
};

export function ChatComposerDialogs({
  agents,
  session,
  group,
}: {
  agents: Agent[];
  session: SessionComposer;
  group: GroupComposer;
}) {
  return (
    <>
      {group.isOpen && (
        <div className="session-dialog-backdrop" role="presentation" onMouseDown={group.close}>
          <AccessibleModal
            className="session-dialog group-dialog"
            role="dialog"
            aria-labelledby="new-group-title"
            onMouseDown={(event) => event.stopPropagation()}
            onClose={() => {
              if (!group.isCreating) group.close();
            }}
          >
            <header>
              <div>
                <span className="eyebrow">CHAT</span>
                <h2 id="new-group-title">New group chat</h2>
              </div>
              <button
                className="session-dialog-close"
                type="button"
                aria-label="Close new group chat"
                onClick={group.close}
                disabled={group.isCreating}
              >
                ×
              </button>
            </header>
            <div className="group-room-picker" aria-label="Existing group chats">
              <h3>Existing rooms</h3>
              {group.roomsLoading ? (
                <p role="status">Loading rooms…</p>
              ) : group.roomsError ? (
                <p role="alert">{group.roomsError}</p>
              ) : group.rooms.length ? (
                <ul>
                  {group.rooms.map((room) => (
                    <li key={room.id}>
                      <div className="group-room-actions">
                        <button
                          type="button"
                          disabled={group.isDeleting}
                          onClick={() => group.openExisting(room)}
                        >
                          <strong>{room.name}</strong>
                          <small>{room.participantAgentIds.length} members</small>
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          aria-label={`Delete ${room.name}`}
                          disabled={group.isDeleting}
                          onClick={() => group.requestDelete?.(room)}
                        >
                          Delete
                        </button>
                      </div>
                      {group.deleteTarget?.id === room.id && (
                        <div
                          className="group-room-confirm"
                          role="group"
                          aria-label={`Confirm deletion of ${room.name}`}
                        >
                          <p>
                            Delete “{room.name}” and its transcript? Active group activity will
                            stop. Individual chats are kept.
                          </p>
                          {group.deleteError && (
                            <p role="alert" className="session-dialog-error">
                              {group.deleteError}
                            </p>
                          )}
                          <button
                            type="button"
                            className="secondary"
                            disabled={group.isDeleting}
                            onClick={group.cancelDelete}
                          >
                            Keep group
                          </button>
                          <button
                            type="button"
                            className="danger"
                            disabled={group.isDeleting}
                            onClick={() => void group.deleteGroup?.()}
                          >
                            {group.isDeleting ? 'Deleting…' : 'Delete group'}
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No rooms on this runtime yet.</p>
              )}
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void group.create();
              }}
            >
              <h3>Create a room</h3>
              <label htmlFor="new-group-name">Group name</label>
              <input
                id="new-group-name"
                autoFocus
                value={group.name}
                onChange={(event) => group.setName(event.target.value)}
                placeholder="Design review"
                maxLength={80}
                disabled={group.isCreating}
              />
              <fieldset className="group-participants">
                <legend>Participants</legend>
                <div className="group-participant-grid">
                  {chatAgents(agents).map((agent) => (
                    <label className="group-participant" key={agent.id}>
                      <input
                        type="checkbox"
                        checked={group.agentIds.includes(agent.id)}
                        onChange={() => group.toggleAgent(agent.id)}
                        disabled={group.isCreating}
                      />
                      <span className="group-participant-avatar" aria-hidden="true">
                        {agent.avatar.startsWith('data:image/') ? (
                          <img src={agent.avatar} alt="" />
                        ) : (
                          agent.name.slice(0, 1).toUpperCase() || '?'
                        )}
                      </span>
                      <span>{agent.name}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {group.error && (
                <p className="session-dialog-error" role="alert">
                  {group.error}
                </p>
              )}
              <footer>
                <button
                  className="secondary"
                  type="button"
                  onClick={group.close}
                  disabled={group.isCreating}
                >
                  Cancel
                </button>
                <button className="primary" type="submit" disabled={group.isCreating}>
                  {group.isCreating ? 'Creating…' : 'Create group chat'}
                </button>
              </footer>
            </form>
          </AccessibleModal>
        </div>
      )}
      {session.isOpen && (
        <div className="session-dialog-backdrop" role="presentation" onMouseDown={session.close}>
          <AccessibleModal
            className="session-dialog"
            role="dialog"
            aria-labelledby="new-session-title"
            onMouseDown={(event) => event.stopPropagation()}
            onClose={() => {
              if (!session.isCreating) session.close();
            }}
          >
            <header>
              <div>
                <span className="eyebrow">SESSIONS</span>
                <h2 id="new-session-title">New session</h2>
              </div>
              <button
                className="session-dialog-close"
                type="button"
                aria-label="Close new session"
                onClick={session.close}
                disabled={session.isCreating}
              >
                ×
              </button>
            </header>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void session.create();
              }}
            >
              <label htmlFor="new-session-name">Session name</label>
              <input
                id="new-session-name"
                autoFocus
                value={session.name}
                onChange={(event) => session.setName(event.target.value)}
                placeholder="planning"
                maxLength={80}
                disabled={session.isCreating}
              />
              {session.error && (
                <p className="session-dialog-error" role="alert">
                  {session.error}
                </p>
              )}
              <footer>
                <button
                  className="secondary"
                  type="button"
                  onClick={session.close}
                  disabled={session.isCreating}
                >
                  Cancel
                </button>
                <button
                  className="primary"
                  type="submit"
                  disabled={session.isCreating || !session.name.trim()}
                >
                  {session.isCreating ? 'Creating…' : 'Create session'}
                </button>
              </footer>
            </form>
          </AccessibleModal>
        </div>
      )}
    </>
  );
}

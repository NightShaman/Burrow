import { useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';
import { AccessibleModal } from '../../app/AccessibleModal';

type Props = { onClose: () => void; onSelect: (id: string) => void; onAgentsChanged: () => Promise<void> };

/** Ordinary agent creation has no setup, operator-profile or OAuth lifetime. */
export function NewAgentDialog({ onClose, onSelect, onAgentsChanged }: Props) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const createdId = useRef('');
  const owner = useRef<object>({});
  useEffect(() => () => { owner.current = {}; }, []);
  const close = () => { if (!pending.current) onClose(); };
  const create = async () => {
    if (pending.current) return;
    const nextId = id.trim(); const nextName = name.trim();
    if (!nextId || !nextName) { setError('An agent ID and display name are required.'); return; }
    const generation = owner.current;
    const current = () => owner.current === generation;
    pending.current = true; setBusy(true); setError('');
    try {
      if (!createdId.current) {
        const result = await api<{ agent: { id: string } }>('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: nextId, name: nextName, enabled: true }) });
        if (!current()) return;
        createdId.current = result.agent.id;
      }
      await onAgentsChanged();
      if (!current()) return;
      onSelect(createdId.current); onClose();
    } catch (cause) {
      if (current()) setError(`${createdId.current ? 'Agent created, but could not refresh agents' : 'Could not add agent'}: ${cause instanceof Error ? cause.message : 'Unknown error'}`);
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  };
  return <div className="agent-modal-backdrop" role="presentation" onMouseDown={close}>
    <AccessibleModal className="agent-modal" role="dialog" aria-labelledby="regular-new-agent-title" onMouseDown={event => event.stopPropagation()} onClose={close}>
      <header><div><span className="eyebrow">AGENTS</span><h2 id="regular-new-agent-title">New Agent</h2></div><button className="agent-modal-close" type="button" aria-label="Close new agent" onClick={close} disabled={busy}>×</button></header>
      <div className="agent-add-fields">
        <label className="field">ID<input autoFocus value={id} onChange={event => setId(event.target.value)} placeholder="luna" pattern="[A-Za-z0-9._-]+" disabled={busy || Boolean(createdId.current)} /></label>
        <label className="field">Name<input value={name} onChange={event => setName(event.target.value)} placeholder="Luna" maxLength={64} disabled={busy || Boolean(createdId.current)} /></label>
        {error && <p className="settings-request-error" role="alert">{error}</p>}
        <footer><button className="secondary" type="button" onClick={close} disabled={busy}>Cancel</button><button className="primary" type="button" onClick={() => void create()} disabled={busy || !id.trim() || !name.trim()}>{busy ? 'Creating…' : createdId.current ? 'Retry refresh' : 'Create agent'}</button></footer>
      </div>
    </AccessibleModal>
  </div>;
}

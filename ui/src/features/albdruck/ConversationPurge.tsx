import { useState } from 'react';
import { api, jsonMutation } from '../../app/api';
import { clearConversationCache } from '../chat/chatConversationCache';
import { clearArchiveCaches } from '../tasks/archiveCache';

type Conversation = { agentId: string; sessionId: string };
type PurgeResult = Conversation & { deleted: boolean; removed: { evidence: number; knowledge: number; revisions: number; working_memory: number; continuity_handoffs: number; conversation_project_bindings: number; dream_diary_entries: number; working_memory_meta: number } };

export function ConversationPurge({ conversation, onClose, onPurged }: { conversation: Conversation; onClose: () => void; onPurged: () => void }) {
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PurgeResult | null>(null);
  async function purge() {
    if (busy || result || !reason.trim() || confirmation !== conversation.sessionId) return;
    setBusy(true); setError('');
    try {
      const response = await api<PurgeResult>('/api/albdruck/purge-conversation', jsonMutation('POST', { ...conversation, reason: reason.trim() }));
      clearConversationCache(); clearArchiveCaches(); setResult(response); onPurged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section aria-label="Destructive conversation purge"><h2>Permanently purge conversation</h2>
    <p>Agent: {conversation.agentId} · Session: {conversation.sessionId}</p>
    <p>This is irreversible, not soft Archive. It removes the original conversation and reset archives, source evidence and preserved excerpts, unsupported derived knowledge and continuity, native runtime handoffs, and unsupported synthesized rolling descendants. Independently supported or human-corrected knowledge, pinned working memory, and mixed-source supported syntheses and their revisions survive; retained syntheses may keep historical source references. Filesystem attachments are outside this purge’s scope and are not deleted.</p>
    <p>Running/finalizing and current-main sessions are protected: the backend refuses their purge with 409. The reason is required but is not persisted as a content-bearing audit.</p>
    {error && <p role="alert">Purge failed: {error}</p>}
    {result ? <div role="status"><p>Purge completed for {result.agentId} · {result.sessionId}. Canonical session removed: {result.deleted ? 'yes' : 'no (already absent)' }.</p><h3>Removed counts</h3><ul>{Object.entries(result.removed).map(([key, count]) => <li key={key}>{key}: {count}</li>)}</ul></div> : <form onSubmit={e => { e.preventDefault(); void purge(); }}>
      <label>Purge reason (required)<textarea required disabled={busy} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <label>Type the exact session ID to confirm irreversible purge<input required disabled={busy} value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" /></label>
      <button disabled={busy || !reason.trim() || confirmation !== conversation.sessionId}>{busy ? 'Purging…' : 'Confirm permanent purge'}</button>
    </form>}
    <button disabled={busy} onClick={onClose}>{result ? 'Close purge result' : 'Cancel purge'}</button>
  </section>;
}

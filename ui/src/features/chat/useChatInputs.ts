import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ChatAttachment } from '../../app/api';
import { secureUuid } from '../../app/secureUuid';
import type { ChatInput } from './chatInputs';

type InputScope = { key: string };
type InputState = { scope: InputScope; generation: number | null; inputs: ChatInput[]; error: string };
const emptyInputs: ChatInput[] = [];
export function useChatInputs(agentId: string, sessionId: string, resetGeneration: number) {
  const scope = useMemo(() => ({ key: JSON.stringify([agentId, sessionId, resetGeneration]) }), [agentId, sessionId, resetGeneration]);
  const current = useRef(scope); current.current = scope;
  const [state, setState] = useState<InputState>({ scope, generation: null, inputs: [], error: '' });
  const stateRef = useRef(state); stateRef.current = state;
  const mutationVersion = useRef(0);
  const [version, setVersion] = useState(0);
  const busy = useRef<InputScope | null>(null);
  const retry = useRef<{ signature: string; key: string } | null>(null);
  const [pending, setPending] = useState('');
  useEffect(() => {
    current.current = scope; retry.current = null; busy.current = null; setPending('');
    return () => { if (current.current === scope) current.current = { key: 'retired' }; };
  }, [scope]);
  useEffect(() => {
    if (!agentId || !sessionId) return;
    let live = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const readVersion = mutationVersion.current;
      try {
        const result = await api<{ generation: number; inputs: ChatInput[] }>(`/api/chat/inputs?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`);
        if (live && readVersion === mutationVersion.current) setState({ scope, generation: result.generation, inputs: result.inputs, error: '' });
      } catch (error) {
        if (live) setState(previous => ({ ...(previous.scope === scope ? previous : { scope, generation: null, inputs: [] }), error: `Could not load queued inputs: ${error instanceof Error ? error.message : 'Unknown error'}` }));
      } finally { if (live) timer = setTimeout(() => void poll(), 1500); }
    };
    void poll(); return () => { live = false; clearTimeout(timer); };
  }, [scope, version]);
  const merge = useCallback((inputs: ChatInput[]) => setState(previous => {
    if (current.current !== scope) return previous;
    const base = previous.scope === scope ? previous : { scope, generation: null, inputs: [], error: '' };
    const byId = new Map(base.inputs.map(input => [input.id, input]));
    inputs.forEach(input => byId.set(input.id, input));
    return { ...base, inputs: [...byId.values()], error: '' };
  }), [scope]);
  const submit = async (intent: ChatInput['intent'], message: string, attachments: ChatAttachment[], targetRunId: string, promotedFrom: string | null) => {
    if (busy.current) return null;
    const generation = stateRef.current.scope === scope ? stateRef.current.generation : null;
    if (generation === null) throw new Error('Conversation generation is not loaded. Try again after inputs refresh.');
    busy.current = scope; setPending('submit');
    const body = { agentId, sessionId, generation, intent, message, attachments, targetRunId: targetRunId || null, promotedFrom };
    const signature = JSON.stringify(body);
    if (retry.current?.signature !== signature) retry.current = { signature, key: secureUuid() };
    try {
      const response = await api<{input: ChatInput}>('/api/chat/inputs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, idempotencyKey: retry.current.key }) });
      if (current.current !== scope) return null;
      mutationVersion.current++; merge([response.input]); retry.current = null; setVersion(v => v + 1); return response.input;
    } finally { if (current.current === scope) { busy.current = null; setPending(''); } }
  };
  const action = useCallback(async (id: string, action: 'cancel' | 'resume') => {
    if (busy.current) return;
    busy.current = scope; setPending(id);
    try {
      const response = await api<{input: ChatInput; inputs?: ChatInput[]}>(`/api/chat/inputs/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId, sessionId, generation: stateRef.current.generation }) });
      if (current.current !== scope) return;
      mutationVersion.current++; merge(response.inputs ?? [response.input]); setVersion(v => v + 1);
    } finally { if (current.current === scope) { busy.current = null; setPending(''); } }
  }, [agentId, sessionId, scope, merge]);
  return { inputs: state.scope === scope ? state.inputs : emptyInputs, generation: state.scope === scope ? state.generation : null,
    error: state.scope === scope ? state.error : '', pending, submit, action };
}

import { secureUuid } from '../../app/secureUuid';
import { useEffect, useRef, useState } from 'react';
import { api, type ChatAttachment } from '../../app/api';
const emptyInputs: SteeringInput[] = [];
export type SteeringInput = { id: string; status: 'pending' | 'delivered' | 'follow_up'; message: string; createdAt: string; deliveredAt?: string | null };
export function useLiveSteering(agentId: string, sessionId: string, activeRunId: string) {
  const scope = `${agentId}:${sessionId}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const [state, setState] = useState<{scope: string; inputs: SteeringInput[]}>({scope, inputs: []});
  const trackedRun = useRef('');
  const [submissionVersion, setSubmissionVersion] = useState(0);
  const retry = useRef<{ signature: string; key: string } | null>(null);
  const busy = useRef(false);
  const merge = (inputs: SteeringInput[]) => setState(previous => {
    const byId = new Map((previous.scope === scope ? previous.inputs : []).map(input => [input.id, input]));
    inputs.forEach(input => byId.set(input.id, input));
    return {scope, inputs: [...byId.values()]};
  });
  useEffect(() => {
    trackedRun.current = ''; retry.current = null; busy.current = false;
  }, [scope]);
  useEffect(() => {
    if (activeRunId) trackedRun.current = activeRunId;
    const runId = trackedRun.current;
    if (!runId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await api<{steering: SteeringInput[]}>(`/api/chat/${encodeURIComponent(runId)}/steering?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`);
        if (!live) return;
        merge(response.steering);
        if (activeRunId || response.steering.some(input => input.status === 'pending')) timer = setTimeout(() => void poll(), 1500);
      } catch { if (live && activeRunId) timer = setTimeout(() => void poll(), 3000); }
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [scope, activeRunId, submissionVersion]);
  const submit = async (message: string, attachments: ChatAttachment[]) => {
    if (busy.current) return null;
    busy.current = true;
    const signature = JSON.stringify({runId: activeRunId, agentId, sessionId, message, attachments});
    if (retry.current?.signature !== signature) retry.current = {signature, key: secureUuid()};
    try {
      const response = await api<{steering: SteeringInput}>(`/api/chat/${encodeURIComponent(activeRunId)}/steer`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({agentId, sessionId, idempotencyKey: retry.current.key, message, ...(attachments.length ? {attachments} : {})})});
      if (currentScope.current !== scope) return null;
      merge([response.steering]); trackedRun.current = activeRunId; setSubmissionVersion(version => version + 1); retry.current = null;
      return response.steering;
    } finally { if (currentScope.current === scope) busy.current = false; }
  };
  return {inputs: state.scope === scope ? state.inputs : emptyInputs, submit};
}

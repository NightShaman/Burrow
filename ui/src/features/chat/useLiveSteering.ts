import { acknowledgeChatInputRetry, chatInputRetryKey } from './chatInputRetryIdentity';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ChatAttachment } from '../../app/api';
const emptyInputs: SteeringInput[] = [];
export type SteeringInput = {
  id: string;
  status: 'pending' | 'delivered' | 'follow_up';
  message: string;
  createdAt: string;
  deliveredAt?: string | null;
};
export function isChatRunNotFoundError(error: unknown) {
  return (
    error instanceof Error &&
    error.message === 'chat_run_not_found' &&
    (error as Error & { status?: number }).status === 404
  );
}
export function useLiveSteering(
  agentId: string,
  sessionId: string,
  activeRunId: string,
  resetGeneration = 0,
) {
  const scope = useMemo(
    () => ({ key: JSON.stringify([agentId, sessionId, resetGeneration]) }),
    [agentId, sessionId, resetGeneration],
  );
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [state, setState] = useState<{ scope: typeof scope; inputs: SteeringInput[] }>({
    scope,
    inputs: [],
  });
  const trackedRun = useRef('');
  const [submissionVersion, setSubmissionVersion] = useState(0);
  const pendingForRun = useRef<{ scope: typeof scope; runId: string; pending: boolean } | null>(
    null,
  );
  const busy = useRef(false);
  const merge = (inputs: SteeringInput[]) =>
    setState((previous) => {
      const byId = new Map(
        (previous.scope === scope ? previous.inputs : []).map((input) => [input.id, input]),
      );
      inputs.forEach((input) => byId.set(input.id, input));
      return { scope, inputs: [...byId.values()] };
    });
  useEffect(() => {
    currentScope.current = scope;
    trackedRun.current = '';
    busy.current = false;
    pendingForRun.current = null;
    return () => {
      if (currentScope.current === scope) currentScope.current = { key: 'retired' };
    };
  }, [scope]);
  useEffect(() => {
    if (activeRunId) trackedRun.current = activeRunId;
    const runId = trackedRun.current;
    if (!runId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await api<{ steering: SteeringInput[] }>(
          `/api/chat/${encodeURIComponent(runId)}/steering?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`,
        );
        if (!live) return;
        merge(response.steering);
        pendingForRun.current = {
          scope,
          runId,
          pending: response.steering.some((input) => input.status === 'pending'),
        };
        if (activeRunId || pendingForRun.current.pending)
          timer = setTimeout(() => void poll(), 1500);
      } catch {
        if (
          live &&
          (activeRunId ||
            (pendingForRun.current?.scope === scope &&
              pendingForRun.current.runId === runId &&
              pendingForRun.current.pending))
        )
          timer = setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [scope, activeRunId, submissionVersion]);
  const submit = async (
    message: string,
    attachments: ChatAttachment[],
    promotion?: { promotedFrom: string; generation: number },
  ) => {
    if (busy.current) return null;
    busy.current = true;
    const retry = chatInputRetryKey('steer', {
      runId: activeRunId,
      agentId,
      sessionId,
      message,
      attachments,
      promotion: promotion ?? null,
      resetGeneration,
    });
    try {
      const response = await api<{ steering: SteeringInput }>(
        `/api/chat/${encodeURIComponent(activeRunId)}/steer`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            agentId,
            sessionId,
            idempotencyKey: retry.key,
            ...promotion,
            message,
            ...(attachments.length ? { attachments } : {}),
          }),
        },
      );
      acknowledgeChatInputRetry(retry.signature, retry.key);
      if (currentScope.current !== scope) return null;
      merge([response.steering]);
      if (response.steering.status === 'pending')
        pendingForRun.current = { scope, runId: activeRunId, pending: true };
      trackedRun.current = activeRunId;
      setSubmissionVersion((version) => version + 1);
      return response.steering;
    } finally {
      if (currentScope.current === scope) busy.current = false;
    }
  };
  return { inputs: state.scope === scope ? state.inputs : emptyInputs, submit };
}

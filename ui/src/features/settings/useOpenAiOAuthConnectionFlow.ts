import { useEffect, useRef, useState } from 'react';
import { modelConnectionsApi, type OpenAiOAuthConnection, type OpenAiOAuthLogin } from './modelConnectionsApi';

type RequestState = 'idle' | 'starting' | 'submitting' | 'cancelling';

type Options = {
  onConnection: (connection: OpenAiOAuthConnection) => void;
  onAuthorized: () => Promise<void>;
};

const pollingStatuses = new Set(['starting', 'waiting_for_callback', 'waiting_for_code', 'exchanging']);
const pollDelay = 2_000;

const errorMessage = (action: string, error: unknown) => error instanceof Error
  ? `Could not ${action}: ${error.message}`
  : `Could not ${action}.`;

export function useOpenAiOAuthConnectionFlow({ onConnection, onAuthorized }: Options) {
  const [login, setLogin] = useState<OpenAiOAuthLogin | null>(null);
  const [code, setCode] = useState('');
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const actionGeneration = useRef(0);
  const completedLoginId = useRef<string | null>(null);
  const onConnectionRef = useRef(onConnection);
  const onAuthorizedRef = useRef(onAuthorized);
  onConnectionRef.current = onConnection;
  onAuthorizedRef.current = onAuthorized;

  useEffect(() => () => {
    mounted.current = false;
    actionGeneration.current += 1;
  }, []);

  const completeAuthorizedLogin = async (nextLogin: OpenAiOAuthLogin) => {
    if (nextLogin.status !== 'authorized' || completedLoginId.current === nextLogin.id) return;
    completedLoginId.current = nextLogin.id;
    if (nextLogin.connection) onConnectionRef.current(nextLogin.connection);
    await onAuthorizedRef.current();
  };

  useEffect(() => {
    if (!login?.id || !pollingStatuses.has(login.status)) return undefined;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      const generation = actionGeneration.current;
      try {
        const result = await modelConnectionsApi.getOpenAiOAuthLogin(login.id);
        if (cancelled || !mounted.current || generation !== actionGeneration.current) return;
        setLogin(result.login);
        if (result.login.error) setError(result.login.error);
        await completeAuthorizedLogin(result.login);
      } catch (cause) {
        if (!cancelled && mounted.current && generation === actionGeneration.current) setError(errorMessage('refresh ChatGPT login', cause));
      } finally {
        if (!cancelled && mounted.current && generation === actionGeneration.current) timer = window.setTimeout(poll, pollDelay);
      }
    };

    timer = window.setTimeout(poll, pollDelay);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [login?.id, login?.status]);

  const start = async () => {
    const generation = ++actionGeneration.current;
    completedLoginId.current = null;
    setRequestState('starting');
    setError('');
    try {
      const result = await modelConnectionsApi.startOpenAiOAuth();
      if (!mounted.current || generation !== actionGeneration.current) return;
      onConnectionRef.current(result.connection);
      setLogin(result.login);
    } catch (cause) {
      if (mounted.current && generation === actionGeneration.current) setError(errorMessage('start ChatGPT login', cause));
    } finally {
      if (mounted.current && generation === actionGeneration.current) setRequestState('idle');
    }
  };

  const submit = async () => {
    if (!login?.id || !code.trim()) return;
    const generation = ++actionGeneration.current;
    setRequestState('submitting');
    setError('');
    try {
      const result = await modelConnectionsApi.submitOpenAiOAuthCode(login.id, code.trim());
      if (!mounted.current || generation !== actionGeneration.current) return;
      setLogin(result.login);
      if (result.login.connection) onConnectionRef.current(result.login.connection);
      setCode('');
      await completeAuthorizedLogin(result.login);
    } catch (cause) {
      if (mounted.current && generation === actionGeneration.current) setError(errorMessage('submit ChatGPT callback', cause));
    } finally {
      if (mounted.current && generation === actionGeneration.current) setRequestState('idle');
    }
  };

  const cancel = async () => {
    if (!login?.id) return;
    const generation = ++actionGeneration.current;
    setRequestState('cancelling');
    setError('');
    try {
      const result = await modelConnectionsApi.cancelOpenAiOAuth(login.id);
      if (mounted.current && generation === actionGeneration.current) setLogin(result.login);
    } catch (cause) {
      if (mounted.current && generation === actionGeneration.current) setError(errorMessage('cancel ChatGPT login', cause));
    } finally {
      if (mounted.current && generation === actionGeneration.current) setRequestState('idle');
    }
  };

  const reset = () => {
    actionGeneration.current += 1;
    completedLoginId.current = null;
    setLogin(null);
    setCode('');
    setRequestState('idle');
    setError('');
  };

  return { login, code, setCode, requestState, error, setError, start, submit, cancel, reset };
}

import { useEffect, useState } from 'react';
import { modelConnectionsApi, type OpenAiOAuthConnection, type OpenAiOAuthLogin } from './modelConnectionsApi';

type RequestState = 'idle' | 'starting' | 'submitting' | 'cancelling';

type Options = {
  onConnection: (connection: OpenAiOAuthConnection) => void;
  onAuthorized: () => Promise<void>;
};

const pollingStatuses = new Set(['starting', 'waiting_for_callback', 'waiting_for_code', 'exchanging']);

const errorMessage = (action: string, error: unknown) => error instanceof Error
  ? `Could not ${action}: ${error.message}`
  : `Could not ${action}.`;

export function useOpenAiOAuthConnectionFlow({ onConnection, onAuthorized }: Options) {
  const [login, setLogin] = useState<OpenAiOAuthLogin | null>(null);
  const [code, setCode] = useState('');
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const [error, setError] = useState('');

  const completeAuthorizedLogin = async (nextLogin: OpenAiOAuthLogin) => {
    if (nextLogin.status !== 'authorized') return;
    if (nextLogin.connection) onConnection(nextLogin.connection);
    await onAuthorized();
  };

  useEffect(() => {
    if (!login?.id || !pollingStatuses.has(login.status)) return undefined;

    const poll = window.setInterval(() => {
      void modelConnectionsApi.getOpenAiOAuthLogin(login.id)
        .then(async (result) => {
          setLogin(result.login);
          if (result.login.error) setError(result.login.error);
          await completeAuthorizedLogin(result.login);
        })
        .catch((cause) => setError(errorMessage('refresh ChatGPT login', cause)));
    }, 2_000);

    return () => window.clearInterval(poll);
  }, [login?.id, login?.status, onAuthorized, onConnection]);

  const start = async () => {
    setRequestState('starting');
    setError('');
    try {
      const result = await modelConnectionsApi.startOpenAiOAuth();
      onConnection(result.connection);
      setLogin(result.login);
    } catch (cause) {
      setError(errorMessage('start ChatGPT login', cause));
    } finally {
      setRequestState('idle');
    }
  };

  const submit = async () => {
    if (!login?.id || !code.trim()) return;
    setRequestState('submitting');
    setError('');
    try {
      const result = await modelConnectionsApi.submitOpenAiOAuthCode(login.id, code.trim());
      setLogin(result.login);
      if (result.login.connection) onConnection(result.login.connection);
      setCode('');
      await completeAuthorizedLogin(result.login);
    } catch (cause) {
      setError(errorMessage('submit ChatGPT callback', cause));
    } finally {
      setRequestState('idle');
    }
  };

  const cancel = async () => {
    if (!login?.id) return;
    setRequestState('cancelling');
    setError('');
    try {
      const result = await modelConnectionsApi.cancelOpenAiOAuth(login.id);
      setLogin(result.login);
    } catch (cause) {
      setError(errorMessage('cancel ChatGPT login', cause));
    } finally {
      setRequestState('idle');
    }
  };

  const reset = () => {
    setLogin(null);
    setCode('');
    setRequestState('idle');
    setError('');
  };

  return { login, code, setCode, requestState, error, setError, start, submit, cancel, reset };
}

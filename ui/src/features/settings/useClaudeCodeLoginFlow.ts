import { useEffect, useRef, useState } from 'react';
import { modelConnectionsApi, type ClaudeCodeLogin, type OpenAiOAuthConnection } from './modelConnectionsApi';

type RequestState = 'idle' | 'starting' | 'submitting' | 'importing' | 'cancelling';

type Options = {
  onConnection: (connection: OpenAiOAuthConnection) => void;
  onImported: (login: ClaudeCodeLogin) => Promise<void>;
  autoImport?: boolean;
};

const pollingStatuses = new Set(['starting', 'waiting_for_url', 'waiting_for_code', 'code_submitted', 'authorizing', 'authorized', 'ready_to_import']);

const errorMessage = (action: string, cause: unknown) => cause instanceof Error
  ? `Could not ${action}: ${cause.message}`
  : `Could not ${action}.`;

export function useClaudeCodeLoginFlow({ onConnection, onImported, autoImport = false }: Options) {
  const [login, setLogin] = useState<ClaudeCodeLogin | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const [error, setError] = useState('');
  const autoImportLoginId = useRef<string | null>(null);

  useEffect(() => {
    if (!login?.id || !pollingStatuses.has(login.status)) return undefined;
    const poll = window.setInterval(() => {
      void modelConnectionsApi.getClaudeCodeLogin(login.id)
        .then((result) => {
          setLogin(result.login);
          if (result.login.error) setError(result.login.error);
        })
        .catch((cause) => setError(errorMessage('refresh Claude Code login', cause)));
    }, 2_000);
    return () => window.clearInterval(poll);
  }, [autoImport, login?.id, login?.status]);

  const start = async (existingConnectionId?: string) => {
    setRequestState('starting');
    setError('');
    setCode('');
    try {
      const result = await modelConnectionsApi.startClaudeCodeLogin(existingConnectionId);
      if (result.connection) {
        onConnection(result.connection);
        setConnectionId(result.connection.id);
      } else if (result.login.connection) {
        onConnection(result.login.connection);
        setConnectionId(result.login.connection.id);
      }
      setLogin(result.login);
    } catch (cause) {
      setError(errorMessage('start Claude Code login', cause));
    } finally {
      setRequestState('idle');
    }
  };

  const submit = async () => {
    if (!login?.id || !code.trim()) return;
    setRequestState('submitting');
    setError('');
    try {
      const result = await modelConnectionsApi.submitClaudeCode(login.id, code.trim());
      setLogin(result.login);
      setCode('');
    } catch (cause) {
      setError(errorMessage('submit Claude callback code', cause));
    } finally {
      setRequestState('idle');
    }
  };

  const cancel = async () => {
    if (!login?.id) return;
    setRequestState('cancelling');
    setError('');
    try {
      const result = await modelConnectionsApi.cancelClaudeCodeLogin(login.id);
      setLogin(result.login);
    } catch (cause) {
      setError(errorMessage('cancel Claude Code login', cause));
    } finally {
      setRequestState('idle');
    }
  };

  const importCredentials = async (existingConnectionId?: string) => {
    if (!login?.id) {
      setError('Start a Claude Code login before importing its credentials.');
      return;
    }
    setRequestState('importing');
    setError('');
    try {
      const result = await modelConnectionsApi.importClaudeCodeLogin(login.id, connectionId ?? existingConnectionId);
      setLogin(result.login);
      if (result.login.status === 'imported') await onImported(result.login);
    } catch (cause) {
      setError(errorMessage('import Claude Code auth', cause));
    } finally {
      setRequestState('idle');
    }
  };

  useEffect(() => {
    if (!autoImport || !login?.id || !['authorized', 'ready_to_import'].includes(login.status) || autoImportLoginId.current === login.id) return;
    autoImportLoginId.current = login.id;
    void importCredentials();
  }, [autoImport, login?.id, login?.status]);

  const reset = () => {
    setLogin(null);
    setConnectionId(null);
    setCode('');
    setRequestState('idle');
    setError('');
    autoImportLoginId.current = null;
  };

  return { login, code, setCode, requestState, error, setError, start, submit, cancel, importCredentials, reset };
}

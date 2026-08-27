import { useEffect, useRef, useState } from 'react';
import { modelConnectionsApi, type ClaudeCodeLogin, type OpenAiOAuthConnection } from './modelConnectionsApi';

type RequestState = 'idle' | 'starting' | 'submitting' | 'importing' | 'cancelling';

type Options = {
  onConnection: (connection: OpenAiOAuthConnection) => void;
  onImported: (login: ClaudeCodeLogin) => Promise<void>;
  autoImport?: boolean;
};

const pollingStatuses = new Set(['starting', 'waiting_for_url', 'waiting_for_code', 'code_submitted', 'authorizing', 'authorized', 'ready_to_import']);
const pollDelay = 2_000;

const errorMessage = (action: string, cause: unknown) => cause instanceof Error
  ? `Could not ${action}: ${cause.message}`
  : `Could not ${action}.`;

export function useClaudeCodeLoginFlow({ onConnection, onImported, autoImport = false }: Options) {
  const [login, setLogin] = useState<ClaudeCodeLogin | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const actionGeneration = useRef(0);
  const autoImportLoginId = useRef<string | null>(null);
  const onConnectionRef = useRef(onConnection);
  const onImportedRef = useRef(onImported);
  onConnectionRef.current = onConnection;
  onImportedRef.current = onImported;

  useEffect(() => () => {
    mounted.current = false;
    actionGeneration.current += 1;
  }, []);

  useEffect(() => {
    if (!login?.id || !pollingStatuses.has(login.status)) return undefined;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      const generation = actionGeneration.current;
      try {
        const result = await modelConnectionsApi.getClaudeCodeLogin(login.id);
        if (cancelled || !mounted.current || generation !== actionGeneration.current) return;
        setLogin(result.login);
        if (result.login.error) setError(result.login.error);
      } catch (cause) {
        if (!cancelled && mounted.current && generation === actionGeneration.current) setError(errorMessage('refresh Claude Code login', cause));
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

  const start = async (existingConnectionId?: string) => {
    const generation = ++actionGeneration.current;
    autoImportLoginId.current = null;
    setRequestState('starting');
    setError('');
    setCode('');
    try {
      const result = await modelConnectionsApi.startClaudeCodeLogin(existingConnectionId);
      if (!mounted.current || generation !== actionGeneration.current) return;
      const connection = result.connection ?? result.login.connection;
      if (connection) {
        onConnectionRef.current(connection);
        setConnectionId(connection.id);
      }
      setLogin(result.login);
    } catch (cause) {
      if (mounted.current && generation === actionGeneration.current) setError(errorMessage('start Claude Code login', cause));
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
      const result = await modelConnectionsApi.submitClaudeCode(login.id, code.trim());
      if (!mounted.current || generation !== actionGeneration.current) return;
      setLogin(result.login);
      setCode('');
    } catch (cause) {
      if (mounted.current && generation === actionGeneration.current) setError(errorMessage('submit Claude callback code', cause));
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
      const result = await modelConnectionsApi.cancelClaudeCodeLogin(login.id);
      if (mounted.current && generation === actionGeneration.current) setLogin(result.login);
    } catch (cause) {
      if (mounted.current && generation === actionGeneration.current) setError(errorMessage('cancel Claude Code login', cause));
    } finally {
      if (mounted.current && generation === actionGeneration.current) setRequestState('idle');
    }
  };

  const importCredentials = async (existingConnectionId?: string) => {
    if (!login?.id) {
      setError('Start a Claude Code login before importing its credentials.');
      return;
    }
    const generation = ++actionGeneration.current;
    setRequestState('importing');
    setError('');
    try {
      const result = await modelConnectionsApi.importClaudeCodeLogin(login.id, connectionId ?? existingConnectionId);
      if (!mounted.current || generation !== actionGeneration.current) return;
      setLogin(result.login);
      if (result.login.status === 'imported') await onImportedRef.current(result.login);
    } catch (cause) {
      if (mounted.current && generation === actionGeneration.current) setError(errorMessage('import Claude Code auth', cause));
    } finally {
      if (mounted.current && generation === actionGeneration.current) setRequestState('idle');
    }
  };

  useEffect(() => {
    if (!autoImport || !login?.id || !['authorized', 'ready_to_import'].includes(login.status) || autoImportLoginId.current === login.id) return;
    autoImportLoginId.current = login.id;
    void importCredentials();
  }, [autoImport, login?.id, login?.status]);

  const reset = () => {
    actionGeneration.current += 1;
    setLogin(null);
    setConnectionId(null);
    setCode('');
    setRequestState('idle');
    setError('');
    autoImportLoginId.current = null;
  };

  return { login, code, setCode, requestState, error, setError, start, submit, cancel, importCredentials, reset };
}

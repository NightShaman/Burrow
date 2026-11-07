import { useEffect, useRef, useState } from 'react';
import { api, importExport } from '../../app/api';
import { completeOperation } from '../../app/durableOperation';
import { agentIdFromName, setupOperation } from './setupOperation';
import type { AgentToolbarProps } from './AgentToolbar';

const importErrorMessage = (cause: unknown) =>
  cause instanceof Error && cause.message === 'import_password_required'
    ? 'Password required.'
    : cause instanceof Error
      ? `Could not import export: ${cause.message}`
      : 'Could not import export.';

type WorkflowOptions = Pick<
  AgentToolbarProps,
  | 'onSelect'
  | 'onAgentsChanged'
  | 'onModelConnectionsChanged'
  | 'onOperatorProfileChanged'
  | 'onSetupComplete'
> &
  Parameters<typeof setupOperation>[0] & {
    setError: (error: string) => void;
    setCelebrating: (celebrating: boolean) => void;
  };

/** First-run import and durable submission lifetime. Import continuations intentionally
 * retain the original unguarded behavior; cancellation invalidates setup submission only.
 * Do not add cancellation guards here as part of an ownership-only extraction.
 */
export function useFirstRunWorkflow({
  onSelect,
  onAgentsChanged,
  onModelConnectionsChanged,
  onOperatorProfileChanged,
  onSetupComplete,
  operatorName,
  operatorAvatar,
  name,
  avatar,
  soul,
  connectionId,
  model,
  setError,
  setCelebrating,
}: WorkflowOptions) {
  const setupOwner = useRef<object>({});
  useEffect(
    () => () => {
      setupOwner.current = {};
    },
    [],
  );
  const setupBusy = useRef(false);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const [importPayload, setImportPayload] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const importInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<'idle' | 'creating'>('idle');
  const markSetupComplete = async () => {
    await onSetupComplete?.();
  };
  const finish = async () => {
    if (setupBusy.current) return;
    const key = 'hc.setupOperation';
    if (!localStorage.getItem(key) && (!operatorName.trim() || !agentIdFromName(name.trim()))) {
      setError('Operator and agent names are required.');
      return;
    }
    const owner = setupOwner.current;
    const current = () => setupOwner.current === owner;
    setupBusy.current = true;
    setState('creating');
    setError('');
    let attempted = false;
    try {
      const payload = setupOperation({
        operatorName,
        operatorAvatar,
        name,
        avatar,
        soul,
        connectionId,
        model,
      });
      attempted = true;
      const result = await api<{ agent: { id: string } }>('/api/setup/operation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      completeOperation(key, payload.operationId);
      if (!current()) return;
      onOperatorProfileChanged?.(payload.operator);
      await Promise.all([onModelConnectionsChanged(), onAgentsChanged()]);
      if (!current()) return;
      await markSetupComplete();
      if (!current()) return;
      onSelect(result.agent.id);
      setCelebrating(true);
    } catch (cause) {
      if (current())
        setError(
          `Could not finish first-run setup: ${cause instanceof Error ? cause.message : 'Unknown error'}.${attempted ? ' Retry to recover the original submission.' : ''}`,
        );
    } finally {
      setupBusy.current = false;
      if (current()) setState('idle');
    }
  };
  const readImportFile = async (file?: File) => {
    if (!file) return;
    setError('');
    setImporting(true);
    try {
      let binary = '';
      new Uint8Array(await file.arrayBuffer()).forEach((byte) => {
        binary += String.fromCharCode(byte);
      });
      const payload = btoa(binary);
      setImportPayload(payload);
      setImportPassword('');
      const preview = await importExport({ payload }, true);
      if (preview.requiresPassword === true || preview.encrypted === true) {
        setImporting(false);
        return;
      }
      await importExport({ payload, confirm: true, conflictPolicy: 'replace' });
      await Promise.all([onModelConnectionsChanged(), onAgentsChanged()]);
      await markSetupComplete();
      setImported(true);
      setCelebrating(true);
    } catch (cause) {
      setError(importErrorMessage(cause));
    } finally {
      setImporting(false);
    }
  };
  const submitProtectedImport = async () => {
    if (!importPayload || !importPassword.trim()) {
      setError('Enter the password for this export.');
      return;
    }
    setError('');
    setImporting(true);
    try {
      await importExport({
        payload: importPayload,
        password: importPassword,
        confirm: true,
        conflictPolicy: 'replace',
      });
      await Promise.all([onModelConnectionsChanged(), onAgentsChanged()]);
      await markSetupComplete();
      setImported(true);
      setImportPassword('');
      setImportPayload('');
      setCelebrating(true);
    } catch (cause) {
      setError(importErrorMessage(cause));
    } finally {
      setImporting(false);
    }
  };
  const resetWorkflow = () => {
    setupOwner.current = {};
    setImportPayload('');
    setImportPassword('');
    setImporting(false);
    setImported(false);
    if (importInput.current) importInput.current.value = '';
  };
  return {
    importing,
    imported,
    importPayload,
    importPassword,
    setImportPassword,
    importInput,
    state,
    finish,
    readImportFile,
    submitProtectedImport,
    resetWorkflow,
  };
}

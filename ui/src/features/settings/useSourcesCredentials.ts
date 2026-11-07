import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  loadModManagement,
  loadSecretReferences,
  modManagementAction,
  type NormalizedModManagement,
  type SecretReference,
} from './modManagementApi';

const compatibleCredentialTypes = new Set(['credential', 'secret', 'token', 'password']);

function sourceIdentity(value: string) {
  try {
    const url = new URL(value);
    return {
      host: url.hostname.toLowerCase(),
      owner: url.pathname.split('/').filter(Boolean)[0]?.toLowerCase() ?? '',
    };
  } catch {
    return { host: '', owner: '' };
  }
}

function credentialText(item: SecretReference) {
  return [item.label, item.type, item.username, item.url, item.service]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function rankSecretReferences(
  items: SecretReference[],
  query: string,
  sourceUrl: string,
  username: string,
) {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const { host, owner } = sourceIdentity(sourceUrl);
  const expectedUsername = username.trim().toLowerCase();
  return items
    .filter((item) => compatibleCredentialTypes.has(item.type))
    .filter((item) => terms.every((term) => credentialText(item).includes(term)))
    .map((item) => {
      const text = credentialText(item);
      let score = 0;
      if (host && (text.includes(host) || text.includes(host.replace(/^www\./u, '')))) score += 12;
      if (owner && text.includes(owner)) score += 6;
      if (expectedUsername && item.username?.toLowerCase() === expectedUsername) score += 4;
      if (item.type === 'token' || item.type === 'password') score += 2;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
    .map(({ item }) => item);
}

export function useSourcesCredentials(
  section: 'installed' | 'sources' | 'automatic-checks',
  state: NormalizedModManagement,
  setState: Dispatch<SetStateAction<NormalizedModManagement>>,
  setBusy: Dispatch<SetStateAction<string | null>>,
  setError: Dispatch<SetStateAction<string | null>>,
) {
  const [sourceUrl, setSourceUrl] = useState('');
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [sourceUsername, setSourceUsername] = useState('');
  const [secretReferences, setSecretReferences] = useState<SecretReference[]>([]);
  const [selectedSecretReference, setSelectedSecretReference] = useState<SecretReference | null>(
    null,
  );
  const [secretReferenceError, setSecretReferenceError] = useState<string | null>(null);
  const [credentialPickerOpen, setCredentialPickerOpen] = useState(false);
  const [credentialQuery, setCredentialQuery] = useState('');
  const [activeCredentialIndex, setActiveCredentialIndex] = useState(0);
  const credentialPickerRef = useRef<HTMLDivElement>(null);
  const credentialSearchRef = useRef<HTMLInputElement>(null);
  const sourceSecretRef = useRef<HTMLInputElement>(null);
  // Do not retain the secret in React state or browser storage. Wipe the DOM field on unmount.
  useEffect(() => {
    const input = sourceSecretRef.current;
    return () => {
      if (input) input.value = '';
    };
  }, []);
  useEffect(() => {
    if (section !== 'sources') return;
    setSecretReferenceError(null);
    void loadSecretReferences()
      .then(setSecretReferences)
      .catch((cause) => {
        setSecretReferences([]);
        setSecretReferenceError(
          cause instanceof Error ? cause.message : 'Stored credentials are unavailable.',
        );
      });
  }, [section]);
  useEffect(() => {
    if (!credentialPickerOpen) return;
    const close = (event: PointerEvent) => {
      if (!credentialPickerRef.current?.contains(event.target as Node))
        setCredentialPickerOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [credentialPickerOpen]);

  const selectedSource = state.sources.find((source) => source.id === selectedSourceId) ?? null;
  useEffect(() => {
    if (selectedSourceId && !selectedSource) setSelectedSourceId(null);
  }, [selectedSourceId, selectedSource]);
  const rankedSecretReferences = useMemo(
    () =>
      rankSecretReferences(
        secretReferences,
        credentialQuery,
        selectedSource?.url ?? sourceUrl,
        sourceUsername,
      ),
    [credentialQuery, secretReferences, selectedSource?.url, sourceUrl, sourceUsername],
  );
  const visibleSecretReferences = rankedSecretReferences.slice(0, 100);
  useEffect(() => {
    setActiveCredentialIndex(0);
  }, [credentialQuery, sourceUrl, sourceUsername]);

  const chooseSecretReference = (item: SecretReference) => {
    setSelectedSecretReference(item);
    if (!sourceUsername && item.username) setSourceUsername(item.username);
    if (sourceSecretRef.current) sourceSecretRef.current.value = '';
    setCredentialPickerOpen(false);
    setCredentialQuery('');
  };
  const openCredentialPicker = (focusSearch = true) => {
    setCredentialPickerOpen(true);
    if (focusSearch) window.setTimeout(() => credentialSearchRef.current?.focus(), 0);
  };
  const credentialPickerKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setCredentialPickerOpen(false);
      sourceSecretRef.current?.focus();
      return;
    }
    if (!visibleSecretReferences.length) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      setActiveCredentialIndex((index) =>
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? visibleSecretReferences.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + visibleSecretReferences.length) %
              visibleSecretReferences.length,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      chooseSecretReference(visibleSecretReferences[activeCredentialIndex]);
    }
  };

  const removeStoredCredential = async () => {
    if (!selectedSource?.credential?.configured) return;
    setBusy('source-credential');
    setError(null);
    try {
      await modManagementAction(
        `/api/mod-management/sources/${encodeURIComponent(selectedSource.id)}/credential`,
        { method: 'DELETE' },
      );
      setSelectedSecretReference(null);
      setSourceUsername('');
      if (sourceSecretRef.current) sourceSecretRef.current.value = '';
      setState(await loadModManagement());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove the stored credential.');
    } finally {
      setBusy(null);
    }
  };

  const addSource = async () => {
    const url = selectedSource?.url ?? sourceUrl.trim();
    if (!url) return;
    const username = sourceUsername.trim();
    const secret = sourceSecretRef.current?.value ?? '';
    const credential = secret || selectedSecretReference?.reference || '';
    const resolvedUsername = username || selectedSecretReference?.username || '';
    if (resolvedUsername || credential) {
      if (!/^https:\/\/[^/]+/i.test(url)) {
        setError(
          'Private repository credentials are supported only for HTTPS Git URLs. Configure SSH access on the Core service account instead.',
        );
        return;
      }
      if (resolvedUsername && !credential) {
        setError('Enter a password or access token when specifying a private repository username.');
        return;
      }
    }
    const body = JSON.stringify({
      url,
      ...(credential
        ? {
            auth: {
              ...(resolvedUsername ? { username: resolvedUsername } : {}),
              token: credential,
            },
          }
        : {}),
    });
    setBusy('source');
    setError(null);
    let submitted = false;
    let discoveryError = false;
    try {
      await modManagementAction('/api/mod-management/sources', { method: 'POST', body });
      submitted = true;
    } catch {
      // Core may retain the source even if discovery failed. Reload before
      // reporting the outcome rather than implying nothing was saved.
      discoveryError = true;
    }
    if (submitted) {
      if (!selectedSource) setSourceUrl('');
      setSourceUsername('');
      setSelectedSecretReference(null);
      if (sourceSecretRef.current) sourceSecretRef.current.value = '';
    }
    try {
      const next = await loadModManagement();
      setState(next);
      if (discoveryError) {
        const retained = next.sources.find((source) => source.url === url);
        setError(
          retained
            ? `Source saved, but discovery failed. ${retained.error || 'See the configured source status for details.'}`
            : 'Could not add mod source. Check the repository URL and credentials.',
        );
      }
    } catch {
      setError(
        submitted
          ? 'Source added, but the catalog could not be refreshed. Refresh sources to see its status.'
          : 'Could not confirm whether the source was saved. Catalog refresh failed; check configured sources before retrying.',
      );
    } finally {
      setBusy(null);
    }
  };

  const selectSource = (source: { id: string; url: string }) => {
    const selecting = selectedSourceId !== source.id;
    setSelectedSourceId(selecting ? source.id : null);
    setSourceUrl(selecting ? source.url : '');
    setSourceUsername('');
    setSelectedSecretReference(null);
    setCredentialPickerOpen(false);
    if (sourceSecretRef.current) sourceSecretRef.current.value = '';
  };

  return {
    selectSource,
    sourceUrl,
    setSourceUrl,
    selectedSourceId,
    setSelectedSourceId,
    sourceUsername,
    setSourceUsername,
    secretReferences,
    selectedSecretReference,
    setSelectedSecretReference,
    secretReferenceError,
    credentialPickerOpen,
    setCredentialPickerOpen,
    credentialQuery,
    setCredentialQuery,
    activeCredentialIndex,
    setActiveCredentialIndex,
    credentialPickerRef,
    credentialSearchRef,
    sourceSecretRef,
    selectedSource,
    rankedSecretReferences,
    visibleSecretReferences,
    chooseSecretReference,
    openCredentialPicker,
    credentialPickerKeyDown,
    removeStoredCredential,
    addSource,
  };
}

import type { useModsManagement } from './useModsManagement';
import { createPortal } from 'react-dom';
import { Field } from './SettingsPrimitives';
import { formatDuration } from './useAutomaticChecks';
import type { ModRecord, ModSource } from './modManagementApi';
function formatCheckedTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function sourceModName(source: ModSource, mods: ModRecord[]) {
  return mods.find((mod) => mod.source === source.url)?.name || 'Undiscovered mod';
}

export function SourcesCredentialsView({
  model,
  overflowTarget,
}: {
  model: Pick<
    ReturnType<typeof useModsManagement>,
    | 'selectSource'
    | 'state'
    | 'sourceUrl'
    | 'setSourceUrl'
    | 'selectedSourceId'
    | 'setSelectedSourceId'
    | 'sourceUsername'
    | 'setSourceUsername'
    | 'secretReferences'
    | 'selectedSecretReference'
    | 'setSelectedSecretReference'
    | 'secretReferenceError'
    | 'credentialPickerOpen'
    | 'setCredentialPickerOpen'
    | 'credentialQuery'
    | 'setCredentialQuery'
    | 'activeCredentialIndex'
    | 'setActiveCredentialIndex'
    | 'credentialPickerRef'
    | 'credentialSearchRef'
    | 'sourceSecretRef'
    | 'busy'
    | 'error'
    | 'selectedSource'
    | 'sourceRefresh'
    | 'rankedSecretReferences'
    | 'visibleSecretReferences'
    | 'chooseSecretReference'
    | 'openCredentialPicker'
    | 'credentialPickerKeyDown'
    | 'run'
    | 'removeStoredCredential'
    | 'addSource'
  >;
  overflowTarget?: HTMLElement | null;
}) {
  const {
    selectSource,
    state,
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
    busy,
    selectedSource,
    sourceRefresh,
    rankedSecretReferences,
    visibleSecretReferences,
    chooseSecretReference,
    openCredentialPicker,
    credentialPickerKeyDown,
    run,
    removeStoredCredential,
    addSource,
  } = model;
  const refreshSourcesAction = (label: string) => (
    <button
      className="secondary"
      type="button"
      disabled={busy !== null}
      onClick={() => void run('refresh', '/api/mod-management/refresh', { method: 'POST' })}
    >
      {busy === 'refresh' ? 'Refreshing…' : label}
    </button>
  );

  const sourceInventoryContents =
    state.sources.length === 0 ? (
      <p className="settings-empty">No custom sources configured.</p>
    ) : (
      <div className="memory-connection-list">
        {state.sources.map((source: ModSource) => (
          <article className="memory-connection" key={source.id}>
            <button
              type="button"
              className="memory-connection-select"
              aria-label={`Edit ${sourceModName(source, state.mods)}`}
              aria-pressed={source.id === selectedSourceId}
              onClick={() => {
                selectSource(source);
              }}
            >
              <strong>{sourceModName(source, state.mods)}</strong>
              <small>
                {source.status || 'Unknown'}
                {source.lastCheckedAt
                  ? ` · Checked ${formatCheckedTime(source.lastCheckedAt)}`
                  : ''}
                {source.error ? ` · ${source.error}` : ''}
              </small>
            </button>
            <div className="memory-connection-actions">
              <button
                className="danger memory-edit"
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    source.id,
                    `/api/mod-management/sources/${encodeURIComponent(source.id)}`,
                    { method: 'DELETE' },
                    () => {
                      if (source.id === selectedSourceId) {
                        setSelectedSourceId(null);
                        setSourceUrl('');
                        setSourceUsername('');
                        if (sourceSecretRef.current) sourceSecretRef.current.value = '';
                      }
                    },
                  )
                }
              >
                Remove
              </button>
            </div>
          </article>
        ))}
      </div>
    );
  const sourceInventory = overflowTarget ? (
    <div
      className="settings-overflow-content memory-saved mod-source-inventory"
      aria-label="Configured mod sources"
    >
      {sourceInventoryContents}
    </div>
  ) : (
    <details className="memory-saved saved-accordion mod-source-inventory" open>
      <summary>
        <h3>Configured sources</h3>
        <span>{state.sources.length}</span>
      </summary>
      {sourceInventoryContents}
    </details>
  );
  const sourceConfiguration = (
    <section
      className="setting-section mod-source-configuration"
      aria-labelledby="mod-sources-heading"
    >
      <h2 id="mod-sources-heading">{selectedSource ? 'Selected mod source' : 'Mod sources'}</h2>
      <p className="settings-description">
        {selectedSource
          ? 'Recheck this source or replace its HTTPS credentials. The repository URL cannot be changed in place; remove it and add a new source to change the URL.'
          : 'Add a Git repository URL (HTTP(S), ssh://, or scp-style SSH). Core discovers version-tagged releases containing burrow.mod.json.'}
      </p>
      <p className="settings-help" role="status">
        {sourceRefresh.refreshing
          ? 'Checking configured sources now…'
          : sourceRefresh.enabled
            ? `Background source checks are active${sourceRefresh.intervalMs ? ` · every ${formatDuration(sourceRefresh.intervalMs)}` : ''}${sourceRefresh.failures ? ` · ${sourceRefresh.failures} consecutive failed refresh${sourceRefresh.failures === 1 ? '' : 'es'}` : ''}.`
            : 'Background source checks are disabled.'}
      </p>
      <Field label="Git repository URL">
        <input
          value={selectedSource?.url ?? sourceUrl}
          readOnly={!!selectedSource}
          onChange={(event) => setSourceUrl(event.target.value)}
          placeholder="https://git.example.com/team/mod.git"
        />
      </Field>
      <Field label="Private repository username (optional)">
        <input
          value={sourceUsername}
          onChange={(event) => setSourceUsername(event.target.value)}
          autoComplete="off"
        />
      </Field>
      {selectedSource?.credential?.configured && !selectedSecretReference && (
        <div className="credential-configured" role="status">
          <span className="credential-configured-icon" aria-hidden="true">
            🔒
          </span>
          <span>
            <strong>Stored credential configured</strong>
            <small>Leave the password or token empty to keep using it.</small>
          </span>
          <button
            className="danger"
            type="button"
            aria-label="Remove stored credential"
            disabled={busy !== null}
            onClick={() => void removeStoredCredential()}
          >
            {busy === 'source-credential' ? 'Removing…' : 'Remove'}
          </button>
        </div>
      )}
      <div className="credential-picker" ref={credentialPickerRef}>
        <div className="field">
          <label htmlFor="mod-source-secret">Password or access token (optional)</label>
          <div className="credential-entry">
            <input
              id="mod-source-secret"
              ref={sourceSecretRef}
              type="password"
              autoComplete="new-password"
              placeholder={
                selectedSecretReference
                  ? 'Stored credential selected'
                  : 'Paste a credential or type {{gss:…}}'
              }
              aria-haspopup={secretReferences.length ? 'listbox' : undefined}
              aria-expanded={secretReferences.length ? credentialPickerOpen : undefined}
              aria-controls={credentialPickerOpen ? 'mod-source-credentials' : undefined}
              onChange={(event) => {
                const exact =
                  secretReferences.find((item) => item.reference === event.target.value) || null;
                setSelectedSecretReference(exact);
                if (event.target.value === '{{' && secretReferences.length) openCredentialPicker();
              }}
            />
            {secretReferences.length > 0 && (
              <button
                className="credential-browse"
                type="button"
                disabled={busy !== null}
                aria-label="Browse stored credentials"
                aria-expanded={credentialPickerOpen}
                aria-controls="mod-source-credentials"
                onClick={() =>
                  credentialPickerOpen ? setCredentialPickerOpen(false) : openCredentialPicker()
                }
              >
                Browse
              </button>
            )}
          </div>
        </div>
        {selectedSecretReference && (
          <div
            className="credential-selection"
            role="status"
            title={selectedSecretReference.reference}
          >
            <span aria-hidden="true">🔒</span>
            <span>
              <strong>{selectedSecretReference.label}</strong>
              <small>
                {[selectedSecretReference.service, selectedSecretReference.username]
                  .filter(Boolean)
                  .join(' · ') || 'Stored credential'}
              </small>
            </span>
            <button
              type="button"
              aria-label={`Clear ${selectedSecretReference.label}`}
              onClick={() => {
                setSelectedSecretReference(null);
                if (sourceSecretRef.current) {
                  sourceSecretRef.current.value = '';
                  sourceSecretRef.current.focus();
                }
              }}
            >
              ×
            </button>
          </div>
        )}
        {credentialPickerOpen && (
          <div className="credential-picker-panel">
            <input
              ref={credentialSearchRef}
              className="credential-search"
              type="search"
              role="combobox"
              aria-label="Search stored credentials"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls="mod-source-credentials"
              aria-activedescendant={
                visibleSecretReferences.length
                  ? `mod-source-credential-${activeCredentialIndex}`
                  : undefined
              }
              value={credentialQuery}
              onChange={(event) => setCredentialQuery(event.target.value)}
              onKeyDown={credentialPickerKeyDown}
              placeholder="Search credentials"
            />
            <div
              id="mod-source-credentials"
              className="credential-options"
              role="listbox"
              aria-label="Stored credentials"
            >
              {visibleSecretReferences.map((item, index) => (
                <button
                  type="button"
                  role="option"
                  id={`mod-source-credential-${index}`}
                  aria-selected={selectedSecretReference?.reference === item.reference}
                  className={activeCredentialIndex === index ? 'active' : ''}
                  key={item.reference}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveCredentialIndex(index)}
                  onClick={() => chooseSecretReference(item)}
                >
                  <span aria-hidden="true">🔒</span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>
                      {[item.service, item.username, item.type].filter(Boolean).join(' · ')}
                    </small>
                  </span>
                </button>
              ))}
              {visibleSecretReferences.length === 0 && (
                <p className="credential-empty">No compatible credentials match.</p>
              )}
            </div>
            {rankedSecretReferences.length > visibleSecretReferences.length && (
              <p className="credential-limit">
                Showing 100 of {rankedSecretReferences.length}. Refine your search.
              </p>
            )}
          </div>
        )}
      </div>
      {secretReferenceError && (
        <p className="settings-help">
          Stored credentials unavailable. You can still paste a credential or enter a secret
          reference.
        </p>
      )}
      <p className="settings-help">
        Public repositories need only a URL. Credentials are for HTTPS Git repositories only.
        Stored-secret references are resolved only by Core; the browser never receives their values.
        For SSH, configure keys and host trust on the Core service account.
      </p>
      <div className="model-actions">
        {refreshSourcesAction('Refresh sources')}
        <button
          className="primary"
          type="button"
          disabled={(!selectedSource && !sourceUrl.trim()) || busy !== null}
          onClick={() => void addSource()}
        >
          {busy === 'source'
            ? selectedSource
              ? 'Updating…'
              : 'Adding…'
            : selectedSource
              ? 'Update source'
              : 'Add source'}
        </button>
      </div>
    </section>
  );

  return (
    <>
      {sourceConfiguration}
      {!overflowTarget && sourceInventory}
      {overflowTarget && createPortal(sourceInventory, overflowTarget)}
    </>
  );
}

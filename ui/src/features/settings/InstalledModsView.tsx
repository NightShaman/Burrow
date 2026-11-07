import type { useModsManagement } from './useModsManagement';
import { createPortal } from 'react-dom';
import type { ModRecord } from './modManagementApi';
function actionLabel(mod: ModRecord) {
  if (mod.status !== 'installed') return 'Install';
  return mod.version && mod.latestVersion && mod.updateAvailable === true ? 'Update' : 'Reinstall';
}

export function InstalledModsView({
  model,
  overflowTarget,
}: {
  model: Pick<
    ReturnType<typeof useModsManagement>,
    | 'state'
    | 'selectedModId'
    | 'setSelectedModId'
    | 'busy'
    | 'selectedMod'
    | 'run'
    | 'install'
    | 'lifecycle'
  >;
  overflowTarget?: HTMLElement | null;
}) {
  const { state, selectedModId, setSelectedModId, busy, selectedMod, run, install, lifecycle } =
    model;
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

  const modInventoryContents =
    state.mods.length === 0 ? (
      <p className="settings-empty">No mods found. Add a source in Mod sources.</p>
    ) : (
      <div className="memory-connection-list">
        {state.mods.map((mod) => (
          <article className="memory-connection" key={mod.id}>
            <button
              type="button"
              className="memory-connection-select"
              aria-label={`Manage ${mod.name}`}
              aria-pressed={mod.id === selectedModId}
              disabled={busy !== null}
              onClick={() => setSelectedModId(mod.id)}
            >
              <strong>
                {mod.name}
                {mod.system && <span className="mod-system-badge">System</span>}
              </strong>
              <small>
                {mod.status === 'installed'
                  ? mod.enabled
                    ? 'Installed · Enabled'
                    : 'Installed · Disabled'
                  : 'Available'}
                {mod.version ? ` · Installed ${mod.version}` : ''}
                {mod.runningVersion ? ` · Running ${mod.runningVersion}` : ''}
                {mod.managedSkillVersion ? ` · Managed skill ${mod.managedSkillVersion}` : ''}
              </small>
            </button>
          </article>
        ))}
      </div>
    );
  const modInventory = overflowTarget ? (
    <div className="settings-overflow-content memory-saved" aria-label="Mod catalog">
      {modInventoryContents}
    </div>
  ) : (
    <details className="memory-saved saved-accordion" open>
      <summary>
        <h3>Mod catalog</h3>
        <span>{state.mods.length}</span>
      </summary>
      {modInventoryContents}
    </details>
  );

  const modConfiguration = (
    <section className="setting-section mod-configuration" aria-labelledby="selected-mod-heading">
      <h2 id="selected-mod-heading">{selectedMod ? selectedMod.name : 'Mod details'}</h2>
      <div className="setting-actions">{refreshSourcesAction('Refresh catalog')}</div>
      {selectedMod ? (
        <>
          <dl className="settings-metadata">
            <div>
              <dt>Mod ID</dt>
              <dd>
                <output aria-label="Mod ID">{selectedMod.id}</output>
              </dd>
            </div>
            <div>
              <dt>Installed version</dt>
              <dd>
                <output aria-label="Installed version">
                  {selectedMod.status === 'installed'
                    ? selectedMod.version || 'Unknown'
                    : 'Not installed'}
                </output>
              </dd>
            </div>
            <div>
              <dt>Running version</dt>
              <dd>
                <output aria-label="Running version">
                  {selectedMod.enabled
                    ? selectedMod.runningVersion || 'Unavailable'
                    : 'Not running'}
                </output>
              </dd>
            </div>
            <div>
              <dt>Latest source version</dt>
              <dd>
                <output aria-label="Latest source version">
                  {selectedMod.latestVersion || 'Unknown'}
                </output>
              </dd>
            </div>
          </dl>
          <p className="settings-description">
            {selectedMod.status === 'installed'
              ? `Installed · ${selectedMod.enabled ? 'Enabled' : 'Disabled'}`
              : 'Available from a configured source'}
            {selectedMod.reason ? ` · ${selectedMod.reason}` : ''}
          </p>
          <p className="settings-help">
            Install, update, enable, and disable apply live without restarting Burrow. All mods,
            including Node Goblin and system mods, start disabled until you explicitly enable them
            in Settings → Mods → Installed mods. Updates and reinstalls preserve the current enabled
            or disabled state.
          </p>
          {selectedMod.status === 'installed' && selectedMod.enabled === false && (
            <p className="settings-help">
              This mod is disabled. Choose Enable to activate it; installation alone does not enable
              it.
            </p>
          )}
          <div className="model-actions">
            {selectedMod.status === 'installed' && (
              <button
                className="danger"
                type="button"
                disabled={busy !== null}
                onClick={() => lifecycle(selectedMod, 'uninstall')}
              >
                {busy === selectedMod.id ? 'Working…' : 'Uninstall'}
              </button>
            )}
            {selectedMod.status === 'installed' && (
              <button
                className="secondary"
                type="button"
                disabled={busy !== null}
                onClick={() => lifecycle(selectedMod, selectedMod.enabled ? 'disable' : 'enable')}
              >
                {busy === selectedMod.id ? 'Working…' : selectedMod.enabled ? 'Disable' : 'Enable'}
              </button>
            )}
            <button
              className={selectedMod.status === 'installed' ? 'secondary' : 'primary'}
              type="button"
              disabled={busy !== null || selectedMod.canInstall === false}
              onClick={() => install(selectedMod)}
            >
              {busy === selectedMod.id ? 'Working…' : actionLabel(selectedMod)}
            </button>
          </div>
        </>
      ) : (
        <p className="settings-empty">Select a mod from the catalog to manage it.</p>
      )}
    </section>
  );

  return (
    <>
      {modConfiguration}
      {!overflowTarget && modInventory}
      {overflowTarget && createPortal(modInventory, overflowTarget)}
    </>
  );
}

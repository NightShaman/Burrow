import './inventoryCardDensity.css';
import { useModsManagement } from './useModsManagement';
export { rankSecretReferences } from './useModsManagement';
import { InstalledModsView } from './InstalledModsView';
import { SourcesCredentialsView } from './SourcesCredentialsView';
import { AutomaticChecksView } from './AutomaticChecksView';

type ModsSection = 'installed' | 'sources' | 'automatic-checks';
type Props = { section?: ModsSection; overflowTarget?: HTMLElement | null };

export function ModsSettings({ section = 'installed', overflowTarget }: Props) {
  const model = useModsManagement(section);
  const { state, error } = model;
  return (
    <div className="mod-management-settings">
      {error && (
        <p className="settings-request-error" role="alert">
          {error}
        </p>
      )}
      {state.restartRequired && (
        <p className="settings-auth-warning mod-restart-notice" role="status">
          <strong>Restart required.</strong> This Core reported that the latest mod change still
          needs a restart.
        </p>
      )}
      {section === 'installed' ? (
        <InstalledModsView model={model} overflowTarget={overflowTarget} />
      ) : section === 'sources' ? (
        <SourcesCredentialsView model={model} overflowTarget={overflowTarget} />
      ) : (
        <AutomaticChecksView model={model} />
      )}
    </div>
  );
}

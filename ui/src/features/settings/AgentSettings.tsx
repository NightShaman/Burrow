import { DefaultMinionModel } from './DefaultMinionModel';
import { MinionDepthSettings } from './MinionDepthSettings';
import { createPortal } from 'react-dom';
import type { Agent, SavedProvider } from '../../app/types';
import { SettingSection } from './SettingsPrimitives';
import { AgentDetails } from './AgentDetails';
import { AgentMcpTools } from './AgentMcpTools';
import { AgentProfileDocuments } from './AgentProfileDocuments';
import { AgentDreams } from './AgentDreams';
import { AgentWorkflowEvents } from './AgentWorkflowEvents';
import { AgentSchedules } from './AgentSchedules';


export type AgentSettingsProps = { selected: Agent; savedProviders: SavedProvider[]; onAgentsChanged: () => Promise<void>; section?: 'details' | 'profile-documents' | 'mcp-tools' | 'cron-jobs' | 'workflow-events' | 'dreams'; overflowTarget?: HTMLElement | null; onOpenChat?: (sessionId: string, agentId: string) => void };

export function AgentSettings({ selected, savedProviders, onAgentsChanged, section, overflowTarget, onOpenChat }: AgentSettingsProps) {
  const resourceId = selected.resourceId ?? selected.id;
  const details = <AgentDetails key={JSON.stringify([selected.id, resourceId])} selected={selected} onAgentsChanged={onAgentsChanged} />;
  const minion = <SettingSection title="Minion settings"><DefaultMinionModel key={JSON.stringify([selected.id, resourceId, 'model'])} resourceId={resourceId} savedProviders={savedProviders} /><MinionDepthSettings key={JSON.stringify([selected.id, resourceId, 'depth'])} resourceId={resourceId} /></SettingSection>;
  if (section === 'details') return <>{details}{overflowTarget ? createPortal(<div className="settings-overflow-content">{minion}</div>, overflowTarget) : minion}</>;
  if (section === 'profile-documents') return <AgentProfileDocuments agentId={selected.id} overflowTarget={overflowTarget} />;
  if (section === 'mcp-tools') return <AgentMcpTools agentId={selected.id} />;
  if (section === 'workflow-events') return <AgentWorkflowEvents agentId={selected.id} overflowTarget={overflowTarget} />;
  if (section === 'cron-jobs') return <AgentSchedules agentId={selected.id} onOpenChat={onOpenChat} savedProviders={savedProviders} overflowTarget={overflowTarget} />;
  if (section === 'dreams') return <AgentDreams agentId={selected.id} savedProviders={savedProviders} overflowTarget={overflowTarget} />;
  return <div className="agent-settings-grid">
    <div className="agent-settings-left">{details}{minion}<div className="agent-profile-documents"><AgentProfileDocuments agentId={selected.id} /></div></div>
    <div className="agent-settings-middle"><AgentMcpTools agentId={selected.id} /><AgentSchedules agentId={selected.id} onOpenChat={onOpenChat} savedProviders={savedProviders} /></div>
    <div className="agent-settings-right agent-settings-dreams"><AgentDreams agentId={selected.id} savedProviders={savedProviders} /></div>
  </div>;
}

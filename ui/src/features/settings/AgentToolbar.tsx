import { useUnsavedNavigation } from '../../app/UnsavedChanges';
import { useEffect, useState } from 'react';
import type { Agent } from '../../app/types';
import { isAgentEnabled } from '../../app/agentCatalog';
import { FirstRunSetup } from './FirstRunSetup';
import { NewAgentDialog } from './NewAgentDialog';

export type AgentToolbarProps = { agents: Agent[]; selectedId: string; onSelect: (id: string) => void; onAgentsChanged: () => Promise<void>; onModelConnectionsChanged: () => Promise<void>; onOperatorProfileChanged?: (profile: { name: string; avatar: string }) => void; onFirstRunComplete?: () => void; onSetupComplete?: () => Promise<void>; firstRun?: boolean; globalSelected?: boolean; onSelectGlobal?: () => void };


/** Setup state is explicit; an empty registry is not a first-run signal. */
export function AgentToolbar(props: AgentToolbarProps) {
  const { agents, selectedId, onSelect, firstRun = false } = props;
  const navigate = useUnsavedNavigation();
  const [showNewAgent, setShowNewAgent] = useState(false);
  // Setup status becomes ready before the existing five-second finale ends.
  // Retain that owner until its completion callback, not merely while status is fresh.
  const [setupOpen, setSetupOpen] = useState(firstRun);
  useEffect(() => { if (firstRun) setSetupOpen(true); }, [firstRun]);
  return <>
    <div className="agent-toolbar" aria-label="Agent configuration selector">
      <button className="primary" type="button" onClick={() => navigate(() => setShowNewAgent(true))}>New Agent</button>
      <div className="agent-toolbar-selector" role="group" aria-label="Configured agents">
        {props.onSelectGlobal && <button type="button" className={props.globalSelected ? 'active' : ''} aria-pressed={props.globalSelected === true} onClick={() => { if (!props.globalSelected) navigate(props.onSelectGlobal!); }}>Global</button>}
        {agents.map(agent => <button className={[!props.globalSelected && agent.id === selectedId ? 'active' : '', !isAgentEnabled(agent) ? 'agent-disabled' : ''].filter(Boolean).join(' ')} type="button" onClick={() => { if (props.globalSelected || agent.id !== selectedId) navigate(() => onSelect(agent.id)); }} key={agent.id} aria-pressed={!props.globalSelected && agent.id === selectedId}>{agent.name}</button>)}
      </div>
    </div>
    {setupOpen ? <FirstRunSetup {...props} onFirstRunComplete={() => { setSetupOpen(false); props.onFirstRunComplete?.(); }} /> : showNewAgent ? <NewAgentDialog onClose={() => setShowNewAgent(false)} onSelect={onSelect} onAgentsChanged={props.onAgentsChanged} /> : null}
  </>;
}

import { useEffect, useState } from 'react';
import type { Agent } from '../../app/types';
import { FirstRunSetup } from './FirstRunSetup';
import { NewAgentDialog } from './NewAgentDialog';

export type AgentToolbarProps = { agents: Agent[]; selectedId: string; onSelect: (id: string) => void; onAgentsChanged: () => Promise<void>; onModelConnectionsChanged: () => Promise<void>; onOperatorProfileChanged?: (profile: { name: string; avatar: string }) => void; onFirstRunComplete?: () => void; onSetupComplete?: () => Promise<void>; firstRun?: boolean };


/** Setup state is explicit; an empty registry is not a first-run signal. */
export function AgentToolbar(props: AgentToolbarProps) {
  const { agents, selectedId, onSelect, firstRun = false } = props;
  const [showNewAgent, setShowNewAgent] = useState(false);
  // Setup status becomes ready before the existing five-second finale ends.
  // Retain that owner until its completion callback, not merely while status is fresh.
  const [setupOpen, setSetupOpen] = useState(firstRun);
  useEffect(() => { if (firstRun) setSetupOpen(true); }, [firstRun]);
  return <>
    <div className="agent-toolbar" aria-label="Agent configuration selector">
      <button className="primary" type="button" onClick={() => setShowNewAgent(true)}>New Agent</button>
      <div className="agent-toolbar-selector" role="group" aria-label="Configured agents">
        {agents.map(agent => <button className={agent.id === selectedId ? 'active' : ''} type="button" onClick={() => onSelect(agent.id)} key={agent.id} aria-pressed={agent.id === selectedId}>{agent.name}</button>)}
      </div>
    </div>
    {setupOpen ? <FirstRunSetup {...props} onFirstRunComplete={() => { setSetupOpen(false); props.onFirstRunComplete?.(); }} /> : showNewAgent ? <NewAgentDialog onClose={() => setShowNewAgent(false)} onSelect={onSelect} onAgentsChanged={props.onAgentsChanged} /> : null}
  </>;
}

import { SettingsEntitySelector } from './SettingsEntitySelector';
import { useUnsavedNavigation } from '../../app/UnsavedChanges';
import { useEffect, useState } from 'react';
import type { Agent } from '../../app/types';
import { isAgentEnabled } from '../../app/agentCatalog';
import { FirstRunSetup } from './FirstRunSetup';
import { NewAgentDialog } from './NewAgentDialog';

export type AgentToolbarProps = {
  agents: Agent[];
  selectedId: string;
  onSelect: (id: string) => void;
  onAgentsChanged: () => Promise<void>;
  onModelConnectionsChanged: () => Promise<void>;
  onOperatorProfileChanged?: (profile: { name: string; avatar: string }) => void;
  onFirstRunComplete?: () => void;
  onSetupComplete?: () => Promise<void>;
  firstRun?: boolean;
  globalSelected?: boolean;
  onSelectGlobal?: () => void;
};

/** Setup state is explicit; an empty registry is not a first-run signal. */
export function AgentToolbar(props: AgentToolbarProps) {
  const { agents, selectedId, onSelect, firstRun = false } = props;
  const navigate = useUnsavedNavigation();
  const [showNewAgent, setShowNewAgent] = useState(false);
  // Setup status becomes ready before the existing five-second finale ends.
  // Retain that owner until its completion callback, not merely while status is fresh.
  const [setupOpen, setSetupOpen] = useState(firstRun);
  useEffect(() => {
    if (firstRun) setSetupOpen(true);
  }, [firstRun]);
  return (
    <>
      <SettingsEntitySelector
        label="Agent configuration selector"
        noun="agents"
        groupLabel="Configured agents"
        buttonsLabel="Agent buttons"
        items={agents.map((agent) => ({
          id: agent.id,
          label: agent.name,
          disabled: !isAgentEnabled(agent),
        }))}
        selectedId={selectedId}
        unselected={props.globalSelected}
        onSelect={(id) => navigate(() => onSelect(id))}
        action={
          <button
            className="primary"
            type="button"
            onClick={() => navigate(() => setShowNewAgent(true))}
          >
            New Agent
          </button>
        }
        leading={
          props.onSelectGlobal && (
            <button
              type="button"
              className={props.globalSelected ? 'active' : ''}
              aria-pressed={props.globalSelected === true}
              onClick={() => {
                if (!props.globalSelected) navigate(props.onSelectGlobal!);
              }}
            >
              Global
            </button>
          )
        }
      />
      {setupOpen ? (
        <FirstRunSetup
          {...props}
          onFirstRunComplete={() => {
            setSetupOpen(false);
            props.onFirstRunComplete?.();
          }}
        />
      ) : showNewAgent ? (
        <NewAgentDialog
          onClose={() => setShowNewAgent(false)}
          onSelect={onSelect}
          onAgentsChanged={props.onAgentsChanged}
        />
      ) : null}
    </>
  );
}

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentSettings } from '../../src/features/settings/AgentSettings';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../src/app/UnsavedChanges';
import '../../src/app.css';
const agents = ['Echo', 'Ember'].map((name) => ({
  id: name.toLowerCase(),
  resourceId: `fixture::${name.toLowerCase()}`,
  name,
  avatar: name[0],
  enabled: true,
  activity: 'Idle',
}));
function Fixture() {
  const [agent, setAgent] = useState(agents[0]);
  const [overflow, setOverflow] = useState<HTMLDivElement | null>(null);
  const navigate = useUnsavedNavigation();
  return (
    <div style={{ padding: 24 }}>
      <header>
        <strong>Owned reference photo fixture — in-memory only</strong>
        <label style={{ marginLeft: 20 }}>
          <input id="fail-writes" type="checkbox" />
          Fail photo writes
        </label>
      </header>
      <div className="settings-prototype-menu">
        <button>General</button>
        <button className="active">Agents</button>
        <button>Connections</button>
      </div>
      <main className="settings-blank-slate has-top-navigation has-agent-selector">
        <div className="settings-prototype-agent-selector">
          <div className="agent-toolbar">
            <div className="agent-toolbar-selector">
              {agents.map((a) => (
                <button key={a.id} onClick={() => navigate(() => setAgent(a))}>
                  {a.name}
                </button>
              ))}
            </div>
          </div>
        </div>
        <nav className="settings-blank-column settings-prototype-sections">
          <button className="active">Agent details</button>
          <button>Profile documents</button>
          <button>MCP tools</button>
        </nav>
        <div className="settings-blank-column settings-prototype-configuration">
          <AgentSettings
            selected={agent as any}
            savedProviders={[]}
            onAgentsChanged={async () => {}}
            section="details"
            overflowTarget={overflow}
          />
        </div>
        <div className="settings-blank-column settings-prototype-overflow" ref={setOverflow} />
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <ConfirmProvider>
    <UnsavedChangesProvider>
      <Fixture />
    </UnsavedChangesProvider>
  </ConfirmProvider>,
);

import { useEffect, useMemo, useState, type DragEvent } from 'react';
import type { Agent } from '../../app/types';
import { completeAgentOrder, orderAgents, type AgentRailPreferences, type AgentRailView } from '../../app/useAgentRailPreferences';
import { Field, SettingSection } from './SettingsPrimitives';

export function AgentSidebarSettings({ agents, preferences, setPreferences }: { agents: Agent[]; preferences: AgentRailPreferences; setPreferences: (next: AgentRailPreferences | ((current: AgentRailPreferences) => AgentRailPreferences)) => void }) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const orderedAgents = useMemo(() => orderAgents(agents, preferences.order), [agents, preferences.order]);

  useEffect(() => {
    const next = completeAgentOrder(agents, preferences.order);
    if (next.length !== preferences.order.length || next.some((id, index) => id !== preferences.order[index])) {
      setPreferences((current) => ({ ...current, order: next }));
    }
  }, [agents, preferences.order, setPreferences]);

  const clearDrag = () => { setDraggedId(null); setDropTargetId(null); };
  const reorder = (sourceId: string, targetId: string) => {
    const next = orderedAgents.map((agent) => agent.id);
    const sourceIndex = next.indexOf(sourceId);
    const targetIndex = next.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
    next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, sourceId);
    setPreferences((current) => ({ ...current, order: next }));
  };
  const drop = (event: DragEvent<HTMLElement>, targetId: string) => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData('text/plain') || draggedId;
    if (sourceId) reorder(sourceId, targetId);
    clearDrag();
  };

  return <SettingSection title="Agent panel options">
    <p className="settings-description">These display and ordering preferences apply everywhere the Agents panel is used.</p>
    <Field label="View">
      <select value={preferences.view} onChange={(event) => setPreferences((current) => ({ ...current, view: event.target.value as AgentRailView }))}>
        <option value="regular">Regular</option>
        <option value="compact">Compact</option>
      </select>
    </Field>
    <div className="agent-sidebar-order" aria-label="Agent order">
      <span className="field-label">Order</span>
      <p className="hint">Drag agents into the order you want them shown in the sidebar.</p>
      <div className="agent-sidebar-order-list">
        {orderedAgents.map((agent) => <div key={agent.id} draggable className={`${draggedId === agent.id ? 'dragging' : ''} ${dropTargetId === agent.id && draggedId !== agent.id ? 'drop-target' : ''}`} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', agent.id); setDraggedId(agent.id); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTargetId(agent.id); }} onDragLeave={() => setDropTargetId((current) => current === agent.id ? null : current)} onDrop={(event) => drop(event, agent.id)} onDragEnd={clearDrag}>
          <span className="agent-sidebar-order-handle" aria-hidden="true">⠿</span>
          <span className="avatar">{agent.avatar.startsWith('data:image/') ? <img src={agent.avatar} alt="" /> : agent.avatar}</span>
          <b>{agent.name}</b>
        </div>)}
      </div>
    </div>
  </SettingSection>;
}

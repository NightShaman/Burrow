import { useEffect, useState, type PointerEvent, type ReactNode } from 'react';
import type { Agent, FileNode, PanelId } from '../../app/types';
import { apiForTarget, type RuntimeHealth, type RuntimeMetrics } from '../../app/api';
import type { ApiTarget } from '../../app/apiTargets';
import type { ProviderConnectionStatus } from '../../app/useRuntimeDashboard';
import { getPanelTitle } from '../../app/panelRegistry';
import './workspace-rail.css';

export function Chevron({ direction }: { direction: 'left' | 'right' | 'down' }) { return <svg className={`chevron chevron-${direction}`} viewBox="0 0 16 16" aria-hidden="true"><path d="m5.5 2.75 5.25 5.25-5.25 5.25" /></svg>; }

export function RailExpander({ label, onClick, side }: { label: string; onClick: () => void; side: 'left' | 'right' }) { return <button className={`rail-expander ${side}`} onClick={onClick} aria-label={label}><Chevron direction={side === 'left' ? 'right' : 'left'} /></button>; }

export type WorkspacePanelContext = { agents: Agent[]; selected: Agent; selectedStreamId: string; expandedAgents: Set<string>; onToggleAgent: (id: string) => void; onSelectAgent: (agent: Agent) => void; onSelectSubagent: (agentId: string, subagentId: string) => void; onOpenFile: (node: FileNode) => void };

export function WorkspaceRail({ collapsed, topPanel, bottomPanel, renderPanel, onExpand, onCollapse, onResizeSplit }: { collapsed: boolean; topPanel: PanelId; bottomPanel: PanelId; renderPanel: (panel: PanelId) => ReactNode; onExpand: () => void; onCollapse: () => void; onResizeSplit: (event: PointerEvent) => void }) {
  return <aside className={`left-rail ${collapsed ? 'collapsed' : ''}`}>{collapsed ? <RailExpander label="Open left rail" onClick={onExpand} side="left" /> : <><div className="rail-head"><span>{getPanelTitle(topPanel)}</span><button onClick={onCollapse} aria-label="Collapse left rail"><Chevron direction="left" /></button></div><div className="left-panes"><section className="rail-panel top">{renderPanel(topPanel)}</section><button className="resize-divider vertical" onPointerDown={onResizeSplit} aria-label="Resize left rail panels" /><section className="rail-panel bottom"><div className="rail-head"><span>{getPanelTitle(bottomPanel)}</span></div>{renderPanel(bottomPanel)}</section></div></>}</aside>;
}

export function AgentsPanel({ agents, selectedStreamId, expandedAgents, onToggleAgent, onSelectAgent, onSelectSubagent }: Pick<WorkspacePanelContext, 'agents' | 'selectedStreamId' | 'expandedAgents' | 'onToggleAgent' | 'onSelectAgent' | 'onSelectSubagent'>) {
 return <section className="agent-pane">{agents.map((agent) => <AgentCard key={agent.id} agent={agent} selectedStreamId={selectedStreamId} expanded={expandedAgents.has(agent.id)} onToggle={() => onToggleAgent(agent.id)} onSelect={() => onSelectAgent(agent)} onSelectSubagent={(subagentId) => onSelectSubagent(agent.id, subagentId)} />)}</section>;
}

export function WorkspacePanel({ selected, onOpenFile }: Pick<WorkspacePanelContext, 'selected' | 'onOpenFile'>) { return <section className="workspace-pane"><FileTree nodes={selected.files} openFile={onOpenFile} /></section>; }

function formatBytes(bytes?: number | null) {
 if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return 'Unavailable';
 if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
 return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUptime(seconds?: number | null) {
 if (seconds === undefined || seconds === null || !Number.isFinite(seconds)) return 'Unavailable';
 const totalMinutes = Math.floor(seconds / 60);
 const days = Math.floor(totalMinutes / 1440);
 const hours = Math.floor((totalMinutes % 1440) / 60);
 const minutes = totalMinutes % 60;
 return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function SystemPanel({ target, provider, providerConnectionStatus }: { target: ApiTarget; provider: string; providerConnectionStatus: ProviderConnectionStatus }) {
 const [now, setNow] = useState(() => new Date());
 const [health, setHealth] = useState<RuntimeHealth | null>(null);
 const [metrics, setMetrics] = useState<RuntimeMetrics | null>(null);
 useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(timer); }, []);
 useEffect(() => { let active = true; setHealth(null); setMetrics(null); const load = () => { void Promise.all([apiForTarget<RuntimeHealth>(target, '/api/health'), apiForTarget<RuntimeMetrics>(target, '/api/metrics')]).then(([nextHealth, nextMetrics]) => { if (active) { setHealth(nextHealth); setMetrics(nextMetrics); } }).catch(() => { if (active) { setHealth(null); setMetrics(null); } }); }; load(); const timer = window.setInterval(load, 10000); return () => { active = false; window.clearInterval(timer); }; }, [target]);
 const traces = health?.traces;
 const process = metrics?.process;
 const heap = process?.heapUsedBytes == null || process?.heapTotalBytes == null ? 'Unavailable' : `${formatBytes(process.heapUsedBytes)} / ${formatBytes(process.heapTotalBytes)}`;
 const stats = [['CPU', process?.cpu.percent == null ? 'Unavailable' : `${process.cpu.percent.toFixed(1)}%`], ['RSS', formatBytes(process?.rssBytes)], ['Heap', heap], ['SQL', metrics?.settingsDatabase.totalBytes == null ? 'Unavailable' : formatBytes(metrics.settingsDatabase.totalBytes)], ['Uptime', formatUptime(process?.uptimeSeconds)], ['Trace storage', traces ? `${formatBytes(traces.logicalBytes)} · ${traces.count ?? '—'} runs` : 'Loading…']];
 const providerLabel = provider.trim() || 'Provider';
 const providerStatusLabel = providerConnectionStatus === 'checking' ? 'Checking provider connection' : providerConnectionStatus === 'connected' ? `${providerLabel} provider` : `${providerLabel} unavailable`;
 return <section className="system-pane"><div className="system-clock">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div><div className="system-date">{now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</div><div className="system-status"><i /> {target.name} runtime</div><div className={`system-provider-status ${providerConnectionStatus}`} title={providerStatusLabel}><i /> <span>{providerLabel}</span></div><div className="system-stats">{stats.map(([label, value]) => <div className="system-stat" key={label}><span>{label}</span><b>{value}</b></div>)}</div></section>;
}


function AgentCard({ agent, selectedStreamId, expanded, onToggle, onSelect, onSelectSubagent }: { agent: Agent; selectedStreamId: string; expanded: boolean; onToggle: () => void; onSelect: () => void; onSelectSubagent: (id: string) => void }) {
  const selected = selectedStreamId === agent.id;
  return <div className={`agent-group ${selected ? 'active' : ''}`}><div className="agent-card"><button type="button" className="agent-select" onClick={onSelect} aria-label={`Select ${agent.name}`} aria-pressed={selected}><span className="avatar">{agent.avatar.startsWith('data:image/') ? <img src={agent.avatar} alt="" /> : agent.avatar}</span><span className="agent-details"><span className="agent-summary"><span className="agent-identity"><span className="agent-name"><b>{agent.name}</b></span></span><span className={`agent-status ${statusClass(agent.activity)}`}><i />{agent.activity}</span></span></span></button><button type="button" className="agent-toggle" onClick={onToggle} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${agent.name}`} aria-expanded={expanded}><Chevron direction="right" /></button><ContextUsage value={agent.context} details={agent.contextDetails} /></div>{expanded && <div className="subagent-list">{agent.subagents.map((subagent) => <button type="button" className={`subagent-row ${selectedStreamId === subagent.id ? 'active' : ''}`} onClick={() => onSelectSubagent(subagent.id)} key={subagent.id} aria-label={`Select ${subagent.name}`} aria-pressed={selectedStreamId === subagent.id}><span className="subagent-branch">└</span><span className="subagent-copy"><b>{subagent.name}</b><small>{subagent.activity}</small></span></button>)}</div>}</div>;
}

function ContextUsage({ value, details, compact = false }: { value: number | null; details?: Agent['contextDetails']; compact?: boolean }) {
  const capacity = details?.capacityTokens ? ` of ${details.capacityTokens.toLocaleString()} tokens` : '';
  const estimate = details?.estimatedTokens === null ? 'Estimate unavailable' : details?.estimatedTokens !== undefined ? `${details.estimatedTokens.toLocaleString()} tokens` : '';
  const pressure = details?.pressure ? `Pressure: ${details.pressure}.` : '';
  const compaction = details?.compactionActive ? `Compaction enabled${details.rawRecentTurnCount !== null && details.rawRecentTurnCount !== undefined ? `; ${details.rawRecentTurnCount} recent turns kept raw` : ''}.` : '';
  const label = value === null ? 'Context capacity unavailable.' : `${value}% context used${capacity}. ${estimate}. ${pressure} ${compaction}`.trim();
  return <span className={`context-usage ${compact ? 'compact' : ''} ${details?.pressure ? `pressure-${details.pressure}` : ''}`} title={label} aria-label={label}><i><b style={{ width: `${value ?? 0}%` }} /></i><em>{value === null ? '—' : `${value}%`}</em></span>;
}

function FileTree({ nodes, openFile }: { nodes: FileNode[]; openFile: (node: FileNode) => void }) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const toggleDirectory = (path: string) => setExpandedPaths((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const renderNodes = (items: FileNode[], depth = 0) => items.map((node) => { const isDirectory = node.type === 'directory'; const isExpanded = expandedPaths.has(node.path); return <div key={node.path}><button className="file-row" style={{ paddingLeft: `${12 + depth * 16}px` }} onClick={() => isDirectory ? toggleDirectory(node.path) : openFile(node)} {...(isDirectory ? { 'aria-expanded': isExpanded } : {})}><span className="file-toggle" aria-hidden="true">{isDirectory ? <Chevron direction={isExpanded ? 'down' : 'right'} /> : '·'}</span>{node.name}</button>{isDirectory && isExpanded && node.children && renderNodes(node.children, depth + 1)}</div>; });
  return <>{renderNodes(nodes)}</>;
}

function statusClass(activity: string) { return activity.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }

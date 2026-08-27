import { useState, type DragEvent, type PointerEvent, type ReactNode } from 'react';
import type { Account, PanelId } from '../../app/types';
import { formatUsageReset } from '../../app/useRuntimeDashboard';
import { Chevron, RailExpander } from '../workspace/WorkspaceRail';
import { getPanelTitle } from '../../app/panelRegistry';
import { AccountCard } from './AccountCard';
export type PanelContext = { accounts: Account[] };
export function RightRail({ collapsed, topPanel, bottomPanel, renderPanel, onExpand, onCollapse, onResizeSplit }: { collapsed: boolean; topPanel: PanelId; bottomPanel: PanelId; renderPanel: (panel: PanelId) => ReactNode; onExpand: () => void; onCollapse: () => void; onResizeSplit: (event: PointerEvent) => void }) { return <aside className={`right-rail ${collapsed ? 'collapsed' : ''}`}>{collapsed ? <RailExpander label="Open right rail" onClick={onExpand} side="right" /> : <><div className="rail-head"><span>{getPanelTitle(topPanel)}</span><button onClick={onCollapse} aria-label="Collapse right rail"><Chevron direction="right" /></button></div><div className="right-panes"><section className="rail-panel top">{renderPanel(topPanel)}</section><button className="resize-divider vertical" onPointerDown={onResizeSplit} aria-label="Resize right rail panels" /><section className="rail-panel bottom"><div className="rail-head"><span>{getPanelTitle(bottomPanel)}</span></div>{renderPanel(bottomPanel)}</section></div></>}</aside>; }

export function CodexAccounts({ accounts, onReorder }: { accounts: Account[]; onReorder?: (draggedId: string, targetId: string) => void }) {
 const [draggedId, setDraggedId] = useState<string | null>(null);
 const [dropTargetId, setDropTargetId] = useState<string | null>(null);
 const clearDrag = () => { setDraggedId(null); setDropTargetId(null); };
 const handleDrop = (event: DragEvent<HTMLElement>, targetId: string) => { event.preventDefault(); const sourceId = event.dataTransfer.getData('text/plain') || draggedId; if (sourceId && sourceId !== targetId) onReorder?.(sourceId, targetId); clearDrag(); };
 return <section className="codex-content account-status">{accounts.map((account) => {
   const remaining = 100 - account.used;
   const statusClass = account.status.toLowerCase().replace(/\s+/g, '-');
   const isDragging = draggedId === account.id;
   const isDropTarget = dropTargetId === account.id && !isDragging;
   const meters = account.meters?.length
     ? account.meters.filter((meter) => !(meter.key === 'primary' && meter.remainingPercent === 0 && !meter.resetAt))
     : [{ key: 'legacy', label: '', remainingPercent: remaining, resetAt: null }];
   return <AccountCard name={account.name} subtitle={account.plan} status={account.status} statusTone={statusClass as 'active' | 'paused' | 'quota-exceeded' | 'reauth-required'} className={`${isDragging ? 'dragging' : ''} ${isDropTarget ? 'drop-target' : ''}`} key={account.id} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', account.id); setDraggedId(account.id); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTargetId(account.id); }} onDragLeave={() => setDropTargetId((current) => current === account.id ? null : current)} onDrop={(event) => handleDrop(event, account.id)} onDragEnd={clearDrag}>
     <div className={`account-meters ${meters.length === 2 ? 'two-up' : ''}`}>
       {meters.map((meter, index) => { const meterLevel = meter.remainingPercent === null ? 'unknown' : meter.remainingPercent <= 15 ? 'low' : meter.remainingPercent <= 50 ? 'medium' : 'high'; return <div className={`account-meter ${index === 1 ? 'secondary' : 'primary'}`} key={meter.key}>
         <div className="usage"><i style={{ width: `${meter.remainingPercent ?? 0}%` }} /></div>
         <small className={`usage-percent ${meterLevel}`}>{meter.remainingPercent === null ? '—' : `${meter.remainingPercent}%`}</small>
         <small className="account-reset-time">{meter.resetAt ? formatUsageReset(meter.resetAt) : '\u00a0'}</small>
       </div>; })}
     </div>
     {!account.meters?.length && <div className="account-footer"><small>{account.reset}</small>{account.resetCredit && <small className="reset-credit">{account.resetCredit}</small>}</div>}
   </AccountCard>;
 })}</section>;
}

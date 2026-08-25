import type { ApiTarget } from '../../app/apiTargets';

export function TargetSelector({ targets, selectedId, onChange }: { targets: ApiTarget[]; selectedId: string; onChange: (id: string) => void }) {
  return <label className="target-selector"><span>NODE</span><select value={selectedId} onChange={(event) => onChange(event.target.value)} aria-label="Active Burrow node">{targets.map((target) => <option value={target.id} key={target.id}>{target.name}</option>)}</select></label>;
}

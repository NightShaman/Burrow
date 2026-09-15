import type { PanelId } from '../../app/types';
import type { RailLayout } from '../../app/usePersistedLayout';
import { panelRegistry } from '../../app/panelRegistry';
import { Field } from './SettingsPrimitives';

export function RailPanelSettings({ side, layout, setLayout, singlePanel, setSinglePanel, topPanel, setTopPanel, bottomPanel, setBottomPanel }: {
  side: 'Left' | 'Right'; layout: RailLayout; setLayout: (layout: RailLayout) => void;
  singlePanel: PanelId; setSinglePanel: (panel: PanelId) => void;
  topPanel: PanelId; setTopPanel: (panel: PanelId) => void;
  bottomPanel: PanelId; setBottomPanel: (panel: PanelId) => void;
}) {
  const panelSelect = (label: string, value: PanelId, onChange: (panel: PanelId) => void) => <Field label={`${side} · ${label}`}><select value={value} onChange={(event) => onChange(event.target.value as PanelId)}>{panelRegistry.map((panel) => <option key={panel.id} value={panel.id}>{panel.label}</option>)}</select></Field>;
  return <div>
    <Field label={`${side} · layout`}><select value={layout === 'divided' ? 'divided' : 'single'} onChange={(event) => setLayout(event.target.value as RailLayout)}><option value="single">1 panel</option><option value="divided">2 panels (divided)</option></select></Field>
    {layout === 'divided' ? <>{panelSelect('top', topPanel, setTopPanel)}{panelSelect('bottom', bottomPanel, setBottomPanel)}</> : panelSelect('panel', singlePanel, setSinglePanel)}
  </div>;
}

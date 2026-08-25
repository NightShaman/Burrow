import { useEffect, useState } from 'react';
import type { PanelId } from './types';
import { panelIds } from './panelRegistry';
const rightPanelDefaultsVersionKey = 'hc.rightPanelDefaultsVersion';
const rightPanelDefaultsVersion = '3';
let rightPanelDefaultsMigrated = false;

function readStorage(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function writeStorage(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Storage may be unavailable or full. */ }
}
function removeStorage(key: string) {
  try { localStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
}
function migrateRightPanelDefaults() {
  if (rightPanelDefaultsMigrated) return;
  rightPanelDefaultsMigrated = true;
  if (readStorage(rightPanelDefaultsVersionKey) === rightPanelDefaultsVersion) return;
  ['hc.rightTopPanel', 'hc.rightBottomPanel', 'hc.leftTopPanel', 'hc.leftBottomPanel'].forEach(removeStorage);
  writeStorage(rightPanelDefaultsVersionKey, rightPanelDefaultsVersion);
}

export const themes = ['smatchet', 'nexus', 'hatchet', 'chaos', 'paper', 'terminal', 'high-contrast'] as const;

export const themeDetails = {
  smatchet: { label: 'Smatchet Dark', description: 'Dense dark workspace with a magenta focus color.' },
  nexus: { label: 'Nexus', description: 'Deep blue control-room surfaces with crisp electric focus.' },
  hatchet: { label: 'Hatchet', description: 'Industrial dark teal with calm, deliberate contrast.' },
  chaos: { label: 'Chaos', description: 'Charcoal and red with sharp, high-energy feedback.' },
  paper: { label: 'Paper', description: 'A calm light workspace with clear, ink-like contrast.' },
  terminal: { label: 'Terminal', description: 'Near-black, compact, and quietly green.' },
  'high-contrast': { label: 'High Contrast', description: 'Maximum contrast with reduced visual decoration.' },
} as const;
export type Theme = typeof themes[number];
const readNumber = (key: string, fallback: number, min: number, max: number) => {
  const value = Number(readStorage(key));
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
};
const readBoolean = (key: string, fallback: boolean) => {
  const value = readStorage(key);
  return value === null ? fallback : value === 'true';
};
const readTheme = (key: string): Theme => {
  const value = readStorage(key);
  return themes.includes(value as unknown as Theme) ? value as unknown as Theme : 'smatchet';
};
const readPanel = (key: string, fallback: PanelId) => {
  const value = readStorage(key) as PanelId | null;
  return value && panelIds.includes(value) ? value : fallback;
};
function useStoredState<T>(key: string, initial: () => T) {
  const [value, setValue] = useState(initial);
  useEffect(() => writeStorage(key, String(value)), [key, value]);
  return [value, setValue] as const;
}
export function usePersistedTheme() {
  return useStoredState<Theme>('hc.theme', () => readTheme('hc.theme'));
}
export function usePersistedAgentSelection() {
  return useStoredState<string>('hc.selectedAgentId', () => readStorage('hc.selectedAgentId') ?? '');
}
export function usePersistedTargetSelection() {
  return useStoredState<string>('hc.selectedTargetId', () => readStorage('hc.selectedTargetId') ?? 'local');
}

export type PersistedModelSelection = { provider: string; model: string; effort: string };

const readModelSelections = (): Record<string, PersistedModelSelection> => {
  try {
    const value: unknown = JSON.parse(readStorage('hc.modelSelections') ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([agentId, selection]) => {
      if (!selection || typeof selection !== 'object') return [];
      const { provider, model, effort } = selection as Record<string, unknown>;
      return typeof provider === 'string' && typeof model === 'string' && typeof effort === 'string'
        ? [[agentId, { provider, model, effort }]]
        : [];
    }));
  } catch {
    return {};
  }
};

export function usePersistedModelSelections() {
  const [selections, setSelections] = useState<Record<string, PersistedModelSelection>>(() => readModelSelections());
  useEffect(() => writeStorage('hc.modelSelections', JSON.stringify(selections)), [selections]);
  return [selections, setSelections] as const;
}
export function usePersistedLayout() {
  migrateRightPanelDefaults();
  const [leftCollapsed, setLeftCollapsed] = useStoredState('hc.leftCollapsed', () => readBoolean('hc.leftCollapsed', false));
  const [rightCollapsed, setRightCollapsed] = useStoredState('hc.rightCollapsed', () => readBoolean('hc.rightCollapsed', false));
  const [leftSplit, setLeftSplit] = useStoredState('hc.leftSplit', () => readNumber('hc.leftSplit', 40, 25, 60));
  const [workspaceCollapsed, setWorkspaceCollapsed] = useStoredState('hc.workspaceCollapsed', () => readBoolean('hc.workspaceCollapsed', false));
  const [rightSplit, setRightSplit] = useStoredState('hc.rightSplit', () => readNumber('hc.rightSplit', 50, 25, 75));
  const [leftTopPanel, setLeftTopPanel] = useStoredState<PanelId>('hc.leftTopPanel', () => readPanel('hc.leftTopPanel', 'agents'));
  const [leftBottomPanel, setLeftBottomPanel] = useStoredState<PanelId>('hc.leftBottomPanel', () => readPanel('hc.leftBottomPanel', 'workspace'));
  const [rightTopPanel, setRightTopPanel] = useStoredState<PanelId>('hc.rightTopPanel', () => readPanel('hc.rightTopPanel', 'none'));
  const [rightBottomPanel, setRightBottomPanel] = useStoredState<PanelId>('hc.rightBottomPanel', () => readPanel('hc.rightBottomPanel', 'none'));
  return { leftCollapsed, setLeftCollapsed, rightCollapsed, setRightCollapsed, leftSplit, setLeftSplit, workspaceCollapsed, setWorkspaceCollapsed, rightSplit, setRightSplit, leftTopPanel, setLeftTopPanel, leftBottomPanel, setLeftBottomPanel, rightTopPanel, setRightTopPanel, rightBottomPanel, setRightBottomPanel };
}
export function listenResize(move: (event: globalThis.PointerEvent) => void) {
  const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop);
}

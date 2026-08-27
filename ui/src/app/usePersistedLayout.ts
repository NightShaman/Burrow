import { useEffect, useState } from 'react';
import { panelIds } from './panelRegistry';
import { readStorage, removeStorage, writeStorage, readStoredValue, writeStoredValue, type StoredValueValidator } from './browserStorage';
import type { PanelId } from './types';

const persistedStateVersion = 1;
const rightPanelDefaultsVersionKey = 'hc.rightPanelDefaultsVersion';
const rightPanelDefaultsVersion = '3';
let rightPanelDefaultsMigrated = false;

function migrateRightPanelDefaults() {
  if (rightPanelDefaultsMigrated) return;
  rightPanelDefaultsMigrated = true;
  if (readStorage(rightPanelDefaultsVersionKey) === rightPanelDefaultsVersion) return;
  ['hc.rightTopPanel', 'hc.rightBottomPanel', 'hc.leftTopPanel', 'hc.leftBottomPanel'].forEach((key) => removeStorage(key));
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

const isString: StoredValueValidator<string> = (value): value is string => typeof value === 'string';
const isBoolean: StoredValueValidator<boolean> = (value): value is boolean => typeof value === 'boolean';
const isTheme: StoredValueValidator<Theme> = (value): value is Theme => typeof value === 'string' && themes.includes(value as Theme);
const isPanel: StoredValueValidator<PanelId> = (value): value is PanelId => typeof value === 'string' && panelIds.includes(value as PanelId);
const boundedNumber = (min: number, max: number): StoredValueValidator<number> => (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

function useStoredState<T>(key: string, fallback: T, validate: StoredValueValidator<T>, decodeLegacy: (raw: string) => T | undefined) {
  const [value, setValue] = useState<T>(() => readStoredValue({ key, version: persistedStateVersion, fallback, validate, decodeLegacy: (raw) => decodeLegacy(raw) }));
  useEffect(() => writeStoredValue(key, persistedStateVersion, value), [key, value]);
  return [value, setValue] as const;
}

export function usePersistedTheme() {
  return useStoredState<Theme>('hc.theme', 'smatchet', isTheme, (raw) => isTheme(raw) ? raw : undefined);
}
export function usePersistedAgentSelection() {
  return useStoredState('hc.selectedAgentId', '', isString, (raw) => raw);
}
export function usePersistedTargetSelection() {
  return useStoredState('hc.selectedTargetId', 'local', isString, (raw) => raw);
}

export function usePersistedLayout() {
  migrateRightPanelDefaults();
  const [leftCollapsed, setLeftCollapsed] = useStoredState('hc.leftCollapsed', false, isBoolean, (raw) => raw === 'true' ? true : raw === 'false' ? false : undefined);
  const [rightCollapsed, setRightCollapsed] = useStoredState('hc.rightCollapsed', false, isBoolean, (raw) => raw === 'true' ? true : raw === 'false' ? false : undefined);
  const [leftSplit, setLeftSplit] = useStoredState('hc.leftSplit', 40, boundedNumber(25, 60), (raw) => { const value = Number(raw); return Number.isFinite(value) ? value : undefined; });
  const [rightSplit, setRightSplit] = useStoredState('hc.rightSplit', 50, boundedNumber(25, 75), (raw) => { const value = Number(raw); return Number.isFinite(value) ? value : undefined; });
  const [leftTopPanel, setLeftTopPanel] = useStoredState<PanelId>('hc.leftTopPanel', 'agents', isPanel, (raw) => isPanel(raw) ? raw : undefined);
  const [leftBottomPanel, setLeftBottomPanel] = useStoredState<PanelId>('hc.leftBottomPanel', 'workspace', isPanel, (raw) => isPanel(raw) ? raw : undefined);
  const [rightTopPanel, setRightTopPanel] = useStoredState<PanelId>('hc.rightTopPanel', 'none', isPanel, (raw) => isPanel(raw) ? raw : undefined);
  const [rightBottomPanel, setRightBottomPanel] = useStoredState<PanelId>('hc.rightBottomPanel', 'none', isPanel, (raw) => isPanel(raw) ? raw : undefined);
  return { leftCollapsed, setLeftCollapsed, rightCollapsed, setRightCollapsed, leftSplit, setLeftSplit, rightSplit, setRightSplit, leftTopPanel, setLeftTopPanel, leftBottomPanel, setLeftBottomPanel, rightTopPanel, setRightTopPanel, rightBottomPanel, setRightBottomPanel };
}

export function listenResize(move: (event: globalThis.PointerEvent) => void) {
  const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop);
}

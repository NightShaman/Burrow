import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../../app/types';
import { api } from '../../app/api';

export type ModSettingsSection = { id: string; label: string };
type MountResult = void | (() => void) | { update?: (context: ModSettingsContext) => void; unmount?: () => void };
type ModSettingsContext = {
  modId: string;
  section: string;
  agents: Agent[];
  primary: HTMLElement;
  overflow: HTMLElement | null;
  api: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  refreshAgents: () => Promise<void>;
  saveAgentExecutionEnvironment: (agentId: string, executionEnvironment: Agent['executionEnvironment']) => Promise<void>;
};
type ModSettingsModule = {
  settingsSections?: ModSettingsSection[];
  mountSettings?: (context: ModSettingsContext) => MountResult | Promise<MountResult>;
};

function validSections(value: unknown): ModSettingsSection[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) || typeof item.label !== 'string' || !item.label.trim() || seen.has(item.id)) return [];
    seen.add(item.id);
    return [{ id: item.id, label: item.label.trim() }];
  });
}

function modApi(modId: string) {
  const prefix = `/api/mods/${modId}`;
  return <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    if (normalized.includes('..')) return Promise.reject(new Error('Mod API paths cannot contain parent traversal.'));
    return api<T>(`${prefix}${normalized}`, init);
  };
}

export function ModSettingsHost({ modId, settingsUrl, agents, onAgentsChanged, navigationTarget, overflowTarget }: { modId: string; settingsUrl: string; agents: Agent[]; onAgentsChanged: () => Promise<void>; navigationTarget: HTMLElement | null; overflowTarget: HTMLElement | null }) {
  const primaryRef = useRef<HTMLDivElement>(null);
  const [module, setModule] = useState<ModSettingsModule | null>(null);
  const [sections, setSections] = useState<ModSettingsSection[]>([]);
  const [section, setSection] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setModule(null); setSections([]); setSection(''); setError('');
    void import(/* @vite-ignore */ settingsUrl).then((loaded: ModSettingsModule) => {
      if (!active) return;
      const next = validSections(loaded.settingsSections);
      if (typeof loaded.mountSettings !== 'function' || !next.length) throw new Error('The mod settings entry does not implement the Burrow settings contract.');
      setModule(loaded); setSections(next); setSection(next[0].id);
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load mod settings.'); });
    return () => { active = false; };
  }, [settingsUrl]);

  useEffect(() => {
    const primary = primaryRef.current;
    if (!module?.mountSettings || !primary || !section) return;
    primary.replaceChildren();
    overflowTarget?.replaceChildren();
    let disposed = false;
    let cleanup: (() => void) | undefined;
    const context: ModSettingsContext = {
      modId,
      section,
      agents,
      primary,
      overflow: overflowTarget,
      api: modApi(modId),
      refreshAgents: onAgentsChanged,
      saveAgentExecutionEnvironment: async (agentId, executionEnvironment) => {
        await api(`/api/agents/${encodeURIComponent(agentId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ executionEnvironment }),
        });
      },
    };
    void Promise.resolve(module.mountSettings(context)).then((result) => {
      const candidate = typeof result === 'function' ? result : result?.unmount;
      if (disposed) candidate?.(); else cleanup = candidate;
    }).catch((cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : 'Could not mount mod settings.'); });
    return () => { disposed = true; cleanup?.(); primary.replaceChildren(); overflowTarget?.replaceChildren(); };
  }, [module, section, agents, modId, onAgentsChanged, overflowTarget]);

  return <>
    {navigationTarget && createPortal(<nav className="settings-prototype-section-items" aria-label={`${modId} settings sections`}>{sections.map((item) => <button type="button" className={section === item.id ? 'active' : ''} aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)} key={item.id}>{item.label}</button>)}</nav>, navigationTarget)}
    {error && <section className="setting-section"><h2>Mod settings unavailable</h2><p className="settings-request-error" role="alert">{error}</p></section>}
    <div ref={primaryRef} className="mod-settings-mount" data-mod-id={modId} />
  </>;
}

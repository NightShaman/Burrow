import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../../app/types';
import { api } from '../../app/api';
import { validateSettingsContribution, type SettingsContribution, type SettingsField, type SettingsAction, type SettingsContributionFactory } from './SettingsContribution';
import { Field, SettingSection } from './SettingsPrimitives';

export type ModSettingsSection = { id: string; label: string };
type MountResult = void | (() => void) | { update?: (context: ModSettingsContext) => void; unmount?: () => void };
export type SettingsSurface = {
  replace: (content: Node | Node[]) => void;
  replaceChildren: (...content: Node[]) => void;
  clear: () => void;
};
type ModSettingsContext = {
  modId: string;
  section: string;
  agents: readonly Agent[];
  primary: SettingsSurface;
  overflow: SettingsSurface | null;
  api: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  refreshAgents: () => Promise<void>;
  saveAgentExecutionEnvironment: (agentId: string, executionEnvironment: Agent['executionEnvironment']) => Promise<void>;
};
type ModSettingsModule = {
  settingsSections?: ModSettingsSection[];
  mountSettings?: (context: ModSettingsContext) => MountResult | Promise<MountResult>;
  settingsContribution?: unknown;
  createSettingsContribution?: SettingsContributionFactory;
  handleSettingsAction?: (actionId: string, values: Record<string, string | boolean>) => void | Promise<void>;
};

function DeclarativeSection({ contribution, section, module, overflowTarget }: { contribution: SettingsContribution; section: ModSettingsSection; module: ModSettingsModule; overflowTarget: HTMLElement | null }) {
  const definition = contribution.sections.find((item) => item.id === section.id);
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries([...(definition?.fields ?? []), ...(definition?.items?.flatMap((item) => item.fields ?? []) ?? [])].map((field) => [field.id, field.control === 'boolean' ? field.value === 'true' : field.value ?? ''])));
  const [actionState, setActionState] = useState<{ id: string; status: 'saving' | 'success' | 'error'; message: string } | null>(null);
  const [selectedId, setSelectedId] = useState(definition?.items?.[0]?.id ?? '');
  if (!definition) return null;
  const update = (id: string, value: string | boolean) => setValues((current) => ({ ...current, [id]: value }));
  const runAction = async (actionId: string, confirm?: string) => {
    if (confirm && !window.confirm(confirm)) return;
    setActionState({ id: actionId, status: 'saving', message: 'Saving…' });
    try { await module.handleSettingsAction?.(actionId, values); setActionState({ id: actionId, status: 'success', message: 'Saved.' }); }
    catch (cause) { setActionState({ id: actionId, status: 'error', message: cause instanceof Error ? cause.message : 'The action could not be completed.' }); }
  };
  const actions = (items: SettingsAction[] | undefined) => items?.length ? <div className="card-actions">{items.map((action) => { const saving = actionState?.id === action.id && actionState?.status === 'saving'; return <button type="button" className={action.tone === 'primary' ? 'primary' : action.tone === 'danger' ? 'danger' : ''} disabled={saving} key={action.id} onClick={() => void runAction(action.id, action.confirm)}>{saving ? 'Saving…' : action.label}</button>; })}</div> : null;
  const feedback = actionState && <p className={actionState.status === 'error' ? 'settings-request-error' : 'settings-help'} role={actionState.status === 'error' ? 'alert' : 'status'}>{actionState.message}</p>;
  if (definition.layout === 'form') return <SettingSection title={definition.label}>
    {definition.description && <p className="settings-help">{definition.description}</p>}
    {definition.fields?.map((field: SettingsField) => <Field label={field.label} key={field.id}>{field.control === 'boolean' ? <input type="checkbox" checked={values[field.id] === true} onChange={(event) => update(field.id, event.currentTarget.checked)} /> : field.control === 'select' ? <select value={String(values[field.id] ?? '')} onChange={(event) => update(field.id, event.currentTarget.value)}>{field.options?.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select> : <input type={field.control === 'password' ? 'password' : field.control === 'number' ? 'number' : 'text'} value={String(values[field.id] ?? '')} onChange={(event) => update(field.id, event.currentTarget.value)} />}{field.description && <small className="settings-help">{field.description}</small>}</Field>)}
    {actions(definition.actions)}{feedback}
  </SettingSection>;
  if (definition.layout === 'list-detail') {
    const selected = definition.items?.find((item) => item.id === selectedId) ?? definition.items?.[0];
    const detail = selected && <section className="setting-section"><h2>{selected.label}</h2>{selected.description && <p className="settings-help">{selected.description}</p>}{selected.meta && <p className="settings-help">{selected.meta}</p>}{selected.detail && <p>{selected.detail}</p>}{selected.fields?.map((field) => <Field label={field.label} key={field.id}>{field.control === 'select' ? <select value={String(values[field.id] ?? field.value ?? '')} onChange={(event) => update(field.id, event.currentTarget.value)}>{field.options?.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select> : <input value={String(values[field.id] ?? field.value ?? '')} onChange={(event) => update(field.id, event.currentTarget.value)} />}</Field>)}{actions(selected.actions)}{feedback}</section>;
    return <><SettingSection title={definition.label}>{definition.description && <p className="settings-help">{definition.description}</p>}{definition.fields?.map((field) => <Field label={field.label} key={field.id}>{field.control === 'boolean' ? <input type="checkbox" checked={values[field.id] === true} onChange={(event) => update(field.id, event.currentTarget.checked)} /> : field.control === 'select' ? <select value={String(values[field.id] ?? '')} onChange={(event) => update(field.id, event.currentTarget.value)}>{field.options?.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select> : <input type={field.control === 'password' ? 'password' : field.control === 'number' ? 'number' : 'text'} value={String(values[field.id] ?? '')} onChange={(event) => update(field.id, event.currentTarget.value)} />}{field.description && <small className="settings-help">{field.description}</small>}</Field>)}{actions(definition.actions)}{feedback}<div className="mcp-server-selector">{definition.items?.map((item) => <button type="button" className={item.id === selected?.id ? 'active' : ''} aria-current={item.id === selected?.id ? 'page' : undefined} onClick={() => setSelectedId(item.id)} key={item.id}>{item.label}{item.meta && <small>{item.meta}</small>}</button>)}</div></SettingSection>{overflowTarget && createPortal(detail, overflowTarget)}</>;
  }
  return <SettingSection title={definition.label}>{definition.description && <p className="settings-help">{definition.description}</p>}{definition.items?.map((item) => <article className="provider-card" key={item.id}><strong>{item.label}</strong>{item.description && <p>{item.description}</p>}{item.meta && <small>{item.meta}</small>}{actions(item.actions)}</article>)}</SettingSection>;
}

function validSections(value: unknown): ModSettingsSection[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) || typeof item.label !== 'string' || !item.label.trim() || seen.has(item.id)) return [];
    seen.add(item.id);
    return [{ id: item.id, label: item.label.trim() }];
  });
}

function createSurface(node: HTMLElement): SettingsSurface {
  return {
    replace: (content) => node.replaceChildren(...(Array.isArray(content) ? content : [content])),
    replaceChildren: (...content) => node.replaceChildren(...content),
    clear: () => node.replaceChildren(),
  };
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
  const [contribution, setContribution] = useState<SettingsContribution | null>(null);
  const [sections, setSections] = useState<ModSettingsSection[]>([]);
  const [section, setSection] = useState('');
  const [error, setError] = useState('');
  const agentsRef = useRef(agents);
  const onAgentsChangedRef = useRef(onAgentsChanged);
  agentsRef.current = agents;
  onAgentsChangedRef.current = onAgentsChanged;

  useEffect(() => {
    let active = true;
    setModule(null); setContribution(null); setSections([]); setSection(''); setError('');
    void import(/* @vite-ignore */ settingsUrl).then(async (loaded: ModSettingsModule) => {
      if (!active) return;
      const staticContribution = validateSettingsContribution(loaded.settingsContribution);
      const contribution = loaded.createSettingsContribution
        ? validateSettingsContribution(await loaded.createSettingsContribution({ api: modApi(modId), agents: agentsRef.current }))
        : staticContribution;
      const next = contribution?.sections ?? validSections(loaded.settingsSections);
      if ((!contribution && typeof loaded.mountSettings !== 'function') || !next.length) throw new Error('The mod settings entry does not implement the Burrow settings contract.');
      setModule(loaded); setContribution(contribution); setSections(next); setSection(next[0].id);
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load mod settings.'); });
    return () => { active = false; };
  }, [settingsUrl]);

  useEffect(() => {
    const primary = primaryRef.current;
    const definition = contribution?.sections.find((item) => item.id === section);
    const hasDeclarativeContent = Boolean(definition && (definition.layout === 'form' ? (definition.fields?.length || definition.actions?.length) : definition.items?.length));
    if (hasDeclarativeContent || !module?.mountSettings || !primary || !section) return;
    primary.replaceChildren();
    overflowTarget?.replaceChildren();
    const primarySurface = createSurface(primary);
    const overflowSurface = overflowTarget ? createSurface(overflowTarget) : null;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    const context: ModSettingsContext = {
      modId,
      section,
      agents: agentsRef.current,
      primary: primarySurface,
      overflow: overflowSurface,
      api: modApi(modId),
      refreshAgents: () => onAgentsChangedRef.current(),
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
  }, [module, contribution, section, modId, overflowTarget]);

  return <>
    {navigationTarget && createPortal(<nav className="settings-prototype-section-items" aria-label={`${modId} settings sections`}>{sections.map((item) => <button type="button" className={section === item.id ? 'active' : ''} aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)} key={item.id}>{item.label}</button>)}</nav>, navigationTarget)}
    {error && <section className="setting-section"><h2>Mod settings unavailable</h2><p className="settings-request-error" role="alert">{error}</p></section>}
    <div ref={primaryRef} className="mod-settings-mount" data-mod-id={modId}>
      {contribution && <DeclarativeSection contribution={contribution} module={module ?? {}} section={sections.find((item) => item.id === section) ?? sections[0]} overflowTarget={overflowTarget} />}
    </div>
  </>;
}

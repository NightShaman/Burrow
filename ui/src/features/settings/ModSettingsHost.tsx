import { SettingsEntitySelector, type SettingsEntityItem } from './SettingsEntitySelector';
import { optimizeAvatar } from '../../app/avatar';
import { enabledAgents } from '../../app/agentCatalog';
import { useConfirm } from '../../app/ConfirmDialog';
import {
  useImperativeUnsavedChanges,
  useUnsavedNavigation,
  type UnsavedDraft,
} from '../../app/UnsavedChanges';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../../app/types';
import { apiLocal, fetchApi } from '../../app/api';
import {
  validateSettingsContribution,
  type SettingsContribution,
  type SettingsContributionFactory,
} from './SettingsContribution';
import { DeclarativeSection } from './DeclarativeSection';
export { DeclarativeSection } from './DeclarativeSection';

export type ModSettingsSection = {
  id: string;
  label: string;
  layout?: SettingsContribution['sections'][number]['layout'] | 'form-wide' | 'document';
};
type MountResult =
  | void
  | (() => void)
  | { update?: (context: ModSettingsContext) => void; unmount?: () => void };
export type SettingsSurface = {
  replace: (content: Node | Node[]) => void;
  replaceChildren: (...content: Node[]) => void;
  clear: () => void;
};
export type ModEntitySelector = {
  label: string;
  items: readonly SettingsEntityItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  addLabel?: string;
  onAdd?: () => void;
};
type ModSettingsContext = {
  setEntitySelector: (selector: ModEntitySelector | null) => void;
  selectedAgentId?: string;
  modId: string;
  runtimeScope: 'local';
  section: string;
  agents: readonly Agent[];
  primary: SettingsSurface;
  overflow: SettingsSurface | null;
  confirm: ReturnType<typeof useConfirm>;
  navigate: (proceed: () => void) => void;
  navigateSection: (sectionId: string, beforeNavigate?: () => void) => void;
  setDraft: (draft: UnsavedDraft | null) => void;
  api: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  fetchContent: (path: string, init?: RequestInit) => Promise<Response>;
  accessApi: <T = unknown>(init?: RequestInit) => Promise<T>;
  refreshAgents: () => Promise<void>;
  optimizeAvatar: typeof optimizeAvatar;
  saveAgentExecutionEnvironment: (
    agentId: string,
    executionEnvironment: Agent['executionEnvironment'],
  ) => Promise<void>;
};
export type ModSettingsModule = {
  settingsSections?: ModSettingsSection[];
  mountSettings?: (context: ModSettingsContext) => MountResult | Promise<MountResult>;
  settingsContribution?: unknown;
  createSettingsContribution?: SettingsContributionFactory;
  handleSettingsAction?: (
    actionId: string,
    values: Record<string, string | boolean>,
  ) => void | Promise<void>;
};

function validSections(value: unknown): ModSettingsSection[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.id !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) ||
      typeof item.label !== 'string' ||
      !item.label.trim() ||
      seen.has(item.id)
    )
      return [];
    seen.add(item.id);
    return [
      {
        id: item.id,
        label: item.label.trim(),
        ...(item.layout === 'form' ||
        item.layout === 'form-wide' ||
        item.layout === 'document' ||
        item.layout === 'form-inventory'
          ? {
              layout: item.layout as 'form' | 'form-wide' | 'form-inventory' | 'document',
            }
          : {}),
      },
    ];
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
  return <T = unknown,>(path: string, init?: RequestInit): Promise<T> => {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    if (normalized.includes('..'))
      return Promise.reject(new Error('Mod API paths cannot contain parent traversal.'));
    return apiLocal<T>(`${prefix}${normalized}`, init);
  };
}

function modAccessApi(modId: string) {
  const path = `/api/operator/mods/${encodeURIComponent(modId)}/access`;
  return <T = unknown,>(init?: RequestInit): Promise<T> => apiLocal<T>(path, init);
}

function settingsFactoryContext(modId: string, agents: readonly Agent[]) {
  return { api: modApi(modId), accessApi: modAccessApi(modId), agents };
}

export function ModSettingsHost({
  selectedAgentId,
  modId,
  settingsUrl,
  agents,
  onAgentsChanged,
  navigationTarget,
  overflowTarget,
  selectorTarget,
  onSelectorVisibilityChange,
  selectedSectionId,
  onSectionChange,
}: {
  selectedAgentId?: string;
  modId: string;
  settingsUrl: string;
  agents: Agent[];
  onAgentsChanged: () => Promise<void>;
  navigationTarget: HTMLElement | null;
  overflowTarget: HTMLElement | null;
  selectorTarget?: HTMLElement | null;
  onSelectorVisibilityChange?: (visible: boolean) => void;
  selectedSectionId?: string;
  onSectionChange?: (sectionId: string) => void;
}) {
  const primaryRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  const navigate = useUnsavedNavigation();
  const createDraft = useImperativeUnsavedChanges();
  const [module, setModule] = useState<ModSettingsModule | null>(null);
  const [contribution, setContribution] = useState<SettingsContribution | null>(null);
  const [sections, setSections] = useState<ModSettingsSection[]>([]);
  const [section, setSection] = useState('');
  const [error, setError] = useState('');
  const [entitySelector, setEntitySelector] = useState<ModEntitySelector | null>(null);
  // The header belongs to the loaded settings owner, not an individual section.
  // Keep its DOM/scroll position while the next section publishes fresh callbacks.
  useEffect(() => {
    setEntitySelector(null);
  }, [settingsUrl, modId, selectedAgentId]);
  useEffect(() => {
    onSelectorVisibilityChange?.(Boolean(entitySelector));
    return () => onSelectorVisibilityChange?.(false);
  }, [Boolean(entitySelector), onSelectorVisibilityChange]);
  const agentsRef = useRef(agents);
  const onAgentsChangedRef = useRef(onAgentsChanged);
  const onSectionChangeRef = useRef(onSectionChange);
  onSectionChangeRef.current = onSectionChange;
  agentsRef.current = agents;
  onAgentsChangedRef.current = onAgentsChanged;

  useEffect(() => {
    let active = true;
    setModule(null);
    setContribution(null);
    setSections([]);
    setSection('');
    setError('');
    void import(/* @vite-ignore */ settingsUrl)
      .then(async (loaded: ModSettingsModule) => {
        if (!active) return;
        const staticContribution = validateSettingsContribution(loaded.settingsContribution);
        const contribution = loaded.createSettingsContribution
          ? validateSettingsContribution(
              await loaded.createSettingsContribution(
                settingsFactoryContext(modId, agentsRef.current),
              ),
            )
          : staticContribution;
        if (!active) return;
        const next = contribution?.sections ?? validSections(loaded.settingsSections);
        if ((!contribution && typeof loaded.mountSettings !== 'function') || !next.length)
          throw new Error(
            'The mod settings entry does not implement the Burrow settings contract.',
          );
        const initialSection = next.find((item) => item.id === selectedSectionId)?.id ?? next[0].id;
        // A module namespace can be reused across remounts. Wrap it so every
        // load has a distinct React state identity, even when its URL is unchanged.
        setModule({ ...loaded });
        setContribution(contribution);
        setSections(next);
        setSection(initialSection);
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : 'Could not load mod settings.');
      });
    return () => {
      active = false;
    };
  }, [settingsUrl, modId]);

  useEffect(() => {
    if (!selectedSectionId || !sections.some((item) => item.id === selectedSectionId)) return;
    setSection(selectedSectionId);
  }, [selectedSectionId, sections]);

  const selectSection = (sectionId: string) => {
    if (sectionId === section) return;
    navigate(() => {
      setSection(sectionId);
      onSectionChange?.(sectionId);
    });
  };

  useEffect(() => {
    const primary = primaryRef.current;
    const definition = contribution?.sections.find((item) => item.id === section);
    const hasDeclarativeContent = Boolean(
      definition &&
        (definition.layout === 'form'
          ? definition.fields?.length || definition.actions?.length
          : definition.items?.length),
    );
    if (hasDeclarativeContent || !module?.mountSettings) {
      setEntitySelector(null);
      return;
    }
    if (!primary || !section) return;
    const node = document.createElement('div');
    node.className = 'mod-settings-surface';
    primary.replaceChildren(node);
    const overflowNode = overflowTarget ? document.createElement('div') : null;
    if (overflowNode) {
      overflowNode.className = 'mod-settings-surface settings-overflow-content';
      overflowTarget!.replaceChildren(overflowNode);
    }
    const primarySurface = createSurface(node);
    const overflowSurface = overflowNode ? createSurface(overflowNode) : null;
    const disposeSafely = (candidate?: () => void) => {
      try {
        candidate?.();
      } catch {
        /* Mod cleanup cannot break navigation. */
      }
    };
    let disposed = false;
    let cleanup: (() => void) | undefined;
    const draft = createDraft();
    const navigationCancellations = new Set<() => void>();
    const context: ModSettingsContext = {
      setEntitySelector: (selector) => {
        if (disposed) return;
        // Wrap callbacks in this mount's lifetime; a retired async mount must
        // never replace the next resident's selector or run its callbacks.
        setEntitySelector(
          selector
            ? {
                ...selector,
                onSelect: (id) => {
                  if (!disposed) selector.onSelect(id);
                },
                onAdd: selector.onAdd
                  ? () => {
                      if (!disposed) selector.onAdd!();
                    }
                  : undefined,
              }
            : null,
        );
      },
      modId,
      selectedAgentId,
      runtimeScope: 'local',
      section,
      agents: agentsRef.current,
      primary: primarySurface,
      overflow: overflowSurface,
      confirm: async (options) => {
        if (disposed) return false;
        const result = await confirm(options);
        return !disposed && result;
      },
      navigate: (proceed) => {
        if (disposed) return;
        let cancel: (() => void) | undefined;
        let completed = false;
        cancel = navigate(() => {
          completed = true;
          if (cancel) navigationCancellations.delete(cancel);
          if (!disposed) proceed();
        });
        if (!completed) navigationCancellations.add(cancel);
      },
      navigateSection: (sectionId, beforeNavigate) => {
        if (disposed || !sections.some((item) => item.id === sectionId)) return;
        context.navigate(() => {
          beforeNavigate?.();
          setSection(sectionId);
          onSectionChangeRef.current?.(sectionId);
        });
      },
      setDraft: draft.setDraft,
      api: modApi(modId),
      fetchContent: (path, init = {}) => {
        if (
          !path.startsWith('/api/') ||
          /[\\#]/.test(path) ||
          path
            .split('?')[0]
            .split('/')
            .some((part) => {
              try {
                return ['.', '..'].includes(decodeURIComponent(part));
              } catch {
                return true;
              }
            })
        )
          return Promise.reject(new Error('Invalid content URL.'));
        return fetchApi(path, { ...init, method: 'GET' });
      },
      accessApi: modAccessApi(modId),
      refreshAgents: () => onAgentsChangedRef.current(),
      optimizeAvatar,
      saveAgentExecutionEnvironment: async (agentId, executionEnvironment) => {
        await apiLocal(`/api/agents/${encodeURIComponent(agentId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ executionEnvironment }),
        });
      },
    };
    void Promise.resolve()
      .then(() => {
        if (!disposed) return module.mountSettings!(context);
      })
      .then((result) => {
        const candidate = typeof result === 'function' ? result : result?.unmount;
        if (disposed) disposeSafely(candidate);
        else cleanup = candidate;
      })
      .catch((cause) => {
        if (!disposed) {
          setEntitySelector(null);
          setError(cause instanceof Error ? cause.message : 'Could not mount mod settings.');
        }
      });
    return () => {
      disposed = true;
      // Retired callbacks are already guarded by `disposed`. Do not remove the
      // header between same-owner sections while their data loads.
      navigationCancellations.forEach((cancel) => cancel());
      draft.dispose();
      node.remove();
      overflowNode?.remove();
      disposeSafely(cleanup);
      node.replaceChildren();
      overflowNode?.replaceChildren();
    };
  }, [
    module,
    contribution,
    section,
    selectedAgentId,
    modId,
    overflowTarget,
    confirm,
    navigate,
    createDraft,
  ]);

  // Semantic layout metadata, not a new surface: imperative portal targets must
  // keep their identity when sections change or a contribution refreshes.
  const activeDefinition = contribution?.sections.find((item) => item.id === section);
  const hasDeclarativeContent = Boolean(
    activeDefinition &&
      (activeDefinition.layout === 'form'
        ? activeDefinition.fields?.length || activeDefinition.actions?.length
        : activeDefinition.items?.length),
  );
  const surfaceLayout =
    activeDefinition && (hasDeclarativeContent || !module?.mountSettings)
      ? activeDefinition.layout
      : 'imperative';
  const imperativeLayout = !hasDeclarativeContent
    ? validSections(module?.settingsSections).find((item) => item.id === section)?.layout
    : undefined;
  return (
    <>
      {entitySelector &&
        (selectorTarget ? (
          createPortal(
            <SettingsEntitySelector
              label={entitySelector.label}
              noun={entitySelector.label.toLowerCase()}
              items={entitySelector.items}
              selectedId={entitySelector.selectedId}
              onSelect={entitySelector.onSelect}
              action={
                entitySelector.onAdd && entitySelector.addLabel ? (
                  <button type="button" className="primary" onClick={entitySelector.onAdd}>
                    {entitySelector.addLabel}
                  </button>
                ) : undefined
              }
            />,
            selectorTarget,
          )
        ) : (
          <SettingsEntitySelector
            label={entitySelector.label}
            noun={entitySelector.label.toLowerCase()}
            items={entitySelector.items}
            selectedId={entitySelector.selectedId}
            onSelect={entitySelector.onSelect}
            action={
              entitySelector.onAdd && entitySelector.addLabel ? (
                <button type="button" className="primary" onClick={entitySelector.onAdd}>
                  {entitySelector.addLabel}
                </button>
              ) : undefined
            }
          />
        ))}
      {navigationTarget &&
        createPortal(
          <nav
            className="settings-prototype-section-items"
            aria-label={`${modId} settings sections`}
          >
            {sections.map((item) => (
              <button
                type="button"
                className={section === item.id ? 'active' : ''}
                aria-current={section === item.id ? 'page' : undefined}
                onClick={() => selectSection(item.id)}
                key={item.id}
              >
                {item.label}
              </button>
            ))}
          </nav>,
          navigationTarget,
        )}
      {error && (
        <section className="setting-section">
          <h2>Mod settings unavailable</h2>
          <p className="settings-request-error" role="alert">
            {error}
          </p>
        </section>
      )}
      <div
        ref={primaryRef}
        className="mod-settings-mount"
        data-mod-id={modId}
        data-settings-layout={imperativeLayout ?? surfaceLayout}
      >
        {contribution && surfaceLayout !== 'imperative' && (
          <DeclarativeSection
            key={section}
            contribution={contribution}
            module={{
              ...module,
              handleSettingsAction: async (actionId, values) => {
                if (typeof module?.handleSettingsAction !== 'function')
                  throw new Error('The mod does not provide an action handler.');
                await module.handleSettingsAction(actionId, values);
                if (module?.createSettingsContribution) {
                  try {
                    const { agents: currentAgents } = await apiLocal<{
                      agents: Agent[];
                    }>('/api/agents');
                    const refreshed = validateSettingsContribution(
                      await module.createSettingsContribution(
                        settingsFactoryContext(modId, enabledAgents(currentAgents)),
                      ),
                    );
                    void onAgentsChangedRef.current();
                    if (!refreshed) throw new Error('Invalid settings response.');
                    setContribution(refreshed);
                    setError('');
                  } catch {
                    setError(
                      'Saved, but could not refresh settings. Reopen Settings to reload the inventory.',
                    );
                  }
                }
              },
            }}
            section={sections.find((item) => item.id === section) ?? sections[0]}
            overflowTarget={overflowTarget}
          />
        )}
      </div>
    </>
  );
}

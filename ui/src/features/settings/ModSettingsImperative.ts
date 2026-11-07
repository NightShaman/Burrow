import { optimizeAvatar } from '../../app/avatar';
import { apiLocal, fetchApi } from '../../app/api';
import type { Agent } from '../../app/types';
import type {
  ModSettingsContext,
  ModSettingsModule,
  ModSettingsSection,
  ModEntitySelector,
  SettingsSurface,
} from './ModSettingsHost';
import type { useConfirm } from '../../app/ConfirmDialog';
import type { useImperativeUnsavedChanges, useUnsavedNavigation } from '../../app/UnsavedChanges';

function createSurface(node: HTMLElement): SettingsSurface {
  return {
    replace: (content) => node.replaceChildren(...(Array.isArray(content) ? content : [content])),
    replaceChildren: (...content) => node.replaceChildren(...content),
    clear: () => node.replaceChildren(),
  };
}
export function modApi(modId: string) {
  const prefix = `/api/mods/${modId}`;
  return <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    if (normalized.includes('..'))
      return Promise.reject(new Error('Mod API paths cannot contain parent traversal.'));
    return apiLocal<T>(`${prefix}${normalized}`, init);
  };
}
export function modAccessApi(modId: string) {
  const path = `/api/operator/mods/${encodeURIComponent(modId)}/access`;
  return <T = unknown>(init?: RequestInit): Promise<T> => apiLocal<T>(path, init);
}

// One owner for the surfaces, context, navigation cancellations and late cleanup.
export function mountImperativeSettings({
  primary,
  overflowTarget,
  module,
  section,
  selectedAgentId,
  modId,
  sections,
  agentsRef,
  onAgentsChangedRef,
  onSectionChangeRef,
  confirm,
  navigate,
  createDraft,
  setEntitySelector,
  setSection,
  setError,
}: {
  primary: HTMLElement;
  overflowTarget: HTMLElement | null;
  module: ModSettingsModule;
  section: string;
  selectedAgentId?: string;
  modId: string;
  sections: ModSettingsSection[];
  agentsRef: { current: Agent[] };
  onAgentsChangedRef: { current: () => Promise<void> };
  onSectionChangeRef: { current: ((sectionId: string) => void) | undefined };
  confirm: ReturnType<typeof useConfirm>;
  navigate: ReturnType<typeof useUnsavedNavigation>;
  createDraft: ReturnType<typeof useImperativeUnsavedChanges>;
  setEntitySelector: (value: ModEntitySelector | null) => void;
  setSection: (value: string) => void;
  setError: (value: string) => void;
}) {
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
}

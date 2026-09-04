import type { ReactNode } from 'react';

export type SettingsLayout = 'form' | 'list-detail' | 'activity';

export type SettingsField = {
  id: string;
  label: string;
  value?: string;
  description?: string;
  control?: 'text' | 'password' | 'number' | 'boolean' | 'select';
  options?: Array<{ value: string; label: string }>;
};

export type SettingsAction = {
  id: string;
  label: string;
  tone?: 'default' | 'primary' | 'danger';
  confirm?: string;
};

export type SettingsValues = Record<string, string | boolean>;

export type SettingsContributionRuntime = {
  values: SettingsValues;
  onChange: (fieldId: string, value: string | boolean) => void;
  onAction: (actionId: string, values: SettingsValues) => void | Promise<void>;
};

export type SettingsItem = {
  id: string;
  label: string;
  description?: string;
  meta?: string;
  detail?: string;
  fields?: SettingsField[];
  actions?: SettingsAction[];
};

export type SettingsSection = {
  id: string;
  label: string;
  description?: string;
  layout: SettingsLayout;
  fields?: SettingsField[];
  items?: SettingsItem[];
  actions?: SettingsAction[];
};

export type SettingsContribution = {
  sections: SettingsSection[];
  render?: (section: SettingsSection) => ReactNode;
};

export type SettingsContributionContext = {
  api: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  agents: readonly unknown[];
};

export type SettingsContributionFactory = (context: SettingsContributionContext) => SettingsContribution | Promise<SettingsContribution>;

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Field/action IDs are also used as namespaced keys by mod contributions. The
// suffix may contain opaque, case-preserving owner IDs such as `Hatchet`.
const nestedIdPattern = /^[A-Za-z0-9]+(?:[A-Za-z0-9:_-]*[A-Za-z0-9])?$/;
// Item IDs identify opaque mod-owned records, so preserve their spelling while
// rejecting values that cannot safely be used as an identifier in the UI.
const maxOpaqueIdLength = 128;
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/u;

function isValidOpaqueId(value: string): boolean {
  return value.length > 0 && value.length <= maxOpaqueIdLength && value.trim().length > 0 && !controlCharacterPattern.test(value);
}

function validateFields(value: unknown): SettingsField[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((field): SettingsField[] => {
    if (!field || typeof field !== 'object') return [];
    const candidate = field as Partial<SettingsField>;
    if (typeof candidate.id !== 'string' || !nestedIdPattern.test(candidate.id) || typeof candidate.label !== 'string' || !candidate.label.trim()) return [];
    const control = candidate.control ?? 'text';
    if (!['text', 'password', 'number', 'boolean', 'select'].includes(control)) return [];
    const options = Array.isArray(candidate.options) ? candidate.options.flatMap((option) => option && typeof option === 'object' && typeof option.value === 'string' && typeof option.label === 'string' ? [{ value: option.value, label: option.label }] : []) : undefined;
    return [{ id: candidate.id, label: candidate.label.trim(), value: typeof candidate.value === 'string' ? candidate.value : undefined, description: typeof candidate.description === 'string' ? candidate.description : undefined, control, ...(options?.length ? { options } : {}) }];
  });
}

function validateActions(value: unknown): SettingsAction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((action): SettingsAction[] => {
    if (!action || typeof action !== 'object') return [];
    const candidate = action as Partial<SettingsAction>;
    return typeof candidate.id === 'string' && nestedIdPattern.test(candidate.id) && typeof candidate.label === 'string' && candidate.label.trim() ? [{ id: candidate.id, label: candidate.label.trim(), tone: candidate.tone === 'primary' || candidate.tone === 'danger' ? candidate.tone : 'default', ...(typeof candidate.confirm === 'string' ? { confirm: candidate.confirm } : {}) }] : [];
  });
}

export function validateSettingsContribution(value: unknown): SettingsContribution | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { sections?: unknown; render?: unknown };
  if (!Array.isArray(candidate.sections)) return null;
  const seen = new Set<string>();
  const sections = candidate.sections.flatMap((section): SettingsSection[] => {
    if (!section || typeof section !== 'object') return [];
    const item = section as Partial<SettingsSection>;
    if (typeof item.id !== 'string' || !idPattern.test(item.id) || seen.has(item.id) || typeof item.label !== 'string' || !item.label.trim()) return [];
    if (item.layout !== 'form' && item.layout !== 'list-detail' && item.layout !== 'activity') return [];
    seen.add(item.id);
    const fields = validateFields(item.fields);
    const actions = validateActions(item.actions);
    let invalidItem = false;
    const items = Array.isArray(item.items) ? item.items.flatMap((entry): SettingsItem[] => {
      if (!entry || typeof entry !== 'object') { invalidItem = true; return []; }
      const item = entry as Partial<SettingsItem>;
      if (typeof item.id !== 'string' || !isValidOpaqueId(item.id) || typeof item.label !== 'string' || !item.label.trim()) { invalidItem = true; return []; }
      const itemFields = validateFields(item.fields);
      const itemActions = validateActions(item.actions);
      return [{
        id: item.id,
        label: item.label.trim(),
        description: typeof item.description === 'string' ? item.description : undefined,
        meta: typeof item.meta === 'string' ? item.meta : undefined,
        detail: typeof item.detail === 'string' ? item.detail : undefined,
        ...(itemFields ? { fields: itemFields } : {}),
        ...(itemActions ? { actions: itemActions } : {}),
      }];
    }) : undefined;
    if (invalidItem) return [];
    return [{ id: item.id, label: item.label.trim(), description: typeof item.description === 'string' ? item.description : undefined, layout: item.layout, ...(fields ? { fields } : {}), ...(items ? { items } : {}), ...(actions ? { actions } : {}) }];
  });
  if (sections.length !== candidate.sections.length) return null;
  return { sections, render: typeof candidate.render === 'function' ? candidate.render as SettingsContribution['render'] : undefined };
}

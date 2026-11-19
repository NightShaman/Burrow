import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConfirm } from '../../app/ConfirmDialog';
import { useUnsavedChanges } from '../../app/UnsavedChanges';
import type { SettingsContribution, SettingsField, SettingsAction } from './SettingsContribution';
import type { ModSettingsSection, ModSettingsModule } from './ModSettingsHost';
import { Field, SettingSection } from './SettingsPrimitives';

function defaultFieldValues(
  definition: SettingsContribution['sections'][number],
): Record<string, string | boolean> {
  return Object.fromEntries(
    [
      ...(definition.fields ?? []),
      ...(definition.items?.flatMap((item) => item.fields ?? []) ?? []),
    ].map((field) => [
      field.id,
      field.control === 'boolean' ? field.value === 'true' : (field.value ?? ''),
    ]),
  );
}

export function DeclarativeSection({
  contribution,
  section,
  module,
  overflowTarget,
}: {
  contribution: SettingsContribution;
  section: ModSettingsSection;
  module: Pick<ModSettingsModule, 'handleSettingsAction'>;
  overflowTarget: HTMLElement | null;
}) {
  const definition = contribution.sections.find((item) => item.id === section.id);
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    definition ? defaultFieldValues(definition) : {},
  );
  const previousDefaults = useRef({
    sectionId: section.id,
    values: definition ? defaultFieldValues(definition) : {},
  });
  const [actionBusy, setActionBusy] = useState(false);
  const [baseline, setBaseline] = useState(() =>
    definition ? defaultFieldValues(definition) : {},
  );
  const [actionState, setActionState] = useState<{
    id: string;
    status: 'saving' | 'success' | 'error';
    message: string;
  } | null>(null);
  const confirm = useConfirm();
  const actionPending = useRef(false);
  const actionOwner = useRef<object | null>(null);
  useEffect(() => {
    const owner = {};
    actionOwner.current = owner;
    return () => {
      actionOwner.current = null;
    };
  }, [section.id, definition]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(definition?.items?.[0]?.id ?? '');
  useEffect(() => {
    if (!definition) return;
    const defaults = defaultFieldValues(definition);
    const previous = previousDefaults.current;
    setValues((current) =>
      Object.fromEntries(
        Object.entries(defaults).map(([id, value]) => [
          id,
          previous.sectionId === section.id &&
          Object.hasOwn(previous.values, id) &&
          current[id] !== previous.values[id]
            ? current[id]
            : value,
        ]),
      ),
    );
    previousDefaults.current = { sectionId: section.id, values: defaults };
    setBaseline(defaults);
    setActionState(null);
    setEditingId(null);
    setSelectedId((current) =>
      definition.items?.some((item) => item.id === current)
        ? current
        : (definition.items?.[0]?.id ?? ''),
    );
  }, [definition, section.id]);
  const busy = actionBusy || actionState?.status === 'saving';
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const dirty = Object.keys(values).some((id) => values[id] !== baseline[id]);
  const editing =
    definition?.items?.find((item) => item.id === editingId) ??
    (!definition?.fields?.length ? definition?.items?.[0] : undefined);
  const selected =
    definition?.items?.find((item) => item.id === selectedId) ?? definition?.items?.[0];
  const actionGroups = [
    { fields: definition?.fields, actions: definition?.actions },
    ...(definition?.items ?? []),
  ];
  const dirtyGroups = actionGroups.filter((group) =>
    group.fields?.some((field) => values[field.id] !== baseline[field.id]),
  );
  const actionForGroup = (group: (typeof actionGroups)[number]) =>
    group.actions?.find((action) => action.tone === 'primary') ??
    group.actions?.find((action) => action.tone !== 'danger');
  useUnsavedChanges({
    dirty,
    busy: Boolean(busy),
    save: async () => {
      const saves = dirtyGroups.map((group) => ({ group, action: actionForGroup(group) }));
      if (!saves.length || saves.some(({ action }) => !action)) return false;
      for (const { group, action } of saves) {
        if (!action || !(await requestAction(action, group.fields))) return false;
      }
      return true;
    },
    discard: () => {
      setValues(baseline);
      setActionState(null);
      setEditingId(null);
    },
  });
  if (!definition) return null;
  const update = (id: string, value: string | boolean) =>
    setValues((current) => ({ ...current, [id]: value }));
  const runAction = async (
    actionId: string,
    fields: SettingsField[] | undefined,
    owner: object,
  ): Promise<boolean> => {
    setActionState({ id: actionId, status: 'saving', message: 'Saving…' });
    const actionValues = { ...defaultFieldValues(definition), ...valuesRef.current };
    try {
      if (typeof module.handleSettingsAction !== 'function')
        throw new Error('The mod does not provide an action handler.');
      await module.handleSettingsAction(actionId, actionValues);
      if (actionOwner.current !== owner) return false;
      setActionState({ id: actionId, status: 'success', message: 'Saved.' });
      const accepted = Object.fromEntries(
        (fields ?? []).map((field) => [
          field.id,
          field.control === 'password' ? '' : actionValues[field.id],
        ]),
      );
      setBaseline((current) => ({ ...current, ...accepted }));
      setValues((current) => ({
        ...current,
        ...Object.fromEntries(
          Object.entries(accepted).filter(([id]) => current[id] === actionValues[id]),
        ),
      }));
      const unchanged = Object.keys(accepted).every(
        (id) => valuesRef.current[id] === actionValues[id],
      );
      if (
        definition.layout === 'form-inventory' &&
        definition.fields?.length &&
        unchanged &&
        fields === editing?.fields &&
        fields
      )
        setEditingId(null);
      return unchanged;
    } catch (cause) {
      if (actionOwner.current === owner)
        setActionState({
          id: actionId,
          status: 'error',
          message: cause instanceof Error ? cause.message : 'The action could not be completed.',
        });
      return false;
    }
  };
  const requestAction = async (
    action: SettingsAction,
    fields?: SettingsField[],
  ): Promise<boolean> => {
    if (actionPending.current) return false;
    actionPending.current = true;
    setActionBusy(true);
    const owner = actionOwner.current;
    try {
      if (
        action.confirm &&
        !(await confirm({
          title: action.label,
          message: action.confirm,
          confirmLabel: action.label,
          tone: action.tone === 'danger' ? 'danger' : 'default',
        }))
      )
        return false;
      if (!owner || actionOwner.current !== owner) return false;
      return await runAction(action.id, fields, owner);
    } finally {
      actionPending.current = false;
      setActionBusy(false);
    }
  };
  const actions = (items: SettingsAction[] | undefined, fields?: SettingsField[]) =>
    items?.length ? (
      <div className="card-actions">
        {items.map((action) => {
          const saving = actionState?.id === action.id && actionState?.status === 'saving';
          return (
            <button
              type="button"
              className={
                action.tone === 'primary' ? 'primary' : action.tone === 'danger' ? 'danger' : ''
              }
              disabled={busy}
              key={action.id}
              onClick={() => void requestAction(action, fields)}
            >
              {saving ? 'Saving…' : action.label}
            </button>
          );
        })}
      </div>
    ) : null;
  const feedback = actionState && (
    <p
      className={actionState.status === 'error' ? 'settings-request-error' : 'settings-help'}
      role={actionState.status === 'error' ? 'alert' : 'status'}
    >
      {actionState.message}
    </p>
  );
  if (definition.layout === 'form-inventory') {
    const reset = () => {
      setEditingId(null);
      setValues(baseline);
      setActionState(null);
    };
    const inventoryContents = definition.items?.length ? (
      <div className="memory-connection-list">
        {definition.items.map((item) => (
          <article
            className={`memory-connection settings-inventory-card${editing?.id === item.id ? ' active' : ''}`}
            key={item.id}
          >
            {item.fields?.length ? (
              <button
                type="button"
                className="settings-inventory-select"
                aria-pressed={editing?.id === item.id}
                disabled={busy}
                onClick={() => {
                  setValues(baseline);
                  setEditingId(item.id);
                  setActionState(null);
                }}
              >
                <strong>{item.label}</strong>
                {item.meta && <small>{item.meta}</small>}
              </button>
            ) : (
              <div>
                <strong>{item.label}</strong>
                {item.meta && <small>{item.meta}</small>}
              </div>
            )}
            {actions(
              item.actions?.filter((action) => !item.fields?.length || action.tone === 'danger'),
            )}
          </article>
        ))}
      </div>
    ) : (
      <p className="settings-empty">No saved items yet.</p>
    );
    const inventory = (
      <div className="settings-overflow-content memory-saved">{inventoryContents}</div>
    );
    return (
      <>
        <SettingSection
          title={editing ? `${editing.editLabel ?? 'Edit'}: ${editing.label}` : definition.label}
        >
          {definition.description && (
            <p className="settings-description">{definition.description}</p>
          )}
          {!editing && !definition.fields?.length && (
            <p className="settings-empty">No items available to configure.</p>
          )}
          {(editing?.fields ?? definition.fields)?.map((field) => (
            <Field label={field.label} key={field.id}>
              {field.control === 'select' ? (
                <select
                  disabled={busy}
                  value={String(values[field.id] ?? '')}
                  onChange={(event) => update(field.id, event.currentTarget.value)}
                >
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : field.control === 'boolean' ? (
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={values[field.id] === true}
                  onChange={(event) => update(field.id, event.currentTarget.checked)}
                />
              ) : (
                <input
                  type={
                    field.control === 'password'
                      ? 'password'
                      : field.control === 'number'
                        ? 'number'
                        : 'text'
                  }
                  disabled={busy}
                  value={String(values[field.id] ?? '')}
                  onChange={(event) => update(field.id, event.currentTarget.value)}
                />
              )}
              {field.description && <small className="settings-help">{field.description}</small>}
            </Field>
          ))}
          {editing?.metadata?.length && (
            <details>
              <summary>Details</summary>
              <dl>
                {editing.metadata.map((entry) => (
                  <div key={entry.label}>
                    <dt>{entry.label}</dt>
                    <dd>{entry.value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
          {actions(
            editing
              ? editing.actions?.filter((action) => action.tone !== 'danger')
              : definition.actions,
            editing?.fields ?? definition.fields,
          )}
          {editing && Boolean(definition.fields?.length) && (
            <button type="button" disabled={busy} onClick={reset}>
              Cancel
            </button>
          )}
          {feedback}
          {!overflowTarget && (
            <details className="memory-saved saved-accordion">
              <summary>Saved {definition.label.toLowerCase()}</summary>
              {inventoryContents}
            </details>
          )}
        </SettingSection>
        {overflowTarget && createPortal(inventory, overflowTarget)}
      </>
    );
  }
  if (definition.layout === 'form')
    return (
      <SettingSection title={definition.label}>
        {definition.description && <p className="settings-help">{definition.description}</p>}
        {definition.fields?.map((field: SettingsField) => (
          <Field label={field.label} key={field.id}>
            {field.control === 'boolean' ? (
              <input
                disabled={busy}
                type="checkbox"
                checked={values[field.id] === true}
                onChange={(event) => update(field.id, event.currentTarget.checked)}
              />
            ) : field.control === 'select' ? (
              <select
                disabled={busy}
                value={String(values[field.id] ?? '')}
                onChange={(event) => update(field.id, event.currentTarget.value)}
              >
                {field.options?.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                disabled={busy}
                type={
                  field.control === 'password'
                    ? 'password'
                    : field.control === 'number'
                      ? 'number'
                      : 'text'
                }
                value={String(values[field.id] ?? '')}
                onChange={(event) => update(field.id, event.currentTarget.value)}
              />
            )}
            {field.description && <small className="settings-help">{field.description}</small>}
          </Field>
        ))}
        {actions(definition.actions, definition.fields)}
        {feedback}
      </SettingSection>
    );
  if (definition.layout === 'list-detail') {
    const detail = selected && (
      <section className="setting-section">
        <h2>{selected.label}</h2>
        {selected.description && <p className="settings-help">{selected.description}</p>}
        {selected.meta && <p className="settings-help">{selected.meta}</p>}
        {selected.detail && <p>{selected.detail}</p>}
        {selected.fields?.map((field) => (
          <Field label={field.label} key={field.id}>
            {field.control === 'select' ? (
              <select
                disabled={busy}
                value={String(values[field.id] ?? field.value ?? '')}
                onChange={(event) => update(field.id, event.currentTarget.value)}
              >
                {field.options?.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.control === 'boolean' ? (
              <input
                disabled={busy}
                type="checkbox"
                checked={values[field.id] === true}
                onChange={(event) => update(field.id, event.currentTarget.checked)}
              />
            ) : (
              <input
                disabled={busy}
                type={
                  field.control === 'password'
                    ? 'password'
                    : field.control === 'number'
                      ? 'number'
                      : 'text'
                }
                value={String(values[field.id] ?? field.value ?? '')}
                onChange={(event) => update(field.id, event.currentTarget.value)}
              />
            )}
          </Field>
        ))}
        {actions(selected.actions, selected.fields)}
        {feedback}
      </section>
    );
    return (
      <>
        <SettingSection title={definition.label}>
          {definition.description && <p className="settings-help">{definition.description}</p>}
          {definition.fields?.map((field) => (
            <Field label={field.label} key={field.id}>
              {field.control === 'boolean' ? (
                <input
                  disabled={busy}
                  type="checkbox"
                  checked={values[field.id] === true}
                  onChange={(event) => update(field.id, event.currentTarget.checked)}
                />
              ) : field.control === 'select' ? (
                <select
                  disabled={busy}
                  value={String(values[field.id] ?? '')}
                  onChange={(event) => update(field.id, event.currentTarget.value)}
                >
                  {field.options?.map((option) => (
                    <option value={option.value} key={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  disabled={busy}
                  type={
                    field.control === 'password'
                      ? 'password'
                      : field.control === 'number'
                        ? 'number'
                        : 'text'
                  }
                  value={String(values[field.id] ?? '')}
                  onChange={(event) => update(field.id, event.currentTarget.value)}
                />
              )}
              {field.description && <small className="settings-help">{field.description}</small>}
            </Field>
          ))}
          {actions(definition.actions, definition.fields)}
          {!selected && feedback}
          <div className="mcp-server-selector">
            {definition.items?.map((item) => (
              <button
                type="button"
                className={item.id === selected?.id ? 'active' : ''}
                aria-current={item.id === selected?.id ? 'page' : undefined}
                disabled={busy}
                onClick={() => setSelectedId(item.id)}
                key={item.id}
              >
                {item.label}
                {item.meta && <small>{item.meta}</small>}
              </button>
            ))}
          </div>
        </SettingSection>
        {overflowTarget ? createPortal(detail, overflowTarget) : detail}
      </>
    );
  }
  return (
    <SettingSection title={definition.label}>
      {definition.description && <p className="settings-help">{definition.description}</p>}
      {definition.items?.map((item) => (
        <article className="provider-card" key={item.id}>
          <strong>{item.label}</strong>
          {item.description && <p>{item.description}</p>}
          {item.meta && <small>{item.meta}</small>}
          {actions(item.actions)}
        </article>
      ))}
    </SettingSection>
  );
}

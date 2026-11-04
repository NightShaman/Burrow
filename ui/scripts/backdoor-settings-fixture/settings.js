/** Operator-facing assignment of Core-owned Backdoor diagnostic and administrative access. */
export const settingsSections = [
  { id: 'global-access', label: 'Global Access', layout: 'form' },
  { id: 'admin-access', label: 'Admin Access', layout: 'form-wide' },
];

const ADMIN_CAPABILITIES = [
  { id: 'mod-management-v1', key: 'modManagementAgentIds', title: 'Mod management', ariaLabel: 'Agents with mod management access', label: 'Approve Backdoor mod management', help: 'Required before assigned administrators can install, update, enable, disable, or uninstall mods.' },
  { id: 'core-api-v1', key: 'coreApiAgentIds', title: 'Core API access', ariaLabel: 'Agents with Core API access', label: 'Approve Backdoor Core API access', help: 'Allows assigned administrators to use the Core API through Backdoor.' },
];
const sectionConfig = {
  'global-access': {
    key: 'diagnosticAgentIds',
    title: 'Global diagnostic access',
    description: 'Agents can inspect their own diagnostics by default. Select agents that may inspect diagnostics across all agents.',
    independence: 'This assignment does not grant or imply Burrow administrative access.',
    ariaLabel: 'Agents with global diagnostic access',
    saveLabel: 'Save global access',
    savedMessage: 'Global access saved.',
  },
  'admin-access': {
    title: 'Burrow administrative access',
    description: 'Assign mod management and Core API access independently.',
    independence: 'This assignment does not grant or imply global diagnostic access.',
    saveLabel: 'Save admin access',
    savedMessage: 'Admin access saved.',
    capabilities: ADMIN_CAPABILITIES,
  },
};

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
};

function readStrings(result, key) {
  if (!Array.isArray(result?.[key]) || result[key].some(value => typeof value !== 'string' || !value)) {
    throw new Error('Core returned an invalid Backdoor access response.');
  }
  return [...result[key]];
}

function readAccess(result) {
  const access = {
    grants: readStrings(result, 'grants'),
    modManagementAgentIds: readStrings(result, 'modManagementAgentIds'),
    coreApiAgentIds: readStrings(result, 'coreApiAgentIds'),
    diagnosticAgentIds: readStrings(result, 'diagnosticAgentIds'),
    declaredCapabilities: readStrings(result, 'declaredCapabilities'),
    restartRequired: result?.restartRequired,
  };
  for (const key of ['grants', 'modManagementAgentIds', 'coreApiAgentIds', 'diagnosticAgentIds', 'declaredCapabilities']) {
    if (new Set(access[key]).size !== access[key].length) throw new Error('Core returned an invalid Backdoor access response.');
  }
  if (typeof access.restartRequired !== 'boolean') throw new Error('Core returned an invalid Backdoor access response.');
  return access;
}

function replacement(access) {
  return {
    grants: [...access.grants],
    modManagementAgentIds: [...access.modManagementAgentIds],
    coreApiAgentIds: [...access.coreApiAgentIds],
    diagnosticAgentIds: [...access.diagnosticAgentIds],
  };
}

export function mountSettings({ section, primary, overflow, accessApi, agents, setDraft, navigate, confirm }) {
  let active = true;
  let saving = false;
  let access = null;
  const controller = new AbortController();
  const inputs = new Map();
  const config = sectionConfig[section] ?? sectionConfig['global-access'];
  const form = el('form', null, 'setting-section backdoor-settings');
  // Layout belongs to the host. Only bound the assignment collection here;
  // fields, checkbox rows, spacing and action treatment use shared variants.
  form.append(el('h2', config.title));
  const body = el('div', null, 'settings-form settings-stack');
  form.append(body);
  body.append(el('p', config.description, 'settings-description'));
  body.append(el('p', config.independence, 'settings-help'));

  const capabilityInputs = new Map();
  const groups = config.capabilities ?? [config];
  const groupBoxes = new Map();
  const groupContainer = config.capabilities ? el('div', null, 'settings-section-pair') : body;
  if (groupContainer !== body) body.append(groupContainer);
  for (const group of groups) {
    const box = el('section', null, 'settings-stack');
    box.setAttribute('aria-label', group.title);
    groupContainer.append(box);
    groupBoxes.set(group.key, box);
  }

  const actions = el('div', null, 'model-actions');
  const save = el('button', config.saveLabel, 'primary');
  save.type = 'submit';
  save.disabled = true;
  const feedback = el('p', 'Loading agent access…', 'settings-status');
  feedback.setAttribute('role', 'status');
  actions.append(save);
  body.append(actions, feedback);
  primary.replace(form);
  overflow?.clear();

  const fail = message => {
    feedback.textContent = message;
    feedback.setAttribute('role', 'alert');
    feedback.className = 'settings-request-error';
  };
  const setStatus = message => {
    feedback.textContent = message;
    feedback.setAttribute('role', 'status');
    feedback.className = 'settings-status';
  };
  const setSaving = next => {
    saving = next;
    save.disabled = next || !isDirty();
    save.textContent = next ? 'Saving…' : config.saveLabel;
    for (const group of inputs.values()) for (const input of group.values()) input.disabled = next;
    for (const input of capabilityInputs.values()) input.disabled = next;
    publishDraft();
  };

  function renderAgents(group, nextAccess, box) {
    const list = el('div', null, 'settings-stack backdoor-agent-list');
    list.setAttribute('aria-label', group.ariaLabel);
    list.setAttribute('role', 'group');
    list.style.maxHeight = 'min(360px, 45dvh)';
    list.style.overflowY = 'auto';
    list.style.overflowWrap = 'anywhere';
    box.append(list);
    const groupInputs = new Map();
    inputs.set(group.key, groupInputs);
    const selectedIds = nextAccess[group.key];
    const selected = new Set(selectedIds);
    const availableIds = new Set(agents.map(agent => agent.id));
    const rows = [
      ...agents.map(agent => ({ id: agent.id, name: agent.name || agent.id, unavailable: false })),
      ...selectedIds.filter(id => !availableIds.has(id)).map(id => ({ id, name: id, unavailable: true })),
    ];
    if (!rows.length) list.append(el('p', 'No agents are available.', 'settings-help'));
    for (const agent of rows) {
      const input = el('input');
      input.type = 'checkbox';
      input.value = agent.id;
      input.checked = selected.has(agent.id);
      input.dataset.unavailable = String(agent.unavailable);
      const copy = el('span', agent.name);
      if (agent.unavailable) copy.append(el('br'), el('span', 'Unavailable agent assignment', 'settings-help'));
      const label = el('label', null, 'settings-checkbox-row');
      label.append(input, copy);
      list.append(label);
      groupInputs.set(agent.id, input);
    }
  }

  function render(nextAccess) {
    access = nextAccess;
    inputs.clear();
    capabilityInputs.clear();
    for (const group of groups) {
      const box = groupBoxes.get(group.key);
      box.replaceChildren();
      if (group.id) {
        box.append(el('h3', group.title));
        if (nextAccess.declaredCapabilities.includes(group.id)) {
          const input = el('input');
          input.type = 'checkbox';
          input.checked = nextAccess.grants.includes(group.id);
          capabilityInputs.set(group.id, input);
          const copy = el('span', group.label);
          copy.append(el('br'), el('span', group.help, 'settings-help'));
          const label = el('label', null, 'settings-checkbox-row');
          label.append(input, copy);
          box.append(label);
        } else {
          box.append(el('p', `Backdoor does not currently declare ${group.id}.`, 'settings-request-error'));
        }
      }
      renderAgents(group, nextAccess, box);
    }
    save.disabled = true;
    publishDraft();
    setStatus(nextAccess.restartRequired ? 'A Core restart is still required for the latest capability grant.' : '');
  }

  async function readCurrent() {
    if (typeof accessApi !== 'function') throw new Error('This Burrow UI does not support Core-owned mod access yet.');
    return readAccess(await accessApi({ signal: controller.signal }));
  }

  async function load() {
    save.disabled = true;
    try {
      if (![setDraft, navigate, confirm].every(method => typeof method === 'function')) {
        throw new Error('Update Burrow UI to use shared draft protection for Backdoor settings.');
      }
      const result = await readCurrent();
      if (!active) return;
      render(result);
    } catch (error) {
      if (active) fail(`Agent access unavailable: ${error?.message || 'Request failed.'}`);
    }
  }

  function selectedIds(key) {
    return [...inputs.get(key)]
      .filter(([, input]) => input.checked)
      .map(([id]) => id);
  }

  function isDirty() {
    if (!access) return false;
    return groups.some(group => {
      const selected = selectedIds(group.key);
      return selected.length !== access[group.key].length
        || selected.some(id => !access[group.key].includes(id));
    })
      || [...capabilityInputs].some(([id, input]) => input.checked !== access.grants.includes(id));
  }

  function publishDraft() {
    if (!active || typeof setDraft !== 'function') return;
    setDraft(access ? {
      dirty: isDirty(), busy: saving, save: saveAccess,
      discard: () => { if (active && !saving) render(access); },
    } : null);
  }

  function changed() {
    save.disabled = saving || !isDirty();
    setStatus(isDirty() ? 'Unsaved changes.' : access?.restartRequired ? 'A Core restart is still required for the latest capability grant.' : '');
    publishDraft();
  }

  async function saveAccess() {
    if (!active || saving || !access) return false;
    if (!isDirty()) return true;
    setSaving(true);
    setStatus('Saving…');
    try {
      // Core replacements are last-writer-wins. Refresh immediately before saving so
      // this panel preserves fields owned by the other panel and any unknown grants.
      const current = await readCurrent();
      if (!active) return false;
      const nextAccess = { ...current };
      for (const group of groups) nextAccess[group.key] = selectedIds(group.key);
      for (const [id, input] of capabilityInputs) {
        nextAccess.grants = input.checked
          ? [...new Set([...nextAccess.grants, id])]
          : nextAccess.grants.filter(capability => capability !== id);
      }
      const result = readAccess(await accessApi({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(replacement(nextAccess)),
        signal: controller.signal,
      }));
      if (!active) return false;
      render(result);
      setStatus(result.restartRequired
        ? `${config.savedMessage} Restart Core to apply newly granted host capabilities.`
        : config.savedMessage);
      return true;
    } catch (error) {
      if (active) fail(`Could not save agent access: ${error?.message || 'Request failed.'}`);
      return false;
    } finally {
      if (active) setSaving(false);
    }
  }

  const submit = event => { event.preventDefault(); return saveAccess(); };
  form.addEventListener('change', changed);
  form.addEventListener('submit', submit);
  void load();

  return () => {
    active = false;
    if (typeof setDraft === 'function') setDraft(null);
    controller.abort();
    form.removeEventListener('change', changed);
    form.removeEventListener('submit', submit);
    primary.clear();
    overflow?.clear();
  };
}


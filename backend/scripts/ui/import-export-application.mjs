import { promises as fs } from 'node:fs';
import path from 'node:path';
import { operatorTimezone, saveOperatorTimezone } from '../../src/timezone.mjs';
import { readDreamPromotion, saveDreamPromotion } from '../../src/dream-promotion-settings.mjs';
import { readExecutionBoundaries, saveExecutionBoundaries } from '../../src/execution-boundaries.mjs';
import { curatorRoot as defaultCuratorRoot, readCuratorSelection, saveCuratorSelection } from '../../src/curator-runtime.mjs';
import { ensureAgentRoots as ensureAgentRootsRuntime } from '../../src/agent-registry.mjs';
import { AGENT_PROFILE_KINDS } from '../../src/agent-profile-store.mjs';
import { planUiAuthSettings, safeUiAuthSettings, createUiAuthService } from '../../src/ui-auth-service.mjs';

// Keep this allowlist distinct from the export catalog: sessions, traces and
// api-contract can be exported, but are intentionally not importable.
export const IMPORT_SUPPORTED_CATEGORIES = new Set(['agents', 'settings', 'task-board', 'model-connections', 'mcp-connections', 'ui-auth', 'scheduled-jobs', 'skills']);
/**
 * Construct the import/export application owner around the existing PostgreSQL
 * stores and runtime services. Store authority stays grouped in `stores`;
 * filesystem/runtime operations stay grouped in `runtime`.
 */
export function createImportExportApplication({ stores, runtime, metadataStore: metadataStoreDependency = stores?.metadata, uiAuthSecretStore: uiAuthSecretStoreDependency = stores?.uiAuthSecrets } = {}) {
  if (!stores || !runtime || typeof runtime.config !== 'function' || typeof runtime.metrics !== 'function'
      || !runtime.archiveSummary || typeof runtime.archiveSummary.read !== 'function' || typeof runtime.archiveSummary.save !== 'function'
      || typeof runtime.sourceRoot !== 'string') throw new TypeError('import_export_dependencies_required');
  if (!metadataStoreDependency || !uiAuthSecretStoreDependency) throw new TypeError('import_export_settings_stores_required');
  const postgresApplication = { stores };
  const sourceRoot = runtime.sourceRoot;
  const modelsStore = () => stores.models;
  const agentsStore = () => stores.agents;
  const profilesStore = () => stores.profiles;
  const dreamSettingsStore = () => stores.dreamSettings;
  const mcpStore = () => stores.mcp;
  const metadataStore = () => typeof metadataStoreDependency === 'function' ? metadataStoreDependency() : metadataStoreDependency;
  const uiAuthSecretStore = () => typeof uiAuthSecretStoreDependency === 'function' ? uiAuthSecretStoreDependency() : uiAuthSecretStoreDependency;
  const withTaskBoard = (operation) => operation(stores.tasks);
  const runtimeConfig = (...args) => runtime.config(...args);
  const ensureAgentRoots = runtime.ensureAgentRoots || ensureAgentRootsRuntime;
  const runtimeMetrics = () => runtime.metrics();
  const curatorRoot = () => typeof runtime.curatorRoot === 'function' ? runtime.curatorRoot() : (runtime.curatorRoot || defaultCuratorRoot());
  const archiveSummarySelection = (agentId) => runtime.archiveSummary.read(agentId);
  const saveArchiveSummaryModelSelection = (agentId, selection) => runtime.archiveSummary.save(agentId, selection);
  const { readUiAuthRecord, saveUiAuthSettings } = createUiAuthService({
    metadataStore,
    uiAuthSecretStore,
    runtimeConfig,
  });

  async function importPreview(decoded, conflictPolicy) {
    const supported = decoded.categories.filter((id) => IMPORT_SUPPORTED_CATEGORIES.has(id));
    const unsupported = decoded.categories.filter((id) => !IMPORT_SUPPORTED_CATEGORIES.has(id));
    let uiAuth = null;
    if (supported.includes('ui-auth') && decoded.payload.categories['ui-auth']?.auth) {
      const category = decoded.payload.categories['ui-auth'];
      const existing = await readUiAuthRecord();
      const secret = category.oidcClientSecret;
      const input = secret && secret !== '[redacted]' ? { ...category.auth, oidc: { ...category.auth.oidc, clientSecret: secret } } : category.auth;
      const basicReconfigurationRequired = input.mode === 'basic' && input.basic?.password === undefined;
      const plan = planUiAuthSettings(basicReconfigurationRequired ? { ...input, mode: existing.mode, basic: existing.basic } : input, existing);
      if (!plan.ok) throw Object.assign(new Error(plan.error), { statusCode: plan.status });
      const summary = record => ({ mode: record.mode, enabled: record.mode !== 'none', basicPasswordConfigured: Boolean(record.basic.passwordHash), oidcClientSecretConfigured: Boolean(record.oidc.clientSecretConfigured || record.oidc.clientSecret) });
      uiAuth = { before: summary(existing), after: summary(plan.next), basicCredentialsPortable: false, requiresBasicReconfiguration: basicReconfigurationRequired, warning: basicReconfigurationRequired ? 'Basic credentials are not portable. Existing authentication will be preserved; configure Basic credentials deliberately after import.' : null };
    }
    const mcpCategory = decoded.payload.categories['mcp-connections'];
    const legacyMcpGrants = mcpCategory && typeof mcpCategory === 'object' && !Array.isArray(mcpCategory) && Array.isArray(mcpCategory.grants) ? mcpCategory.grants : [];
    const mcpConnections = Array.isArray(mcpCategory) ? mcpCategory : (Array.isArray(mcpCategory?.connections) ? mcpCategory.connections : []);
    const mcpAuthorization = supported.includes('mcp-connections') ? {
      transferred: false,
      ignoredGrantRecords: legacyMcpGrants.length,
      ignoredToolGrants: legacyMcpGrants.reduce((count, grant) => count + (Array.isArray(grant?.tools) ? grant.tools.length : 0), 0),
      regrantRequired: mcpConnections.length > 0,
      message: 'MCP tool grants are deployment-local and are not imported. Regrant access deliberately on this deployment.',
    } : null;
    return { ok: true, format: decoded.payload.manifest.format, encrypted: decoded.encrypted, categories: decoded.categories, supported, unsupported, conflictPolicy, requiresConfirmation: true, redacted: Boolean(decoded.payload.manifest.redacted), uiAuth, mcpAuthorization };
  }
  async function applyImport(decoded, { conflictPolicy = 'error' } = {}) {
    const categories = Object.fromEntries(decoded.categories.map(id => [id, decoded.payload.categories[id]]));
    const importedMcpCategory = categories['mcp-connections'];
    const legacyMcpGrants = importedMcpCategory && typeof importedMcpCategory === 'object' && !Array.isArray(importedMcpCategory) && Array.isArray(importedMcpCategory.grants) ? importedMcpCategory.grants : [];
    const importedMcpConnections = Array.isArray(importedMcpCategory) ? importedMcpCategory : (Array.isArray(importedMcpCategory?.connections) ? importedMcpCategory.connections : []);
    const mcpAuthorization = Object.hasOwn(categories, 'mcp-connections') ? {
      transferred: false,
      ignoredGrantRecords: legacyMcpGrants.length,
      ignoredToolGrants: legacyMcpGrants.reduce((count, grant) => count + (Array.isArray(grant?.tools) ? grant.tools.length : 0), 0),
      regrantRequired: importedMcpConnections.length > 0,
      message: 'MCP tool grants are deployment-local and are not imported. Regrant access deliberately on this deployment.',
    } : null;
    const unsupported = decoded.categories.filter((id) => !IMPORT_SUPPORTED_CATEGORIES.has(id));
    if (unsupported.length) return { ok: false, status: 400, error: 'import_category_unsupported', details: { categories: unsupported } };
    if (Object.hasOwn(categories, 'agents') && (!categories.agents || typeof categories.agents !== 'object' || Array.isArray(categories.agents) || categories.agents.schema !== 'burrow.agents-and-profiles/v2' || !Array.isArray(categories.agents.records) || !categories.agents.profiles || typeof categories.agents.profiles !== 'object' || Array.isArray(categories.agents.profiles))) {
      return { ok: false, status: 400, error: 'import_agents_format_invalid', details: { expected: 'burrow.agents-and-profiles/v2' } };
    }
    if (Object.hasOwn(categories, 'scheduled-jobs') && (categories['scheduled-jobs']?.schema !== 'burrow.scheduled-jobs/v1' || !Array.isArray(categories['scheduled-jobs'].jobs) || categories['scheduled-jobs'].jobs.some(job => !job || !/^[A-Za-z0-9._-]{1,96}$/.test(job.id || '') || job.ownerModId))) return { ok: false, status: 400, error: 'import_scheduled_jobs_format_invalid' };
    if (Object.hasOwn(categories, 'skills') && (categories.skills?.schema !== 'burrow.skills/v1' || !Array.isArray(categories.skills.records) || !Array.isArray(categories.skills.assignments) || categories.skills.records.some(skill => !skill || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skill.id || '') || skill.storage && skill.storage !== 'postgres' || skill.contentOwner && skill.contentOwner !== 'operator'))) return { ok: false, status: 400, error: 'import_skills_format_invalid' };
    if (categories.skills?.assignments.some(assignment => !assignment || typeof assignment.agentId !== 'string' || !Array.isArray(assignment.assignedSkillIds) || assignment.assignedSkillIds.some(id => !categories.skills.records.some(skill => skill.id === id)))) return { ok: false, status: 400, error: 'import_skill_assignments_invalid' };
    for (const records of [categories['scheduled-jobs']?.jobs, categories.skills?.records]) {
      if (records && new Set(records.map(record => record.id)).size !== records.length) return { ok: false, status: 400, error: 'import_duplicate_id' };
    }
    const conflicts = [];
    for (const skill of (categories.skills?.records || [])) if (await postgresApplication.stores.skills.get(skill.id)) conflicts.push({ category: 'skills', id: skill.id });
    for (const job of (categories['scheduled-jobs']?.jobs || [])) {
      const existing = await postgresApplication.stores.scheduledJobs.getJob(job.id);
      // Generic config imports must never overwrite mod-owned definitions.
      if (existing?.ownerModId) return { ok: false, status: 409, error: 'import_scheduled_job_mod_owned', details: { id: job.id } };
      if (existing) conflicts.push({ category: 'scheduled-jobs', id: job.id });
    }
    if (categories['task-board']?.projects && Array.isArray(categories['task-board'].projects)) for (const project of categories['task-board'].projects) if (await withTaskBoard((store) => store.getProject(project.id))) conflicts.push({ category: 'task-board.projects', id: project.id });
    if (Array.isArray(categories['model-connections'])) {
      const store = modelsStore();
      for (const connection of categories['model-connections']) {
        if (!connection?.id) continue;
        const existingById = await store.get(connection.id);
        const existingByProvider = (await store.list()).find((item) => String(item.provider || '').toLowerCase() === String(connection.provider || '').toLowerCase() && item.id !== connection.id);
        if (existingById) conflicts.push({ category: 'model-connections', id: connection.id, reason: 'id' });
        if (existingByProvider) conflicts.push({ category: 'model-connections', id: connection.id, existingId: existingByProvider.id, reason: 'provider' });
      }
    }
    for (const agent of (categories.agents?.records || [])) if (await agentsStore().get(agent.id)) conflicts.push({ category: 'agents', id: agent.id });
    const mcpConnections = importedMcpConnections;
    for (const connection of mcpConnections) if (await mcpStore().get(connection.id)) conflicts.push({ category: 'mcp-connections', id: connection.id });
    for (const task of (categories['task-board']?.tasks || [])) if (await withTaskBoard(store => store.getTask(task.id))) conflicts.push({ category: 'task-board.tasks', id: task.id });
    if (conflicts.length && conflictPolicy === 'error') return { ok: false, status: 409, error: 'import_conflicts', details: { conflicts }, mcpAuthorization };
    const imported = [];
    const deleted = [];
    const completed = [];
    let currentItem = null;
    const failure = (result) => ({ ...result, ok: false, status: result.status || result.statusCode || 400, imported: [...imported], deleted: [...deleted], completed: [...completed], partial: completed.length > 0 || deleted.length > 0, failed: { item: currentItem, error: String(result.error || 'import_failed') }, skipped: conflicts.filter(c => conflictPolicy === 'skip'), unsupported: [], mcpAuthorization });
    const write = async (item, operation) => {
      currentItem = item;
      const result = await operation();
      if (result?.ok === false || result === false) throw Object.assign(new Error(result?.error || 'import_write_failed'), { importResult: result || {} });
      completed.push(item);
      return result;
    };
    try {
    let importRuntime = null;
    const materializeAgentRuntime = async (agent) => {
      if (!agent?.id) return;
      importRuntime ||= await runtimeConfig();
      const context = await ensureAgentRoots({ runtimeState: importRuntime.runtimeState, agent });
      await postgresApplication.stores.conversations.updateMetadata({ agentId: agent.id, sessionId: 'default', update: (metadata) => metadata });

    };
    if (categories.settings && typeof categories.settings === 'object') {
      if (categories.settings.timezone !== undefined) {
        await write('settings:timezone', () => saveOperatorTimezone(postgresApplication.stores.metadata, { timezone: categories.settings.timezone }));
        imported.push('settings:timezone');
      }
      if (categories.settings.retentionPolicy !== undefined) {
        await write('settings:retention-policy', () => postgresApplication.stores.retentionSettings.savePolicy(categories.settings.retentionPolicy));
        imported.push('settings:retention-policy');
      }
      if (categories.settings.brainMemory !== undefined) {
        await write('settings:brain-memory', () => saveDreamPromotion(metadataStore(), categories.settings.brainMemory));
        imported.push('settings:brain-memory');
      }
      if (categories.settings.workingMemoryRetention !== undefined) {
        await write('settings:working-memory-retention', () => postgresApplication.stores.workingMemoryRetention.save(categories.settings.workingMemoryRetention));
        imported.push('settings:working-memory-retention');
      }
      // Legacy browserOrigin exports are ignored; only deployment environment controls it.
      if (categories.settings.executionBoundaries) {
        const result = await write('settings:execution-boundaries', () => saveExecutionBoundaries(categories.settings.executionBoundaries, { metadataStore: postgresApplication.stores.metadata, }));
        if (!result.ok) return failure(result);
        imported.push('settings:execution-boundaries');
      }
      if (categories.settings.curatorSelection) {
        try {
          await write('settings:curator-selection', () => saveCuratorSelection(categories.settings.curatorSelection, { stores: postgresApplication.stores, root: curatorRoot() }));
          imported.push('settings:curator-selection');
        } catch (error) { return failure({ status: 400, error: String(error?.message || error) }); }
      }
    }
    // Model connections must exist before agent dream settings are restored.
    if (Array.isArray(categories['model-connections'])) {
      const store = modelsStore();
      for (const connection of categories['model-connections']) {
        if (connection.auth?.apiKey === '[redacted]' || connection.auth?.token === '[redacted]') continue;
        const connectionConflicts = conflicts.filter((conflict) => conflict.category === 'model-connections' && conflict.id === connection.id);
        if (conflictPolicy === 'skip' && connectionConflicts.length) continue;
        for (const conflict of connectionConflicts) {
          if (conflict.reason === 'provider' && conflict.existingId && conflict.existingId !== connection.id) { await write(`model-connections:delete:${conflict.existingId}`, () => store.remove(conflict.existingId)); deleted.push(`model-connections:${conflict.existingId}`); }
        }
        await write(`model-connections:${connection.id}`, () => store.save(connection));
        imported.push(`model-connections:${connection.id}`);
      }
    }
    if (categories.agents && typeof categories.agents === 'object' && !Array.isArray(categories.agents)) {
      const agentRecords = Array.isArray(categories.agents.records) ? categories.agents.records : [];
      const profiles = categories.agents.profiles && typeof categories.agents.profiles === 'object' ? categories.agents.profiles : {};
      for (const agent of agentRecords) {
        if (conflictPolicy === 'skip' && conflicts.some((c) => c.category === 'agents' && c.id === agent.id)) continue;
        // Portable restoration checks ownership and writes the complete registry
        // identity under a row lock. The normal create/update APIs ignore modAgent
        // and cannot distinguish an old regular payload from a mod-owned ID.
        const importedAgent = await write(`agents:${agent.id}:record`, () => agentsStore().restorePortable(agent, { conflictPolicy }));
        const modOwned = Boolean(importedAgent.modAgent);
        if (!modOwned) await write(`agents:${agent.id}:runtime`, () => materializeAgentRuntime(importedAgent));
        if (agent.avatar !== undefined || agent.identityName !== undefined) await write(`agents:${agent.id}:identity`, () => modelsStore().saveIdentity({ kind: 'agent', id: agent.id, name: agent.identityName ?? agent.name, avatar: agent.avatar ?? '' }));
        const profileDocuments = Array.isArray(profiles[agent.id]) ? profiles[agent.id] : [];
        // Mod profiles are provided by the owner, not imported core profiles.
        // Existing legacy data stays untouched.
        if (!modOwned && profileDocuments.length) {
          const profileStore = profilesStore();
          try { await write(`agents:${agent.id}:profiles`, () => profileStore.replace(agent.id, profileDocuments.filter((item) => AGENT_PROFILE_KINDS.includes(String(item?.kind || '').toUpperCase())).map((item) => ({ ...item, kind: String(item.kind).toUpperCase() })))); } finally { await profileStore.close(); }
        }
        if (!modOwned && agent.dreamSettings && typeof agent.dreamSettings === 'object') {
          const dreamStore = dreamSettingsStore();
          try {
            try {
              await write(`agents:${agent.id}:dream`, () => dreamStore.save(agent.id, agent.dreamSettings));
            } catch (error) {
              // Dream model selection is optional. An export may refer to a provider
              // model that was not included, was redacted, or is unavailable here.
              // Preserve the rest of the dream configuration rather than aborting
              // the entire import; the model can be selected later in Settings.
              if (!['dream_settings_model_selection_invalid', 'dream_settings_model_selection_incomplete'].includes(error?.message)) throw error;
              await write(`agents:${agent.id}:dream`, () => dreamStore.save(agent.id, { ...agent.dreamSettings, modelConnectionId: null, model: null }));
            }
          } finally { await dreamStore.close(); }
        }
        for (const [field, minion] of [['modelSelection', false], ['minionModelSelection', true]]) {
          if ((modOwned && minion) || !Object.hasOwn(agent, field)) continue; // Older v2 bundles remain valid.
          const selection = agent[field];
          if (selection) await write(`agents:${agent.id}:${field}`, () => modelsStore().saveModelSelection({ ...selection, agentId: agent.id, minion }));
          else await write(`agents:${agent.id}:${field}`, () => modelsStore().clearModelSelection(agent.id, { minion }));
        }
        if (!modOwned && Object.hasOwn(agent, 'archiveSummaryModelSelection')) await write(`agents:${agent.id}:archive-summary-model`, () => saveArchiveSummaryModelSelection(agent.id, agent.archiveSummaryModelSelection || {}));
        imported.push(`agents:${agent.id}`);
      }
      if (categories.agents.operator?.name && typeof categories.agents.operator === 'object') {
        const operator = categories.agents.operator;
        await write('agents:operator', () => modelsStore().saveIdentity({ kind: 'operator', id: 'default', name: operator.name ?? '', avatar: operator.avatar ?? '' }));
        imported.push('agents:operator');
      }
    }
    if (categories.settings?.brainEmbeddings !== undefined) {
      await write('settings:brain-embeddings', () => postgresApplication.stores.brainEmbeddings.configure(categories.settings.brainEmbeddings));
      imported.push('settings:brain-embeddings');
    }
    for (const skill of (categories.skills?.records || [])) {
      if (conflictPolicy === 'skip' && conflicts.some(c => c.category === 'skills' && c.id === skill.id)) continue;
      const store = postgresApplication.stores.skills;
      await write(`skills:${skill.id}`, async () => await store.get(skill.id) ? store.update(skill.id, skill) : store.create(skill));
      imported.push(`skills:${skill.id}`);
    }
    for (const assignment of (categories.skills?.assignments || [])) {
      if (conflictPolicy === 'skip' && (conflicts.some(c => c.category === 'agents' && c.id === assignment.agentId) || conflicts.some(c => c.category === 'skills' && assignment.assignedSkillIds.includes(c.id)))) continue;
      const skillStore = postgresApplication.stores.skills;
      const incomingIds = new Set(categories.skills.records.map(skill => skill.id));
      const retainedIds = (await skillStore.assignments(assignment.agentId)).assignedSkillIds.filter(id => !incomingIds.has(id));
      await write(`skills:assignments:${assignment.agentId}`, () => skillStore.replaceAssignments(assignment.agentId, [...retainedIds, ...assignment.assignedSkillIds]));
      imported.push(`skills:assignments:${assignment.agentId}`);
    }
    if (categories['task-board']) for (const project of (categories['task-board'].projects || [])) { if (conflictPolicy === 'skip' && conflicts.some((c) => c.category === 'task-board.projects' && c.id === project.id)) continue; const existing = await withTaskBoard((store) => store.getProject(project.id)); if (!existing) await write(`task-board.projects:${project.id}`, () => withTaskBoard((store) => store.createProject(project))); else if (conflictPolicy === 'replace') await write(`task-board.projects:${project.id}`, () => withTaskBoard((store) => store.updateProject(project.id, project))); else continue; imported.push(`task-board.projects:${project.id}`); }
    if (categories['task-board']) for (const task of (categories['task-board'].tasks || [])) { const exists = await withTaskBoard((store) => store.getTask(task.id)); if (exists && conflictPolicy !== 'replace') continue; if (!exists) await write(`task-board.tasks:${task.id}`, () => withTaskBoard((store) => store.createTask(task))); else await write(`task-board.tasks:${task.id}`, () => withTaskBoard((store) => store.updateTask(task.id, task))); imported.push(`task-board.tasks:${task.id}`); }
    for (const job of (categories['scheduled-jobs']?.jobs || [])) {
      if (conflictPolicy === 'skip' && conflicts.some(c => c.category === 'scheduled-jobs' && c.id === job.id)) continue;
      const store = postgresApplication.stores.scheduledJobs;
      const existing = await store.getJob(job.id);
      await write(`scheduled-jobs:${job.id}`, async () => {
        if (!await agentsStore().get(job.agentId)) throw new Error('scheduled_job_agent_not_found');
        return existing ? store.updateJob(job.id, job) : store.createJob(job);
      });
      imported.push(`scheduled-jobs:${job.id}`);
    }
    if (categories['mcp-connections'] && typeof categories['mcp-connections'] === 'object' && !Array.isArray(categories['mcp-connections'])) {
      const connections = Array.isArray(categories['mcp-connections'].connections) ? categories['mcp-connections'].connections : [];
      for (const connection of connections) { if (connection.apiKey === '[redacted]' || (conflictPolicy === 'skip' && conflicts.some(c => c.category === 'mcp-connections' && c.id === connection.id))) continue; const { environmentVariables, ...portableConnection } = connection; await write(`mcp-connections:${connection.id}`, () => mcpStore().save(portableConnection)); imported.push(`mcp-connections:${connection.id}`); }
    } else if (Array.isArray(categories['mcp-connections'])) for (const connection of categories['mcp-connections']) { if (connection.apiKey === '[redacted]' || (conflictPolicy === 'skip' && conflicts.some(c => c.category === 'mcp-connections' && c.id === connection.id))) continue; const { environmentVariables, ...portableConnection } = connection; await write(`mcp-connections:${connection.id}`, () => mcpStore().save(portableConnection)); imported.push(`mcp-connections:${connection.id}`); }
    if (categories['ui-auth'] && typeof categories['ui-auth'] === 'object') {
      const importedAuth = categories['ui-auth'].auth;
      const auth = importedAuth?.mode === 'basic' && importedAuth.basic?.password === undefined ? null : importedAuth;
      const secret = categories['ui-auth'].oidcClientSecret;
      if (auth && typeof auth === 'object' && secret !== '[redacted]' && secret) {
        const result = await write('ui-auth:oidc-secret', () => saveUiAuthSettings({ ...auth, oidc: { ...(auth.oidc || {}), clientSecret: secret } }));
        if (!result.ok) return failure(result);
        imported.push('ui-auth:oidc-secret');
      } else if (auth && typeof auth === 'object') {
        const result = await write('ui-auth:settings', () => saveUiAuthSettings(auth));
        if (!result.ok) return failure(result);
        imported.push('ui-auth:settings');
      }
    }
    return { ok: true, imported, deleted, completed, partial: false, skipped: conflicts.filter((c) => conflictPolicy === 'skip'), unsupported: [], mcpAuthorization };
    } catch (error) {
      return failure({ ...(error?.importResult || {}), error: String(error?.importResult?.error || error?.message || error), status: error?.importResult?.status || error?.statusCode || 400 });
    }
  }

  async function exportSnapshot(categories = []) {
    const data = {};
    if (categories.includes('api-contract')) {
      data['api-contract'] = {
        openapi: JSON.parse(await fs.readFile(path.join(sourceRoot, 'docs', 'openapi.json'), 'utf8')),
        streamContract: await fs.readFile(path.join(sourceRoot, 'docs', 'chat-stream-contract.md'), 'utf8'),
        policy: await fs.readFile(path.join(sourceRoot, 'docs', 'api-contract-policy.md'), 'utf8'),
      };
    }
    if (categories.includes('agents')) {
      const identities = await modelsStore().identities();
      const identitiesById = new Map(identities.agents.map((identity) => [identity.id, identity]));
      const agentRecords = await agentsStore().list({ includeDisabled: true });
      const profileStore = profilesStore();
      const dreamStore = dreamSettingsStore();
      let profiles;
      let dreamSettings;
      const modelSelections = Object.fromEntries(await Promise.all(agentRecords.map(async agent => [agent.id, { modelSelection: await modelsStore().modelSelection(agent.id), minionModelSelection: await modelsStore().modelSelection(agent.id, { minion: true }), archiveSummaryModelSelection: await archiveSummarySelection(agent.id) }])));
      try {
        profiles = Object.fromEntries(await Promise.all(agentRecords.map(async (agent) => [agent.id, await profileStore.list(agent.id)])));
        // Dream get() persists default settings, which a mod-owned identity must
        // never acquire just by being included in a portable export.
        dreamSettings = Object.fromEntries(await Promise.all(agentRecords.map(async (agent) => [agent.id, agent.modAgent ? null : await dreamStore.get(agent.id)])));
      } finally { await profileStore.close(); await dreamStore.close(); }
      data.agents = {
        schema: 'burrow.agents-and-profiles/v2',
        operator: identities.operator,
        records: agentRecords.map((agent) => {
          const identity = identitiesById.get(agent.id);
          return { ...agent, ...modelSelections[agent.id], ...(identity ? { identityName: identity.name, avatar: identity.avatar || '' } : {}), dreamSettings: dreamSettings[agent.id] };
        }),
        profiles,
      };
    }
    if (categories.includes('settings')) {
      data.settings = {
        schema: 'burrow.portable-settings/v1',
        timezone: await operatorTimezone(postgresApplication.stores.metadata),
        retentionPolicy: await postgresApplication.stores.retentionSettings.readPolicy(),
        workingMemoryRetention: await postgresApplication.stores.workingMemoryRetention.read(),
        brainMemory: await readDreamPromotion(metadataStore()),
        brainEmbeddings: await postgresApplication.stores.brainEmbeddings.settings().then(s => ({ enabled: s.enabled, conversationEnabled: s.conversation_enabled === true, connectionId: s.connection_id, model: s.model })),
        executionBoundaries: await readExecutionBoundaries({ metadataStore: postgresApplication.stores.metadata, }),
        curatorSelection: await readCuratorSelection({ stores: postgresApplication.stores, root: curatorRoot() }),
        ownership: [{ id: 'core-persistence', authority: 'postgres', storage: 'PostgreSQL' }],
      };
    }
    if (categories.includes('skills')) {
      const skills = await postgresApplication.stores.skills.list();
      const sourceIds = new Set((await postgresApplication.stores.skillSources.list()).map(s => s.skillId));
      const portable = skills.filter(s => s.storage === 'postgres' && s.contentOwner === 'operator' && !sourceIds.has(s.id));
      const portableIds = new Set(portable.map(s => s.id));
      data.skills = { schema: 'burrow.skills/v1', records: portable.map(({ id, name, description, content, lifecycle, global }) => ({ id, name, description, content, lifecycle, global })),
        assignments: await Promise.all((await agentsStore().list({ includeDisabled: true })).map(async agent => ({ agentId: agent.id, assignedSkillIds: (await postgresApplication.stores.skills.assignments(agent.id)).assignedSkillIds.filter(id => portableIds.has(id)) }))),
        externalDependencies: skills.filter(s => !portableIds.has(s.id)).map(({ id, storage, contentOwner, installedPath, lifecycle, global }) => ({ id, storage, contentOwner, installedPath, lifecycle, global, requiresReinstallation: true })),
        externalAssignments: await Promise.all((await agentsStore().list({ includeDisabled: true })).map(async agent => ({ agentId: agent.id, assignedSkillIds: (await postgresApplication.stores.skills.assignments(agent.id)).assignedSkillIds.filter(id => !portableIds.has(id)) }))) };
    }
    if (categories.includes('scheduled-jobs')) {
      data['scheduled-jobs'] = { schema: 'burrow.scheduled-jobs/v1', jobs: (await postgresApplication.stores.scheduledJobs.listJobs({ ownerModId: null })).map(({ id, agentId, name, prompt, cron, sessionId, modelConnectionId, model, enabled, contextMode, jobKind, taskId, extraInstructions, scheduleKind, runAt }) => ({ id, agentId, name, prompt, cron, sessionId, modelConnectionId, model, enabled, contextMode, jobKind, taskId, extraInstructions, scheduleKind, runAt })) };
    }
    if (categories.includes('model-connections')) {
      const store = modelsStore();
      data['model-connections'] = await Promise.all((await store.list()).map(async (connection) => ({ ...connection, auth: await store.auth(connection.id) })));
    }
    if (categories.includes('mcp-connections')) {
      const store = mcpStore();
      data['mcp-connections'] = {
        schema: 'burrow.mcp-connections/v3',
        connections: await Promise.all((await store.list()).filter(connection => connection.transport !== 'mod' && !connection.id.startsWith('mod.')).map(async (connection) => ({ ...connection, apiKey: await store.apiKey(connection.id), headers: await store.secretHeaders(connection.id), environmentVariables: (connection.environmentVariables || []).map(({ name }) => ({ name, configured: true })) }))),
      };
    }
    if (categories.includes('ui-auth')) {
      data['ui-auth'] = { auth: safeUiAuthSettings(await readUiAuthRecord()), oidcClientSecret: await uiAuthSecretStore().get('oidcClientSecret') };
    }
    if (categories.includes('sessions')) data.sessions = { note: 'Session content export is intentionally bounded to metadata in v1.', agents: (await agentsStore().list({ includeDisabled: true })).map((agent) => ({ id: agent.id, name: agent.name })) };
    if (categories.includes('task-board')) data['task-board'] = { projects: await withTaskBoard((store) => store.listProjects()), tasks: await withTaskBoard((store) => store.listTasks()) };
    if (categories.includes('traces')) data.traces = await runtimeMetrics();
    return data;
  }

  return { importPreview, applyImport, exportSnapshot };
}

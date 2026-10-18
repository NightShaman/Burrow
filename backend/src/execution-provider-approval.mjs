// Core-owned compatibility policy. A manifest name or system flag is not trust.
const CAPABILITY = 'execution-provider-v1';
const PROVIDER_ID = 'node-goblin';
const SOURCES = new Set(['nightshaman/node-goblin', 'goblinking-burrow/node-goblin']);

export function isOperatorModAction(req) {
  if (req?.burrowApiToken || !req?.burrowVerifiedAuth) return false;
  const auth = req.burrowVerifiedAuth;
  return (auth.enabled === true && auth.authenticated === true) || (auth.enabled === false && auth.authenticated === false);
}

export function trustedExecutionProviderSource(value) {
  if (typeof value !== 'string') return false;
  const input = value.startsWith('git@github.com:') ? `ssh://git@github.com/${value.slice('git@github.com:'.length)}` : value;
  try {
    const url = new URL(input);
    if (url.hostname.toLowerCase() !== 'github.com' || url.port || url.search || url.hash || url.password) return false;
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return false;
    if (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) return false;
    return SOURCES.has(url.pathname.replace(/^\//, '').replace(/\.git$/, '').toLowerCase());
  } catch { return false; }
}

export async function executionProviderEligibility(repository, mod, candidateInstallation = null) {
  if (mod?.id !== PROVIDER_ID || mod.status === 'failed' || mod.manifest?.system !== true || !mod.systemCapabilities?.includes(CAPABILITY)) return { eligible: false, reason: 'provider_declaration_ineligible' };
  const installation = candidateInstallation || await repository.executionProviderInstallation(mod.id);
  if (!installation || !trustedExecutionProviderSource(installation.source_url) || !/^[a-f0-9]{64}$/i.test(installation.archive_sha256 || '') || installation.version !== mod.manifest.version) return { eligible: false, reason: 'provider_installation_provenance_unverified' };
  return { eligible: true };
}

export async function approveOperatorExecutionProvider(repository, mod, { restoreRevoked = false, candidateInstallation = null } = {}) {
  if (!(await executionProviderEligibility(repository, mod, candidateInstallation)).eligible) return null;
  return repository.grantExecutionProvider(mod.id, { restoreRevoked });
}

export async function migrateLegacyExecutionProviderApproval({ repositoryFactory, mods, agents, logger = console }) {
  const repository = await repositoryFactory();
  try {
    await repository.transaction(async tx => {
      // One startup adoption pass, not an ongoing source of authority for later
      // agent-driven installation or assignment changes.
      if (!await tx.beginExecutionProviderApprovalMigration()) return;
      const mod = mods.find(entry => entry.id === PROVIDER_ID);
      const enabled = [true, 1].includes((await tx.lifecycle(PROVIDER_ID))?.enabled);
      const assigned = agents.some(agent => agent.executionEnvironment?.kind === 'remote' && agent.executionEnvironment.providerId === PROVIDER_ID);
      if (!mod || !enabled || !assigned) return;
      const eligibility = await executionProviderEligibility(tx, mod);
      if (!eligibility.eligible) {
        logger.warn?.(`Node Goblin legacy execution approval not adopted: ${eligibility.reason}`);
        return;
      }
      // INSERT-only: any existing row, including an explicit empty revocation,
      // wins. No mod-owned settings or other capability is imported.
      await tx.grantExecutionProvider(PROVIDER_ID, { restoreRevoked: false });
    });
  } finally { await repository.close(); }
}

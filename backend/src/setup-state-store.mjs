import { getSettingsMeta, setSettingsMeta } from './settings-database.mjs';

export const SETUP_STATE_KEY = 'installation_setup_state';

function setupStatus(record) {
  const installed = record?.installed === true;
  const configured = record?.configured === true;
  return {
    ok: true,
    installed,
    configured,
    wizardStep: configured ? 'ready' : (installed ? 'incomplete' : 'fresh'),
    blockers: configured ? [] : ['setup_not_completed'],
  };
}

/**
 * Installation setup is an explicit operator-owned state machine. It must not
 * be inferred from agents, identities, model connections, or runtime health.
 */
export function readSetupStatus(db) {
  return setupStatus(getSettingsMeta(db, SETUP_STATE_KEY));
}

export function completeSetup(db, { clock = () => new Date().toISOString() } = {}) {
  const prior = getSettingsMeta(db, SETUP_STATE_KEY);
  const completedAt = prior?.completedAt || clock();
  setSettingsMeta(db, SETUP_STATE_KEY, {
    version: 1,
    installed: true,
    configured: true,
    completedAt,
  }, { clock });
  return readSetupStatus(db);
}


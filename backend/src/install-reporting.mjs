import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const collector = 'https://burrow-install-counts.robert-stack.workers.dev/v1/install';
const publicVersion = /^\d{4}\.\d{2}\.\d{2}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const clientTimeoutMs = 5_000;
const retryMs = [60_000, 5 * 60_000, 30 * 60_000, 60 * 60_000];

async function readIfPresent(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

async function writeAtomic(file, text, commit) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await commit(temporary);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function installationId(file) {
  let existing = await readIfPresent(file);
  if (existing === null) {
    try { await writeAtomic(file, `${randomUUID()}\n`, temp => fs.link(temp, file)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    existing = await fs.readFile(file, 'utf8');
  }
  const id = existing.trim();
  // Do not silently issue a second identity if persistent state was damaged.
  if (id.length !== 36 || !uuid.test(id)) throw new Error('install_id_invalid');
  return id;
}

export async function reportPublicInstallation({
  runtimeRoot, version, provenance, signal, env = process.env, send = fetch, pause = delay,
}) {
  // Public promotion writes a plain UTC date to both fields. Development
  // assembly always adds a revision; loose source has no release provenance.
  if (version?.length !== 10 || !publicVersion.test(version) || provenance?.assembly !== version ||
      env.CI || env.GITHUB_ACTIONS || env.BURROW_SMOKE_TOKEN || env.BURROW_INSTALL_TEST_ROOT) return;
  const identityFile = path.join(runtimeRoot, 'install-id');
  const ackFile = path.join(runtimeRoot, 'install-id.reported');
  for (let attempt = 0; !signal?.aborted; attempt++) {
    try {
      const id = await installationId(identityFile);
      const record = `${id}\n`;
      if ((await readIfPresent(ackFile)) === record || signal?.aborted) return;
      const deadline = AbortSignal.timeout(clientTimeoutMs);
      const response = await send(collector, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ installId: id }),
        redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      await response.body?.cancel().catch(() => {});
      if (response.status === 204) {
        await writeAtomic(ackFile, record, temp => fs.rename(temp, ackFile));
        return;
      }
    } catch {
      // Egress, storage and collector failures cannot prevent Burrow startup.
    }
    if (signal?.aborted) return;
    try { await pause(retryMs[Math.min(attempt, retryMs.length - 1)], undefined, { signal, ref: false }); }
    catch { return; } // Service stopped; keep the same identity across restarts.
  }
}

import os from 'node:os';
import { promises as fs } from 'node:fs';

export const METRICS_CACHE_MS = 2_000;

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function metricError(error) {
  return String(error?.code || error?.message || error || 'unavailable').slice(0, 160);
}

export function createProcessCpuSampler({ clock = () => Date.now(), cpuUsage = process.cpuUsage } = {}) {
  let previous = null;
  return () => {
    const now = Number(clock());
    const usage = cpuUsage();
    const userMicros = finite(usage?.user);
    const systemMicros = finite(usage?.system);
    const totalMicros = userMicros === null || systemMicros === null ? null : userMicros + systemMicros;
    let percent = null;
    let sampleWindowMs = null;
    if (previous && totalMicros !== null) {
      sampleWindowMs = now - previous.at;
      const cpuDeltaMicros = totalMicros - previous.totalMicros;
      if (sampleWindowMs > 0 && cpuDeltaMicros >= 0) percent = Math.round((cpuDeltaMicros / (sampleWindowMs * 10)) * 100) / 100;
    }
    previous = { at: now, totalMicros };
    return { userMicros, systemMicros, totalMicros, percent, sampleWindowMs };
  };
}

async function filesystemMetric(root, statfs = fs.statfs) {
  try {
    const value = await statfs(root);
    const blockSize = finite(value?.bsize) ?? finite(value?.frsize) ?? 0;
    const totalBytes = blockSize * (finite(value?.blocks) ?? 0);
    const availableBytes = blockSize * (finite(value?.bavail) ?? 0);
    const freeBytes = blockSize * (finite(value?.bfree) ?? 0);
    return { totalBytes, usedBytes: Math.max(0, totalBytes - freeBytes), availableBytes, error: null };
  } catch (error) {
    return { totalBytes: null, usedBytes: null, availableBytes: null, error: metricError(error) };
  }
}

async function fileSize(filePath, stat = fs.stat) {
  try { return { bytes: finite((await stat(filePath)).size), error: null }; }
  catch (error) { return { bytes: null, error: error?.code === 'ENOENT' ? null : metricError(error) }; }
}

async function settingsMetric(databasePath, stat = fs.stat) {
  const files = await Promise.all([
    fileSize(databasePath, stat),
    fileSize(`${databasePath}-wal`, stat),
    fileSize(`${databasePath}-shm`, stat),
  ]);
  const [database, wal, shm] = files;
  const errors = files.map((item) => item.error).filter(Boolean);
  const knownBytes = files.map((item) => item.bytes).filter((value) => value !== null);
  return {
    databaseBytes: database.bytes,
    walBytes: wal.bytes,
    shmBytes: shm.bytes,
    totalBytes: knownBytes.length ? knownBytes.reduce((sum, value) => sum + value, 0) : null,
    error: errors.length ? errors.join('; ') : null,
  };
}

export function createRuntimeMetricsCollector({ runtimeRoot, settingsDatabasePath, cacheMs = METRICS_CACHE_MS, clock = () => Date.now(), memoryUsage = process.memoryUsage, uptime = () => process.uptime(), cpuSampler = createProcessCpuSampler({ clock }), loadavg = () => os.loadavg(), statfs = fs.statfs, stat = fs.stat } = {}) {
  let cached = null;
  return async function collect() {
    const now = Number(clock());
    if (cached && now - cached.at < cacheMs) return cached.value;
    const [filesystem, settingsDatabase] = await Promise.all([
      filesystemMetric(runtimeRoot, statfs),
      settingsMetric(settingsDatabasePath, stat),
    ]);
    const memory = memoryUsage() || {};
    const cpu = cpuSampler();
    const loads = loadavg() || [];
    const value = {
      ok: true,
      cache: { ageMs: 0, ttlMs: cacheMs },
      filesystem,
      process: {
        rssBytes: finite(memory.rss),
        heapUsedBytes: finite(memory.heapUsed),
        heapTotalBytes: finite(memory.heapTotal),
        externalBytes: finite(memory.external),
        uptimeSeconds: finite(uptime()),
        cpu,
      },
      load: { oneMinute: finite(loads[0]), fiveMinutes: finite(loads[1]), fifteenMinutes: finite(loads[2]) },
      settingsDatabase,
    };
    cached = { at: now, value };
    return value;
  };
}

export { filesystemMetric, settingsMetric };

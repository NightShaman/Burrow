import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { withPostgresTransaction } from './postgres-foundation.mjs';
import { publicMcpError } from './mcporter-adapter.mjs';

export const POSTGRES_MCP_PROVIDER_STATE_SCHEMA_SQL = `
CREATE TABLE mcp_provider_events (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event json NOT NULL
);
CREATE TABLE mcp_provider_legacy_imports (
 source_path text PRIMARY KEY, source_text text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now()
);`;

// One transaction lock serializes imports, live writes and bounded pruning.
export class PostgresMcpProviderStateStore {
  constructor({ pool }) { this.pool = pool; }
  async locked(work) {
    return withPostgresTransaction(this.pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(724024)");
      return work(client);
    });
  }
  async prune(client) {
    await client.query('DELETE FROM mcp_provider_events WHERE sequence NOT IN (SELECT sequence FROM mcp_provider_events ORDER BY sequence DESC LIMIT 200)');
  }
  async append(event) {
    const receipt = { ts: event.ts, providerId: event.providerId, status: event.status };
    if (event.error) receipt.error = publicMcpError(event.error);
    await this.locked(async client => {
      await client.query('INSERT INTO mcp_provider_events(event) VALUES ($1::json)', [JSON.stringify(receipt)]);
      await this.prune(client);
    });
  }
  async list() {
    const { rows } = await this.pool.query('SELECT event FROM mcp_provider_events ORDER BY sequence');
    return rows.map(row => row.event);
  }
  async migrateLegacy(runtimeRoot) {
    const source = path.resolve(runtimeRoot, 'runtime', 'mcp-provider-events.jsonl');
    return this.locked(async client => {
      if ((await client.query('SELECT 1 FROM mcp_provider_legacy_imports WHERE source_path=$1', [source])).rowCount) return 0;
      let content;
      try { content = await readFile(source, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
      // Preserve the entire source, including malformed lines and unknown JSON fields.
      await client.query('INSERT INTO mcp_provider_legacy_imports(source_path,source_text) VALUES ($1,$2)', [source, content]);
      const events = [];
      for (const line of content.split('\n')) {
        try { const event = JSON.parse(line); if (event?.providerId && event?.status && event?.ts) events.push(event); } catch {}
      }
      // Imported receipts precede live receipts even when a live writer wins the lock.
      const live = (await client.query('SELECT event FROM mcp_provider_events ORDER BY sequence')).rows.map(row => row.event);
      await client.query('DELETE FROM mcp_provider_events');
      for (const event of [...events, ...live].slice(-200)) {
        const receipt = { ts: event.ts, providerId: String(event.providerId), status: event.status };
        if (event.error) receipt.error = publicMcpError(event.error);
        await client.query('INSERT INTO mcp_provider_events(event) VALUES ($1::json)', [JSON.stringify(receipt)]);
      }
      return events.length;
    });
  }
}

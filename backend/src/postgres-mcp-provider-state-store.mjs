import { normalizePostgresPool } from './postgres-foundation.mjs';
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

// One transaction lock serializes imports, live writes and current-state updates.
export class PostgresMcpProviderStateStore {
  constructor({ pool }) { this.pool = normalizePostgresPool(pool); }
  async locked(work) {
    return withPostgresTransaction(this.pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(724024)");
      return work(client);
    });
  }
  async updateCurrent(client, event) {
    await client.query('INSERT INTO mcp_provider_current(provider_id,event) VALUES ($1,$2::json) ON CONFLICT(provider_id) DO UPDATE SET event=EXCLUDED.event', [String(event.providerId), JSON.stringify(event)]);
  }
  async current() {
    const { rows } = await this.pool.query('SELECT event FROM mcp_provider_current ORDER BY provider_id');
    return rows.map(row => row.event);
  }
  async append(event) {
    const receipt = { ...event };
    if (event.error) receipt.error = publicMcpError(event.error);
    await this.locked(async client => {
      await client.query('INSERT INTO mcp_provider_events(event) VALUES ($1::json)', [JSON.stringify(receipt)]);
      await this.updateCurrent(client, receipt);
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
      // Keep native history intact and ensure imports cannot replace live state.
      const live = (await client.query('SELECT event FROM mcp_provider_events ORDER BY sequence')).rows.map(row => row.event);
      for (const event of events) {
        const receipt = { ...event, providerId: String(event.providerId) };
        if (event.error) receipt.error = publicMcpError(event.error);
        await client.query('INSERT INTO mcp_provider_events(event) VALUES ($1::json)', [JSON.stringify(receipt)]);
        await this.updateCurrent(client, receipt);
      }
      // Existing native state wins over imported historical receipts.
      for (const event of live) await this.updateCurrent(client, event);
      return events.length;
    });
  }
}

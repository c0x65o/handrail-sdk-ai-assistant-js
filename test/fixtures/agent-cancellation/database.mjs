// Ordinary disposable host-domain fixture. All SDK DDL comes from its public API.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { migrateAgentPostgres } from 'handrail-agent-sdk/server/postgres';
export async function createPostgresHarness() {
  if (process.env.HANDRAIL_TEST_POSTGRES_DISPOSABLE !== '1') throw Error('DISPOSABLE_REQUIRED');
  const schema = `sdk_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({ connectionString: process.env.HANDRAIL_TEST_POSTGRES_URL,
    options: '-c search_path=pg_catalog', max: 5 });
  const client = { query: (sql, values) => pool.query(sql, values),
    async transaction(run) {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const result = await run(c); await c.query('COMMIT'); return result; }
      catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    } };
  return { schema, pool, table: name => { if (!/^[a-z_]+$/.test(name)) throw Error(); return `"${schema}"."${name}"`; },
    client: async () => client,
    async cleanup() {
      // This database exists only inside run-local-postgres; remove owned tables
      // together with RESTRICT so outside dependencies cannot be cascaded away.
      const tables = await pool.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=$1', [schema]);
      if (tables.rowCount) await pool.query(`DROP TABLE ${tables.rows.map(r => `"${schema}"."${r.tablename}"`).join(',')} RESTRICT`);
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" RESTRICT`); await pool.end();
    } };
}
export async function migrations(_t, harness) { await migrateAgentPostgres(harness.pool, harness.schema); }

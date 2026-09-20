import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadMigrateConfig } from './config.js';

/**
 * Applies `database/migrations/*.sql` and records them in `comms.schema_migrations`.
 *
 * Ported nearly verbatim from TPS's `apps/bff/src/migrate.ts`, deliberately: it is forty
 * lines, it already wraps each migration in its own transaction, and it already handles
 * the Windows `fileURLToPath` trap. Reimplementing it would only be a chance to lose one
 * of those.
 *
 * ITS OWN LEDGER, inside its own schema. The parent platform owns
 * `public.bf_schema_migrations` and TPS owns `tps.schema_migrations`; this writes to
 * neither. Three modules share one database and none of them may claim to have applied
 * another's files.
 *
 * NOT idempotent by luck — by construction. Every statement in `001` is IF NOT EXISTS, so
 * running this against a database that already carries the schema (one migrated by TPS
 * before this repository was extracted) adopts it and writes a ledger row, rather than
 * failing or rebuilding.
 */
const config = loadMigrateConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const migrationDirectory = new URL('../../database/migrations/', import.meta.url);

try {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${config.COMMS_SCHEMA}`);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${config.COMMS_SCHEMA}.schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );

  const files = (await readdir(migrationDirectory)).filter((f) => f.endsWith('.sql')).sort();
  let applied = 0;

  for (const file of files) {
    const seen = await pool.query(
      `SELECT 1 FROM ${config.COMMS_SCHEMA}.schema_migrations WHERE name = $1`,
      [file]
    );
    if (seen.rowCount) continue;

    // fileURLToPath, not URL.pathname — on Windows the latter yields "/C:/..." which
    // readFile rejects.
    const sql = await readFile(fileURLToPath(new URL(file, migrationDirectory)), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // SET LOCAL so it lives exactly as long as this transaction. The migration reads it
      // with current_setting(..., true) to decide whether to issue GRANTs; unset, the
      // whole block is skipped.
      if (config.COMMS_DML_ROLE) {
        await client.query(`SET LOCAL comms.dml_role = '${config.COMMS_DML_ROLE}'`);
      }
      await client.query(sql);
      await client.query(
        `INSERT INTO ${config.COMMS_SCHEMA}.schema_migrations (name) VALUES ($1)`,
        [file]
      );
      await client.query('COMMIT');
      console.log(`Applied ${file}`);
      applied += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  console.log(applied === 0 ? 'Nothing to apply; schema is current.' : `Applied ${applied} migration(s).`);
} finally {
  await pool.end();
}

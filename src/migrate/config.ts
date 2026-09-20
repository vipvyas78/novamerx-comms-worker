import { z } from 'zod';

/**
 * The migration runner's environment. Same shape and same reasoning as TPS's `config.ts`:
 * the schema name is interpolated into SQL (CREATE SCHEMA, the ledger table), so it is
 * constrained to a bare SQL identifier rather than accepting arbitrary text.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  COMMS_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, 'COMMS_SCHEMA must be a bare SQL identifier')
    .default('comms'),
  /**
   * The role that reads and writes these tables — TPS's database user. Optional, and
   * unset on a single-role deployment, where the GRANT block in the migration is skipped.
   * Constrained the same way because it reaches SQL through format(%I).
   */
  COMMS_DML_ROLE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, 'COMMS_DML_ROLE must be a bare SQL identifier')
    .optional()
});

export type MigrateConfig = z.infer<typeof schema>;

export function loadMigrateConfig(input: NodeJS.ProcessEnv = process.env): MigrateConfig {
  return schema.parse(input);
}

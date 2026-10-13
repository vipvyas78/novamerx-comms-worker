import { describe, expect, it } from 'vitest';
import { loadMigrateConfig } from '../src/migrate/config.js';

/**
 * Compose passes `COMMS_DML_ROLE: ${COMMS_DML_ROLE:-}`, so a single-role deployment hands the
 * runner an empty string, not an absent variable. Both must mean "no DML role" — the runner
 * used to refuse the empty string and restart for ever.
 */
describe('loadMigrateConfig', () => {
  const base = { DATABASE_URL: 'postgres://x' };

  it('reads an empty COMMS_DML_ROLE as unset', () => {
    expect(loadMigrateConfig({ ...base, COMMS_DML_ROLE: '' }).COMMS_DML_ROLE).toBeUndefined();
  });

  it('reads an absent COMMS_DML_ROLE as unset', () => {
    expect(loadMigrateConfig(base).COMMS_DML_ROLE).toBeUndefined();
  });

  it('keeps a valid role', () => {
    expect(loadMigrateConfig({ ...base, COMMS_DML_ROLE: 'tps' }).COMMS_DML_ROLE).toBe('tps');
  });

  it('still refuses a role that is not a bare identifier', () => {
    expect(() => loadMigrateConfig({ ...base, COMMS_DML_ROLE: 'tps; drop' })).toThrow();
  });
});

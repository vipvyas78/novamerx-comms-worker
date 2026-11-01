import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain .mjs script, untyped
import { renderWrangler } from '../scripts/render-wrangler.mjs';

const source = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const STORE = '0123456789abcdef0123456789abcdef';

describe('render-wrangler', () => {
  it('fills in the store id for every binding and keeps the comments', () => {
    const out: string = renderWrangler(source, { env: 'staging', secretsStoreId: STORE });
    expect(out).not.toContain('"SECRETS_STORE_ID"');
    expect(out.match(new RegExp(`"store_id": "${STORE}"`, 'g'))).toHaveLength(6);
    expect(out).toContain('"secret_name": "staging__INBOUND_EMAIL_SIGNING_SECRET"');
    expect(out).toContain('// Secrets, NOT vars.');
  });

  it('refuses a bad store id or environment', () => {
    expect(() => renderWrangler(source, { env: 'dev', secretsStoreId: 'x' })).toThrow(/secrets-store-id/);
    expect(() => renderWrangler(source, { env: 'qa', secretsStoreId: STORE })).toThrow(/unknown environment/);
  });
});

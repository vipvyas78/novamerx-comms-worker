#!/usr/bin/env node
/**
 * wrangler.jsonc with this account's Secrets Store id filled in, for one deploy
 * (vipvyas78/nrm-seed-generator#188).
 *
 *   node scripts/render-wrangler.mjs --env dev --secrets-store-id <id> [--out wrangler.deploy.jsonc]
 *
 * The bindings themselves are written out per environment in wrangler.jsonc, naming the
 * secret (`dev__INBOUND_EMAIL_TOKEN`) and the placeholder store id `SECRETS_STORE_ID`. This
 * replaces the placeholder as text, so the file's comments survive, and refuses to write a
 * config in which the chosen environment would still bind nothing real.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

export const PLACEHOLDER = 'SECRETS_STORE_ID';

export function renderWrangler(source, { env, secretsStoreId }) {
  if (!['dev', 'staging', 'production'].includes(env)) throw new Error(`unknown environment "${env}"`);
  if (!/^[0-9a-f]{32}$/.test(secretsStoreId ?? '')) throw new Error('--secrets-store-id must be a 32-character Secrets Store id');
  if (!source.includes(`"${PLACEHOLDER}"`)) throw new Error(`wrangler.jsonc has no "${PLACEHOLDER}" binding to fill in`);
  if (!source.includes(`"${env}__INBOUND_EMAIL_TOKEN"`) || !source.includes(`"${env}__INBOUND_EMAIL_SIGNING_SECRET"`)) {
    throw new Error(`wrangler.jsonc binds no ${env}__INBOUND_EMAIL_* secrets`);
  }
  return source.replaceAll(`"${PLACEHOLDER}"`, JSON.stringify(secretsStoreId));
}

if (process.argv[1]?.endsWith('render-wrangler.mjs')) {
  const { values } = parseArgs({
    options: {
      env: { type: 'string' },
      'secrets-store-id': { type: 'string' },
      out: { type: 'string', default: 'wrangler.deploy.jsonc' }
    }
  });
  const rendered = renderWrangler(readFileSync('wrangler.jsonc', 'utf8'), {
    env: values.env, secretsStoreId: values['secrets-store-id']
  });
  writeFileSync(values.out, rendered);
  console.log(`rendered ${values.out} for ${values.env}`);
}

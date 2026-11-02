import { describe, expect, it } from 'vitest';
import { inboundSecrets, secretValue } from '../src/worker/secrets.js';

const store = (value: string) => ({ get: async () => value });

describe('inbound secrets', () => {
  it('reads Secrets Store bindings in the cloud', async () => {
    await expect(inboundSecrets({ INBOUND_EMAIL_TOKEN: store('t'), INBOUND_EMAIL_SIGNING_SECRET: store('s') }))
      .resolves.toEqual({ token: 't', secret: 's' });
  });

  it('takes plain strings from .dev.vars under wrangler dev', async () => {
    await expect(inboundSecrets({ INBOUND_EMAIL_TOKEN: 't', INBOUND_EMAIL_SIGNING_SECRET: 's' }))
      .resolves.toEqual({ token: 't', secret: 's' });
  });

  it('names a secret that is not configured, rather than signing with undefined', async () => {
    await expect(secretValue('INBOUND_EMAIL_TOKEN', undefined)).rejects.toThrow(/INBOUND_EMAIL_TOKEN is not configured/);
  });

  it('surfaces a store read that fails', async () => {
    const failing = { get: async () => { throw new Error('secret not found'); } };
    await expect(inboundSecrets({ INBOUND_EMAIL_TOKEN: failing, INBOUND_EMAIL_SIGNING_SECRET: 's' })).rejects.toThrow(/not found/);
  });
});

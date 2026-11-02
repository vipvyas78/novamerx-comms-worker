/**
 * The two secrets this Worker shares with TPS (vipvyas78/nrm-seed-generator#188).
 *
 * In the cloud they are Cloudflare Secrets Store bindings (`<env>__INBOUND_EMAIL_TOKEN`, …),
 * read asynchronously; under `wrangler dev` they are plain strings from `.dev.vars`. Both
 * shapes are accepted, so the local stack needs no store.
 */
export type SecretSource = string | { get(): Promise<string> };

export interface InboundSecrets {
  token: string;
  secret: string;
}

export async function secretValue(name: string, source: SecretSource | undefined): Promise<string> {
  if (typeof source === 'string') return source;
  if (!source) throw new Error(`${name} is not configured (a Secrets Store binding, or .dev.vars locally)`);
  return source.get();
}

/** Read per invocation, so a rotated value is used on the next message without a redeploy. */
export async function inboundSecrets(env: {
  INBOUND_EMAIL_TOKEN?: SecretSource;
  INBOUND_EMAIL_SIGNING_SECRET?: SecretSource;
}): Promise<InboundSecrets> {
  const [token, secret] = await Promise.all([
    secretValue('INBOUND_EMAIL_TOKEN', env.INBOUND_EMAIL_TOKEN),
    secretValue('INBOUND_EMAIL_SIGNING_SECRET', env.INBOUND_EMAIL_SIGNING_SECRET)
  ]);
  return { token, secret };
}

import { defineConfig } from 'vitest/config';

/**
 * One node-pool project for everything.
 *
 * `sign.ts` is deliberately WebCrypto-only, and Node 24 exposes `crypto.subtle` globally,
 * so the signing code the Worker actually ships runs unmodified under plain vitest — no
 * workerd, no miniflare, no Cloudflare account. That is what lets CI gate on the signature
 * test vectors, which are the contract this repo exists to honour.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node'
  }
});

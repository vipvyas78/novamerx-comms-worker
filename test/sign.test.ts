import { describe, expect, it } from 'vitest';
import vectors from './vectors/inbound-signature.json' with { type: 'json' };
import { signInboundRequest, signedPayload } from '../src/worker/sign.js';

/**
 * The contract this repository exists to honour.
 *
 * These vectors were generated from TPS's OWN `signInboundRequest` — the verifier is the
 * authority, not this signer — and the identical file is asserted in the TPS test suite.
 * Neither side can drift without failing here or there, with the other repository absent.
 */
describe('signInboundRequest', () => {
  for (const testCase of vectors.cases) {
    it(`matches the canonical vector: ${testCase.name}`, async () => {
      const signature = await signInboundRequest(vectors.secret, vectors.timestamp, testCase.body);
      expect(signature).toBe(testCase.expected);
    });
  }

  it('always renders two hex characters per byte', async () => {
    // Roughly one byte in sixteen is below 0x10, so a missing padStart fails on most
    // messages and passes on a fixture that happens to have no low byte. TPS's
    // `^v1=([0-9a-f]{64})$` rejects the short form as malformed, which presents as an
    // intermittent 401 rather than as a bug in hex formatting.
    for (let i = 0; i < 64; i += 1) {
      const signature = await signInboundRequest(vectors.secret, String(1700000000 + i), `{"n":${i}}`);
      expect(signature, `iteration ${i}`).toMatch(/^v1=[0-9a-f]{64}$/);
    }
  });

  // The ascii vector's digest starts 04 — the padding case is pinned by the contract
  // itself, not only by the loop above.
  it('pins a low leading byte in the canonical vector', () => {
    expect(vectors.cases[0]!.expected.startsWith('v1=04')).toBe(true);
  });

  it('puts the timestamp INSIDE the signature, so it cannot be moved', async () => {
    const body = '{"a":1}';
    const first = await signInboundRequest(vectors.secret, '1700000000', body);
    const second = await signInboundRequest(vectors.secret, '1700000060', body);
    expect(second).not.toBe(first);
    expect(signedPayload('1700000000', body)).toBe(`1700000000.${body}`);
  });

  it('changes when the body changes by one character', async () => {
    const a = await signInboundRequest(vectors.secret, vectors.timestamp, '{"a":1}');
    const b = await signInboundRequest(vectors.secret, vectors.timestamp, '{"a":2}');
    expect(b).not.toBe(a);
  });

  it('changes when the secret changes', async () => {
    const a = await signInboundRequest(vectors.secret, vectors.timestamp, '{"a":1}');
    const b = await signInboundRequest('a-different-secret-entirely-abcdef', vectors.timestamp, '{"a":1}');
    expect(b).not.toBe(a);
  });
});

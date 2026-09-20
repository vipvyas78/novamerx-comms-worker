import { describe, expect, it } from 'vitest';
import { parseAuthenticationResults } from '../src/worker/authResults.js';

/**
 * The one rule: absent or unrecognised means null, never a verdict.
 *
 * TPS gates Client-answer attribution on `dkim === 'pass'`. Defaulting to "pass" would let
 * a forged message claim a reply token; defaulting to "fail" would silently stop filing
 * legitimate answers. Null is the truth and TPS already handles it.
 */
describe('parseAuthenticationResults', () => {
  it('reads the three verdicts out of a typical header', () => {
    expect(parseAuthenticationResults(
      'mx.cloudflare.com; dkim=pass header.d=acme.test; spf=pass smtp.mailfrom=acme.test; dmarc=pass header.from=acme.test'
    )).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
  });

  it('reports a failure as a failure', () => {
    expect(parseAuthenticationResults('mx.cloudflare.com; dkim=fail; spf=softfail; dmarc=none'))
      .toEqual({ spf: 'softfail', dkim: 'fail', dmarc: 'none' });
  });

  it('returns null for a method the header does not mention', () => {
    expect(parseAuthenticationResults('mx.cloudflare.com; spf=pass'))
      .toEqual({ spf: 'pass', dkim: null, dmarc: null });
  });

  it('returns all null for an absent or empty header, never a default', () => {
    for (const header of [null, undefined, '', '   ']) {
      expect(parseAuthenticationResults(header)).toEqual({ spf: null, dkim: null, dmarc: null });
    }
  });

  it('is not fooled by a method name appearing inside another token', () => {
    // `header.d=` and `x-dkim-ish=` must not be read as the dkim verdict.
    expect(parseAuthenticationResults('mx.cloudflare.com; spf=pass smtp.helo=dkim=nonsense.test').dkim)
      .not.toBe('nonsense');
  });

  it('is case-insensitive about the method and normalises the verdict', () => {
    expect(parseAuthenticationResults('MX; DKIM=PASS').dkim).toBe('pass');
  });

  it('tolerates whitespace around the equals sign', () => {
    expect(parseAuthenticationResults('mx; dkim = pass').dkim).toBe('pass');
  });
});

/**
 * What the receiving edge concluded about SPF, DKIM and DMARC.
 *
 * Read from the `Authentication-Results` header rather than inferred, because we did not
 * see the connection and nothing here could know. The contract says outright: "Report what
 * the receiving edge actually concluded. Do not infer, default or normalise."
 *
 * ABSENT OR UNPARSEABLE MEANS null, NEVER "pass" AND NEVER "fail". TPS gates Client-answer
 * attribution on `dkim === 'pass'`, so a default of "pass" would let a forged message claim
 * a reply token, and a default of "fail" would silently stop filing legitimate answers.
 * Null says "we do not know", which is the truth and which TPS already handles.
 *
 * UNVERIFIED AGAINST A REAL DELIVERY. The exact header text Cloudflare emits, and whether
 * several `Authentication-Results` headers can appear (an ARC chain, where only the one
 * bearing Cloudflare's own authserv-id is ours), have not been confirmed. Until they are,
 * this parser is deliberately conservative: it reads only what it recognises and returns
 * null for the rest.
 */

export interface AuthResults {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}

const EMPTY: AuthResults = { spf: null, dkim: null, dmarc: null };

/**
 * The verdicts in an `Authentication-Results` header.
 *
 * RFC 8601 gives the header as `authserv-id; resinfo *( ";" resinfo )`, and each resinfo is
 * `method "=" result` followed by properties. So the verdict is the FIRST `key=value` in
 * each semicolon-separated segment, and everything after it is detail we do not interpret.
 *
 * Parsed by splitting rather than with a regex built from a template literal — `\s` inside
 * a template literal is not an escape and silently degrades to a bare `s`, which produced a
 * matcher that looked right and matched nothing.
 */
function verdicts(header: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const segment of header.split(';')) {
    // The first '=' in the segment, not the first whitespace token: RFC 8601 permits
    // folding whitespace around it, so `dkim = pass` is legal and `dkim` alone is not a
    // pair. Taking the last word before it and the first word after it handles both.
    const equals = segment.indexOf('=');
    if (equals < 0) continue;
    const method = (segment.slice(0, equals).trim().split(/\s+/).pop() ?? '').toLowerCase();
    const result = (segment.slice(equals + 1).trim().split(/\s+/)[0] ?? '').toLowerCase();
    if (!method) continue;
    // Only the first occurrence counts: a later repeat is a second opinion we did not ask
    // for, and the leading one is the receiving edge's own.
    if (result && !found.has(method)) found.set(method, result);
  }
  return found;
}

export function parseAuthenticationResults(header: string | null | undefined): AuthResults {
  if (!header || header.trim().length === 0) return { ...EMPTY };
  const found = verdicts(header);
  return {
    spf: found.get('spf') ?? null,
    dkim: found.get('dkim') ?? null,
    dmarc: found.get('dmarc') ?? null
  };
}

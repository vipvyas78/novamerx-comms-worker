/**
 * The request signature TPS verifies on every inbound email.
 *
 * WebCrypto, not `node:crypto`. workerd does expose much of node:crypto behind the
 * `nodejs_compat` flag these days, so this is a choice rather than a necessity — but
 * `crypto.subtle` needs no compatibility flag, cannot be affected by one being removed,
 * and is available unchanged in Node 24, which is what lets the test vectors below run in
 * plain vitest with no workerd.
 *
 * THIS FUNCTION AND TPS'S `verifyInboundSignature` SHARE NO CODE AND NEVER WILL — two
 * runtimes, two repositories. What stops them drifting is `test/vectors/inbound-signature.json`:
 * fixed inputs and an absolute expected hex, asserted in BOTH repositories. A constant
 * cannot drift. If either side changes its algorithm, key handling, encoding or digest,
 * that side's own CI fails, without the other repository being present.
 */

const encoder = new TextEncoder();

export async function signInboundRequest(
  secret: string,
  timestampSeconds: string,
  rawBody: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestampSeconds}.${rawBody}`));
  return `v1=${toHex(new Uint8Array(mac))}`;
}

/**
 * Lowercase hex, TWO CHARACTERS PER BYTE.
 *
 * The padStart is the whole point. A MAC byte below 0x10 renders as one character without
 * it, giving a 63-character signature that TPS's `^v1=([0-9a-f]{64})$` rejects as
 * malformed — and since roughly 1 byte in 16 is below 0x10, a naive `toString(16)` fails
 * on the overwhelming majority of messages while passing any test whose fixture happens to
 * have no low byte. Intermittent, and invisible in a round-trip test that makes the same
 * mistake on both sides.
 */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** The `${timestamp}.${body}` string the signature covers. Exported so a test can assert
 *  that moving the timestamp changes the signature — it is inside it, not beside it. */
export function signedPayload(timestampSeconds: string, rawBody: string): string {
  return `${timestampSeconds}.${rawBody}`;
}

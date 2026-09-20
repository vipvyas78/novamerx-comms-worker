/**
 * A live check against a running TPS.
 *
 *   TPS_INBOUND_URL=… INBOUND_EMAIL_TOKEN=… INBOUND_EMAIL_SIGNING_SECRET=… pnpm conformance
 *
 * The signature vectors prove the two implementations agree about HMAC. They cannot prove
 * anything about the things either side could still get wrong in isolation: header NAMES,
 * the bearer format, the skew window, the body limits — or nginx, whose 1 MB default
 * silently capped every upload on the TPS side until it was found.
 *
 * So this signs with the REAL `sign.ts` the Worker ships, posts at a real endpoint, and
 * asserts the contract's own documented outcomes. Run it after changing either side, and
 * after any deploy that touches the proxy.
 *
 * It sends a message from a nobody@ address on purpose: TPS files an unattributable message
 * in a triage thread rather than dropping it, so a successful run leaves one harmless
 * untriaged row and touches no real tender.
 */
import { signInboundRequest } from '../src/worker/sign.js';

const url = process.env.TPS_INBOUND_URL;
const token = process.env.INBOUND_EMAIL_TOKEN;
const secret = process.env.INBOUND_EMAIL_SIGNING_SECRET;

if (!url || !token || !secret) {
  console.error('Set TPS_INBOUND_URL, INBOUND_EMAIL_TOKEN and INBOUND_EMAIL_SIGNING_SECRET.');
  process.exit(2);
}

const recipient = process.env.CONFORMANCE_RECIPIENT;
if (!recipient) {
  console.error(
    'Set CONFORMANCE_RECIPIENT to an <org>-ittcomms@ address this TPS is configured for.\n'
    + 'Without one every request correctly 422s as UNKNOWN_RECIPIENT and proves nothing.'
  );
  process.exit(2);
}

const messageId = `<conformance-${Date.now()}@novamerx.test>`;
const body = JSON.stringify({
  messageId,
  recipient,
  from: { address: 'conformance-probe@example.invalid', name: 'Conformance probe' },
  to: [recipient],
  subject: 'Conformance probe — safe to ignore',
  textBody: 'Sent by scripts/conformance.ts. Lands in a triage thread; touches no tender.',
  auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
  attachmentsTruncated: false,
  rawOmitted: false
});

async function post(options: { timestamp?: string; mangle?: boolean } = {}) {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  let signature = await signInboundRequest(secret!, timestamp, body);
  // Flip one hex digit rather than sending nonsense: a malformed header is rejected by the
  // SHAPE check, which would pass this test without the HMAC ever being compared.
  if (options.mangle) {
    const last = signature.slice(-1);
    signature = signature.slice(0, -1) + (last === '0' ? '1' : '0');
  }
  const response = await fetch(url!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-TPS-Timestamp': timestamp,
      'X-TPS-Signature': signature,
      'Idempotency-Key': messageId
    },
    body
  });
  return { status: response.status, text: (await response.text()).slice(0, 300) };
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
}

const first = await post();
check('a signed message is accepted (202)', first.status === 202, `got ${first.status} ${first.text}`);

// The same key again. A redelivery is ordinary traffic for an at-least-once Worker, so the
// contract says 200 duplicate — NOT 409, which would make a real Worker retry for ever.
const second = await post();
check('a redelivery is a 200 duplicate, not an error', second.status === 200, `got ${second.status} ${second.text}`);

const tampered = await post({ mangle: true });
check('a tampered signature is refused (401)', tampered.status === 401, `got ${tampered.status} ${tampered.text}`);

const stale = await post({ timestamp: String(Math.floor(Date.now() / 1000) - 6 * 60) });
check('a six-minute-old timestamp is refused (401)', stale.status === 401, `got ${stale.status} ${stale.text}`);

// The one nginx would fail. ~2 MB of body sails past nginx's 1 MB default and is well under
// the app's own 20 MB, so a 413 here means a proxy limit, not the application's.
const big = JSON.stringify({ ...JSON.parse(body), messageId: `${messageId}-big`, textBody: 'x'.repeat(2_000_000) });
const bigTimestamp = String(Math.floor(Date.now() / 1000));
const bigResponse = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-TPS-Timestamp': bigTimestamp,
    'X-TPS-Signature': await signInboundRequest(secret, bigTimestamp, big),
    'Idempotency-Key': `${messageId}-big`
  },
  body: big
});
check(
  'a 2MB body reaches the application (no 1MB proxy cap)',
  bigResponse.status === 202 || bigResponse.status === 200,
  `got ${bigResponse.status} — a 413 here is nginx client_max_body_size, not the app`
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);

import type { InboundPayload } from './buildPayload.js';
import { signInboundRequest } from './sign.js';
import { TRUNCATED } from './sizePolicy.js';

/**
 * Getting one message to TPS, and deciding what to do when that fails.
 *
 * `fetch` is injected so every branch — 202, 200, 413, 401, 5xx, a network throw — is
 * testable in CI with no network and no Cloudflare account.
 */

export type DeliveryOutcome =
  | { status: 'delivered'; httpStatus: number; duplicate: boolean }
  /** Retriable and exhausted: the caller spools it. */
  | { status: 'spool'; reason: string; attempts: number }
  /** Our own misconfiguration. Never retried, never bounced — the sender did nothing wrong. */
  | { status: 'alert'; httpStatus: number; body: string };

export interface DeliverOptions {
  url: string;
  token: string;
  secret: string;
  payload: InboundPayload;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
  /** Attempts on a 5xx or a network failure. Three is enough to ride out a deploy; more
   *  just holds the isolate open while Email Routing waits. */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function post(options: DeliverOptions, payload: InboundPayload, fetchImpl: typeof fetch) {
  // Serialise ONCE and sign exactly the string that is sent. Re-serialising between
  // signing and sending changes the bytes, and the signature fails for no visible reason.
  const body = JSON.stringify(payload);
  // A FRESH timestamp on every attempt. TPS refuses anything more than five minutes from
  // its own clock, and the timestamp is inside the signature — so reusing the first
  // attempt's would make every retry a 401 `stale` instead of a retry.
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signInboundRequest(options.secret, timestamp, body);

  return fetchImpl(options.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.token}`,
      'X-TPS-Timestamp': timestamp,
      'X-TPS-Signature': signature,
      'Idempotency-Key': options.idempotencyKey
    },
    body
  });
}

export async function deliver(options: DeliverOptions): Promise<DeliveryOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? 3;
  let payload = options.payload;
  let triedTruncated = false;
  let lastReason = 'unknown';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await post(options, payload, fetchImpl);
    } catch (error) {
      lastReason = error instanceof Error ? error.message : 'network error';
      if (attempt < maxAttempts) await sleep(backoffMs(attempt));
      continue;
    }

    if (response.status === 202 || response.status === 200) {
      return { status: 'delivered', httpStatus: response.status, duplicate: response.status === 200 };
    }

    // BRANCH ON THE STATUS, NEVER THE ERROR STRING. A 413 arrives with three different
    // bodies depending on whether the app's attachment cap, Fastify's own bodyLimit or
    // nginx produced it — and nginx's is HTML. See the contract, §8.
    if (response.status === 413 && !triedTruncated) {
      triedTruncated = true;
      payload = { ...payload, attachments: [], rawBase64: null, ...TRUNCATED };
      // Does not consume an attempt: this is a different request, not a retry of a
      // failed one, and it should get the same budget the original had.
      attempt -= 1;
      continue;
    }

    if (response.status >= 500) {
      lastReason = `HTTP ${response.status}`;
      if (attempt < maxAttempts) await sleep(backoffMs(attempt));
      continue;
    }

    // 401, 413-after-truncation, 422 and anything else in the 4xx range are ours to fix,
    // not the sender's. Retrying cannot help and rejecting would bounce a subcontractor's
    // query because WE are misconfigured.
    return { status: 'alert', httpStatus: response.status, body: await safeText(response) };
  }

  return { status: 'spool', reason: lastReason, attempts: maxAttempts };
}

/** Jittered, so a TPS restart does not bring every queued worker back at the same instant. */
function backoffMs(attempt: number): number {
  const base = 500 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * 250);
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

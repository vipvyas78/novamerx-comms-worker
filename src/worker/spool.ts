import type { InboundPayload } from './buildPayload.js';

/**
 * The dead-letter spool: R2, plus a cron that replays it.
 *
 * WHY NOT THE OBVIOUS ALTERNATIVES.
 *
 *  - `message.setReject()` is a PERMANENT SMTP error. It bounces. Using it because TPS is
 *    briefly down would bounce a subcontractor's tender query back at them, which is the
 *    one outcome the contract says must never happen. It is not a retry mechanism.
 *  - Throwing from `email()` is undocumented. Cloudflare does not say whether Email Routing
 *    retries, bounces or silently drops, and silent drop is a live possibility. Nothing
 *    here relies on it.
 *  - Cloudflare Queues is the textbook answer and does not fit: a queue message caps at
 *    128 KB against a payload of up to 20 MB. You would have to stage the body in R2 and
 *    queue only a key — at which point R2 is providing the durability and the queue is
 *    providing a timer, for a Workers Paid dependency. A cron trigger is that timer, free.
 *
 * So: write the payload to R2 and return normally. The message is durable and the delivery
 * is acknowledged, so nothing rides on behaviour that is not written down. If Email Routing
 * does also redeliver, the duplicate is harmless — that is what the idempotency key and the
 * `200 duplicate` response are for.
 */

/**
 * The slice of R2 this module uses.
 *
 * Declared structurally rather than taken from `@cloudflare/workers-types`, so the spool
 * compiles and tests under plain Node — `R2Bucket` is a workerd global and the test
 * tsconfig deliberately does not carry workers-types. An `R2Bucket` satisfies this by
 * shape, so `index.ts` passes `env.SPOOL` straight in.
 *
 * It also states the whole dependency in six lines: put, get, delete, list. Anything this
 * module grew beyond that would be worth noticing.
 */
export interface SpoolBucket {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number }): Promise<{ objects: Array<{ key: string }> }>;
}

export const PENDING_PREFIX = 'pending/';
export const FAILED_PREFIX = 'failed/';

/** Keyed on the idempotency key, so a redelivery that also fails overwrites its own spool
 *  entry rather than producing a second copy of the same message. */
export function spoolKey(prefix: string, idempotencyKey: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  // The key is a Message-ID or a sha256: both can carry characters that make an awkward
  // object key, so it is encoded rather than trusted.
  return `${prefix}${day}/${encodeURIComponent(idempotencyKey)}.json`;
}

export interface SpoolEntry {
  idempotencyKey: string;
  payload: InboundPayload;
  attempts: number;
  firstSpooledAt: string;
  lastReason: string;
}

export async function spool(
  bucket: SpoolBucket, prefix: string, entry: SpoolEntry, now = new Date()
): Promise<string> {
  const key = spoolKey(prefix, entry.idempotencyKey, now);
  await bucket.put(key, JSON.stringify(entry), {
    httpMetadata: { contentType: 'application/json' }
  });
  return key;
}

export async function readEntry(bucket: SpoolBucket, key: string): Promise<SpoolEntry | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    return JSON.parse(await object.text()) as SpoolEntry;
  } catch {
    return null;
  }
}

/** After this many replay passes a message stops being retried and is moved to `failed/`,
 *  where it stays for a person to look at. Unbounded retry of a message TPS will never
 *  accept is just a cron job writing logs for ever. */
export const MAX_REPLAY_ATTEMPTS = 12;

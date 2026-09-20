import PostalMime from 'postal-mime';
import { buildPayload, idempotencyKeyFor } from './buildPayload.js';
import { deliver } from './deliver.js';
import type { Env } from './env.d.ts';
import {
  FAILED_PREFIX, MAX_REPLAY_ATTEMPTS, PENDING_PREFIX, readEntry, spool, type SpoolEntry
} from './spool.js';

/**
 * The Cloudflare Email Worker for `<org>-ittcomms@` and `itt-reply@`.
 *
 * Thin on purpose. Every decision it makes lives in a pure module beside it
 * (`buildPayload`, `sizePolicy`, `authResults`, `sign`, `deliver`), which is the same split
 * TPS keeps for `ittEmail.ts` and the reason the whole thing is tested in CI with no
 * Cloudflare account.
 *
 * It does NO attribution. Which tender, which firm, which conversation — TPS decides all of
 * it, from the recipient address, the reply token and the headers. A routing opinion formed
 * here would be a second one nobody asked for and nobody could see.
 */
export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    // Buffered ONCE. The same bytes are needed twice — to parse, and to carry as the
    // archival .eml — and `message.raw` is a stream that can only be read through once.
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const parsed = await new PostalMime().parse(raw);

    const payload = buildPayload({
      parsed,
      raw,
      // The ENVELOPE recipient. This is what selects the organisation on the TPS side, and
      // it differs from the To: header whenever a message was forwarded, bcc'd or
      // plus-addressed — which is exactly the case that carries a reply token.
      envelopeRecipient: message.to,
      authenticationResults: message.headers.get('authentication-results')
    });
    const idempotencyKey = await idempotencyKeyFor(payload, raw);

    const outcome = await deliver({
      url: env.TPS_INBOUND_URL,
      token: env.INBOUND_EMAIL_TOKEN,
      secret: env.INBOUND_EMAIL_SIGNING_SECRET,
      payload,
      idempotencyKey
    });

    if (outcome.status === 'delivered') return;

    if (outcome.status === 'alert') {
      // Ours to fix, not the sender's. Never rejected: bouncing a subcontractor's query
      // because our own token or configuration is wrong would be blaming them for it.
      console.error('inbound-email refused by TPS', {
        idempotencyKey, httpStatus: outcome.httpStatus, body: outcome.body
      });
      if (env.SPOOL) {
        ctx.waitUntil(spool(env.SPOOL, FAILED_PREFIX, {
          idempotencyKey, payload, attempts: 0,
          firstSpooledAt: new Date().toISOString(),
          lastReason: `HTTP ${outcome.httpStatus}`
        }));
      }
      return;
    }

    // Retriable and exhausted. Durable if we have somewhere to put it.
    if (!env.SPOOL) {
      console.error('inbound-email undeliverable and no spool configured', {
        idempotencyKey, reason: outcome.reason
      });
      return;
    }
    await spool(env.SPOOL, PENDING_PREFIX, {
      idempotencyKey, payload, attempts: outcome.attempts,
      firstSpooledAt: new Date().toISOString(),
      lastReason: outcome.reason
    });
  },

  /**
   * Replays the spool. This is the durable half of the retry story — unbounded, observable
   * and free, where Queues would cost a paid plan to provide a timer over an R2 object it
   * would have had to stage anyway (a queue message caps at 128 KB; the payload runs to 20 MB).
   */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.SPOOL) return;
    const listing = await env.SPOOL.list({ prefix: PENDING_PREFIX, limit: 100 });

    for (const object of listing.objects) {
      const entry = await readEntry(env.SPOOL, object.key);
      if (!entry) {
        // Unparseable: move it rather than retrying it for ever.
        await env.SPOOL.delete(object.key);
        continue;
      }

      const outcome = await deliver({
        url: env.TPS_INBOUND_URL,
        token: env.INBOUND_EMAIL_TOKEN,
        secret: env.INBOUND_EMAIL_SIGNING_SECRET,
        payload: entry.payload,
        idempotencyKey: entry.idempotencyKey,
        // One attempt per pass: the cron IS the retry loop, and holding the isolate open
        // retrying inside a pass only delays every other spooled message behind it.
        maxAttempts: 1
      });

      if (outcome.status === 'delivered') {
        await env.SPOOL.delete(object.key);
        continue;
      }

      const attempts = entry.attempts + 1;
      const reason = outcome.status === 'spool' ? outcome.reason : `HTTP ${outcome.httpStatus}`;
      // A message TPS will never accept must stop being retried, or this is a cron job
      // writing logs for ever.
      const giveUp = outcome.status === 'alert' || attempts >= MAX_REPLAY_ATTEMPTS;
      const next: SpoolEntry = { ...entry, attempts, lastReason: reason };

      if (giveUp) {
        await spool(env.SPOOL, FAILED_PREFIX, next);
        await env.SPOOL.delete(object.key);
        console.error('inbound-email moved to failed/', { key: object.key, attempts, reason });
      } else {
        await env.SPOOL.put(object.key, JSON.stringify(next), {
          httpMetadata: { contentType: 'application/json' }
        });
      }
    }
  },

  /** Liveness only. The Worker exposes no HTTP surface of its own — every route it could
   *  offer would be a second way into the message store, which belongs to TPS. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'novamerx-comms-worker' });
    }
    return new Response('Not found', { status: 404 });
  }
};

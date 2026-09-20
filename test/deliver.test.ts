import { describe, expect, it, vi } from 'vitest';
import type { InboundPayload } from '../src/worker/buildPayload.js';
import { deliver } from '../src/worker/deliver.js';

const payload = {
  messageId: '<abc@acme.test>', recipient: 'novamerx-ittcomms@novamerx.ai',
  from: { address: 'sam@acme.test', name: 'Sam' }, to: [], cc: [],
  subject: 'Q', date: null, textBody: 'body', htmlBody: null,
  headers: { inReplyTo: null, references: [] },
  auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
  attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', size: 3, contentBase64: 'AAA=' }],
  attachmentsTruncated: false, rawOmitted: false, rawSize: 10, rawBase64: 'AAAA'
} satisfies InboundPayload;

const base = {
  url: 'https://tps.test/internal/email/inbound',
  token: 'a-token', secret: 'a-secret', payload, idempotencyKey: '<abc@acme.test>',
  sleep: async () => {}
};

const reply = (status: number, body = '') =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } });

describe('deliver', () => {
  it('accepts a 202 and stops', async () => {
    const fetchImpl = vi.fn(async () => reply(202, '{"status":"recorded"}'));
    const outcome = await deliver({ ...base, fetchImpl: fetchImpl as never });
    expect(outcome).toEqual({ status: 'delivered', httpStatus: 202, duplicate: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats a 200 duplicate as success, not an error', async () => {
    // An Email Worker delivers at least once by design, so a redelivery is ordinary
    // traffic. A 4xx here would make the worker retry for ever.
    const outcome = await deliver({ ...base, fetchImpl: (async () => reply(200, '{"status":"duplicate"}')) as never });
    expect(outcome).toEqual({ status: 'delivered', httpStatus: 200, duplicate: true });
  });

  it('sends the contract headers and signs the exact body', async () => {
    let seen: RequestInit | undefined;
    await deliver({
      ...base,
      fetchImpl: (async (_url: string, init: RequestInit) => { seen = init; return reply(202); }) as never
    });
    const headers = seen!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer a-token');
    expect(headers['Idempotency-Key']).toBe('<abc@acme.test>');
    expect(headers['X-TPS-Signature']).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(headers['X-TPS-Timestamp']).toMatch(/^\d+$/);
    // The body that was signed is the body that was sent — re-serialising between the two
    // changes the bytes and the signature fails for no visible reason.
    expect(JSON.parse(seen!.body as string).messageId).toBe('<abc@acme.test>');
  });

  it('re-posts ONCE without attachments on a 413, and says so', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return bodies.length === 1 ? reply(413, '{"error":"MESSAGE_TOO_LARGE"}') : reply(202);
    });
    const outcome = await deliver({ ...base, fetchImpl: fetchImpl as never });
    expect(outcome.status).toBe('delivered');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const retried = JSON.parse(bodies[1]!);
    expect(retried.attachments).toEqual([]);
    expect(retried.rawBase64).toBeNull();
    expect(retried.attachmentsTruncated).toBe(true);
    expect(retried.rawOmitted).toBe(true);
  });

  it('branches on the 413 STATUS, not the error string', async () => {
    // A 413 arrives with three different bodies depending on whether the app's attachment
    // cap, Fastify's own bodyLimit or nginx produced it — and nginx's is HTML. Keying on
    // the string would stop the truncation retry the moment the body limit fired.
    const fetchImpl = vi.fn(async () =>
      fetchImpl.mock.calls.length === 1
        ? new Response('<html>413 Request Entity Too Large</html>', { status: 413 })
        : reply(202));
    const outcome = await deliver({ ...base, fetchImpl: fetchImpl as never });
    expect(outcome.status).toBe('delivered');
  });

  it('gives up rather than looping when the truncated post is ALSO 413', async () => {
    const fetchImpl = vi.fn(async () => reply(413));
    const outcome = await deliver({ ...base, fetchImpl: fetchImpl as never });
    expect(outcome.status).toBe('alert');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx to the attempt limit, then asks to be spooled', async () => {
    const fetchImpl = vi.fn(async () => reply(503));
    const outcome = await deliver({ ...base, fetchImpl: fetchImpl as never, maxAttempts: 3 });
    expect(outcome).toEqual({ status: 'spool', reason: 'HTTP 503', attempts: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('re-signs with a FRESH timestamp on every attempt', async () => {
    // TPS refuses anything more than five minutes from its own clock and the timestamp is
    // inside the signature, so reusing the first attempt's would turn every retry into a
    // 401 `stale` — a retry loop that cannot possibly succeed.
    const signatures: string[] = [];
    let call = 0;
    await deliver({
      ...base, maxAttempts: 3,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        signatures.push((init.headers as Record<string, string>)['X-TPS-Signature']!);
        call += 1;
        return call < 3 ? reply(500) : reply(202);
      }) as never,
      // Advance the clock between attempts, as real backoff would.
      sleep: async () => { vi.setSystemTime(Date.now() + 61_000); }
    });
    vi.useRealTimers();
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it('retries a network failure, then spools', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const outcome = await deliver({ ...base, fetchImpl: fetchImpl as never, maxAttempts: 2 });
    expect(outcome).toEqual({ status: 'spool', reason: 'ECONNREFUSED', attempts: 2 });
  });

  it('never retries a 401 or a 422 — they are ours to fix, not the sender’s', async () => {
    for (const status of [401, 422]) {
      const fetchImpl = vi.fn(async () => reply(status, `{"error":"X"}`));
      const outcome = await deliver({ ...base, fetchImpl: fetchImpl as never });
      expect(outcome.status).toBe('alert');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});

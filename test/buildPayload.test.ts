import PostalMime from 'postal-mime';
import { describe, expect, it } from 'vitest';
import { buildPayload, idempotencyKeyFor, toBase64 } from '../src/worker/buildPayload.js';
import { TRUNCATED } from '../src/worker/sizePolicy.js';

const encoder = new TextEncoder();

async function payloadFor(eml: string, over: Partial<Parameters<typeof buildPayload>[0]> = {}) {
  const raw = encoder.encode(eml.replace(/\n/g, '\r\n'));
  const parsed = await new PostalMime().parse(raw);
  return buildPayload({
    parsed, raw,
    envelopeRecipient: 'novamerx-ittcomms@novamerx.ai',
    authenticationResults: 'mx.cloudflare.com; dkim=pass; spf=pass; dmarc=pass',
    ...over
  });
}

const PLAIN = `From: Sam Colleague <sam@acme.test>
To: novamerx-ittcomms@novamerx.ai
Subject: Ceiling grid query
Message-ID: <abc123@acme.test>
Date: Fri, 19 Sep 2026 08:41:00 +0000
Content-Type: text/plain; charset=utf-8

Is the suspended ceiling grid included?
`;

describe('buildPayload', () => {
  it('maps a plain message onto the contract shape', async () => {
    const payload = await payloadFor(PLAIN);
    expect(payload.messageId).toBe('<abc123@acme.test>');
    expect(payload.from).toEqual({ address: 'sam@acme.test', name: 'Sam Colleague' });
    expect(payload.subject).toBe('Ceiling grid query');
    expect(payload.textBody).toContain('suspended ceiling grid');
    expect(payload.auth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
  });

  it('uses the ENVELOPE recipient, not the To: header', async () => {
    // They differ whenever a message was forwarded, bcc'd or plus-addressed — which is
    // exactly the case that carries a Client reply token. Taking the header would lose it.
    const payload = await payloadFor(PLAIN, {
      envelopeRecipient: 'itt-reply+Zm9vYmFyX3Rva2VuLTEyMzQ1Njc4OTA@novamerx.co.uk'
    });
    expect(payload.recipient).toContain('itt-reply+');
    expect(payload.to).toEqual(['novamerx-ittcomms@novamerx.ai']);
  });

  it('reports a missing Message-ID as null rather than inventing one', async () => {
    const payload = await payloadFor(PLAIN.replace(/Message-ID:.*\n/, ''));
    expect(payload.messageId).toBeNull();
  });

  it('survives a message with no text part', async () => {
    const htmlOnly = `From: sam@acme.test
To: novamerx-ittcomms@novamerx.ai
Subject: HTML only
Content-Type: text/html; charset=utf-8

<p>Is the grid included?</p>
`;
    const payload = await payloadFor(htmlOnly);
    expect(payload.htmlBody).toContain('grid');
    expect(payload.subject).toBe('HTML only');
  });

  it('keeps a reply marker in the subject intact', async () => {
    // TPS finds the Client's conversation by this marker when plus-addressing has not
    // survived the sender's mail system. Mangling the subject loses the second of three
    // attribution routes.
    const payload = await payloadFor(
      PLAIN.replace('Subject: Ceiling grid query', 'Subject: Re: FW: query [TPS-Zm9vYmFyX3Rva2VuLTEyMzQ1Njc4OTA]')
    );
    expect(payload.subject).toContain('[TPS-Zm9vYmFyX3Rva2VuLTEyMzQ1Njc4OTA]');
  });

  it('splits References on whitespace and keeps In-Reply-To', async () => {
    const threaded = PLAIN.replace(
      'Date:',
      'In-Reply-To: <b@novamerx.ai>\nReferences: <a@novamerx.ai> <b@novamerx.ai>\nDate:'
    );
    const payload = await payloadFor(threaded);
    expect(payload.headers.inReplyTo).toBe('<b@novamerx.ai>');
    expect(payload.headers.references).toEqual(['<a@novamerx.ai>', '<b@novamerx.ai>']);
  });

  it('carries an attachment as base64 of its real bytes', async () => {
    const withFile = `From: sam@acme.test
To: novamerx-ittcomms@novamerx.ai
Subject: With a sketch
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: text/plain

See attached.
--b1
Content-Type: application/pdf
Content-Disposition: attachment; filename="sketch.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQgcHJldGVuZA==
--b1--
`;
    const payload = await payloadFor(withFile);
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0]!.filename).toBe('sketch.pdf');
    expect(Buffer.from(payload.attachments[0]!.contentBase64, 'base64').toString())
      .toBe('%PDF-1.4 pretend');
  });

  it('reports the true size even when the bytes do not travel', async () => {
    // rawSize is what arrived; rawBase64 is whether we could carry it. Conflating them
    // would make a truncated message look like a small one.
    const payload = await payloadFor(PLAIN, { decision: TRUNCATED });
    expect(payload.rawBase64).toBeNull();
    expect(payload.rawOmitted).toBe(true);
    expect(payload.attachmentsTruncated).toBe(true);
    expect(payload.rawSize).toBeGreaterThan(0);
  });

  it('never reports an auth verdict it was not told', async () => {
    const payload = await payloadFor(PLAIN, { authenticationResults: null });
    expect(payload.auth).toEqual({ spf: null, dkim: null, dmarc: null });
  });
});

describe('toBase64', () => {
  it('round-trips bytes', () => {
    const bytes = encoder.encode('naïve café ✓');
    expect(Buffer.from(toBase64(bytes), 'base64').toString('utf8')).toBe('naïve café ✓');
  });

  it('handles a payload far past the argument-spread limit', () => {
    // `String.fromCharCode(...bytes)` on a multi-megabyte array blows the call stack long
    // before it blows the memory limit, and the RangeError points nowhere useful.
    const big = new Uint8Array(300_000).fill(65);
    expect(Buffer.from(toBase64(big), 'base64').byteLength).toBe(300_000);
  });
});

describe('idempotencyKeyFor', () => {
  it('prefers the Message-ID', async () => {
    const raw = encoder.encode(PLAIN);
    const payload = await payloadFor(PLAIN);
    expect(await idempotencyKeyFor(payload, raw)).toBe('<abc123@acme.test>');
  });

  it('falls back to a STABLE hash when there is none', async () => {
    // Anything random here would defeat the point: an at-least-once delivery would file
    // every message twice.
    const eml = PLAIN.replace(/Message-ID:.*\n/, '');
    const raw = encoder.encode(eml);
    const payload = await payloadFor(eml);
    const first = await idempotencyKeyFor(payload, raw);
    const second = await idempotencyKeyFor(payload, raw);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });
});

import type { Email } from 'postal-mime';
import { parseAuthenticationResults } from './authResults.js';
import { sizePolicy, type SizeDecision } from './sizePolicy.js';

/**
 * A parsed message turned into the JSON shape TPS_INBOUND_EMAIL_API.md §5 describes.
 *
 * Pure: it takes an already-parsed message and the already-buffered raw bytes, and returns
 * an object. No network, no bindings, no Cloudflare types — which is what lets every branch
 * be tested in CI with nothing but node.
 *
 * THE WORKER DOES NO ATTRIBUTION. It does not decide which tender, firm or conversation
 * this belongs to; TPS does, from the recipient address, the reply token and the headers.
 * Anything here that looked like a routing decision would be a second opinion nobody asked
 * for and nobody could see.
 */

export interface InboundPayload {
  messageId: string | null;
  recipient: string;
  from: { address: string; name: string | null };
  to: string[];
  cc: string[];
  subject: string | null;
  date: string | null;
  textBody: string | null;
  htmlBody: string | null;
  headers: { inReplyTo: string | null; references: string[] };
  auth: { spf: string | null; dkim: string | null; dmarc: string | null };
  attachments: Array<{ filename: string; contentType: string | null; size: number; contentBase64: string }>;
  attachmentsTruncated: boolean;
  rawOmitted: boolean;
  rawSize: number;
  rawBase64: string | null;
}

/**
 * base64 for the Worker runtime.
 *
 * Chunked rather than `String.fromCharCode(...bytes)` in one call: spreading a multi-megabyte
 * Uint8Array into arguments blows the call stack long before it blows the memory limit, and
 * the failure is a RangeError from somewhere that looks nothing like the cause.
 */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** `References: <a> <b>` is whitespace-separated, and postal-mime hands it over raw. */
function splitReferences(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(/\s+/).map((id) => id.trim()).filter(Boolean);
}

export function buildPayload(input: {
  parsed: Email;
  raw: Uint8Array<ArrayBuffer>;
  /** The ENVELOPE recipient (`message.to`), not the To: header. This is what selects the
   *  organisation on the TPS side, and the two differ whenever a message was forwarded,
   *  bcc'd or plus-addressed. */
  envelopeRecipient: string;
  authenticationResults: string | null;
  decision?: SizeDecision;
}): InboundPayload {
  const { parsed, raw, envelopeRecipient } = input;
  const decision = input.decision ?? sizePolicy(raw.byteLength);

  const attachments = decision.includeAttachments
    ? (parsed.attachments ?? []).map((attachment) => {
        const bytes = attachment.content instanceof ArrayBuffer
          ? new Uint8Array(attachment.content)
          : new TextEncoder().encode(String(attachment.content ?? ''));
        return {
          // A part with no filename still has to be stored under something; TPS builds the
          // object key from an id it mints, never from this, so a placeholder is safe.
          filename: attachment.filename ?? 'attachment',
          contentType: attachment.mimeType ?? null,
          size: bytes.byteLength,
          contentBase64: toBase64(bytes)
        };
      })
    : [];

  return {
    messageId: parsed.messageId ?? null,
    recipient: envelopeRecipient,
    from: { address: parsed.from?.address ?? '', name: parsed.from?.name || null },
    to: (parsed.to ?? []).map((a) => a.address ?? '').filter(Boolean),
    cc: (parsed.cc ?? []).map((a) => a.address ?? '').filter(Boolean),
    subject: parsed.subject ?? null,
    date: parsed.date ?? null,
    textBody: parsed.text ?? null,
    htmlBody: parsed.html ?? null,
    headers: {
      inReplyTo: parsed.inReplyTo ?? null,
      references: splitReferences(parsed.references)
    },
    // Reported, never inferred. Absent means null, which TPS reads as "unverified".
    auth: parseAuthenticationResults(input.authenticationResults),
    attachments,
    attachmentsTruncated: decision.attachmentsTruncated,
    rawOmitted: decision.rawOmitted,
    // The true size of what arrived, whether or not the bytes travel with it.
    rawSize: raw.byteLength,
    rawBase64: decision.includeRaw ? toBase64(raw) : null
  };
}

/**
 * The idempotency key for a message.
 *
 * Mirrors TPS's own fallback order so the two agree on what "the same message" means. The
 * Message-ID when there is one; nothing random, ever, or an at-least-once delivery files
 * every message twice.
 */
export async function idempotencyKeyFor(
  payload: InboundPayload,
  // Narrower than plain Uint8Array: crypto.subtle.digest takes a BufferSource, which does
  // not admit a view that could be backed by a SharedArrayBuffer. Narrowing here beats a
  // cast at the call site.
  raw: Uint8Array<ArrayBuffer>
): Promise<string> {
  if (payload.messageId?.trim()) return payload.messageId.trim().slice(0, 400);
  const digest = await crypto.subtle.digest("SHA-256", raw);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

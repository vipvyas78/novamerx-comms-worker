/**
 * How much of a message to put in the payload, decided BEFORE building it.
 *
 * A Worker isolate has a 128 MB memory limit, and the payload can carry the raw `.eml` as
 * base64 AND every attachment as base64 — on top of the original bytes and whatever
 * `JSON.stringify` allocates for the output string. A 15 MB email is plausibly 75-95 MB
 * live, and an OOM in workerd is an abrupt isolate termination, not a catchable error.
 *
 * So the ladder is a decision taken up front, not a reaction to a 413. The 413 branch in
 * `deliver.ts` remains as a backstop and should fire approximately never.
 *
 * The thresholds are measured on the DECODED message, which is the figure a person would
 * recognise; base64 inflation is accounted for in the limits themselves. Validate against
 * a real 12 MB .eml in `wrangler dev` before trusting the arithmetic — 128 MB is
 * documented, the multiplier is an estimate.
 */

export const RAW_INCLUDE_LIMIT = 3 * 1024 * 1024;
export const ATTACHMENT_INCLUDE_LIMIT = 8 * 1024 * 1024;

export interface SizeDecision {
  includeAttachments: boolean;
  includeRaw: boolean;
  /** Set on the payload so TPS can mark the message rather than silently having no files. */
  attachmentsTruncated: boolean;
  /** Set on the payload so TPS can mark the message rather than silently having no .eml. */
  rawOmitted: boolean;
}

export function sizePolicy(decodedBytes: number): SizeDecision {
  if (decodedBytes <= RAW_INCLUDE_LIMIT) {
    return { includeAttachments: true, includeRaw: true, attachmentsTruncated: false, rawOmitted: false };
  }
  if (decodedBytes <= ATTACHMENT_INCLUDE_LIMIT) {
    // The attachments are the point of the message — a drawing attached to a query is the
    // query. The archival .eml is a convenience, so it is what goes first.
    return { includeAttachments: true, includeRaw: false, attachmentsTruncated: false, rawOmitted: true };
  }
  return { includeAttachments: false, includeRaw: false, attachmentsTruncated: true, rawOmitted: true };
}

/** What to fall back to if TPS returns 413 anyway. Carries neither, and says so. */
export const TRUNCATED: SizeDecision = {
  includeAttachments: false, includeRaw: false, attachmentsTruncated: true, rawOmitted: true
};

import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_INCLUDE_LIMIT, RAW_INCLUDE_LIMIT, TRUNCATED, sizePolicy
} from '../src/worker/sizePolicy.js';

/**
 * The ladder exists to stop the Worker building a payload it cannot hold. A 128 MB isolate
 * against a 15 MB message carrying raw + attachments + the original bytes + the stringified
 * output is an OOM, and an OOM in workerd is an abrupt termination, not a catchable error.
 */
describe('sizePolicy', () => {
  it('carries everything for a small message', () => {
    expect(sizePolicy(500 * 1024)).toEqual({
      includeAttachments: true, includeRaw: true, attachmentsTruncated: false, rawOmitted: false
    });
  });

  it('drops the archival copy BEFORE the attachments', () => {
    // The attachments are the point of the message — a drawing attached to a query is the
    // query. The .eml is a convenience, so it goes first.
    const mid = sizePolicy(RAW_INCLUDE_LIMIT + 1);
    expect(mid.includeAttachments).toBe(true);
    expect(mid.includeRaw).toBe(false);
    expect(mid.rawOmitted).toBe(true);
    expect(mid.attachmentsTruncated).toBe(false);
  });

  it('drops both past the upper limit, and says so on both counts', () => {
    const big = sizePolicy(ATTACHMENT_INCLUDE_LIMIT + 1);
    expect(big).toEqual(TRUNCATED);
    // Both flags, because TPS marks the message differently for each and "no attachments"
    // is a different fact from "no archival copy".
    expect(big.attachmentsTruncated).toBe(true);
    expect(big.rawOmitted).toBe(true);
  });

  it('treats each boundary as inclusive of the smaller tier', () => {
    expect(sizePolicy(RAW_INCLUDE_LIMIT).includeRaw).toBe(true);
    expect(sizePolicy(ATTACHMENT_INCLUDE_LIMIT).includeAttachments).toBe(true);
  });

  it('never claims to carry something it has dropped', () => {
    for (const size of [0, 1, RAW_INCLUDE_LIMIT, RAW_INCLUDE_LIMIT + 1, ATTACHMENT_INCLUDE_LIMIT, 50e6]) {
      const decision = sizePolicy(size);
      expect(decision.includeRaw, `${size}`).toBe(!decision.rawOmitted);
      expect(decision.includeAttachments, `${size}`).toBe(!decision.attachmentsTruncated);
    }
  });
});

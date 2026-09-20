import { describe, expect, it } from 'vitest';
import type { InboundPayload } from '../src/worker/buildPayload.js';
import {
  FAILED_PREFIX, PENDING_PREFIX, readEntry, spool, spoolKey, type SpoolBucket, type SpoolEntry
} from '../src/worker/spool.js';

/** An in-memory R2. It satisfies SpoolBucket by shape, which is the point of declaring
 *  that interface structurally rather than importing a workerd global. */
function fakeBucket() {
  const store = new Map<string, string>();
  const bucket: SpoolBucket = {
    async put(key, value) { store.set(key, value); return undefined; },
    async get(key) {
      const value = store.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    async delete(key) { store.delete(key); },
    async list(options) {
      const prefix = options?.prefix ?? '';
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    }
  };
  return { bucket, store };
}

const payload = { messageId: '<a@b.test>', subject: 'Q' } as unknown as InboundPayload;
const entry: SpoolEntry = {
  idempotencyKey: '<a@b.test>', payload, attempts: 3,
  firstSpooledAt: '2026-09-19T10:00:00.000Z', lastReason: 'HTTP 503'
};

describe('spoolKey', () => {
  it('encodes the idempotency key, which is a Message-ID and not key-safe', () => {
    const key = spoolKey(PENDING_PREFIX, '<CAF=abc/123@mail.gmail.com>', new Date('2026-09-19T00:00:00Z'));
    expect(key).toBe('pending/2026-09-19/%3CCAF%3Dabc%2F123%40mail.gmail.com%3E.json');
    // A raw Message-ID carries '/' and would silently create a nested pseudo-directory,
    // so a replay listing `pending/<date>/` would never find it again.
    expect(key.split('/')).toHaveLength(3);
  });

  it('is STABLE for one message, so a redelivery that also fails does not duplicate it', () => {
    const now = new Date('2026-09-19T00:00:00Z');
    expect(spoolKey(PENDING_PREFIX, '<a@b.test>', now)).toBe(spoolKey(PENDING_PREFIX, '<a@b.test>', now));
  });

  it('separates pending from failed', () => {
    const now = new Date('2026-09-19T00:00:00Z');
    expect(spoolKey(FAILED_PREFIX, '<a@b.test>', now)).not.toBe(spoolKey(PENDING_PREFIX, '<a@b.test>', now));
  });
});

describe('spool and readEntry', () => {
  it('round-trips an entry', async () => {
    const { bucket } = fakeBucket();
    const key = await spool(bucket, PENDING_PREFIX, entry);
    const loaded = await readEntry(bucket, key);
    expect(loaded).toEqual(entry);
  });

  it('returns null for a key that is not there', async () => {
    const { bucket } = fakeBucket();
    expect(await readEntry(bucket, 'pending/nope.json')).toBeNull();
  });

  it('returns null rather than throwing on a corrupt entry', async () => {
    // A replay pass must be able to move past an unparseable object; throwing would stop
    // every other spooled message behind it.
    const { bucket, store } = fakeBucket();
    store.set('pending/2026-09-19/bad.json', 'not json');
    expect(await readEntry(bucket, 'pending/2026-09-19/bad.json')).toBeNull();
  });

  it('overwrites its own entry rather than accumulating copies', async () => {
    const { bucket, store } = fakeBucket();
    const now = new Date('2026-09-19T00:00:00Z');
    await spool(bucket, PENDING_PREFIX, entry, now);
    await spool(bucket, PENDING_PREFIX, { ...entry, attempts: 4 }, now);
    expect(store.size).toBe(1);
    const loaded = await readEntry(bucket, spoolKey(PENDING_PREFIX, entry.idempotencyKey, now));
    expect(loaded?.attempts).toBe(4);
  });

  it('lists only the prefix asked for', async () => {
    const { bucket } = fakeBucket();
    await spool(bucket, PENDING_PREFIX, entry);
    await spool(bucket, FAILED_PREFIX, { ...entry, idempotencyKey: '<c@d.test>' });
    expect((await bucket.list({ prefix: PENDING_PREFIX })).objects).toHaveLength(1);
    expect((await bucket.list({ prefix: FAILED_PREFIX })).objects).toHaveLength(1);
  });
});

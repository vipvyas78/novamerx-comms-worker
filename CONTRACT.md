# The inbound contract

**`TPS_INBOUND_EMAIL_API.md` in the TPS repository is authoritative.** The endpoint belongs
to TPS; this file records what this repository has to honour and where it is enforced.

## Where each rule is enforced here

| contract rule | enforced by |
|---|---|
| bearer **and** HMAC signature over `${timestamp}.${body}` | `src/worker/sign.ts`, `src/worker/deliver.ts` |
| the timestamp is inside the signature | `test/sign.test.ts` |
| sign the exact string that is sent — serialise once | `deliver.ts` (`post` builds `body` once) |
| a fresh timestamp on every attempt | `test/deliver.test.ts` |
| `Idempotency-Key` from the Message-ID, else a stable hash | `buildPayload.ts`, `test/buildPayload.test.ts` |
| the **envelope** recipient selects the organisation | `index.ts` passes `message.to`, asserted in `test/buildPayload.test.ts` |
| `auth` reported honestly, never inferred | `authResults.ts` — unrecognised is `null` |
| 413 → one truncated re-post | `deliver.ts`, `test/deliver.test.ts` |
| **branch on the 413 status, never the error string** | `test/deliver.test.ts` (an HTML 413 from nginx must still trigger it) |
| 5xx retried, then spooled | `deliver.ts`, `spool.ts` |
| 401/422 never retried, never rejected | `deliver.ts`, `index.ts` |

## The signature vectors

`test/vectors/inbound-signature.json` is **canonical**. A byte-identical copy lives at
`apps/bff/src/fixtures/inbound-signature-vectors.json` in the TPS repository, and both test
suites iterate it.

They were generated from **TPS's own** `signInboundRequest` — the verifier is the authority,
not this signer.

An absolute expected hex cannot drift. If either side changes its algorithm, key handling,
encoding or digest, that side's own CI fails without the other repository being present.

Two cases:

- **ascii** — also pins hex padding: its digest begins `04`, a byte below `0x10`, so a naive
  `toString(16)` without `padStart` produces a 63-character signature that TPS's
  `^v1=([0-9a-f]{64})$` rejects as malformed.
- **non-ascii** — pins UTF-8 on both sides. `TextEncoder` is UTF-8 and so is node's default
  string encoding, but nothing else proves they agree, and a UK construction subject line
  reaches `—` and `£` on day one.

## Changing the contract

It is a contract, so both sides move together:

1. change `TPS_INBOUND_EMAIL_API.md` in the TPS repository first — it is the statement of
   record;
2. change the TPS side (schema, route, tests);
3. change this repository;
4. if the signature itself changed, **regenerate the vectors from TPS** and copy the file
   into both repositories;
5. run `pnpm conformance` against a deployed TPS. Vectors cannot catch header names, bearer
   format, the skew window, body limits or nginx — that script can.

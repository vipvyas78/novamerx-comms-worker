# novamerx-comms-worker

Two things live here, and they never talk to each other:

| | |
|---|---|
| **the Cloudflare Email Worker** | receives mail for `<org>-ittcomms@` and `itt-reply@`, parses it, and POSTs it to BuildFlow TPS |
| **the `comms` schema** | the DDL for the tender communications store — threads, messages, attachments, forwards, notifications |

Added for BuildFlow issue #34 (subcontractor Request for Information).

## The ownership rule, which is unusual and worth reading

**This repository owns the DDL. Nothing in it ever reads or writes those tables.**

The Worker runs at Cloudflare's edge and holds no connection string. Every `SELECT`,
`INSERT` and `UPDATE` against `comms` lives in the **TPS** repository, in
`apps/bff/src/commsDb.ts` — the single file there permitted to name a `comms.` table.

That split is lopsided and it has one sharp consequence:

> **A breaking change made here is invisible here.** No test, type or query in this
> repository can notice that a column was renamed.

So the rule is absolute:

### ADDITIVE CHANGES ONLY

No rename, no drop, no type narrowing, ever, in a single migration. Anything else is
two-phase — add the new column here, merge the TPS change that uses it, and only then drop
the old one in a later migration.

Three things defend the consumer, and all three are in the TPS repository, because that is
where a break actually shows up:

1. `commsDb.ts` declares `REQUIRED_COMMS_MIGRATION` and TPS's `server.ts` **refuses to
   start** against a database behind it — so "schema absent" and "schema behind" fail
   identically, at boot, instead of as `column "x" does not exist` on a Friday afternoon.
2. `comms-schema.integration.test.ts` asserts the exact column and index shape.
3. `commsBoundary.test.ts` asserts `commsDb.ts` is still the only file naming a `comms.`
   table, so the blast radius of a schema change stays one file.

## Start order

**parent → comms → tps.**

`bff-tps` reads `comms.*` at runtime. A Docker `depends_on` cannot reach a service in
another compose project — the parent owns Postgres and TPS's own compose file already says
so — which is why ordering is guaranteed by TPS's boot assertion and `restart: on-failure`
rather than by any compose file. Getting it wrong costs a restart loop and a log line
naming this repository, not a corrupt state.

```bash
# 1. the parent platform (owns postgres, redis, minio)
cd ../nrm-seed-generator && docker compose up -d

# 2. this repository's migration
pnpm migrate            # or: docker compose -f infra/docker/docker-compose.yml up

# 3. TPS
cd ../nrm-seed-generator_TPS && docker compose -f infra/docker/docker-compose.yml up -d
```

## The Worker

```
Email Routing  ->  email()  ->  parse  ->  build payload  ->  sign  ->  POST to TPS
                                                                         |
                                                        5xx / network ---+
                                                                         v
                                                            R2 spool  ->  cron replay
```

Logic lives in pure functions and the handler stays thin (`buildPayload`, `sizePolicy`,
`authResults`, `sign`, `deliver`), which is why every branch is tested in CI with **no
Cloudflare account and no database**.

**It does no attribution.** Which tender, which firm, which conversation — TPS decides all
of it, from the recipient address, the reply token and the headers. A routing opinion
formed here would be a second one nobody asked for and nobody could see.

### Why the retry works the way it does

Three facts, checked against Cloudflare's docs rather than assumed:

- **`message.setReject()` is a permanent SMTP error.** It bounces. Using it because TPS is
  briefly down would bounce a subcontractor's tender query back at them — the one outcome
  the contract says must never happen. It is not a retry mechanism.
- **Cloudflare's documented durable pattern is `email()` to a Queue to a `queue()`
  consumer**, and **a queue message caps at 128 KB** against a payload of up to 20 MB. A
  queue could only ever carry a pointer to an R2 object we had already written: a paid
  dependency providing a timer. The cron trigger is that timer, free.
- **What Cloudflare does when `email()` throws is not documented.** Silent drop is a live
  possibility. Nothing here relies on it — every path ends in an explicit accept or spool.

So: three attempts on 5xx or a network failure, **re-signed with a fresh timestamp each
time** (TPS refuses anything more than five minutes off and the timestamp is inside the
signature, so reusing one would make every retry a 401 `stale`). On exhaustion the payload
goes to `pending/` in R2 and the handler returns normally. A cron replays it every five
minutes, deletes on success, and gives up into `failed/` after twelve passes.

`401` and `422` never retry and never reject: they are our own misconfiguration, not the
sender's problem.

### Without an R2 binding

Everything still works except durability: a message TPS cannot accept after three attempts
is **logged and lost**. That is a deliberate, stated degradation rather than a silent one —
but do not run production without the binding.

### The size ladder

A Worker isolate has a 128 MB limit, and a large message carrying base64 attachments *and*
a base64 raw copy *and* the original bytes *and* the stringified output can approach it. An
OOM in workerd is an abrupt termination, not a catchable error, so the payload is never
built at that size:

| decoded message | carries |
|---|---|
| up to 3 MB | attachments + raw `.eml` |
| 3–8 MB | attachments only (`rawOmitted`) |
| over 8 MB | neither (`attachmentsTruncated`) |

TPS marks the message either way, so a query whose drawing did not fit is still visibly a
query somebody has to answer.

## Contract

`TPS_INBOUND_EMAIL_API.md` in the **TPS** repository is authoritative — the endpoint is
theirs. `CONTRACT.md` here is a pointer plus the parts this repository has to honour.

### The signature, and how the two implementations are kept honest

The Worker signs with WebCrypto; TPS verifies with `node:crypto`. They share no code and
never will — two runtimes, two repositories.

`test/vectors/inbound-signature.json` holds fixed inputs and an **absolute expected hex**,
and the identical file is asserted in the TPS test suite. A constant cannot drift: change
the algorithm, key handling, encoding or digest on either side and *that side's own CI
fails*, with the other repository absent. One vector is non-ASCII, which pins UTF-8 on both
sides — a UK construction subject line reaches an em dash and a pound sign on day one.

`scripts/conformance.ts` catches what vectors cannot: header names, bearer format, the skew
window, body limits and nginx. Run it against a deployed TPS after changing either side.

## Commands

```bash
pnpm install
pnpm typecheck          # both tsconfigs: the Worker has no node types, the runner has no workerd
pnpm test               # no network, no database, no Cloudflare
pnpm deploy:dry         # bundles the Worker — the real guard against a `node:` import
pnpm migrate            # applies database/migrations against DATABASE_URL
pnpm dev                # wrangler dev
pnpm conformance        # live check against a running TPS
```

## Deployment, which is not done by this repository

1. `wrangler secret put INBOUND_EMAIL_TOKEN` and `INBOUND_EMAIL_SIGNING_SECRET` — both must
   match the TPS deployment exactly.
2. `wrangler r2 bucket create novamerx-comms-spool`.
3. `wrangler deploy`.
4. **Email Routing rules**, one per `<org>-ittcomms@novamerx.ai` address plus one for
   `itt-reply@novamerx.co.uk`, each targeting this Worker. Nothing in this repository
   creates them, and until they exist no mail reaches the Worker at all.
5. Verify `Authentication-Results` on the first real delivery — see the caveat below.

### Rotating the secrets

TPS accepts exactly one signing secret, so rotation is not atomic: there is a window where
in-flight messages 401. The R2 spool means that window **self-heals** — the messages land
in `pending/` and the cron replays them once both sides agree. Rotate TPS first, then the
Worker, and expect one replay cycle.

## Known and unverified

- **`Authentication-Results` has not been verified against a real Cloudflare delivery.** The
  exact header text, and whether several can appear (an ARC chain, where only the one
  bearing Cloudflare's own authserv-id is ours), are unconfirmed. `authResults.ts` is
  deliberately conservative and reports `null` for anything it does not recognise — never a
  default — because TPS gates Client-answer attribution on `dkim === 'pass'`.
- **The size ladder's thresholds are estimates.** 128 MB is documented; the multiplier is
  not. Validate with a real 12 MB `.eml` under `wrangler dev`.
- **Plus-addressing may not survive every mail system.** Already mitigated by two fallback
  attribution routes on the TPS side, but worth confirming on the first real Client reply.
- Migration `022` is retired in TPS and its ledger row there is left in place: it is a true
  record that the migration was once applied to that database. TPS's next migration is `023`.
- Wrangler is pinned at v3; v4 is available. Upgrade deliberately, with a `deploy:dry` check.

## Why this is one flat package and not a pnpm workspace

The other repositories in this suite are workspaces because they ship two deployable
artifacts with disjoint dependency trees. Here the second "package" would be a ~70-line
migration runner. The genuine conflict — the Worker needs `@cloudflare/workers-types`, the
runner needs `types: ["node"]` — is solved by **two tsconfigs**, and the real guard against
a `node:` import reaching the edge is `pnpm deploy:dry`, not a package boundary.

**Revisit when a second Worker appears** (outbound mail, bounce handling). That is the
trigger; it is written down here so nobody has to relitigate it.

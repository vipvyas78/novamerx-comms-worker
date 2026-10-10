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
# 1. the shared infrastructure (owns postgres, redis, minio and the buildflow network)
cd ../novamerx-infra && make infra-up

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

## Deployment

Since nrm-seed-generator#145 this repository deploys itself, one script per environment
(`env` blocks in `wrangler.jsonc`):

| environment | script | how |
|---|---|---|
| dev | `novamerx-comms-worker-dev` | **Deploy** workflow, any branch (or the parent's "Deploy all to dev") |
| staging | `novamerx-comms-worker-staging` | every merge to `main`, **off until `STAGING_ENABLED=true`** |
| production | `novamerx-comms-worker` (unchanged) | **Deploy** workflow from a tag, behind a reviewer |

The workflow migrates the `comms` schema, deploys, then sets the two inbound-email secrets
from the GitHub Environment. [novamerx-infra](https://github.com/vipvyas78/novamerx-infra)'s
`scripts/sync-env-secrets.sh` writes the same values to TPS, so the pair always matches. The
spool buckets come from novamerx-infra's Terraform. What is still manual, per environment:

1. **Email Routing rules**, one per `<org>-ittcomms@novamerx.ai` address plus one for
   `itt-reply@novamerx.co.uk`, each targeting this Worker. Nothing in this repository
   creates them, and until they exist no mail reaches the Worker at all.
2. Verify `Authentication-Results` on the first real delivery — see the caveat below.

Dev and staging route mail from a **separate, non-production zone**, so testing never
consumes `novamerx.ai`'s Email Routing and Sending domain allowance.

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

## Migration 002 — ITT reminder kinds

Widens two CHECKs and nothing else: `comms.messages.kind` gains `itt_reminder` (a chase sent
to a subcontractor, which is what puts it on the contractor timeline) and
`comms.notifications.kind` gains `itt_response_detected` (a reply the classifier read as an
accept/decline). Added for BuildFlow issue #36. TPS's `REQUIRED_COMMS_MIGRATION` moves to
`002_itt_reminder_kinds.sql`, so **this migrates before TPS deploys** — `bff-tps` refuses to
boot against a `comms` schema behind it.

## Migration 003 — RFI response kind

Widens the same two CHECKs again: `comms.messages.kind` gains `rfi_response` (the estimator's
approved answer to a subcontractor's query, sent from the app) and
`comms.notifications.kind` gains `rfi_review_required` (drafts are ready for the estimator to
review — the acceptance criterion issue #41 states outright). **Not** `relay_to_subcontractor`
— see the migration file's own comment for why that would silently break
`listClientAnswersForWorkflow`'s "has this answer been relayed" check. TPS's
`REQUIRED_COMMS_MIGRATION` moves to `003_rfi_kinds.sql`, same deploy-order consequence as 002.

## Migration 004 — tender addendum notification

`comms.notifications.kind` gains `addendum_approval_required`: the client's revised documents
changed the take-off, and an estimator has to approve the addendum and the revised tender
return date before anything is issued. BuildFlow issue #68, part of #42. `comms.messages.kind`
is **not** widened — the addendum is not a message, which is the point below.

It also adds **`comms.notifications.dedupe_key`**, and that is the part worth reading. Every
notification until now hangs off a `comms.messages` row, and that is where its idempotency
comes from: `message_id` is UNIQUE and `insertNotification` says
`ON CONFLICT (message_id) DO NOTHING`. An addendum approval has no message — nothing was sent
to anyone; the app is asking its own estimator a question.

Leaving `message_id` NULL does not merely lose the guarantee, it loses it **silently**: a
UNIQUE index treats every NULL as distinct, so the `ON CONFLICT` never fires and a retried
write inserts a second identical row. The bell would show "2 addenda to approve" for one
addendum, and the count is the whole point of a bell. So a nullable `dedupe_key` with its own
partial unique index; callers set one or the other, never neither.

TPS's `REQUIRED_COMMS_MIGRATION` moves to `004_addendum_notification.sql`, same deploy-order
consequence as 002 and 003.

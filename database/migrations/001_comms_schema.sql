-- The subcontractor / Client communications store (BuildFlow issue #34): every RFI a
-- tenderer raises, every inbound email, every forward to the Client and every answer
-- relayed back - one chronological history per counterparty.
--
-- THIS REPOSITORY OWNS THE DDL. NOTHING IN IT EVER READS OR WRITES THESE TABLES.
--
-- The Cloudflare Email Worker beside this file runs at the edge and holds no connection
-- string; it POSTs parsed mail to TPS over HTTPS. Every SELECT, INSERT and UPDATE against
-- `comms` lives in the TPS repository, in `apps/bff/src/commsDb.ts` - the single file
-- there permitted to name a `comms.` table.
--
-- That split is deliberately lopsided and it has one sharp consequence: **a breaking
-- change made here is invisible here**. No test, type or query in this repository can
-- notice that a column was renamed. So:
--
--   ADDITIVE CHANGES ONLY. No rename, no drop, no type narrowing, ever, in a single
--   migration. Anything else is two-phase: add the new column here, merge the TPS change
--   that uses it, and only then drop the old one in a later migration.
--
-- Three things defend the consumer, and all three are in the TPS repository:
--   * `commsDb.ts` declares REQUIRED_COMMS_MIGRATION and `server.ts` refuses to start
--     against a database behind it - so "absent" and "behind" fail identically, at boot;
--   * `comms-schema.integration.test.ts` asserts the exact column and index shape;
--   * `commsBoundary.test.ts` asserts commsDb.ts is still the only file naming `comms.`.
--
-- History: this was `022_comms_schema.sql` in the TPS repository until that repository was
-- extracted from. The DDL below is unchanged by the move, so a database already carrying
-- it is adopted rather than rebuilt - every statement is IF NOT EXISTS.
--
-- NO CROSS-SCHEMA FOREIGN KEYS. workflow_id, shortlist_entry_id, organization_id,
-- subcontractor_id and created_by are bare UUIDs. That rule is what made the extraction a
-- move rather than a rewrite, and it is why this schema can be pointed at a different
-- database from the rest of the platform later without unpicking anything.
--
-- NOTHING WRITES updated_at HERE, so there are no triggers and no updated_at columns: a
-- trigger would tie this schema to public.bf_touch_updated_at(), a dependency owned by a
-- third repository.

CREATE SCHEMA IF NOT EXISTS comms;

-- ----------------------------------------------------------------------- threads
--
-- GRAIN: one thread per (workflow x counterparty), which is deliberately ONE COARSER
-- than everything else at ITT Dispatch - tps.itt_dispatch and
-- tps.pricing_portal_links are both UNIQUE (shortlist_entry_id), i.e. package x firm.
--
-- It has to be. An inbound email carries a sender address and nothing else: it cannot
-- be attributed to a package, and frequently not even to a tender. A thread keyed on
-- shortlist_entry_id would make most inbound traffic unrepresentable. The package is
-- not lost - it is recorded per MESSAGE (comms.messages.shortlist_entry_id), which a
-- portal RFI always knows because it was raised on that package's own portal link.
--
-- workflow_id NULL is the untriaged case: mail from a firm on no shortlist, or from a
-- public email domain that was never issued a portal link. Those must land somewhere
-- visible rather than being dropped.
CREATE TABLE IF NOT EXISTS comms.threads (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL,
    workflow_id         UUID,
    counterparty_kind   TEXT NOT NULL CHECK (counterparty_kind IN ('subcontractor', 'client')),
    subcontractor_id    UUID,
    counterparty_email  TEXT NOT NULL,
    counterparty_domain TEXT NOT NULL,
    counterparty_name   TEXT,
    subject             TEXT,
    status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'awaiting_client', 'answered', 'closed')),
    last_message_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- TWO PARTIAL indexes, not one constraint. workflow_id is nullable and Postgres treats
-- NULLs as distinct, so a single UNIQUE (workflow_id, kind, email) would silently
-- permit any number of duplicate triage threads for the same sender - the one case
-- where duplicates are most likely, because nothing there has an id to key on.
CREATE UNIQUE INDEX IF NOT EXISTS threads_wf_party_idx
    ON comms.threads (workflow_id, counterparty_kind, counterparty_email)
    WHERE workflow_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS threads_untriaged_party_idx
    ON comms.threads (organization_id, counterparty_kind, counterparty_email)
    WHERE workflow_id IS NULL;

CREATE INDEX IF NOT EXISTS threads_org_recent_idx ON comms.threads (organization_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS threads_workflow_idx   ON comms.threads (workflow_id, last_message_at DESC);

-- ---------------------------------------------------------------------- messages
--
-- organization_id and workflow_id are DENORMALISED from the thread on purpose: the
-- notification bell and the "filter by tender" timeline are the two hottest reads in
-- this feature and neither should have to join to answer.
--
-- author_name / author_email are WHAT THE PORTAL MODAL COLLECTED, not the portal
-- link's recipient. The whole point of the "Request information" form asking for them
-- is that the person raising a query is routinely not the person the ITT was
-- addressed to.
--
-- occurred_at vs received_at: a sender's Date: header is routinely wrong, sometimes by
-- years, and an uncorrected one would pin a message to the top of the timeline for
-- ever. So occurred_at is clamped to received_at at write time, and the CHECK makes
-- that a guarantee of the database rather than an intention of the caller.
CREATE TABLE IF NOT EXISTS comms.messages (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id              UUID NOT NULL REFERENCES comms.threads (id) ON DELETE CASCADE,
    organization_id        UUID NOT NULL,
    workflow_id            UUID,
    -- Which PACKAGE this message is about, when that is known. NULL for anything
    -- arriving by email.
    shortlist_entry_id     UUID,

    direction              TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    channel                TEXT NOT NULL CHECK (channel IN ('portal', 'email', 'app')),
    kind                   TEXT NOT NULL CHECK (kind IN (
                               'subcontractor_rfi', 'client_forward', 'client_reply',
                               'relay_to_subcontractor', 'note')),

    author_name            TEXT,
    author_email           TEXT,
    subject                TEXT,
    body_text              TEXT,
    body_html              TEXT,

    occurred_at            TIMESTAMPTZ NOT NULL,
    received_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    in_reply_to_message_id UUID REFERENCES comms.messages (id) ON DELETE SET NULL,
    external_message_id    TEXT,
    external_in_reply_to   TEXT,
    external_references    TEXT[],

    -- How this message was attached to its thread. Recorded so a misrouted reply is
    -- diagnosable rather than mysterious - see TPS_INBOUND_EMAIL_API.md.
    attribution_method     TEXT CHECK (attribution_method IN (
                               'reply_token', 'subject_marker', 'in_reply_to',
                               'sender_email', 'sender_domain', 'manual')),
    dkim_result            TEXT,
    spf_result             TEXT,
    dmarc_result           TEXT,

    -- The archival .eml, in BuildFlow's bucket. NULL for anything raised in the app.
    raw_object_key         TEXT,
    -- The message exceeded the inbound size cap and was re-posted without its
    -- attachments. Filed with a visible marker rather than dropped.
    attachments_truncated  BOOLEAN NOT NULL DEFAULT FALSE,

    -- Inbound dedupe. The RFC 5322 Message-ID, or sha256 of the raw message when the
    -- sender omitted one. An Email Worker delivers at least once by design.
    idempotency_key        TEXT UNIQUE,

    created_by             UUID,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ck_messages_occurred_not_future CHECK (occurred_at <= received_at)
);

CREATE INDEX IF NOT EXISTS messages_thread_idx   ON comms.messages (thread_id, occurred_at);
CREATE INDEX IF NOT EXISTS messages_workflow_idx ON comms.messages (workflow_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS messages_org_inbound_idx
    ON comms.messages (organization_id, occurred_at DESC) WHERE direction = 'inbound';

-- ------------------------------------------------------------------- attachments
--
-- The BYTES are not here and never will be. They go to BuildFlow's object storage
-- through POST /internal/comms/attachments, because the durable-link primitive a
-- non-BuildFlow viewer needs (bf_document_share_links + GET /links/:token) lives
-- where the bucket is. share_token is the last link minted for this object; it is
-- re-minted on expiry rather than stored for ever.
CREATE TABLE IF NOT EXISTS comms.attachments (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id       UUID NOT NULL REFERENCES comms.messages (id) ON DELETE CASCADE,
    seq              INTEGER NOT NULL,
    filename         TEXT NOT NULL,
    content_type     TEXT,
    byte_size        BIGINT,
    sha256           TEXT,
    object_key       TEXT NOT NULL,
    -- The durable link EXACTLY as BuildFlow returned it, never reassembled here. BuildFlow
    -- builds it from its own BFF_PUBLIC_URL, which is the browser-reachable host; the only
    -- BuildFlow URL this process knows is the internal one (http://bff:3000 on the shared
    -- Docker network), so anything constructed here would be a link nobody outside the
    -- network could open. Its contract says so outright: embed `url`, do not construct it.
    share_url        TEXT,
    share_token      TEXT,
    share_expires_at TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (message_id, seq)
);

-- ----------------------------------------------------------------- forward_items
--
-- ONE forward carries N selected RFIs - that is what the issue asks for ("select
-- multiple messages and forward to Client"), and without this table the relationship
-- is unrecoverable. It is what later answers "which of the six questions did the
-- Client's one reply actually cover" and "relay this answer back to whom".
CREATE TABLE IF NOT EXISTS comms.forward_items (
    forward_message_id UUID NOT NULL REFERENCES comms.messages (id) ON DELETE CASCADE,
    source_message_id  UUID NOT NULL REFERENCES comms.messages (id) ON DELETE CASCADE,
    seq                INTEGER NOT NULL,
    PRIMARY KEY (forward_message_id, source_message_id),
    CONSTRAINT ck_forward_items_not_self CHECK (forward_message_id <> source_message_id)
);

CREATE INDEX IF NOT EXISTS forward_items_source_idx ON comms.forward_items (source_message_id);

-- ------------------------------------------------------------ client_reply_links
--
-- Deliberately the same column vocabulary as tps.pricing_portal_links (019), because
-- it is the same problem with a different counterparty: a bearer token in an emailed
-- URL, plus a recipient identity that the viewer's verified Cloudflare Access email
-- must match before anything is served.
--
-- THE TRAP THIS EXISTS TO MAKE VISIBLE: Cloudflare Access is reconciled only against
-- portal recipients (PricingPortalDatabase.liveRecipients reads pricing_portal_links
-- alone). A Client's address appears in no such row, so unless these rows are unioned
-- into the include list BEFORE the forward email is sent, every Client link is refused
-- at the edge with no signal anywhere in this application.
--
-- blocked_reason mirrors 019's: a row exists even when no token could be issued, so
-- the UI shows a stated reason rather than the recipient simply being absent.
CREATE TABLE IF NOT EXISTS comms.client_reply_links (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    forward_message_id UUID NOT NULL REFERENCES comms.messages (id) ON DELETE CASCADE,
    thread_id          UUID NOT NULL REFERENCES comms.threads (id) ON DELETE CASCADE,
    organization_id    UUID NOT NULL,
    workflow_id        UUID,
    token              TEXT,
    recipient_email    TEXT NOT NULL,
    recipient_domain   TEXT NOT NULL,
    expires_at         TIMESTAMPTZ,
    blocked_reason     TEXT,
    first_opened_at    TIMESTAMPTZ,
    last_opened_at     TIMESTAMPTZ,
    last_opened_email  TEXT,
    denied_attempts    INTEGER NOT NULL DEFAULT 0,
    last_denied_email  TEXT,
    last_denied_at     TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (forward_message_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS client_reply_links_token_idx
    ON comms.client_reply_links (token) WHERE token IS NOT NULL;

-- ----------------------------------------------------------------- notifications
--
-- STORED, not derived. "Pending approval" is a state column and can be counted on
-- read; "a contractor asked for clarification" is an EVENT that must stay notifiable
-- after the thread has moved on. Read/unread is per-user and cannot be derived from a
-- message row at all.
--
-- message_id UNIQUE, written in the SAME TRANSACTION as the message, makes both "two
-- notifications for one message" and "a message nobody was told about"
-- unrepresentable rather than merely unlikely.
--
-- deep_link_path is stored at write time rather than computed on read, the same rule
-- tps.shortlist_entries.suggestion_reason follows: what the reader is sent to should
-- be what was meant when the event happened.
--
-- These two tables land DORMANT: nothing writes them until the notification bell
-- (commit 3). A half-built schema applied in pieces is worse than two unused tables.
CREATE TABLE IF NOT EXISTS comms.notifications (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID NOT NULL,
    kind             TEXT NOT NULL CHECK (kind IN (
                         'subcontractor_rfi', 'client_reply', 'forward_failed', 'unattributed_email')),
    thread_id        UUID REFERENCES comms.threads (id) ON DELETE CASCADE,
    message_id       UUID UNIQUE REFERENCES comms.messages (id) ON DELETE CASCADE,
    workflow_id      UUID,
    subcontractor_id UUID,
    title            TEXT NOT NULL,
    body             TEXT,
    deep_link_path   TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_org_recent_idx ON comms.notifications (organization_id, created_at DESC);

-- user_id is public.bf_users.id. It is NOT a foreign key, per this schema's rule, and
-- it needs no identity mapping: TPS provisions its actors straight into
-- public.bf_users / public.bf_organizations, so the ids BuildFlow holds ARE the ids
-- stored here. Anyone tempted to add a mapping table should read this line first.
CREATE TABLE IF NOT EXISTS comms.notification_reads (
    notification_id UUID NOT NULL REFERENCES comms.notifications (id) ON DELETE CASCADE,
    user_id         UUID NOT NULL,
    read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (notification_id, user_id)
);

COMMENT ON SCHEMA comms IS
    'Subcontractor and Client communications (issue #34). Migrated by the TPS repo; fed by novamerx-comms-worker over HTTPS. No cross-schema foreign keys, so the store is portable.';

-- ------------------------------------------------------------------- privileges
--
-- A no-op today: every process connects as the owning `buildflow` role, so nothing here
-- changes who can do what. It is written now because the day roles ARE split is the day
-- it stops being writable cheaply - and the failure it prevents is nasty and narrow:
-- without ALTER DEFAULT PRIVILEGES, a table added by a LATER migration in this repository
-- would be invisible to TPS while the seven below stayed readable, so exactly one query
-- would start failing and nothing would explain why.
--
-- The role name is not hard-coded. The migration runner sets `comms.dml_role` from the
-- COMMS_DML_ROLE environment variable; unset, current_setting returns NULL and this whole
-- block is skipped. Declaring the DML owner in the DDL is also the clearest place to say
-- who is allowed to write here, given nothing in this repository ever does.
DO $$
DECLARE
    dml_role TEXT := current_setting('comms.dml_role', true);
BEGIN
    IF dml_role IS NULL OR dml_role = '' THEN
        RAISE NOTICE 'comms.dml_role not set; skipping GRANTs (single-role deployment)';
        RETURN;
    END IF;
    EXECUTE format('GRANT USAGE ON SCHEMA comms TO %I', dml_role);
    EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA comms TO %I', dml_role);
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA comms GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
        dml_role);
END $$;

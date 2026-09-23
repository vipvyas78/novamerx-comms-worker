-- Tender addenda (BuildFlow issue #68, part of #42): one new notification kind, and the
-- idempotency key a notification WITHOUT a message needs.
--
--   comms.notifications.kind + 'addendum_approval_required'
--       "the client's revised documents changed 27 lines across 3 work packages -- approve
--       the addendum and the revised return date". The issue's own acceptance criterion:
--       "Novamerx will issue notification seeking approval for the addendum to packages".
--
-- WHY THIS NEEDS MORE THAN A WIDER CHECK, unlike 002 and 003.
--
-- Every notification so far hangs off a comms.messages row, and that is where its
-- idempotency comes from: message_id is UNIQUE and insertNotification says
-- ON CONFLICT (message_id) DO NOTHING. An addendum approval has NO message -- nothing was
-- sent to anyone; the app is asking its own estimator a question.
--
-- Leaving message_id NULL does not merely lose the guarantee, it loses it SILENTLY: a
-- UNIQUE index treats every NULL as distinct, so the ON CONFLICT never fires and a retried
-- write inserts a second identical notification. The bell would then show "2 addenda to
-- approve" for one addendum, and the count is the whole point of a bell.
--
-- So: a nullable dedupe_key with its own partial unique index. Additive, and it unblocks
-- every future notification that is about a THING rather than about a message.
ALTER TABLE comms.notifications
    ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

COMMENT ON COLUMN comms.notifications.dedupe_key IS
    'Idempotency for a notification with no message behind it (e.g. an addendum awaiting '
    'approval). message_id UNIQUE cannot serve: it is NULL for these, and UNIQUE treats '
    'every NULL as distinct, so ON CONFLICT (message_id) silently never fires. Callers set '
    'one OR the other, never neither.';

-- Partial, so the hundreds of message-backed rows that will never carry one do not all
-- collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key_idx
    ON comms.notifications (dedupe_key)
    WHERE dedupe_key IS NOT NULL;

-- Same idempotent, additive, find-by-definition recipe as 002 and 003: the CHECK was
-- declared inline by 001, so its name is whatever Postgres generated, and it is located by
-- a value it already contains rather than by a name nobody chose.
DO $$
DECLARE
  target RECORD;
  found_name TEXT;
  current_def TEXT;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('notifications', 'subcontractor_rfi', 'addendum_approval_required',
        'ck_notifications_kind',
        $v$'subcontractor_rfi', 'client_reply', 'forward_failed', 'unattributed_email', 'itt_response_detected', 'rfi_review_required', 'addendum_approval_required'$v$)
    ) AS t(tbl, anchor_value, new_value, new_name, full_list)
  LOOP
    SELECT c.conname, pg_get_constraintdef(c.oid)
      INTO found_name, current_def
      FROM pg_constraint c
     WHERE c.conrelid = format('comms.%I', target.tbl)::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%kind%'
       AND pg_get_constraintdef(c.oid) LIKE '%' || target.anchor_value || '%'
     LIMIT 1;

    IF found_name IS NULL THEN
      RAISE EXCEPTION 'comms.%: no CHECK on "kind" found to widen - has 003 been applied?', target.tbl;
    END IF;

    IF current_def LIKE '%' || target.new_value || '%' THEN
      CONTINUE;  -- already widened
    END IF;

    EXECUTE format('ALTER TABLE comms.%I DROP CONSTRAINT %I', target.tbl, found_name);
    EXECUTE format('ALTER TABLE comms.%I ADD CONSTRAINT %I CHECK (kind IN (%s))',
                   target.tbl, target.new_name, target.full_list);
  END LOOP;
END $$;

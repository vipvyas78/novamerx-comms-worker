-- Automated and manual ITT reminders (BuildFlow issue #36): two new kinds, and nothing else.
--
--   comms.messages.kind       + 'itt_reminder'          a chase sent to a subcontractor. It is
--                                                       an outbound message on the firm's
--                                                       thread, which is exactly what puts it
--                                                       on the contractor timeline.
--   comms.notifications.kind  + 'itt_response_detected' "Acme appear to have declined", read
--                                                       from their email by the classifier.
--
-- ADDITIVE, per the rule stated in 001: a CHECK is only ever WIDENED here. The new list is the
-- old list plus one value, so no row already in either table can be rejected by it.
--
-- WHY THE CONSTRAINTS ARE FOUND BY DEFINITION, NOT BY NAME. 001 declares both as inline,
-- unnamed CHECKs, so Postgres named them (messages_kind_check, notifications_kind_check).
-- Relying on that generated name would fail on any database where somebody has since renamed
-- one. The constraint is instead identified as "the CHECK on this table that mentions this
-- column's first known value", then dropped and re-added under an explicit name so the next
-- widening does not have to play this game.
--
-- Idempotent: if the explicit-named constraint already carries the new value, nothing runs.

DO $$
DECLARE
  target RECORD;
  found_name TEXT;
  current_def TEXT;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('messages',      'subcontractor_rfi', 'itt_reminder',
        'ck_messages_kind',
        $v$'subcontractor_rfi', 'client_forward', 'client_reply', 'relay_to_subcontractor', 'note', 'itt_reminder'$v$),
      ('notifications', 'subcontractor_rfi', 'itt_response_detected',
        'ck_notifications_kind',
        $v$'subcontractor_rfi', 'client_reply', 'forward_failed', 'unattributed_email', 'itt_response_detected'$v$)
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
      RAISE EXCEPTION 'comms.%: no CHECK on "kind" found to widen - has 001 been applied?', target.tbl;
    END IF;

    IF current_def LIKE '%' || target.new_value || '%' THEN
      CONTINUE;  -- already widened
    END IF;

    EXECUTE format('ALTER TABLE comms.%I DROP CONSTRAINT %I', target.tbl, found_name);
    EXECUTE format('ALTER TABLE comms.%I ADD CONSTRAINT %I CHECK (kind IN (%s))',
                   target.tbl, target.new_name, target.full_list);
  END LOOP;
END $$;

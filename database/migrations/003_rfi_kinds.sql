-- Auto-drafted RFI responses (BuildFlow issue #41): two new kinds, and nothing else.
--
--   comms.messages.kind       + 'rfi_response'          the estimator's approved answer to a
--                                                       subcontractor's query, sent from the
--                                                       app. Outbound on the firm's own thread,
--                                                       which is what puts it on the timeline.
--   comms.notifications.kind  + 'rfi_review_required'   "3 draft responses are ready to review"
--                                                       - the issue's own acceptance criterion
--                                                       ("app will issue notification to the
--                                                       estimator for his/her review").
--
-- WHY NOT REUSE 'relay_to_subcontractor' FOR THE RESPONSE. It looks close enough to save a
-- migration, and it is the wrong choice: CommsDatabase.listClientAnswersForWorkflow computes
-- whether a client answer has been "relayed" as EXISTS(a relay_to_subcontractor message on
-- this workflow at or after this answer's occurred_at). An RFI response sent after a client
-- answer, under that kind, would falsely mark the answer already relayed and the estimator
-- would never see it as outstanding. A distinct kind costs one migration; the alternative
-- costs a silently dropped client answer.
--
-- Same idempotent, additive, find-by-definition recipe as 002.

DO $$
DECLARE
  target RECORD;
  found_name TEXT;
  current_def TEXT;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('messages',      'subcontractor_rfi', 'rfi_response',
        'ck_messages_kind',
        $v$'subcontractor_rfi', 'client_forward', 'client_reply', 'relay_to_subcontractor', 'note', 'itt_reminder', 'rfi_response'$v$),
      ('notifications', 'subcontractor_rfi', 'rfi_review_required',
        'ck_notifications_kind',
        $v$'subcontractor_rfi', 'client_reply', 'forward_failed', 'unattributed_email', 'itt_response_detected', 'rfi_review_required'$v$)
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
      RAISE EXCEPTION 'comms.%: no CHECK on "kind" found to widen - has 002 been applied?', target.tbl;
    END IF;

    IF current_def LIKE '%' || target.new_value || '%' THEN
      CONTINUE;  -- already widened
    END IF;

    EXECUTE format('ALTER TABLE comms.%I DROP CONSTRAINT %I', target.tbl, found_name);
    EXECUTE format('ALTER TABLE comms.%I ADD CONSTRAINT %I CHECK (kind IN (%s))',
                   target.tbl, target.new_name, target.full_list);
  END LOOP;
END $$;

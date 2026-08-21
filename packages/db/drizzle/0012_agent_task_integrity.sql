-- Permit one-way privacy minimization of immutable report snapshots while preserving all report identity.
CREATE OR REPLACE FUNCTION app.guard_agent_task_report_redaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'agent task reports are append-only'; END IF;
  IF ROW(NEW.id,NEW.task_id,NEW.attempt_id,NEW.lease_generation,NEW.kind,NEW.request_id,NEW.request_digest,
         NEW.accepted,NEW.error_code,NEW.occurred_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.task_id,OLD.attempt_id,OLD.lease_generation,OLD.kind,OLD.request_id,OLD.request_digest,
         OLD.accepted,OLD.error_code,OLD.occurred_at)
     OR NEW.response_snapshot IS DISTINCT FROM jsonb_set(OLD.response_snapshot,'{task,result}',jsonb_build_object('kind','redacted'))
     OR OLD.response_snapshot #>> '{task,state}' <> 'completed'
     OR OLD.response_snapshot #>> '{task,result,kind}' NOT IN ('no_action','action_requests_emitted')
     OR NOT EXISTS (SELECT 1 FROM app.agent_tasks t WHERE t.id=OLD.task_id AND t.state='completed') THEN
    RAISE EXCEPTION 'agent task report identity is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER agent_task_reports_append_only ON app.agent_task_reports;
--> statement-breakpoint
CREATE TRIGGER agent_task_reports_append_only BEFORE UPDATE OR DELETE ON app.agent_task_reports
FOR EACH ROW EXECUTE FUNCTION app.guard_agent_task_report_redaction();
--> statement-breakpoint
-- New Task writes must bind frozen assignment/grant authority to the same tenant and Manager.
CREATE FUNCTION app.enforce_agent_task_authority_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.mailbox_manager_assignment_revisions r
    WHERE r.assignment_id=NEW.assignment_id AND r.revision=NEW.assignment_revision
      AND r.user_id=NEW.user_id AND r.account_id=NEW.account_id
      AND r.manager_kind=NEW.manager_kind
      AND r.agent_connection_id IS NOT DISTINCT FROM NEW.manager_connection_id
  ) OR NOT EXISTS (
    SELECT 1 FROM app.agent_capability_grant_revisions r
    WHERE r.grant_id=NEW.grant_id AND r.revision=NEW.grant_revision
      AND r.user_id=NEW.user_id AND r.account_id=NEW.account_id
      AND r.manager_kind=NEW.manager_kind
      AND r.agent_connection_id IS NOT DISTINCT FROM NEW.manager_connection_id
  ) THEN
    RAISE EXCEPTION 'agent task authority identity mismatch';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER agent_tasks_authority_identity BEFORE INSERT OR UPDATE OF
  user_id,account_id,manager_kind,manager_connection_id,assignment_id,assignment_revision,grant_id,grant_revision
ON app.agent_tasks FOR EACH ROW EXECUTE FUNCTION app.enforce_agent_task_authority_identity();

ALTER TABLE app.drafts ADD COLUMN body_format text DEFAULT 'markdown' NOT NULL;--> statement-breakpoint
ALTER TABLE app.drafts ADD CONSTRAINT drafts_body_format_allowed CHECK (body_format IN ('markdown', 'html'));--> statement-breakpoint
UPDATE app.draft_revisions SET snapshot = '{}'::jsonb WHERE jsonb_typeof(snapshot) <> 'object';--> statement-breakpoint
UPDATE app.draft_revisions SET snapshot = jsonb_set(snapshot, '{bodyFormat}', '"markdown"'::jsonb, true) WHERE NOT snapshot ? 'bodyFormat';

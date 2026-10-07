-- M7.7 PR 1: the audit log's table. Columns, limits and triggers only:
-- nothing writes to it yet.
--
-- No userId and no foreign key to User, on purpose: a row has to outlive the
-- account it's about. People, Items and sessions appear only as keyed hashes
-- (64 lowercase hex), and every other column is a code the database limits,
-- so an error message or a name can't slip in. The value lists match
-- src/lib/auditLog.ts; tests/audit-log.test.ts checks both.
--
-- Append-only, by the triggers at the end: UPDATE and TRUNCATE are refused,
-- DELETE only for rows past the 400-day retention, and "at" is always the
-- insert time (UTC), so nobody can insert a pre-aged row and then delete it.
-- That stops app code, not someone holding DATABASE_URL: the app's role owns
-- the table and could drop the triggers.

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "subject" TEXT,
    "itemRef" TEXT,
    "sessionRef" TEXT,
    "plaidResult" TEXT,
    "outcome" TEXT,
    "stage" TEXT,
    "errorCode" TEXT,
    "count" INTEGER,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_sessionRef_key" ON "AuditEvent"("sessionRef");

-- CreateIndex
CREATE INDEX "AuditEvent_subject_at_idx" ON "AuditEvent"("subject", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_at_idx" ON "AuditEvent"("at");

-- Value limits
ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_event_check" CHECK ("event" IN (
    'item.linked', 'item.link_discarded', 'item.unlinked',
    'item.permission_revoked', 'item.account_revoked',
    'deletion.requested', 'deletion.stopped', 'deletion.incomplete', 'deletion.completed',
    'session.first_seen')),
  ADD CONSTRAINT "AuditEvent_actor_check" CHECK ("actor" IN ('user', 'operator', 'plaid')),
  ADD CONSTRAINT "AuditEvent_plaidResult_check" CHECK ("plaidResult" IN ('removed', 'already_gone', 'failed')),
  ADD CONSTRAINT "AuditEvent_outcome_check" CHECK ("outcome" IN ('ok', 'failed', 'duplicate', 'clerk_pending')),
  ADD CONSTRAINT "AuditEvent_subject_check" CHECK ("subject" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "AuditEvent_itemRef_check" CHECK ("itemRef" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "AuditEvent_sessionRef_check" CHECK ("sessionRef" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "AuditEvent_stage_check" CHECK ("stage" ~ '^[A-Z0-9_]{1,32}$'),
  ADD CONSTRAINT "AuditEvent_errorCode_check" CHECK ("errorCode" ~ '^[A-Z0-9_]{1,48}$'),
  ADD CONSTRAINT "AuditEvent_count_check" CHECK ("count" >= 0),
  ADD CONSTRAINT "AuditEvent_keyVersion_check" CHECK ("keyVersion" >= 1),
  -- Only Plaid's own events may lack a person (a webhook for an Item we no longer hold).
  ADD CONSTRAINT "AuditEvent_subject_required" CHECK ("actor" = 'plaid' OR "subject" IS NOT NULL),
  -- A session hash belongs to session.first_seen, and that event always has one.
  ADD CONSTRAINT "AuditEvent_sessionRef_event" CHECK (("event" = 'session.first_seen') = ("sessionRef" IS NOT NULL));

-- Append-only
CREATE FUNCTION audit_event_set_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."at" := now() AT TIME ZONE 'UTC';
  RETURN NEW;
END $$;

CREATE FUNCTION audit_event_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent is append-only: % refused', TG_OP;
END $$;

-- Retention: 400 days, the same number as AUDIT_RETENTION_DAYS.
CREATE FUNCTION audit_event_expiry_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."at" >= (now() AT TIME ZONE 'UTC') - interval '400 days' THEN
    RAISE EXCEPTION 'AuditEvent is append-only: DELETE refused for a row inside retention';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER audit_event_set_at BEFORE INSERT ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_set_at();
CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_refuse();
CREATE TRIGGER audit_event_expiry_only BEFORE DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_expiry_only();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_refuse();

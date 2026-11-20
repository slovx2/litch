// 追加到经理库的迁移。分表索引存筛选键，正文列只存结构化元数据。
export const EXTERNAL_STORE_MIGRATION = `
CREATE TABLE external_sources(source_id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL);
CREATE TABLE external_repos(
  source_id TEXT NOT NULL REFERENCES external_sources(source_id),
  repo_id TEXT NOT NULL, provider TEXT NOT NULL, enabled INTEGER NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY(source_id, repo_id)
);
CREATE UNIQUE INDEX external_enabled_repo ON external_repos(provider, repo_id) WHERE enabled=1;
CREATE TABLE external_routes(
  source_id TEXT NOT NULL REFERENCES external_sources(source_id),
  route_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(source_id, route_id)
);
CREATE TABLE external_credentials(credential_ref TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL);
CREATE TABLE external_owner(provider TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL);
CREATE TABLE external_config_requests(
  scope TEXT NOT NULL, operation_id TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY(scope, operation_id)
);
CREATE TABLE external_cursor(
  source_id TEXT NOT NULL, repo_id TEXT NOT NULL, stream TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY(source_id, repo_id, stream)
);
CREATE TABLE external_poll_checkpoints(
  source_id TEXT NOT NULL, repo_id TEXT NOT NULL, stream TEXT NOT NULL,
  bucket TEXT NOT NULL, checkpoint_key TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY(source_id,repo_id,stream,bucket,checkpoint_key)
);
CREATE TABLE external_observed(
  source_id TEXT NOT NULL, repo_id TEXT NOT NULL, stream TEXT NOT NULL, object_key TEXT NOT NULL,
  subject_key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(source_id, repo_id, stream, object_key)
);
CREATE INDEX external_observed_object ON external_observed(source_id, repo_id, object_key);
CREATE INDEX external_observed_subject ON external_observed(source_id, subject_key);
CREATE TABLE external_inbox(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, source_id TEXT NOT NULL,
  repo_id TEXT NOT NULL, manager_id TEXT, status TEXT NOT NULL, reason TEXT, body TEXT NOT NULL
);
CREATE TABLE external_event_evidence(
  event_key TEXT PRIMARY KEY NOT NULL REFERENCES external_inbox(event_key), body TEXT NOT NULL
);
CREATE INDEX external_inbox_source ON external_inbox(source_id, seq);
CREATE INDEX external_inbox_manager ON external_inbox(manager_id, seq);
CREATE TABLE external_intakes(
  intake_id TEXT PRIMARY KEY NOT NULL, subject_key TEXT NOT NULL, manager_id TEXT,
  status TEXT NOT NULL, body TEXT NOT NULL
);
CREATE UNIQUE INDEX external_pending_intake ON external_intakes(subject_key, coalesce(manager_id, ''))
  WHERE status='pending_triage';
CREATE TABLE external_triage_requests(
  intake_id TEXT NOT NULL, idem_key TEXT NOT NULL, signature TEXT NOT NULL, body TEXT NOT NULL, internal_reason TEXT,
  PRIMARY KEY(intake_id, idem_key)
);
CREATE TABLE external_refs(
  provider TEXT NOT NULL, repo_id TEXT NOT NULL, number TEXT NOT NULL, manager_id TEXT NOT NULL,
  issue_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(provider, repo_id, number),
  FOREIGN KEY(manager_id, issue_id) REFERENCES issues(manager_id, id)
);
CREATE INDEX external_refs_issue ON external_refs(manager_id, issue_id);
CREATE TABLE external_mandates(
  mandate_id TEXT PRIMARY KEY NOT NULL, manager_id TEXT NOT NULL, issue_id TEXT NOT NULL, body TEXT NOT NULL,
  FOREIGN KEY(manager_id, issue_id) REFERENCES issues(manager_id, id)
);
CREATE INDEX external_mandates_issue ON external_mandates(manager_id, issue_id);
CREATE TABLE external_deliveries(
  group_id TEXT PRIMARY KEY NOT NULL, delivery_id TEXT UNIQUE, manager_id TEXT NOT NULL,
  state TEXT NOT NULL, available_at INTEGER NOT NULL, body TEXT NOT NULL
);
CREATE INDEX external_deliveries_ready ON external_deliveries(state, available_at);
CREATE TABLE external_run_watches(
  repo_id TEXT NOT NULL, run_id TEXT NOT NULL, attempt INTEGER NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY(repo_id, run_id, attempt)
);
CREATE TABLE external_outbox(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, idem_key TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL, manager_id TEXT NOT NULL, repo_id TEXT NOT NULL, subject_key TEXT NOT NULL,
  state TEXT NOT NULL, next_attempt INTEGER, body TEXT NOT NULL
);
CREATE UNIQUE INDEX external_outbox_sending ON external_outbox(subject_key) WHERE state='sending';
CREATE INDEX external_outbox_ready ON external_outbox(state, next_attempt, seq);
CREATE INDEX external_outbox_manager ON external_outbox(manager_id, seq);
CREATE TABLE external_write_attempts(
  operation_id TEXT NOT NULL REFERENCES external_outbox(operation_id), attempt INTEGER NOT NULL,
  body TEXT NOT NULL, PRIMARY KEY(operation_id, attempt)
);
CREATE TABLE external_audit(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL
);
CREATE INDEX external_audit_subject ON external_audit(subject, seq);
`

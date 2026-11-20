// A 线迁移前的九步表结构快照。保持静态，避免用新迁移构造旧库。
export const MANAGER_V9_SQL = `
PRAGMA application_id=0x43484131;
CREATE TABLE managers(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
   CREATE TABLE objects(manager_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(manager_id,id));
   CREATE TABLE counters(manager_id TEXT NOT NULL, kind TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(manager_id,kind));
   CREATE TABLE situations(manager_id TEXT PRIMARY KEY, body TEXT NOT NULL);
   CREATE TABLE changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, manager_id TEXT NOT NULL, body TEXT NOT NULL);
   CREATE INDEX changes_manager ON changes(manager_id,seq);
   CREATE TABLE deliveries(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, manager_id TEXT NOT NULL, text TEXT NOT NULL);
   CREATE TABLE reports(thread_id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE endings(manager_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, text TEXT NOT NULL, turn_id TEXT);
CREATE TABLE questions(manager_id TEXT NOT NULL, decision_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(manager_id,decision_id));
CREATE TABLE suggestion_reviews(proposal_id TEXT PRIMARY KEY, manager_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE manager_reports(manager_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(manager_id,id));
   CREATE TABLE manager_suggestion_versions(manager_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(manager_id,id));
CREATE TABLE manager_relations(manager_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(manager_id,id));
CREATE TABLE manager_resets(manager_id TEXT PRIMARY KEY, body TEXT NOT NULL);
   CREATE TABLE manager_history(thread_id TEXT PRIMARY KEY, manager_id TEXT NOT NULL);
CREATE TABLE issues(manager_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(manager_id,id));
   CREATE TABLE issue_comments(manager_id TEXT NOT NULL, issue_id TEXT NOT NULL, comment_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(manager_id,comment_id));
   CREATE TABLE issue_notifications(manager_id TEXT NOT NULL, event_id TEXT NOT NULL, issue_id TEXT NOT NULL, recipient TEXT NOT NULL, body TEXT NOT NULL, seen_at INTEGER, PRIMARY KEY(manager_id,event_id));
   CREATE TABLE issue_idempotency(manager_id TEXT NOT NULL, idem_key TEXT NOT NULL, kind TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(manager_id,idem_key));
   CREATE TABLE issue_meta(manager_id TEXT NOT NULL, issue_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(manager_id,issue_id));
   CREATE TABLE issue_history(seq INTEGER PRIMARY KEY AUTOINCREMENT, manager_id TEXT NOT NULL, body TEXT NOT NULL);
   CREATE INDEX issue_comments_issue ON issue_comments(manager_id,issue_id);
   CREATE INDEX issue_notifications_unread ON issue_notifications(manager_id,issue_id,recipient,seen_at);
   CREATE INDEX issue_history_manager ON issue_history(manager_id,seq);
CREATE TABLE manager_reset_requests(manager_id TEXT NOT NULL, request_id TEXT NOT NULL, body TEXT NOT NULL,
   PRIMARY KEY(manager_id,request_id));
PRAGMA user_version=9;
`

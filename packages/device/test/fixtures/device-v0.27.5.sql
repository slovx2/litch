-- 由 v0.27.5 的 openDeviceStore 建库并经当版 ProjectStore/SectionStore 写入，再导出。
-- 项目与分区实现已核对 v0.27.5 到 v0.28.1 没有变化；不依赖当前初始化逻辑。
PRAGMA application_id=1128808753;
PRAGMA user_version=2;
CREATE TABLE imports(harness TEXT PRIMARY KEY, imported_at INTEGER NOT NULL, summary TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE project_threads (
        thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL
      );
CREATE TABLE projects (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, roots_json TEXT NOT NULL, metadata_json TEXT NOT NULL,
        position INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
CREATE TABLE sections(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, appearance_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
CREATE TABLE thread_sections(
        thread_id TEXT PRIMARY KEY, section_id TEXT NOT NULL, entered_at INTEGER NOT NULL
      ) WITHOUT ROWID;
CREATE TABLE threads(
      id TEXT PRIMARY KEY,
      harness TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      ephemeral INTEGER NOT NULL DEFAULT 0,
      seen_at INTEGER NOT NULL
    ) WITHOUT ROWID;
CREATE INDEX idx_project_members ON project_threads(project_id);
CREATE INDEX idx_section_members ON thread_sections(section_id);
INSERT INTO "imports" VALUES('pi',100,'{}');
INSERT INTO "project_threads" VALUES('claude-old','c30527e0-5528-421f-bd6a-03a9485cdd84');
INSERT INTO "project_threads" VALUES('archived-old','c30527e0-5528-421f-bd6a-03a9485cdd84');
INSERT INTO "project_threads" VALUES('pi-old','57181314-1d7f-4455-8f16-759a31f6582d');
INSERT INTO "projects" VALUES('c30527e0-5528-421f-bd6a-03a9485cdd84','multi','多根项目','[{"path":"/work/甲"},{"path":"/work/乙"}]','{"color":"blue"}',1,1793595959,1793595959);
INSERT INTO "projects" VALUES('57181314-1d7f-4455-8f16-759a31f6582d','single','第二项目','[{"path":"/work/丙"}]','{}',0,1793595959,1793595959);
INSERT INTO "sections" VALUES('custom','开发','{"icon":"code","color":"blue"}',100,100);
INSERT INTO "thread_sections" VALUES('claude-old','custom',120);
INSERT INTO "thread_sections" VALUES('pi-old','01984de2-8f74-7c91-a3b2-5c5e937cf318',130);
INSERT INTO "threads" VALUES('archived-old','pi',100,1,0,1793595959717);
INSERT INTO "threads" VALUES('claude-old','claude-code',100,0,0,1793595959717);
INSERT INTO "threads" VALUES('pi-old','pi',100,0,0,1793595959717);

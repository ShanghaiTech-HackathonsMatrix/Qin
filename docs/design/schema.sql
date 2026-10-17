-- Matrix 核心数据库 schema（SQLite / SQLCipher）
-- 约束：只使用 Capacitor SQLite 与 better-sqlite3 的公共 SQL 子集。
-- 所有时间戳为 Unix 毫秒（INTEGER）。所有 JSON 列以 TEXT 存储。
-- 本文件仅描述 core scope；插件表由宿主按 manifest 自动生成（见文末）。

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- 元数据 / 迁移

CREATE TABLE IF NOT EXISTS core_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS _migration (
  scope      TEXT    NOT NULL,          -- 'core' | 'plugin:<pluginId>'
  version    INTEGER NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (scope, version)
);

-- ---------------------------------------------------------------- 课表域

CREATE TABLE IF NOT EXISTS course (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,          -- 插件 id，或 'user'
  external_id   TEXT,                   -- 平台侧课程 id
  name          TEXT NOT NULL,
  code          TEXT,                   -- 课程号
  term          TEXT,                   -- '2025-2026-2'
  instructor    TEXT,
  default_location TEXT,
  color         TEXT,                   -- 用户指定的强调色
  archived      INTEGER NOT NULL DEFAULT 0,
  meta          TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_course_ext
  ON course(source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_course_term ON course(term, archived);

CREATE TABLE IF NOT EXISTS session (
  id          TEXT PRIMARY KEY,
  course_id   TEXT NOT NULL REFERENCES course(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  external_id TEXT,
  start_at    INTEGER NOT NULL,
  end_at      INTEGER NOT NULL,
  location    TEXT,
  kind        TEXT NOT NULL DEFAULT 'lecture',   -- lecture|lab|tutorial|exam|other
  rrule       TEXT,                              -- 可选：重复规则（展开后落成多条）
  note        TEXT,
  meta        TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_session_ext
  ON session(source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_session_start ON session(start_at);
CREATE INDEX IF NOT EXISTS ix_session_course ON session(course_id, start_at);

-- ---------------------------------------------------------------- 事件域（DDL / Quiz / 签到 / 考试 / 自定义）

CREATE TABLE IF NOT EXISTS event (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,            -- ddl|quiz|checkin|exam|note|custom
  title       TEXT NOT NULL,
  body        TEXT,
  course_id   TEXT REFERENCES course(id)  ON DELETE SET NULL,
  session_id  TEXT REFERENCES session(id) ON DELETE SET NULL,

  start_at    INTEGER,                  -- 开始/开放时间
  due_at      INTEGER,                  -- 截止时间（DDL 的核心字段）
  all_day     INTEGER NOT NULL DEFAULT 0,

  status      TEXT NOT NULL DEFAULT 'open',   -- open|in_progress|done|dismissed
  priority    INTEGER NOT NULL DEFAULT 0,     -- 0 普通，>0 用户置顶
  progress    REAL,                           -- 0..1，可选

  source      TEXT NOT NULL,            -- 插件 id，或 'user'
  external_id TEXT,
  dedupe_key  TEXT,
  confidence  REAL,                     -- 自动生成事件的置信度 0..1
  raw         TEXT,                     -- 原始消息/抓取片段（默认保留 7 天）
  raw_expires_at INTEGER,
  meta        TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,

  CHECK (due_at IS NOT NULL OR start_at IS NOT NULL),
  CHECK (status IN ('open','in_progress','done','dismissed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_event_ext
  ON event(source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_event_due   ON event(due_at)   WHERE due_at   IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_event_start ON event(start_at) WHERE start_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_event_course ON event(course_id, due_at);
CREATE INDEX IF NOT EXISTS ix_event_dedupe ON event(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_event_open_due ON event(due_at) WHERE status IN ('open','in_progress');

-- 待合并候选：不同来源描述同一个 DDL 时不直接覆盖，交由用户确认
CREATE TABLE IF NOT EXISTS merge_candidate (
  id          TEXT PRIMARY KEY,
  dedupe_key  TEXT NOT NULL,
  event_id    TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,  -- 已有事件
  incoming    TEXT NOT NULL,            -- 待合并的规范化 JSON（含 source/confidence）
  diff        TEXT NOT NULL,            -- 字段级差异，供 UI 展示
  state       TEXT NOT NULL DEFAULT 'pending',  -- pending|merged|rejected
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_merge_pending ON merge_candidate(state, created_at);

-- ---------------------------------------------------------------- 资源绑定

CREATE TABLE IF NOT EXISTS resource (
  id         TEXT PRIMARY KEY,
  event_id   TEXT REFERENCES event(id)   ON DELETE CASCADE,
  course_id  TEXT REFERENCES course(id)  ON DELETE CASCADE,
  session_id TEXT REFERENCES session(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,   -- assignment_desc|submit|slides|recording|checkin|quiz|meeting|other
  url        TEXT NOT NULL,
  label      TEXT,
  mime       TEXT,
  source     TEXT NOT NULL,   -- 'connector'|'heuristic'|'user'|插件 id
  confidence REAL NOT NULL DEFAULT 1.0,
  verified   INTEGER NOT NULL DEFAULT 0,
  meta       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  CHECK (event_id IS NOT NULL OR course_id IS NOT NULL OR session_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_resource_event ON resource(event_id, role);
CREATE INDEX IF NOT EXISTS ix_resource_session ON resource(session_id, role);
CREATE INDEX IF NOT EXISTS ix_resource_course ON resource(course_id, role);
-- 同一 owner 下同一 role 的 URL 唯一，避免重复同步产生脏数据
CREATE UNIQUE INDEX IF NOT EXISTS ux_resource_owner_role_url
  ON resource(IFNULL(event_id,''), IFNULL(course_id,''), IFNULL(session_id,''), role, url);

-- URL 模式库：把「作业页 → 提交页」这类推导规则沉淀下来，提升后续绑定置信度
CREATE TABLE IF NOT EXISTS url_pattern (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,          -- 域名或插件 id
  match_regex TEXT NOT NULL,
  role        TEXT NOT NULL,
  derive_to   TEXT,                   -- 目标 URL 模板，支持 {1} {2} 反向引用
  hits        INTEGER NOT NULL DEFAULT 0,
  misses      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_url_pattern ON url_pattern(scope, match_regex, role);

-- ---------------------------------------------------------------- 提醒与调度

CREATE TABLE IF NOT EXISTS reminder (
  id         TEXT PRIMARY KEY,
  ref_type   TEXT NOT NULL,     -- session|event
  ref_id     TEXT NOT NULL,
  fire_at    INTEGER NOT NULL,
  lead_min   INTEGER,
  channel    TEXT NOT NULL DEFAULT 'local',   -- local|inapp
  precision  TEXT NOT NULL DEFAULT 'inexact', -- exact|inexact
  state      TEXT NOT NULL DEFAULT 'pending', -- pending|fired|cancelled|failed
  payload    TEXT NOT NULL DEFAULT '{}',
  native_id  TEXT,                            -- 原生通知/闹钟的句柄，用于取消
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_reminder_pending ON reminder(fire_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS ix_reminder_ref ON reminder(ref_type, ref_id);

-- 本地缓存（讲义/PPT 等预取内容）
CREATE TABLE IF NOT EXISTS resource_cache (
  id          TEXT PRIMARY KEY,
  resource_id TEXT REFERENCES resource(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,          -- 平台沙箱目录内的相对路径
  bytes       INTEGER NOT NULL,
  mime        TEXT,
  etag        TEXT,
  fetched_at  INTEGER NOT NULL,
  expires_at  INTEGER
);
CREATE INDEX IF NOT EXISTS ix_cache_resource ON resource_cache(resource_id);
CREATE INDEX IF NOT EXISTS ix_cache_expiry ON resource_cache(expires_at);

-- ---------------------------------------------------------------- 插件与权限

CREATE TABLE IF NOT EXISTS plugin_registry (
  id           TEXT PRIMARY KEY,      -- 反域名：app.matrix.timeline
  version      TEXT NOT NULL,
  api_version  TEXT NOT NULL,
  kind         TEXT NOT NULL,         -- declarative|logic|connector|ui|first-party
  origin       TEXT NOT NULL DEFAULT 'user',       -- official|user：包来源
  trust_level  TEXT NOT NULL DEFAULT 'restricted', -- signed|restricted|remote-trusted（见 DESIGN §5.7）
  trust_updated_at INTEGER,
  enabled      INTEGER NOT NULL DEFAULT 1,
  manifest     TEXT NOT NULL,         -- 原始 manifest JSON
  declared     TEXT NOT NULL,         -- 声明权限（manifest 子集）
  granted      TEXT NOT NULL,         -- 用户实际授予的权限子集
  signature    TEXT,                  -- Ed25519 签名（base64）
  install_path TEXT,                  -- 解包后的插件目录
  installed_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- 会话句柄的持久部分：只有加密后的 cookie jar / refresh token，
-- 明文凭证存于 Keystore / Keychain / DPAPI，不落库。
CREATE TABLE IF NOT EXISTS auth_session (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  account_label TEXT,                 -- 仅用于 UI 展示，例如邮箱脱敏
  vault_ref     TEXT NOT NULL,        -- 安全存储中的键名
  expires_at    INTEGER,
  last_ok_at    INTEGER,
  state         TEXT NOT NULL DEFAULT 'active',  -- active|expired|revoked
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_auth_session
  ON auth_session(provider, IFNULL(account_label,''));
CREATE INDEX IF NOT EXISTS ix_auth_session_state ON auth_session(state, expires_at);

-- ---------------------------------------------------------------- 审计与配额

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  actor   TEXT NOT NULL,              -- 插件 id 或 'host' / 'user'
  action  TEXT NOT NULL,              -- net.request|auth.login|fs.write|notify|db.raw|...
  target  TEXT,
  ok      INTEGER NOT NULL,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_ts     ON audit_log(ts);
CREATE INDEX IF NOT EXISTS ix_audit_actor  ON audit_log(actor, ts);
CREATE INDEX IF NOT EXISTS ix_audit_action ON audit_log(action, ts);

CREATE TABLE IF NOT EXISTS plugin_quota (
  plugin_id   TEXT PRIMARY KEY,
  rows_used   INTEGER NOT NULL DEFAULT 0,
  bytes_used  INTEGER NOT NULL DEFAULT 0,
  net_window  TEXT NOT NULL DEFAULT '{}',   -- 令牌桶状态快照
  updated_at  INTEGER NOT NULL
);

-- ---------------------------------------------------------------- 同步状态

CREATE TABLE IF NOT EXISTS sync_state (
  connector_id TEXT NOT NULL,
  scope        TEXT NOT NULL,        -- 例如 'courses' | 'assignments:<courseId>'
  cursor       TEXT,                 -- 增量游标 / etag / last-modified
  last_sync_at INTEGER,
  last_status  TEXT,                 -- ok|auth_error|parse_error|network_error
  last_error   TEXT,
  PRIMARY KEY (connector_id, scope)
);

-- ---------------------------------------------------------------- 用户界面配置

CREATE TABLE IF NOT EXISTS layout_profile (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  doc         TEXT NOT NULL,         -- 布局 JSON（纯数据）
  schema_ver  INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 0,
  builtin     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_layout_active ON layout_profile(active) WHERE active = 1;

-- 跨插件共享的应用状态（命名空间化的 KV）
CREATE TABLE IF NOT EXISTS app_state (
  scope      TEXT NOT NULL,          -- 'core' | 插件 id
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

-- ================================================================
-- 插件表模板（宿主按 manifest 自动生成，插件不可自行指定表名）
--
-- 插件 id: app.matrix.connector.ecloud
-- 表前缀:  plugin_app_matrix_connector_ecloud_
--
-- 对每个声明的 collection（例：'task'，声明字段 dueAt / courseId / status）：
--
--   CREATE TABLE plugin_app_matrix_connector_ecloud_task (
--     id         TEXT PRIMARY KEY,
--     doc        TEXT NOT NULL,
--     created_at INTEGER NOT NULL,
--     updated_at INTEGER NOT NULL,
--     due_at     INTEGER GENERATED ALWAYS AS (json_extract(doc,'$.dueAt'))    VIRTUAL,
--     course_id  TEXT    GENERATED ALWAYS AS (json_extract(doc,'$.courseId')) VIRTUAL,
--     status     TEXT    GENERATED ALWAYS AS (json_extract(doc,'$.status'))   VIRTUAL
--   );
--   CREATE INDEX ix_pamece_task_due    ON plugin_..._task(due_at);
--   CREATE INDEX ix_pamece_task_course ON plugin_..._task(course_id, due_at);
--
-- 说明：
--  * 插件只提交 collection 名 + JSON Schema + 需索引的字段；SQL 由宿主编译。
--  * 查询 DSL 编译为参数化 SQL，字段路径必须在声明集合内，越界直接 EPERM。
--  * 卸载时按前缀 DROP TABLE；用户可选择保留（转为 orphan_ 前缀）以便重装恢复。
-- ================================================================

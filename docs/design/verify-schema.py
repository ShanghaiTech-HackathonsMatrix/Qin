import sqlite3, pathlib, sys

sql = pathlib.Path('docs/design/schema.sql').read_text(encoding='utf-8')
c = sqlite3.connect(':memory:')
c.executescript(sql)

# 1) 外键与表是否建齐
tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
expected = {'core_meta','_migration','course','session','event','merge_candidate','resource',
            'url_pattern','reminder','resource_cache','plugin_registry','auth_session',
            'audit_log','plugin_quota','sync_state','layout_profile','app_state'}
missing = expected - tables
assert not missing, f'缺表: {missing}'

# 2) 幂等：重复执行不应报错
c.executescript(sql)

# 3) 唯一索引是否真的生效（连接器重复同步场景）
c.execute("INSERT INTO course(id,source,external_id,name,created_at,updated_at) "
          "VALUES('c1','plug','E1','高数',1,1)")
try:
    c.execute("INSERT INTO course(id,source,external_id,name,created_at,updated_at) "
              "VALUES('c2','plug','E1','高数',1,1)")
    raise AssertionError('ux_course_ext 未生效')
except sqlite3.IntegrityError:
    pass

# 4) event 的 CHECK：due_at 与 start_at 不能同时为空
try:
    c.execute("INSERT INTO event(id,kind,title,source,created_at,updated_at) "
              "VALUES('e0','ddl','x','user',1,1)")
    raise AssertionError('event CHECK 未生效')
except sqlite3.IntegrityError:
    pass

# 5) 插件表模板：generated column + json_extract + 索引
c.executescript("""
CREATE TABLE plugin_app_matrix_connector_ecloud_task (
  id TEXT PRIMARY KEY, doc TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  due_at INTEGER GENERATED ALWAYS AS (json_extract(doc,'$.dueAt')) VIRTUAL,
  course_id TEXT GENERATED ALWAYS AS (json_extract(doc,'$.courseId')) VIRTUAL
);
CREATE INDEX ix_pamece_task_due ON plugin_app_matrix_connector_ecloud_task(due_at);
""")
c.execute("INSERT INTO plugin_app_matrix_connector_ecloud_task(id,doc,created_at,updated_at) "
          "VALUES('t1','{\"dueAt\":1700000000000,\"courseId\":\"c1\"}',1,1)")
got = c.execute("SELECT due_at,course_id FROM plugin_app_matrix_connector_ecloud_task "
                "WHERE due_at >= 1699999999999").fetchall()
assert got == [(1700000000000, 'c1')], got

# 6) 查询计划确认索引被使用（而非全表扫描）
plan = c.execute("EXPLAIN QUERY PLAN SELECT id FROM plugin_app_matrix_connector_ecloud_task "
                 "WHERE due_at > 1").fetchall()
assert 'ix_pamece_task_due' in str(plan), plan

print('schema OK; sqlite', sqlite3.sqlite_version)
print('plan:', plan)

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/kanban.db');

let db = null;

function initDB() {
  db = new Database(DB_PATH);

  // 启用外键
  db.pragma('foreign_keys = ON');

  // 创建表
  db.exec(`
    -- Agent 成员表
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      emoji TEXT DEFAULT '',
      color TEXT DEFAULT '#6366F1',
      status TEXT DEFAULT 'idle',
      current_action TEXT DEFAULT '空闲中',
      current_detail TEXT DEFAULT '',
      progress INTEGER DEFAULT 0,
      workload INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 项目表
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      phase TEXT DEFAULT 'start',
      status TEXT DEFAULT 'pending',
      deleted INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 需求表
    CREATE TABLE IF NOT EXISTS requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      project_id INTEGER,
      priority TEXT DEFAULT 'p2',
      status TEXT DEFAULT 'pending',
      owner_id TEXT,
      plan_start_time DATETIME,
      plan_end_time DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      deleted INTEGER DEFAULT 0,
      review_time DATETIME,
      FOREIGN KEY (owner_id) REFERENCES agents(id),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    -- 技术方案表
    CREATE TABLE IF NOT EXISTS tech_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_id INTEGER NOT NULL,
      author_id TEXT NOT NULL,
      content TEXT,
      status TEXT DEFAULT 'draft',
      reviewer_id TEXT,
      reviewed_at DATETIME,
      review_comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (requirement_id) REFERENCES requirements(id),
      FOREIGN KEY (author_id) REFERENCES agents(id),
      FOREIGN KEY (reviewer_id) REFERENCES agents(id)
    );

    -- 需求成员表
    CREATE TABLE IF NOT EXISTS requirement_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_id INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (requirement_id) REFERENCES requirements(id),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    -- 任务安排表
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_id INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      assignee_id TEXT,
      status TEXT DEFAULT 'todo',
      priority TEXT DEFAULT 'p2',
      estimated_hours INTEGER,
      actual_hours INTEGER DEFAULT 0,
      result_type TEXT DEFAULT 'text',
      start_time DATETIME,
      end_time DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (requirement_id) REFERENCES requirements(id),
      FOREIGN KEY (assignee_id) REFERENCES agents(id)
    );

    -- 任务结果表
    CREATE TABLE IF NOT EXISTS task_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      file_name TEXT,
      file_path TEXT,
      content TEXT,
      content_type TEXT DEFAULT 'text',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    -- 审批申请表
    CREATE TABLE IF NOT EXISTS approval_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      requirement_id INTEGER,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      reviewer_id TEXT,
      reviewed_at DATETIME,
      review_comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (requirement_id) REFERENCES requirements(id),
      FOREIGN KEY (agent_id) REFERENCES agents(id),
      FOREIGN KEY (reviewer_id) REFERENCES agents(id)
    );

    -- Agent 日志表
    CREATE TABLE IF NOT EXISTS agent_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      level TEXT DEFAULT 'info',
      message TEXT NOT NULL,
      context TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    -- Agent 工作状态表（实时）
    CREATE TABLE IF NOT EXISTS agent_work_status (
      agent_id TEXT PRIMARY KEY,
      current_action TEXT,
      current_detail TEXT,
      progress REAL DEFAULT 0,
      start_time DATETIME,
      last_update DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    -- 通知表
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    -- 系统信息表 (Key-Value)
    CREATE TABLE IF NOT EXISTS system_info (
      info_key TEXT PRIMARY KEY,
      info_value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 创建索引
    CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirements(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_logs_agent ON agent_logs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approval_requests(status);
    CREATE INDEX IF NOT EXISTS idx_notifications_agent ON notifications(agent_id);

    -- 本地项目表
    CREATE TABLE IF NOT EXISTS local_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      name TEXT DEFAULT '',
      start_command TEXT DEFAULT '',
      work_dir TEXT DEFAULT '',
      port INTEGER DEFAULT 0,
      pid INTEGER DEFAULT 0,
      status TEXT DEFAULT 'stopped',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    -- 本地项目 Key-Value 配置表
    CREATE TABLE IF NOT EXISTS local_project_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_project_id INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      item_value TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (local_project_id) REFERENCES local_projects(id)
    );
  `);

  // 初始化Agent数据
  initAgents();

  // 修复 tasks 表的字段（如果表已存在）
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN requirement_id INTEGER`);
  } catch (e) {}

  // 修复 requirements 表的字段（如果表已存在）
  try {
    db.exec(`ALTER TABLE requirements ADD COLUMN project_id INTEGER`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE requirements ADD COLUMN plan_start_time DATETIME`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE requirements ADD COLUMN plan_end_time DATETIME`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE requirements ADD COLUMN deleted INTEGER DEFAULT 0`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE requirements ADD COLUMN review_time DATETIME`);
  } catch (e) {}

  // 创建需求分析结果表
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS requirement_analysis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requirement_id INTEGER NOT NULL,
        needs_ui INTEGER DEFAULT 0,
        needs_frontend INTEGER DEFAULT 0,
        needs_backend INTEGER DEFAULT 0,
        needs_test INTEGER DEFAULT 1,
        needs_ops INTEGER DEFAULT 0,
        analysis_summary TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (requirement_id) REFERENCES requirements(id)
      )
    `);
  } catch (e) {}

  // 创建需求成员表
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS requirement_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requirement_id INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (requirement_id) REFERENCES requirements(id),
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);
  } catch (e) {}

  // 创建 task_results 表（如果不存在）
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        file_name TEXT,
        file_path TEXT,
        content TEXT,
        content_type TEXT DEFAULT 'text',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);
  } catch (e) {}

  // 修复 tech_plans 表字段（如果表已存在）
  try {
    db.exec(`ALTER TABLE tech_plans ADD COLUMN deleted INTEGER DEFAULT 0`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE tech_plans ADD COLUMN category TEXT DEFAULT 'frontend'`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE tech_plans ADD COLUMN version INTEGER DEFAULT 1`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE tech_plans ADD COLUMN audit_status TEXT DEFAULT 'pending'`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE tech_plans ADD COLUMN auditor_id TEXT`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE tech_plans ADD COLUMN audited_at DATETIME`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE tech_plans ADD COLUMN audit_comment TEXT`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE tech_plans ADD COLUMN review_status TEXT DEFAULT 'pending'`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE tech_plans ADD COLUMN retrieval_log TEXT DEFAULT '[]'`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE tech_plans ADD COLUMN dispatch_phase TEXT DEFAULT 'frontend'`);
  } catch (e) {}

  // 修复 tasks 表 deleted 字段
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN deleted INTEGER DEFAULT 0`);
  } catch (e) {}

  // 修复 notifications 表 processed 字段
  try {
    db.exec(`ALTER TABLE notifications ADD COLUMN processed INTEGER DEFAULT 0`);
  } catch (e) {}

  // 修复 notifications 表扩展字段
  try {
    db.exec(`ALTER TABLE notifications ADD COLUMN tech_plan_id INTEGER`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE notifications ADD COLUMN requirement_id INTEGER`);
  } catch (e) {}
  try {
    db.exec(`ALTER TABLE notifications ADD COLUMN category TEXT`);
  } catch (e) {}

  // 创建 Agent 消息队列表
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT,
        content TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        priority TEXT DEFAULT 'normal',
        callback_url TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);
  } catch (e) {}

  // 添加 metadata 列（如果表已存在）
  try {
    db.exec(`ALTER TABLE agent_messages ADD COLUMN metadata TEXT`);
  } catch (e) {}

  // 创建 Agent 实时输出表
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_outputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        requirement_id INTEGER,
        message_type TEXT DEFAULT 'text',
        content TEXT NOT NULL,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (agent_id) REFERENCES agents(id),
        FOREIGN KEY (requirement_id) REFERENCES requirements(id)
      )
    `);
  } catch (e) {}

  return db;
}

function initAgents() {
  const agents = [
    { id: 'leader-001', name: 'Leader', role: 'Team Leader', emoji: '👑', color: '#FCD34D' },
    { id: 'ui-001', name: 'Maya', role: 'UI Designer', emoji: '🎨', color: '#8B5CF6' },
    { id: 'fe-001', name: 'Alex', role: 'Frontend Engineer', emoji: '💻', color: '#3B82F6' },
    { id: 'be-001', name: 'Ryan', role: 'Backend Engineer', emoji: '⚙️', color: '#10B981' },
    { id: 'ops-001', name: 'Devin', role: 'DevOps Engineer', emoji: '🚀', color: '#F97316' },
    { id: 'te-001', name: 'Casey', role: 'Test Engineer', emoji: '🧪', color: '#EF4444' }
  ];

  const insertAgent = db.prepare(`
    INSERT OR IGNORE INTO agents (id, name, role, emoji, color)
    VALUES (@id, @name, @role, @emoji, @color)
  `);

  const insertWorkStatus = db.prepare(`
    INSERT OR IGNORE INTO agent_work_status (agent_id, current_action, current_detail)
    VALUES (@agent_id, '空闲中', '等待分配任务')
  `);

  for (const agent of agents) {
    insertAgent.run(agent);
    insertWorkStatus.run({ agent_id: agent.id });
  }

  // 初始化系统信息
  initSystemInfo();
}

function initSystemInfo() {
  const infoPairs = [
    { key: '服务器名称', value: 'Kanban Server' },
    { key: '服务端口', value: '1888' },
    { key: 'SSE 推送端口', value: '1888' },
    { key: '主机名', value: require('os').hostname() },
    { key: '操作系统', value: require('os').platform() },
    { key: '系统架构', value: require('os').arch() },
    { key: 'Node 版本', value: process.version },
    { key: 'CPU 核心数', value: String(require('os').cpus().length) },
    { key: '总内存', value: String(Math.round(require('os').totalmem() / 1024 / 1024 / 1024 * 100) / 100) + ' GB' },
    { key: '版本号', value: '1.0.0' }
  ];

  const insertInfo = db.prepare(`
    INSERT OR REPLACE INTO system_info (info_key, info_value, updated_at)
    VALUES (@key, @value, CURRENT_TIMESTAMP)
  `);

  for (const info of infoPairs) {
    insertInfo.run(info);
  }
}

function getDB() {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

module.exports = { initDB, getDB };

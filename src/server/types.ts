# 看扳系统 - 技术方案 v1.0
**日期**: 2026-04-25
**作者**: Ryan (后端工程师)
**状态**: 待Leader审批

---

## 1. 技术选型

| 组件 | 技术 | 理由 |
|------|------|------|
| 后端 | Node.js + Express | 轻量、简单、资源占用低 |
| 数据库 | SQLite (better-sqlite3) | 无服务器依赖、单文件、性能优秀 |
| 前端 | EJS 模板引擎 | 纯Node.js渲染、无需前端构建 |
| 实时通信 | Server-Sent Events (SSE) | 轻量、无需WebSocket库 |
| 任务守护 | Node.js Child Process | 监控Agent进程 |

---

## 2. 数据库设计

### 2.1 表结构

```sql
-- Agent 成员表
CREATE TABLE agents (
  id TEXT PRIMARY KEY,           -- 唯一标识
  name TEXT NOT NULL,            -- 名称
  role TEXT NOT NULL,            -- 角色
  emoji TEXT,                    -- 表情
  color TEXT,                    -- 颜色
  status TEXT DEFAULT 'idle',   -- idle/busy/pause
  current_task_id INTEGER,       -- 当前任务ID
  workload INTEGER DEFAULT 0,    -- 工作负载
  skills TEXT,                   -- JSON技能数组
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 需求表
CREATE TABLE requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,           -- 需求标题
  description TEXT,              -- 需求描述
  priority TEXT DEFAULT 'p2',    -- p0/p1/p2
  status TEXT DEFAULT 'pending', -- pending/tech_review/approved/planning/development/review/done
  owner_id TEXT,                 -- 负责人
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,         -- 完成时间
  FOREIGN KEY (owner_id) REFERENCES agents(id)
);

-- 技术方案表
CREATE TABLE tech_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL,
  author_id TEXT NOT NULL,       -- 编写者
  content TEXT,                  -- 方案内容 (Markdown)
  status TEXT DEFAULT 'draft',   -- draft/submitted/approved/rejected
  reviewer_id TEXT,               -- 审批人
  reviewed_at DATETIME,           -- 审批时间
  review_comment TEXT,           -- 审批意见
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (requirement_id) REFERENCES requirements(id),
  FOREIGN KEY (author_id) REFERENCES agents(id),
  FOREIGN KEY (reviewer_id) REFERENCES agents(id)
);

-- 任务安排表
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requirement_id INTEGER NOT NULL,
  title TEXT NOT NULL,           -- 任务标题
  description TEXT,             -- 任务描述
  assignee_id TEXT,             -- 分配给谁
  status TEXT DEFAULT 'todo',   -- todo/in_progress/paused/done
  priority TEXT DEFAULT 'p2',   -- p0/p1/p2
  estimated_hours INTEGER,       -- 预估工时
  actual_hours INTEGER DEFAULT 0, -- 实际工时
  start_time DATETIME,          -- 开始时间
  end_time DATETIME,            -- 结束时间
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (requirement_id) REFERENCES requirements(id),
  FOREIGN KEY (assignee_id) REFERENCES agents(id)
);

-- 审批申请表
CREATE TABLE approval_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,              -- 关联任务（可选）
  requirement_id INTEGER,        -- 关联需求（可选）
  agent_id TEXT NOT NULL,        -- 申请人
  type TEXT NOT NULL,            -- type_decision/resource/time/clarification
  title TEXT NOT NULL,           -- 申请标题
  content TEXT NOT NULL,         -- 申请内容
  status TEXT DEFAULT 'pending', -- pending/approved/rejected
  reviewer_id TEXT,             -- 审批人
  reviewed_at DATETIME,         -- 审批时间
  review_comment TEXT,          -- 审批意见
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (requirement_id) REFERENCES requirements(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (reviewer_id) REFERENCES agents(id)
);

-- Agent 日志表
CREATE TABLE agent_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  level TEXT DEFAULT 'info',    -- info/warn/error
  message TEXT NOT NULL,        -- 日志内容
  context TEXT,                  -- JSON上下文
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Agent 工作状态表（实时）
CREATE TABLE agent_work_status (
  agent_id TEXT PRIMARY KEY,
  current_action TEXT,          -- 当前动作
  current_detail TEXT,          -- 当前详情
  progress REAL DEFAULT 0,     -- 进度 0-100
  start_time DATETIME,          -- 开始时间
  last_update DATETIME,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
```

---

## 3. API 接口设计

### 3.1 Agent 相关
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/agents | 获取所有Agent列表 |
| GET | /api/agents/:id | 获取单个Agent详情 |
| GET | /api/agents/:id/logs | 获取Agent实时日志 (SSE) |
| POST | /api/agents/:id/status | 更新Agent状态 |
| PATCH | /api/agents/:id/work-status | 更新工作状态（实时） |

### 3.2 需求相关
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/requirements | 获取需求列表 |
| POST | /api/requirements | 创建需求 |
| GET | /api/requirements/:id | 获取需求详情 |
| PATCH | /api/requirements/:id | 更新需求状态 |

### 3.3 技术方案相关
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/requirements/:id/tech-plan | 获取需求的技术方案 |
| POST | /api/requirements/:id/tech-plan | 提交技术方案 |
| POST | /api/tech-plans/:id/approve | 审批通过 |
| POST | /api/tech-plans/:id/reject | 审批拒绝 |

### 3.4 任务相关
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/tasks | 获取任务列表 |
| POST | /api/requirements/:id/tasks | 创建任务 |
| PATCH | /api/tasks/:id | 更新任务状态 |
| POST | /api/tasks/:id/pause | Agent申请暂停 |
| POST | /api/tasks/:id/resume | Agent继续任务 |

### 3.5 审批相关
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/approvals | 获取待审批列表 |
| POST | /api/approvals/:id/approve | 审批通过 |
| POST | /api/approvals/:id/reject | 审批拒绝 |
| GET | /api/approvals/:id/notifications | Agent获取通知 (SSE) |

---

## 4. 核心功能设计

### 4.1 Agent 守护进程
- 每个Agent作为独立进程运行
- 主进程通过 Child Process 监控
- Agent每5秒上报工作状态到数据库
- Agent断开连接时标记为 idle

### 4.2 实时日志 (SSE)
```javascript
// /api/agents/:id/logs
app.get('/api/agents/:id/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  const interval = setInterval(() => {
    const logs = db.getLatestLogs(req.params.id);
    res.write(`data: ${JSON.stringify(logs)}\n\n`);
  }, 2000);

  req.on('close', () => clearInterval(interval));
});
```

### 4.3 审批通知
- Agent发起审批申请 → 状态变为 pause
- Leader审批 → 通过/拒绝
- 通过后通过 SSE 通知 Agent
- Agent收到通知后恢复工作

---

## 5. 运维相关

### 5.1 端口管理
- 主服务端口: 3000
- 健康检查端点: /health
- 端口状态API: /api/system/ports

### 5.2 防火墙检查脚本
```bash
# 检查端口是否开放
netstat -tlnp | grep :3000
# 或
ss -tlnp | grep :3000
```

---

## 6. 文件结构

```
kanban/
├── src/
│   ├── server.js              # 主入口
│   ├── db.js                  # 数据库初始化
│   ├── routes/
│   │   ├── agents.js
│   │   ├── requirements.js
│   │   ├── tasks.js
│   │   └── approvals.js
│   ├── middleware/
│   │   └── auth.js
│   └── utils/
│       └── logger.js
├── public/
│   ├── css/
│   └── js/
├── views/
│   └── index.ejs              # 单页应用
├── data/
│   └── kanban.db              # SQLite数据库
├── package.json
└── README.md
```

---

## 7. Leader 审批清单

- [ ] 技术选型是否合适？
- [ ] 数据库设计是否满足需求？
- [ ] API 接口是否完整？
- [ ] 审批流程是否符合预期？
- [ ] 是否需要调整？

**请 Leader 审批此技术方案，审批通过后开始开发。**

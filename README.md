# Agency Team 看扳系统

团队看板系统 - Agent协作平台

## 快速开始

```bash
cd /home/myprojects/JavaScript/kanban
npm install
npm start
```

访问 http://localhost:3000

## 技术栈

- **后端**: Node.js + Express
- **数据库**: SQLite (better-sqlite3)
- **前端**: EJS 模板引擎
- **实时通信**: Server-Sent Events (SSE)

## 功能特性

### Agent 概览
- 实时监控所有 Agent 状态 (空闲/工作中/暂停)
- 实时日志显示
- 工作进度跟踪

### 任务看板
- 需求管理 (P0/P1/P2 优先级)
- 任务分配与跟踪
- 状态流转: pending → tech_review → planning → development → done

### 技术方案审批
- Agent 提交技术方案
- Leader 审批通过/驳回
- 审批通知实时推送

### 审批工作流
- Agent 在任务中遇到问题可申请暂停
- 提交审批请求 (类型/资源/时间/澄清)
- Leader 审批后 Agent 收到通知继续工作

### DevOps 功能
- 端口状态检查
- 防火墙状态查询
- 系统资源监控

## API 接口

### Agent
- `GET /api/agents` - 获取所有 Agent
- `GET /api/agents/:id` - 获取单个 Agent
- `PATCH /api/agents/:id/status` - 更新 Agent 状态
- `PATCH /api/agents/:id/work-status` - 更新工作状态
- `GET /api/agents/:id/logs` - 实时日志 (SSE)

### 需求
- `GET /api/requirements` - 获取需求列表
- `POST /api/requirements` - 创建需求
- `GET /api/requirements/:id` - 获取需求详情
- `PATCH /api/requirements/:id` - 更新需求状态

### 任务
- `GET /api/tasks` - 获取任务列表
- `PATCH /api/tasks/:id` - 更新任务
- `POST /api/tasks/:id/pause` - 申请暂停
- `POST /api/tasks/:id/resume` - 继续任务

### 审批
- `GET /api/approvals` - 获取待审批列表
- `POST /api/approvals` - 创建审批申请
- `POST /api/approvals/:id/approve` - 审批通过
- `POST /api/approvals/:id/reject` - 审批拒绝

### 系统
- `GET /api/system/info` - 系统信息
- `GET /api/system/ports` - 端口状态
- `GET /api/system/health` - 健康检查

## 团队成员

| Agent | 角色 | 职责 |
|-------|------|------|
| Maya 🎨 | UI Designer | 界面设计 |
| Alex 💻 | Frontend Engineer | 前端开发 |
| Ryan ⚙️ | Backend Engineer | 后端开发 |
| Devin 🚀 | DevOps Engineer | 运维部署 |
| Casey 🧪 | Test Engineer | 测试验证 |

## 工作流程

1. **创建需求** → 分配给 Agent
2. **技术方案** → Agent 编写 → Leader 审批
3. **任务分配** → 审批通过后创建任务
4. **执行任务** → Agent 工作 → 遇到问题申请审批
5. **完成任务** → 更新状态 → 统计工时

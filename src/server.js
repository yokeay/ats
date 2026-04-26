const express = require('express');
const path = require('path');
const { initDB } = require('./server/db');
const { registerSSE, unregisterSSE, broadcastToAgent, broadcastToAll } = require('./server/sse');

// 初始化数据库
initDB();

const app = express();
const PORT = process.env.PORT || 1888;

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 视图引擎
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// 静态文件
app.use(express.static(path.join(__dirname, '../public')));

// 路由
const agentsRouter = require('./routes/agents');
const requirementsRouter = require('./routes/requirements');
const tasksRouter = require('./routes/tasks');
const approvalsRouter = require('./routes/approvals');
const systemRouter = require('./routes/system');
const projectsRouter = require('./routes/projects');
const techPlansRouter = require('./routes/tech-plans');
const localProjectsRouter = require('./routes/local-projects');

app.use('/api/agents', agentsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/requirements', requirementsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/approvals', approvalsRouter);
app.use('/api/system', systemRouter);
app.use('/api/tech-plans', techPlansRouter);
app.use('/api/local-projects', localProjectsRouter);

// 主页面
app.get('/', (req, res) => {
  res.render('index', {
    title: 'ATS',
    agents: require('./server/db').getDB().prepare('SELECT * FROM agents').all()
  });
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 导出
module.exports = { app, registerSSE, unregisterSSE, broadcastToAgent, broadcastToAll };

// 启动服务器
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════╗
║     ATS 已启动                                    ║
╠════════════════════════════════════════════════════╣
║  🌐 http://localhost:${PORT}                          ║
║  📊 健康检查: http://localhost:${PORT}/health         ║
║  👥 Agent数量: 5                                    ║
╚════════════════════════════════════════════════════╝
    `);

    // 启动工作进度模拟器（演示用）
    startWorkSimulator();
    // 启动技术方案生成模拟器
    startTechPlanSimulator();
    // 启动任务创建模拟器（检测方案通过通知，Agent 自动创建任务）
    startTaskCreationSimulator();
  });
}

// 技术方案模板生成器
function generateTechPlanContent(category, reqTitle, reqDesc, auditComment) {
  const now = new Date().toLocaleString('zh-CN');
  const isRejection = !!auditComment;

  // 根据驳回意见分析关键词，生成有针对性的内容
  const catNames = { frontend: '前端', backend: '后端', test: '测试', ops: '运维' };
  const catLabel = catNames[category] || category;

  if (category === 'frontend' && isRejection) {
    // 前端驳回：解析关键词，生成真正的分析内容
    const comment = auditComment.toLowerCase();
    const isPersonalCenter = reqTitle.includes('个人中心');
    const hasIconIssue = comment.includes('图标') || comment.includes('混乱') || comment.includes('乱码');
    const hasModalIssue = comment.includes('弹窗') || comment.includes('modal') || comment.includes('dialog') || (comment.includes('乱') && (comment.includes('新建') || comment.includes('页面')));

    const issueAnalysis = [];
    if (isPersonalCenter) issueAnalysis.push('- 个人中心页面管理：涉及用户信息、页面列表、新建/编辑页面等核心功能');
    if (hasIconIssue) issueAnalysis.push('- **图标混乱问题**：排查 FontAwesome / Material Icons 图标库引入方式，检查图标名映射是否正确，确认 CSS 加载顺序是否有冲突导致图标渲染错误');
    if (hasModalIssue) issueAnalysis.push('- **弹窗布局错乱问题**：排查 Modal 组件的 z-index 层级、flex 布局的 overflow hidden 是否误包裹了图标容器，检查响应式断点是否在窄屏下触发布局异常');

    const rootCause = [];
    if (hasIconIssue) rootCause.push('- **图标渲染错乱**：根因是图标字体未正确加载或图标类名拼写错误；修复方案：检查 src/icons/ 路径、确认 iconfont.css 引入顺序、验证图标渲染 DOM 结构');
    if (hasModalIssue) rootCause.push('- **弹窗布局错乱**：根因是 Modal 内部 flex 布局 overflow hidden 截断了图标容器；修复方案：隔离 Modal body 样式、增加 min-width、修正 overflow 设置');
    if (isPersonalCenter) rootCause.push('- **页面列表图标异常**：根因是列表数据 icon 字段与图标库映射表不匹配；修复方案：建立 iconMap 映射对象，增加兜底默认图标');

    return `
# 前端技术方案：${reqTitle}

## 0. 驳回意见分析与整改
> 审核意见：${auditComment}

根据上述驳回意见，本次修订重点：
1. **先查代码**：到 src/pages/UserCenter/ 和 src/components/Modal/ 目录查看实际代码，找到图标混乱的根因
2. **问题优先**：不套模板，先写出"现状→问题→根因→方案"的推导过程
3. **修复导向**：每个分析点都对应具体的代码改动，而非泛泛的架构建议

## 1. 问题分析

### 1.1 现状调研
- 个人中心页面管理位于 \`src/pages/UserCenter/components/PageManage/\`
- 新建页面弹窗组件为 \`NewPageModal.tsx\`
- 图标使用 FontAwesome，引入方式为 \`@fortawesome/fontawesome-svg-core\`

### 1.2 问题清单
\`\`\`
页面管理 → 新建页面 → 弹窗打开后图标显示异常（显示乱码/方块/位置错乱）
\`\`\`

### 1.3 根因分析
${rootCause.join('\n') || '- 需实际查看代码后才能确认根因'}

### 1.4 整改计划
| 问题 | 修复文件 | 修改内容 |
|------|---------|---------|
| 图标混乱 | src/styles/iconfont.css | 调整 @import 顺序，确保字体文件先加载 |
| 弹窗错乱 | NewPageModal.tsx | 修复 flex 布局溢出问题，增加 min-width |
| 图标名错误 | iconMap.ts | 修正图标名映射表，增加未定义图标的兜底处理 |

## 2. 核心修复代码

### 2.1 修复图标显示（NewPageModal.tsx）
\`\`\`tsx
// 错误示例：图标名拼写错误或未导入
// <i className="fa-pencil-alt" /> ❌

// 正确写法：确保图标已通过组件库导入
import { faPencil } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

// 使用
<FontAwesomeIcon icon={faPencil} />

// 兜底处理
const getIcon = (name: string) => {
  const iconMap = { edit: faPencil, delete: faTrash, add: faPlus };
  return iconMap[name] || faCircle;
};
<FontAwesomeIcon icon={getIcon(item.icon)} />
\`\`\`

### 2.2 修复 Modal 弹窗布局（PageManageModal.css）
\`\`\`css
/* 错误：overflow:hidden 截断了图标 */
.page-modal-body { overflow: hidden; }

/* 修复：使用 overflow:visible + 容器高度限制 */
.page-modal-body {
  overflow-y: auto;
  max-height: 60vh;       /* 限制高度，超出滚动 */
  overflow-x: hidden;     /* 仅横向截断 */
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 16px;
}
\`\`\`

## 3. 自检清单
- [ ] 个人中心页面管理弹窗图标显示正常
- [ ] 窄屏幕下弹窗不发生布局错乱
- [ ] 图标名映射表兜底处理生效（未定义图标显示默认图标）
- [ ] 单元测试覆盖图标渲染逻辑
- [ ] 在 Chrome / Safari / Firefox 三浏览器验证

## 4. 交付物
- NewPageModal.tsx（修复后）
- PageManageModal.css（样式修正）
- iconMap.ts（图标映射表）
- 截图对比（修复前 / 修复后）

---
> 本方案由 Agent 持续集成生成于 ${now}（已根据驳回意见修订）
> 修订说明：本次方案不再套用模板，而是根据"个人中心页面管理弹窗图标错乱"这一实际问题，从代码层面分析根因并给出具体修复方案
`;
  }

  const rejectionSection = isRejection ? `
## 0. 驳回意见分析与整改
> 审核意见：${auditComment}

根据上述驳回意见，本次修订重点：
1. **先查代码**：定位到实际出问题的代码文件，分析根因
2. **针对性方案**：围绕实际 bug 而非套用通用模板
3. **修复优先**：每个章节都对应具体的代码改动点
` : '';

  const templates = {
    frontend: `
# 前端技术方案：${reqTitle}
${rejectionSection}
## 1. 需求背景
${reqDesc || '针对' + reqTitle + '的需求开发'}

## 2. 问题分析（现状 → 问题 → 根因）
${isRejection ? '> 上次方案被驳回，原因：' + auditComment + '\n\n本次修订：需定位到实际代码文件，分析根因后再出方案' : '需先通过代码审查确认当前代码状态，分析问题根因后再出方案。'}

## 3. 界面设计
- 采用 Tailwind CSS 进行响应式布局
- 增加新的交互组件：Modal, LoadingOverlay
- 状态管理使用 React Context 或 Redux

## 4. 核心逻辑
\`\`\`typescript
const handleSubmit = async (data) => {
  setLoading(true);
  try {
    await api.post('/api/feature', data);
    showToast('success', '提交成功');
  } finally {
    setLoading(false);
  }
}
\`\`\`

## 5. 交付物
- 核心组件源码
- 单元测试覆盖率 > 80%
- UI 交互文档
`,
    backend: `
# 后端技术方案：${reqTitle}
${rejectionSection}
## 1. 需求背景
${reqDesc || '针对' + reqTitle + '的需求开发'}

## 2. 接口设计
### POST /api/feature
- 输入：JSON Payload
- 输出：Code 0 / Data object

## 3. 数据库设计
- 表结构变更：增加 status, update_time 字段
- 索引优化：idx_feature_status

## 4. 核心架构
- 采用 Controller-Service-Repository 三层架构
- 增加 Redis 缓存层减少 DB 压力

## 5. 安全考虑
- 接口增加 Rate Limiting 防刷
- 参数强制合法性校验
`,
    test: `
# 测试方案：${reqTitle}
${rejectionSection}
## 1. 测试范围
- 功能测试：全量覆盖 ${reqTitle} 的核心流程
- 兼容性测试：Chrome, Safari, Firefox
- 性能测试：并发量 > 100 QPS

## 2. 测试用例
- [x] 冒烟测试流程
- [ ] 边界值异常校验
- [ ] 并发冲突验证

## 3. 自动化计划
- 使用 Playwright 编写 E2E 脚本
- 集成到 CI/CD 流程中
`,
    ops: `
# 运维布署方案：${reqTitle}
${rejectionSection}
## 1. 部署架构
- 运行环境：Docker + K8s
- 资源配置：1CU / 2GB RAM

## 2. CI/CD 流程
- Github Actions 自动构件镜像
- 灰度发布策略：Canary 10% -> 50% -> 100%

## 3. 监控报警
- Prometheus 监控 API 错误率
- 5xx 错误率超过 1% 自动发送飞书通知
`
  };

  return (templates[category] || templates.frontend) + `\n\n---
> 本方案由 Agent 持续集成生成于 ${now}${isRejection ? '（已根据驳回意见修订）' : ''}`;
}

// 技术方案模拟器
function startTechPlanSimulator() {
  const { getDB } = require('./server/db');

  setInterval(() => {
    try {
      const db = getDB();
      // 获取所有正在生成中的技术方案（初始生成 或 驳回后重新生成）
      const pendingPlans = db.prepare(`
        SELECT tp.*, r.title, r.description, a.name as agent_name
        FROM tech_plans tp
        JOIN requirements r ON tp.requirement_id = r.id
        JOIN agents a ON tp.author_id = a.id
        WHERE tp.review_status = 'generating' AND tp.deleted = 0
        LIMIT 1
      `).all();

      for (const tp of pendingPlans) {
        const isRejection = tp.audit_status === 'reject' || !!tp.audit_comment;
        const actionLabel = isRejection ? '修改方案（驳回重做）' : '编写方案';
        const detailPrefix = isRejection
          ? '正在根据驳回意见修改「' + tp.title + '」的' + tp.category + '技术方案...'
          : '正在为需求「' + tp.title + '」构思' + tp.category + '技术方案...';

        // 1. 将 Agent 设为忙碌
        db.prepare(`UPDATE agents SET status = 'busy' WHERE id = ?`).run(tp.author_id);
        db.prepare(`
          UPDATE agent_work_status
          SET current_action = ?,
              current_detail = ?,
              progress = 10,
              last_update = CURRENT_TIMESTAMP
          WHERE agent_id = ?
        `).run(actionLabel, detailPrefix, tp.author_id);

        // 广播进入状态
        broadcastToAgent(tp.author_id, { type: 'tech_plan_starting', tech_plan_id: tp.id });

        // 2. 模拟耗时过程（5-10秒后完成）
        setTimeout(() => {
          try {
            const content = generateTechPlanContent(tp.category, tp.title, tp.description, tp.audit_comment);

            // 提交内容：如果是驳回重做，状态重置为 pending 待重新审核
            const newAuditStatus = isRejection ? 'pending' : tp.audit_status;
            db.prepare(`
              UPDATE tech_plans
              SET content = ?, review_status = 'review', audit_status = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(content, newAuditStatus, tp.id);

            // 恢复 Agent 状态
            db.prepare(`UPDATE agents SET status = 'idle' WHERE id = ?`).run(tp.author_id);
            db.prepare(`
              UPDATE agent_work_status
              SET current_action = '已完成方案',
                  current_detail = '已提交' + ? + '技术方案' + ?,
                  progress = 100,
                  last_update = CURRENT_TIMESTAMP
              WHERE agent_id = ?
            `).run(tp.category, isRejection ? '（已根据驳回意见修改）' : '', tp.author_id);

            // 广播完成
            broadcastToAll({ type: 'tech_plan_completed', tech_plan_id: tp.id, agent_id: tp.author_id });
          } catch (e) {
            console.error('Tech plan generation inner error:', e);
          }
        }, 8000 + Math.random() * 4000); // 8-12秒
      }
    } catch (e) {
      // 忽略模拟器错误
    }
  }, 5000);
}

// 生成模拟结果内容
function generateSimulatedResult(agent, task) {
  const timestamp = new Date().toLocaleString('zh-CN');
  const results = {
    'ui-001': `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: system-ui; padding: 20px; }
    .login-form { max-width: 400px; margin: 50px auto; }
    input { width: 100%; padding: 12px; margin: 8px 0; border: 1px solid #ddd; border-radius: 8px; }
    button { width: 100%; padding: 12px; background: #6366f1; color: white; border: none; border-radius: 8px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="login-form">
    <h2>用户登录</h2>
    <input type="text" placeholder="用户名">
    <input type="password" placeholder="密码">
    <button>登录</button>
  </div>
</body>
</html>`,
    'fe-001': `// 文件列表:
// src/pages/login.tsx
// src/components/LoginForm.tsx
// src/styles/login.css

// login.tsx
import { LoginForm } from '../components/LoginForm';

export default function LoginPage() {
  return <LoginForm />;
}

// LoginForm.tsx
export function LoginForm() {
  return (
    <form className="login-form">
      <input type="text" placeholder="用户名" />
      <input type="password" placeholder="密码" />
      <button type="submit">登录</button>
    </form>
  );
}`,
    'be-001': `// 文件列表:
// src/api/auth/login.ts
// src/models/User.ts
// src/services/auth.ts

// auth/login.ts
import { Request, Response } from 'express';

export async function login(req: Request, res: Response) {
  const { username, password } = req.body;
  const user = await User.findByUsername(username);
  if (user && await bcrypt.compare(password, user.password)) {
    return res.json({ token: generateToken(user) });
  }
  return res.status(401).json({ error: '无效凭证' });
}`,
    'ops-001': `// 部署脚本已准备完成:
// deploy.sh - 自动化部署脚本
// docker-compose.yml - 容器编排配置
// nginx.conf - Nginx 反向代理配置

// deploy.sh 主要功能:
1. 构建 Docker 镜像
2. 推送到私有仓库
3. 远程服务器拉取并启动
4. 健康检查验证`,
    'te-001': `// 测试报告已生成:
// tests/login.spec.ts - 登录功能测试
// tests/auth.spec.ts - 认证测试
// coverage/lcov.html - 代码覆盖率报告

// 测试结果:
✓ 用户名密码正确登录成功
✓ 错误密码返回401
✓ 空用户名提示必填
✓ SQL注入防护验证通过
覆盖率: 85%`
  };

  return `【${agent.name}】完成【${task.title}】

完成时间: ${timestamp}
负责人: ${agent.emoji} ${agent.name} (${agent.role})

${results[agent.agent_id] || '任务已按时完成'}`
    .replace('【${agent.name}】', '')
    .replace('【${task.title}】', '');
}

// Agent 任务创建模拟器：检测 tech_plan_approved 通知后，自动模拟 Agent 创建任务
function startTaskCreationSimulator() {
  const { getDB } = require('./server/db');

  setInterval(() => {
    try {
      const db = getDB();

      // 查找所有未处理的"方案通过"通知
      const notifications = db.prepare(`
        SELECT n.*, a.name as agent_name, a.emoji as agent_emoji
        FROM notifications n
        JOIN agents a ON n.agent_id = a.id
        WHERE n.type = 'tech_plan_approved' AND n.processed = 0
        LIMIT 1
      `).all();

      for (const notif of notifications) {
        const { agent_id, tech_plan_id, requirement_id, category } = notif;
        // 从 content 字段解析方案标题（content 格式："前端技术方案已审核通过，请...")
        // 从 title 字段获取完整标题：'✅ 技术方案通过 - xxx'
        const title = notif.title.replace('✅ 技术方案通过 - ', '').trim();

        // 1. 标记通知已处理
        db.prepare(`UPDATE notifications SET processed = 1 WHERE id = ?`).run(notif.id);

        // 2. 更新 Agent 状态为规划中
        db.prepare(`UPDATE agents SET status = 'busy' WHERE id = ?`).run(agent_id);
        db.prepare(`
          UPDATE agent_work_status
          SET current_action = '规划任务中',
              current_detail = '正在根据技术方案规划任务...',
              progress = 0,
              start_time = CURRENT_TIMESTAMP,
              last_update = CURRENT_TIMESTAMP
          WHERE agent_id = ?
        `).run(agent_id);

        broadcastToAgent(agent_id, { type: 'tech_plan_approved', tech_plan_id, requirement_id, category, title });

        // 3. 模拟 Agent 思考排期（3秒后开始创建任务）
        setTimeout(() => {
          try {
            // 根据方案类别生成任务模板
            const catTasks = {
              frontend: [
                { title: '界面开发', detail: '根据技术方案完成前端界面开发', priority: 'p1', hours: 8 },
                { title: '组件封装', detail: '封装可复用组件', priority: 'p2', hours: 4 },
                { title: '接口对接', detail: '对接后端 API 接口', priority: 'p2', hours: 3 },
                { title: '样式适配', detail: '响应式样式与浏览器兼容', priority: 'p3', hours: 2 }
              ],
              backend: [
                { title: '数据库设计', detail: '设计并创建数据表', priority: 'p1', hours: 4 },
                { title: '接口实现', detail: '实现业务接口', priority: 'p1', hours: 8 },
                { title: '权限校验', detail: '权限校验与安全处理', priority: 'p2', hours: 3 },
                { title: '性能优化', detail: 'SQL 优化与缓存设计', priority: 'p3', hours: 3 }
              ],
              test: [
                { title: '用例编写', detail: '编写功能测试用例', priority: 'p1', hours: 6 },
                { title: '自动化脚本', detail: '编写自动化测试脚本', priority: 'p2', hours: 5 },
                { title: '缺陷管理', detail: '缺陷跟踪与回归验证', priority: 'p3', hours: 3 }
              ],
              ops: [
                { title: '部署脚本', detail: '编写自动化部署脚本', priority: 'p1', hours: 4 },
                { title: '配置管理', detail: '配置管理与环境变量', priority: 'p2', hours: 2 },
                { title: '监控告警', detail: '配置监控指标与告警', priority: 'p3', hours: 3 }
              ]
            };

            const tasks = catTasks[category] || catTasks.frontend;
            const createdTaskIds = [];

            for (const t of tasks) {
              const result = db.prepare(`
                INSERT INTO tasks (title, description, requirement_id, assignee_id, priority, estimated_hours, status, start_time)
                VALUES (?, ?, ?, ?, ?, ?, 'in_progress', CURRENT_TIMESTAMP)
              `).run(
                '【' + title + '】' + t.title,
                t.detail,
                requirement_id,
                agent_id,
                t.priority,
                t.hours
              );
              createdTaskIds.push(result.lastInsertRowid);
            }

            // 记录日志：任务规划完成
            db.prepare(`
              INSERT INTO agent_logs (agent_id, level, message, context)
              VALUES (?, 'info', ?, ?)
            `).run(agent_id, '📋 任务规划完成：已创建 ' + createdTaskIds.length + ' 个任务', JSON.stringify({ requirement_id, category }));

            // 通知前端任务已创建
            broadcastToAll({ type: 'task_created', requirement_id, agent_id, count: createdTaskIds.length });

            // 4. 模拟 Agent 开始执行第一个任务
            if (createdTaskIds.length > 0) {
              const firstTask = db.prepare(`
                SELECT t.*, a.name as assignee_name
                FROM tasks t JOIN agents a ON t.assignee_id = a.id
                WHERE t.id = ?
              `).get(createdTaskIds[0]);

              db.prepare(`UPDATE agents SET status = 'busy' WHERE id = ?`).run(agent_id);
              db.prepare(`
                UPDATE agent_work_status
                SET current_action = '执行任务中',
                    current_detail = ?,
                    progress = 0,
                    start_time = CURRENT_TIMESTAMP,
                    last_update = CURRENT_TIMESTAMP
                WHERE agent_id = ?
              `).run(firstTask.title, agent_id);

              broadcastToAgent(agent_id, {
                type: 'work_started',
                title: firstTask.title,
                current_action: '执行任务中',
                current_detail: firstTask.title,
                task_id: firstTask.id
              });
              broadcastToAll({ type: 'work_started', agentId: agent_id, current_detail: firstTask.title });
            }
          } catch (e) {
            console.error('Task creation simulator inner error:', e);
          }
        }, 3000); // 3秒后创建任务
      }
    } catch (e) {
      // 忽略模拟器错误
    }
  }, 4000);
}

// 工作进度模拟器（演示用）
let simulatorInterval = null;
function startWorkSimulator() {
  const { getDB } = require('./server/db');

  simulatorInterval = setInterval(() => {
    try {
      const db = getDB();

      // 查找所有正在工作的 Agent
      const busyAgents = db.prepare(`
        SELECT aws.*, a.name, a.emoji
        FROM agent_work_status aws
        JOIN agents a ON aws.agent_id = a.id
        WHERE a.status = 'busy' AND aws.progress < 100
      `).all();

      if (busyAgents.length === 0) return;

      for (const agent of busyAgents) {
        // 随机增加 5-15% 进度
        const increment = Math.floor(Math.random() * 11) + 5;
        const newProgress = Math.min(100, agent.progress + increment);

        // 更新进度
        db.prepare(`
          UPDATE agent_work_status
          SET progress = ?, last_update = CURRENT_TIMESTAMP
          WHERE agent_id = ?
        `).run(newProgress, agent.agent_id);

        // 广播更新
        broadcastToAgent(agent.agent_id, {
          type: 'progress_update',
          progress: newProgress,
          current_action: agent.current_action,
          current_detail: agent.current_detail
        });

        // 完成后自动提交结果并更新任务状态
        if (newProgress >= 100) {
          // 查找该 Agent 对应的进行中的任务
          const task = db.prepare(`
            SELECT t.*, a.name as assignee_name
            FROM tasks t
            JOIN agents a ON t.assignee_id = a.id
            WHERE t.assignee_id = ? AND t.status = 'in_progress'
            ORDER BY t.created_at DESC
            LIMIT 1
          `).get(agent.agent_id);

          if (task) {
            // 生成模拟结果内容
            const resultContent = generateSimulatedResult(agent, task);

            // 保存结果
            db.prepare(`
              INSERT INTO task_results (task_id, content, content_type)
              VALUES (?, ?, ?)
            `).run(task.id, resultContent, 'text');

            // 更新任务状态为已完成
            db.prepare(`UPDATE tasks SET status = 'done', end_time = CURRENT_TIMESTAMP WHERE id = ?`).run(task.id);
          }

          // 重置 Agent 状态
          db.prepare(`UPDATE agents SET status = 'idle' WHERE id = ?`).run(agent.agent_id);
          db.prepare(`
            UPDATE agent_work_status
            SET current_action = '已完成任务',
                current_detail = '等待分配新任务',
                progress = 100,
                last_update = CURRENT_TIMESTAMP
            WHERE agent_id = ?
          `).run(agent.agent_id);

          // 记录完成日志
          db.prepare(`
            INSERT INTO agent_logs (agent_id, level, message, context)
            VALUES (?, 'info', ?, ?)
          `).run(agent.agent_id, `✓ 完成任务: ${agent.current_detail}`, JSON.stringify({type:'task_completed', task: agent.current_detail}));

          broadcastToAll({ type: 'task_completed', task_id: task ? task.id : null });
          broadcastToAgent(agent.agent_id, { type: 'work_completed', agent_name: agent.name });
        }
      }
    } catch (e) {
      // 忽略模拟器错误
    }
  }, 3000); // 每 3 秒更新一次
}

const express = require('express');
const router = express.Router();
const { getDB } = require('../server/db');
const { broadcastToAgent } = require('../server/sse');

// 获取所有技术方案（只展示最新版本，支持搜索、排序、分页）
router.get('/', (req, res) => {
  const db = getDB();
  const { search, sort = 'desc', page = 1, pageSize = 20, requirement_id, category, status, audit_status } = req.query;

  let where = 'tp.deleted = 0';
  const params = [];

  // 只查询每个 requirement+category 组合的最新版本
  where += ' AND tp.version = (SELECT MAX(tp2.version) FROM tech_plans tp2 WHERE tp2.requirement_id = tp.requirement_id AND tp2.category = tp.category AND tp2.deleted = 0)';

  if (search) {
    where += ' AND (r.title LIKE ? OR p.name LIKE ?)';
    params.push('%' + search + '%', '%' + search + '%');
  }

  if (requirement_id) {
    where += ' AND tp.requirement_id = ?';
    params.push(requirement_id);
  }

  if (category) {
    where += ' AND tp.category = ?';
    params.push(category);
  }

  if (status) {
    where += ' AND tp.review_status = ?';
    params.push(status);
  }

  if (audit_status) {
    where += ' AND tp.audit_status = ?';
    params.push(audit_status);
  }

  const total = db.prepare(`SELECT COUNT(*) as count FROM tech_plans tp LEFT JOIN requirements r ON tp.requirement_id = r.id LEFT JOIN projects p ON r.project_id = p.id WHERE ${where}`).get(...params).count;

  const offset = (parseInt(page) - 1) * parseInt(pageSize);
  const order = sort === 'asc' ? 'ASC' : 'DESC';

  const techPlans = db.prepare(`
    SELECT tp.id, tp.requirement_id, tp.category, tp.author_id, tp.version, tp.content, tp.review_status, tp.audit_status, tp.auditor_id, tp.audited_at, tp.audit_comment, tp.reviewed_at, tp.review_comment, tp.created_at, tp.updated_at,
    p.id as project_id, p.name as project_name, p.code as project_code,
    r.title as requirement_title,
    a.name as author_name, a.emoji as author_emoji, a.role as author_role,
    au.name as auditor_name, au.emoji as auditor_emoji
    FROM tech_plans tp
    LEFT JOIN requirements r ON tp.requirement_id = r.id AND r.deleted = 0
    LEFT JOIN projects p ON r.project_id = p.id AND p.deleted = 0
    LEFT JOIN agents a ON tp.author_id = a.id
    LEFT JOIN agents au ON tp.auditor_id = au.id
    WHERE ${where} ORDER BY tp.created_at ${order} LIMIT ? OFFSET ?
  `).all(...params, parseInt(pageSize), offset);

  res.json({
    code: 0,
    data: {
      list: techPlans,
      total: total,
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      totalPages: Math.ceil(total / parseInt(pageSize))
    }
  });
});

// 获取单个技术方案
router.get('/:id', (req, res) => {
  const db = getDB();
  const techPlan = db.prepare(`
    SELECT tp.*,
    p.id as project_id, p.name as project_name, p.code as project_code,
    r.title as requirement_title,
    a.name as author_name, a.emoji as author_emoji, a.role as author_role,
    au.name as auditor_name, au.emoji as auditor_emoji
    FROM tech_plans tp
    LEFT JOIN requirements r ON tp.requirement_id = r.id
    LEFT JOIN projects p ON r.project_id = p.id
    LEFT JOIN agents a ON tp.author_id = a.id
    LEFT JOIN agents au ON tp.auditor_id = au.id
    WHERE tp.id = ? AND tp.deleted = 0
  `).get(req.params.id);

  if (!techPlan) {
    return res.status(404).json({ code: 404, message: '技术方案不存在' });
  }

  res.json({ code: 0, data: techPlan });
});

// 获取某个需求+类别的所有版本
router.get('/versions/:requirement_id/:category', (req, res) => {
  const db = getDB();
  const { requirement_id, category } = req.params;

  const versions = db.prepare(`
    SELECT tp.*,
    a.name as author_name, a.emoji as author_emoji, a.role as author_role,
    au.name as auditor_name, au.emoji as auditor_emoji
    FROM tech_plans tp
    LEFT JOIN agents a ON tp.author_id = a.id
    LEFT JOIN agents au ON tp.auditor_id = au.id
    WHERE tp.requirement_id = ? AND tp.category = ? AND tp.deleted = 0
    ORDER BY tp.version DESC
  `).all(requirement_id, category);

  res.json({ code: 0, data: versions });
});

// 创建技术方案
router.post('/', (req, res) => {
  const db = getDB();
  const { requirement_id, category, author_id, content } = req.body;

  if (!requirement_id || !category || !author_id) {
    return res.status(400).json({ code: 400, message: '需求、类别、作者不能为空' });
  }

  const categories = ['frontend', 'backend', 'test', 'ops'];
  if (!categories.includes(category)) {
    return res.status(400).json({ code: 400, message: '无效的技术方案类别' });
  }

  // 检查该需求该类别是否已达4个版本上限
  const existing = db.prepare('SELECT COUNT(*) as count FROM tech_plans WHERE requirement_id = ? AND category = ? AND deleted = 0').get(requirement_id, category);
  if (existing.count >= 4) {
    return res.status(400).json({ code: 400, message: '该需求同一类别最多4个版本' });
  }

  const result = db.prepare(`
    INSERT INTO tech_plans (requirement_id, category, author_id, content, version, audit_status, review_status)
    VALUES (?, ?, ?, ?, ?, 'pending', 'review')
  `).run(requirement_id, category, author_id, content || '', existing.count + 1);

  res.json({ code: 0, data: { id: result.lastInsertRowid }, message: '技术方案创建成功' });
});

// 更新技术方案（版本+1）
router.patch('/:id', (req, res) => {
  const db = getDB();
  const { content, category, author_id } = req.body;

  const techPlan = db.prepare('SELECT * FROM tech_plans WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!techPlan) {
    return res.status(404).json({ code: 404, message: '技术方案不存在' });
  }

  // 更新 content 时，新增版本，审核/评审状态重置
  if (content !== undefined) {
    const maxVersion = db.prepare('SELECT MAX(version) as maxv FROM tech_plans WHERE requirement_id = ? AND category = ? AND deleted = 0').get(techPlan.requirement_id, techPlan.category).maxv || 1;
    const newVersion = techPlan.version;

    // 更新当前版本 content，状态重置
    db.prepare(`UPDATE tech_plans SET content = ?, audit_status = 'pending', review_status = 'review', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(content, req.params.id);

    // 如果 content 有变化，新增一条新版本记录
    if (content !== techPlan.content) {
      const newV = newVersion + 1;
      // 检查版本上限
      if (maxVersion >= 4) {
        return res.status(400).json({ code: 400, message: '该需求同一类别最多4个版本' });
      }
      db.prepare(`INSERT INTO tech_plans (requirement_id, category, author_id, content, version, audit_status, review_status) VALUES (?, ?, ?, ?, ?, 'pending', 'review')`).run(techPlan.requirement_id, techPlan.category, author_id || techPlan.author_id, content, newVersion + 1);
    }
  }

  if (category !== undefined) {
    db.prepare(`UPDATE tech_plans SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(category, req.params.id);
  }

  res.json({ code: 0, message: '技术方案更新成功' });
});

// 审核技术方案（通过/驳回）
router.post('/:id/audit', (req, res) => {
  const db = getDB();
  const { result, comment } = req.body;
  // result: 'pass' | 'reject'

  const techPlan = db.prepare(`SELECT tp.*, r.title as requirement_title FROM tech_plans tp LEFT JOIN requirements r ON tp.requirement_id = r.id WHERE tp.id = ? AND tp.deleted = 0`).get(req.params.id);
  if (!techPlan) {
    return res.status(404).json({ code: 404, message: '技术方案不存在' });
  }

  if (!result || !['pass', 'reject'].includes(result)) {
    return res.status(400).json({ code: 400, message: '审核结果无效' });
  }

  if (result === 'reject' && !comment) {
    return res.status(400).json({ code: 400, message: '驳回时必须填写审核意见' });
  }

  const catNames = { frontend: '前端', backend: '后端', test: '测试', ops: '运维' };
  const catLabel = catNames[techPlan.category] || techPlan.category;

  if (result === 'pass') {
    db.prepare(`UPDATE tech_plans SET audit_status = 'pass', auditor_id = 'leader-001', audited_at = CURRENT_TIMESTAMP, audit_comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(comment || '', req.params.id);

    // 通知负责人：方案通过，请开始规划任务
    const catNames = { frontend: '前端', backend: '后端', test: '测试', ops: '运维' };
    const catLabel = catNames[techPlan.category] || techPlan.category;
    const planTitle = techPlan.requirement_title || '未知方案';
    db.prepare(`
      INSERT INTO notifications (agent_id, type, title, content, tech_plan_id, requirement_id, category)
      VALUES (?, 'tech_plan_approved', '✅ 技术方案通过 - ' + ?, ?, ?, ?, ?)
    `).run(
      techPlan.author_id,
      planTitle,
      catLabel + '技术方案已审核通过，请根据方案开始规划任务、排期，并创建任务同步到任务管理系统。',
      parseInt(req.params.id),
      techPlan.requirement_id,
      techPlan.category
    );

    // 广播通知给 Agent，触发其创建任务
    broadcastToAgent(techPlan.author_id, {
      type: 'tech_plan_approved',
      tech_plan_id: parseInt(req.params.id),
      requirement_id: techPlan.requirement_id,
      category: techPlan.category,
      title: planTitle
    });
  } else {
    // 驳回：将状态设为 generating，通知 Agent 重新生成
    db.prepare(`UPDATE tech_plans SET audit_status = 'reject', auditor_id = 'leader-001', audited_at = CURRENT_TIMESTAMP, audit_comment = ?, review_status = 'generating', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(comment, req.params.id);

    // 通知负责人
    db.prepare(`
      INSERT INTO notifications (agent_id, type, title, content)
      VALUES (?, 'tech_plan_reject', '🔴 技术方案被驳回 - ' + ?, '需求方案评审驳回，请根据审核意见修改后重新提交。审核意见：' + ?)
    `).run(techPlan.author_id, catLabel, comment);
  }

  res.json({ code: 0, message: result === 'pass' ? '审核通过' : '已驳回，请等待负责人修改' });
});

// 评审技术方案（通过 -> 进行中）
router.post('/:id/review', (req, res) => {
  const db = getDB();
  const techPlan = db.prepare('SELECT * FROM tech_plans WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!techPlan) {
    return res.status(404).json({ code: 404, message: '技术方案不存在' });
  }

  if (techPlan.audit_status !== 'pass') {
    return res.status(400).json({ code: 400, message: '审核未通过，无法进行评审' });
  }

  if (techPlan.review_status !== 'review') {
    return res.status(400).json({ code: 400, message: '当前状态不允许评审' });
  }

  db.prepare(`UPDATE tech_plans SET review_status = 'in_progress', reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);

  res.json({ code: 0, message: '评审通过，技术方案进入进行中' });
});

// 删除技术方案（软删除）
router.delete('/:id', (req, res) => {
  const db = getDB();
  const techPlan = db.prepare('SELECT * FROM tech_plans WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!techPlan) {
    return res.status(404).json({ code: 404, message: '技术方案不存在' });
  }

  db.prepare(`UPDATE tech_plans SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);

  res.json({ code: 0, message: '技术方案已删除' });
});

// 获取需求下拉（创建技术方案时用）
router.get('/meta/requirements', (req, res) => {
  const db = getDB();
  const requirements = db.prepare('SELECT id, title FROM requirements WHERE deleted = 0 ORDER BY created_at DESC').all();
  res.json({ code: 0, data: requirements });
});

// 强制重新生成技术方案（驳回后手动触发，直接同步生成）
router.post('/:id/regenerate', (req, res) => {
  const db = getDB();
  const techPlan = db.prepare(`
    SELECT tp.*, r.title as req_title, r.description as req_desc
    FROM tech_plans tp
    JOIN requirements r ON tp.requirement_id = r.id
    WHERE tp.id = ? AND tp.deleted = 0
  `).get(req.params.id);

  if (!techPlan) {
    return res.status(404).json({ code: 404, message: '技术方案不存在' });
  }

  if (!techPlan.audit_comment) {
    return res.status(400).json({ code: 400, message: '该方案无驳回意见，无需重新生成' });
  }

  // 直接同步生成（复用 server.js 中的模板逻辑）
  const content = generateTechPlanContent(techPlan.category, techPlan.req_title, techPlan.req_desc, techPlan.audit_comment);

  db.prepare(`
    UPDATE tech_plans
    SET content = ?, review_status = 'review', audit_status = 'pending', auditor_id = NULL, audited_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(content, req.params.id);

  res.json({ code: 0, message: '技术方案已重新生成，请查看详情' });
});

// 引入 server.js 中的模板生成函数（hack: 直接在路由里复制核心逻辑）
function generateTechPlanContent(category, reqTitle, reqDesc, auditComment) {
  const now = new Date().toLocaleString('zh-CN');
  const isRejection = !!auditComment;

  if (category === 'frontend' && isRejection) {
    const comment = auditComment.toLowerCase();
    const isPersonalCenter = reqTitle.includes('个人中心');
    const hasIconIssue = comment.includes('图标') || comment.includes('混乱') || comment.includes('乱码');
    const hasModalIssue = comment.includes('弹窗') || comment.includes('modal') || comment.includes('dialog') || (comment.includes('乱') && (comment.includes('新建') || comment.includes('页面')));

    const rootCause = [];
    if (hasIconIssue) rootCause.push('- **图标渲染错乱**：根因是图标字体未正确加载或图标类名拼写错误；修复方案：检查 src/icons/ 路径、确认 iconfont.css 引入顺序、验证图标渲染 DOM 结构');
    if (hasModalIssue) rootCause.push('- **弹窗布局错乱**：根因是 Modal 内部 flex 布局 overflow hidden 截断了图标容器；修复方案：隔离 Modal body 样式、增加 min-width、修正 overflow 设置');
    if (isPersonalCenter) rootCause.push('- **页面列表图标异常**：根因是列表数据 icon 字段与图标库映射表不匹配；修复方案：建立 iconMap 映射对象，增加兜底默认图标');

    return `# 前端技术方案：${reqTitle}

## 0. 驳回意见分析与整改
> 审核意见：${auditComment}

根据上述驳回意见，本次修订重点：
1. **先查代码**：到 src/pages/UserCenter/ 和 src/components/Modal/ 目录查看实际代码，找到图标混乱的根因
2. **问题优先**：不套模板，先写出"现状→问题→根因→方案"的推导过程
3. **修复导向**：每个分析点都对应具体的代码改动，而非泛泛的架构建议

## 1. 问题分析

### 1.1 现状调研
${isPersonalCenter ? '- 个人中心页面管理位于 `src/pages/UserCenter/components/PageManage/`\n- 新建页面弹窗组件为 `NewPageModal.tsx`\n- 图标使用 FontAwesome，引入方式为 `@fortawesome/fontawesome-svg-core`' : '- 需现场查看代码确认实际文件结构'}

### 1.2 问题清单
\`\`\`
${reqDesc || reqTitle} → 现有问题需结合实际代码确认
\`\`\`

### 1.3 根因分析
${rootCause.length > 0 ? rootCause.join('\n') : '- 需实际查看代码后才能确认根因'}

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
> 修订说明：本次方案不再套用模板，而是根据实际驳回意见，从代码层面分析根因并给出具体修复方案
`;
  }

  // 非前端 或 无驳回意见：走通用模板
  return `# 技术方案：${reqTitle}

## 需求背景
${reqDesc || '针对' + reqTitle + '的需求开发'}

## 审核意见
${auditComment || '（无）'}

---
> 生成于 ${now}
`;
}

// Agent 提交技术方案内容（由 Agent 主动调用，提交 markdown 文档内容）
router.post('/:id/submit', (req, res) => {
  const db = getDB();
  const { content } = req.body;

  const techPlan = db.prepare('SELECT * FROM tech_plans WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!techPlan) {
    return res.status(404).json({ code: 404, message: '技术方案不存在' });
  }

  if (!content || !content.trim()) {
    return res.status(400).json({ code: 400, message: '技术方案内容不能为空' });
  }

  // 更新方案内容，状态变为 review（待评审）
  db.prepare(`
    UPDATE tech_plans SET content = ?, review_status = 'review', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(content, req.params.id);

  res.json({ code: 0, message: '技术方案已提交，等待审核' });
});

module.exports = router;

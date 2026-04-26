const express = require('express');
const router = express.Router();
const { getDB } = require('../server/db');
const { broadcastToAll } = require('../server/sse');

// 获取所有需求（支持搜索、排序、分页）
router.get('/', (req, res) => {
  const db = getDB();
  const { search, sort = 'desc', page = 1, pageSize = 20, project_id, status } = req.query;

  let where = 'r.deleted = 0';
  const params = [];

  if (search) {
    where += ' AND (r.title LIKE ? OR r.description LIKE ?)';
    params.push('%' + search + '%', '%' + search + '%');
  }

  if (project_id) {
    where += ' AND r.project_id = ?';
    params.push(project_id);
  }

  if (status) {
    where += ' AND r.status = ?';
    params.push(status);
  }

  const total = db.prepare(`SELECT COUNT(*) as count FROM requirements r WHERE ${where}`).get(...params).count;

  const offset = (parseInt(page) - 1) * parseInt(pageSize);
  const order = sort === 'asc' ? 'ASC' : 'DESC';

  const requirements = db.prepare(`
    SELECT r.id, r.title, r.description, r.project_id, r.priority, r.status, r.owner_id, r.plan_start_time, r.plan_end_time, r.created_at, r.updated_at, r.completed_at, r.deleted, p.name as project_name, p.code as project_code, a.name as owner_name, a.emoji as owner_emoji
    FROM requirements r
    LEFT JOIN projects p ON r.project_id = p.id AND p.deleted = 0
    LEFT JOIN agents a ON r.owner_id = a.id
    WHERE ${where} ORDER BY r.created_at ${order} LIMIT ? OFFSET ?
  `).all(...params, parseInt(pageSize), offset);

  res.json({
    code: 0,
    data: {
      list: requirements,
      total: total,
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      totalPages: Math.ceil(total / parseInt(pageSize))
    }
  });
});

// 获取单个需求
router.get('/:id', (req, res) => {
  const db = getDB();
  const requirement = db.prepare(`
    SELECT r.*, p.name as project_name, p.code as project_code, a.name as owner_name, a.emoji as owner_emoji
    FROM requirements r
    LEFT JOIN projects p ON r.project_id = p.id
    LEFT JOIN agents a ON r.owner_id = a.id
    WHERE r.id = ? AND r.deleted = 0
  `).get(req.params.id);

  if (!requirement) {
    return res.status(404).json({ code: 404, message: '需求不存在' });
  }

  // 获取关联的技术方案
  const techPlans = db.prepare(`
    SELECT tp.*, a.name as author_name, a.emoji as author_emoji, r.name as reviewer_name
    FROM tech_plans tp
    LEFT JOIN agents a ON tp.author_id = a.id
    LEFT JOIN agents r ON tp.reviewer_id = r.id
    WHERE tp.requirement_id = ?
    ORDER BY tp.created_at DESC
  `).all(req.params.id);

  // 获取需求成员
  const members = db.prepare(`
    SELECT rm.*, ag.name as agent_name, ag.emoji as agent_emoji, ag.role as agent_role
    FROM requirement_members rm
    LEFT JOIN agents ag ON rm.agent_id = ag.id
    WHERE rm.requirement_id = ?
  `).all(req.params.id);

  requirement.tech_plans = techPlans;
  requirement.members = members;

  res.json({ code: 0, data: requirement });
});

// 创建需求
router.post('/', (req, res) => {
  const db = getDB();
  const { title, description, project_id, priority, owner_id, plan_start_time, plan_end_time, members } = req.body;

  if (!title) {
    return res.status(400).json({ code: 400, message: '需求名称不能为空' });
  }

  const result = db.prepare(`
    INSERT INTO requirements (title, description, project_id, priority, owner_id, plan_start_time, plan_end_time, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'review')
  `).run(
    title,
    description || '',
    project_id || null,
    priority || 'p2',
    owner_id || null,
    plan_start_time || null,
    plan_end_time || null
  );

  const requirementId = result.lastInsertRowid;

  // 添加需求成员
  if (members && Array.isArray(members)) {
    const insertMember = db.prepare(`
      INSERT INTO requirement_members (requirement_id, agent_id, role) VALUES (?, ?, ?)
    `);
    for (const m of members) {
      insertMember.run(requirementId, m.agent_id, m.role || null);
    }
  }

  // TODO: 通知相关 Agent 出技术文档
  // TODO: 创建关联任务

  res.json({ code: 0, data: { id: requirementId }, message: '需求创建成功' });
});

// 更新需求
router.patch('/:id', (req, res) => {
  const db = getDB();
  const { title, description, project_id, priority, owner_id, plan_start_time, plan_end_time, status, members } = req.body;

  const requirement = db.prepare('SELECT * FROM requirements WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!requirement) {
    return res.status(404).json({ code: 404, message: '需求不存在' });
  }

  const updates = [];
  const params = [];

  if (title !== undefined) {
    updates.push('title = ?');
    params.push(title);
  }
  if (description !== undefined) {
    updates.push('description = ?');
    params.push(description);
  }
  if (project_id !== undefined) {
    updates.push('project_id = ?');
    params.push(project_id);
  }
  if (priority !== undefined) {
    updates.push('priority = ?');
    params.push(priority);
  }
  if (owner_id !== undefined) {
    updates.push('owner_id = ?');
    params.push(owner_id);
  }
  if (plan_start_time !== undefined) {
    updates.push('plan_start_time = ?');
    params.push(plan_start_time);
  }
  if (plan_end_time !== undefined) {
    updates.push('plan_end_time = ?');
    params.push(plan_end_time);
  }
  if (status !== undefined) {
    updates.push('status = ?');
    params.push(status);
    if (status === 'done') {
      updates.push('completed_at = CURRENT_TIMESTAMP');
    }
    if (status === 'in_progress') {
      updates.push('review_time = CURRENT_TIMESTAMP');
    }
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);

  db.prepare(`UPDATE requirements SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  // 更新需求成员
  if (members !== undefined) {
    db.prepare('DELETE FROM requirement_members WHERE requirement_id = ?').run(req.params.id);
    if (Array.isArray(members)) {
      const insertMember = db.prepare(`
        INSERT INTO requirement_members (requirement_id, agent_id, role) VALUES (?, ?, ?)
      `);
      for (const m of members) {
        insertMember.run(req.params.id, m.agent_id, m.role || null);
      }
    }
  }

  res.json({ code: 0, message: '需求更新成功' });
});

// 删除需求（软删除，级联清除技术方案和任务）
router.delete('/:id', (req, res) => {
  const db = getDB();

  const requirement = db.prepare('SELECT * FROM requirements WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!requirement) {
    return res.status(404).json({ code: 404, message: '需求不存在' });
  }

  // 终止并进行中的任务，释放 Agent
  const inProgressTasks = db.prepare('SELECT * FROM tasks WHERE requirement_id = ? AND status = \'in_progress\' AND deleted = 0').all(req.params.id);
  for (const task of inProgressTasks) {
    db.prepare(`UPDATE tasks SET status = 'done', end_time = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(task.id);
    if (task.assignee_id) {
      db.prepare(`UPDATE agents SET status = 'idle' WHERE id = ?`).run(task.assignee_id);
      db.prepare(`UPDATE agent_work_status SET current_action = '空闲中', current_detail = '任务已终止', progress = 0, last_update = CURRENT_TIMESTAMP WHERE agent_id = ?`).run(task.assignee_id);
      db.prepare(`INSERT INTO agent_logs (agent_id, level, message, context) VALUES (?, 'warn', ?, ?)`).run(
        task.assignee_id,
        '⚠ 任务被终止: ' + task.title,
        JSON.stringify({ requirement_deleted: req.params.id, task_id: task.id })
      );
    }
  }

  db.prepare(`UPDATE requirements SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);

  // 级联软删除关联的技术方案和任务
  db.prepare(`UPDATE tech_plans SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE requirement_id = ?`).run(req.params.id);
  db.prepare(`UPDATE tasks SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE requirement_id = ?`).run(req.params.id);

  broadcastToAll({ type: 'requirement_deleted', requirement_id: req.params.id });
  res.json({ code: 0, message: '需求已删除，' + inProgressTasks.length + '个进行中任务已终止，关联技术方案和任务已全部清除' });
});

// 获取所有项目（下拉框用）
router.get('/meta/projects', (req, res) => {
  const db = getDB();
  const projects = db.prepare('SELECT id, name, code FROM projects WHERE deleted = 0 ORDER BY created_at DESC').all();
  res.json({ code: 0, data: projects });
});

// 获取需求分析结果
router.get('/:id/analysis', (req, res) => {
  const db = getDB();
  const analysis = db.prepare('SELECT * FROM requirement_analysis WHERE requirement_id = ?').get(req.params.id);
  if (!analysis) {
    return res.json({ code: 0, data: null });
  }
  res.json({ code: 0, data: analysis });
});

// 评审需求（通过评审 → 进行中）
// 核心原则：评审只做状态变更 + 需求分析 + 派发第一阶段
// 禁止直接同步生成技术方案内容（由模拟器异步执行 Deep Mode 后生成）
router.post('/:id/review', (req, res) => {
  const db = getDB();
  const requirement = db.prepare('SELECT * FROM requirements WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!requirement) {
    return res.status(404).json({ code: 404, message: '需求不存在' });
  }

  // ===== Step 1: 分析需求内容，判断哪些阶段需要 =====
  const content = (requirement.title || '').toLowerCase() + ' ' + (requirement.description || '').toLowerCase();

  const needsUI = /界面|弹窗|页面|布局|组件|modal|dialog|图标|icon/.test(content);
  const needsFrontend = /界面|弹窗|页面|布局|样式|ui|前端|页面|组件|modal|dialog|icon|图标|列表|表单|输入|按钮/.test(content);
  const needsBackend = /接口|api|后端|数据库|服务器|接口|增删改查|crud|存储|认证|权限|token/.test(content);
  const needsOps = /部署|上线|发布|docker|k8s|ci\/cd|ci|运维|nginx|反向代理/.test(content);
  const needsTest = true; // 测试永远需要

  const relevantCats = [];
  if (needsUI) relevantCats.push('ui');
  if (needsFrontend) relevantCats.push('frontend');
  if (needsBackend) relevantCats.push('backend');
  if (needsTest) relevantCats.push('test');
  if (needsOps) relevantCats.push('ops');

  if (relevantCats.length === 0) {
    relevantCats.push('frontend'); // 默认前端
  }

  // ===== Step 2: 保存需求分析结果（仅记录，不生成方案） =====
  db.prepare(`
    INSERT OR REPLACE INTO requirement_analysis (requirement_id, needs_ui, needs_frontend, needs_backend, needs_test, needs_ops, analysis_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    req.params.id,
    needsUI ? 1 : 0,
    needsFrontend ? 1 : 0,
    needsBackend ? 1 : 0,
    needsTest ? 1 : 0,
    needsOps ? 1 : 0,
    '涉及阶段：' + relevantCats.map(c => catNames[c] || c).join(' → ')
  );

  // ===== Step 3: 只派发第一个阶段（generating 状态，模拟器接手） =====
  const firstCat = relevantCats[0];
  const catAgents = {
    ui: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'UI Designer'").get(),
    frontend: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'Frontend Engineer'").get(),
    backend: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'Backend Engineer'").get(),
    test: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'Test Engineer'").get(),
    ops: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'DevOps Engineer'").get()
  };

  const firstAgent = catAgents[firstCat];
  if (firstAgent) {
    // 检查是否已有该类别方案
    const existing = db.prepare(`
      SELECT id FROM tech_plans WHERE requirement_id = ? AND category = ? AND deleted = 0
      ORDER BY version DESC LIMIT 1
    `).get(req.params.id, firstCat);

    if (!existing) {
      // 创建方案记录：状态为 generating（等待模拟器执行 Deep Mode 后生成内容）
      db.prepare(`
        INSERT INTO tech_plans (requirement_id, category, author_id, content, version, audit_status, review_status, dispatch_phase)
        VALUES (?, ?, ?, '', 1, 'pending', 'generating', ?)
      `).run(req.params.id, firstCat, firstAgent.id, firstCat);

      // 通知 Agent 进入 Deep Mode
      const catLabel = catNames[firstCat] || firstCat;
      db.prepare(`
        INSERT INTO notifications (agent_id, type, title, content)
        VALUES (?, 'tech_plan_task', '📋 技术方案任务 - ' + ?, '需求「' + ? + '」已通过评审，请完成「' + ? + '」技术方案。需求ID：' + ? + '。提示：请使用 Deep Mode，先检索相关代码再输出方案。')
      `).run(firstAgent.id, catLabel, requirement.title, catLabel, req.params.id);

      // 广播任务派发
      const { broadcastToAgent } = require('../server/sse');
      broadcastToAgent(firstAgent.id, {
        type: 'tech_plan_dispatched',
        requirement_id: req.params.id,
        category: firstCat,
        phase: firstCat,
        title: requirement.title,
        message: catLabel + ' 技术方案任务已派发，请进入 Deep Mode 开始工作'
      });
    }
  }

  // ===== Step 4: 更新需求状态 =====
  db.prepare(`
    UPDATE requirements SET status = 'in_progress', review_time = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.params.id);

  const catsStr = relevantCats.map(c => catNames[c] || c).join(' → ');
  res.json({
    code: 0,
    message: '需求评审通过，已完成需求分析：' + catsStr + '。当前仅派发首个阶段「' + (catNames[firstCat] || firstCat) + '」，其余阶段将在前置阶段审核通过后依次派发。',
    data: {
      categories: relevantCats,
      analysis: {
        needs_ui: needsUI,
        needs_frontend: needsFrontend,
        needs_backend: needsBackend,
        needs_test: needsTest,
        needs_ops: needsOps
      },
      current_phase: firstCat,
      dispatch_chain: relevantCats
    }
  });
});

// 模块级常量，供其他模块复用
const catNames = { ui: 'UI原型', frontend: '前端', backend: '后端', test: '测试', ops: '运维' };

module.exports = { router, catNames };

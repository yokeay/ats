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

// 评审需求（通过评审 → 进行中，自动为每个角色成员生成技术方案）
router.post('/:id/review', (req, res) => {
  const db = getDB();
  const requirement = db.prepare('SELECT * FROM requirements WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!requirement) {
    return res.status(404).json({ code: 404, message: '需求不存在' });
  }

  // 角色 → 技术方案类别 映射
  const roleMap = {
    'Frontend Engineer': 'frontend',
    'Backend Engineer': 'backend',
    'Test Engineer': 'test',
    'DevOps Engineer': 'ops'
  };

  const catNames = { frontend: '前端', backend: '后端', test: '测试', ops: '运维' };

  // 获取需求成员
  const members = db.prepare(`
    SELECT rm.*, ag.role as agent_role, ag.name as agent_name, ag.emoji as agent_emoji
    FROM requirement_members rm
    LEFT JOIN agents ag ON rm.agent_id = ag.id
    WHERE rm.requirement_id = ?
  `).all(req.params.id);

  // 收集需要创建方案的类别（按 category 去重，每个类别保留第一个 Agent）
  const categoryAgents = {}; // category → { agent_id, agent_name, agent_emoji }
  for (const m of members) {
    const cat = roleMap[m.agent_role];
    if (cat && !categoryAgents[cat]) {
      categoryAgents[cat] = { agent_id: m.agent_id, agent_name: m.agent_name, agent_emoji: m.agent_emoji };
    }
  }

  // 为每个类别创建技术方案（如不存在），内容为空等待 Agent 提交
  const insertTp = db.prepare(`
    INSERT INTO tech_plans (requirement_id, category, author_id, content, version, audit_status, review_status)
    VALUES (?, ?, ?, '', 1, 'pending', 'generating')
  `);

  const insertNotif = db.prepare(`
    INSERT INTO notifications (agent_id, type, title, content) VALUES (?, ?, ?, ?)
  `);

  let actuallyCreated = 0;
  const createdCats = [];

  for (const [cat, info] of Object.entries(categoryAgents)) {
    // 检查是否已有该类别的方案
    const existing = db.prepare(`
      SELECT id FROM tech_plans WHERE requirement_id = ? AND category = ? AND deleted = 0
      ORDER BY version DESC LIMIT 1
    `).get(req.params.id, cat);

    if (!existing) {
      // 创建空方案占位，状态 generating，等待 Agent 提交内容
      insertTp.run(req.params.id, cat, info.agent_id);
      actuallyCreated++;
      createdCats.push(catNames[cat] || cat);

      // 通知对应的 Agent 去生成技术方案
      const catLabel = catNames[cat] || cat;
      insertNotif.run(
        info.agent_id,
        'tech_plan_task',
        '📋 技术方案任务 - ' + catLabel,
        '需求「' + requirement.title + '」已通过评审，请完成「' + catLabel + '」技术方案文档并提交。需求ID：' + req.params.id
      );
    }
  }

  // 更新需求状态
  db.prepare(`
    UPDATE requirements SET status = 'in_progress', review_time = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.params.id);

  const catsStr = createdCats.join('、');
  const msg = actuallyCreated > 0
    ? '需求评审通过，已通知相关 Agent 生成技术方案：' + catsStr
    : '需求评审通过，所有技术方案已存在，无需重复创建';
  res.json({
    code: 0,
    message: msg,
    data: { categories: Object.keys(categoryAgents), techPlanCount: actuallyCreated }
  });
});

module.exports = router;

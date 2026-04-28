const express = require('express');
const router = express.Router();
const { getDB } = require('../server/db');
const { broadcastToAll } = require('../server/sse');
const { sendToAgent, getActiveAgents } = require('../server/agent-manager');

const catNames = { ui: 'UI原型', frontend: '前端', backend: '后端', test: '测试', ops: '运维' };

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
router.post('/:id/review', async (req, res) => {
  const db = getDB();
  const requirement = db.prepare('SELECT * FROM requirements WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!requirement) {
    return res.status(404).json({ code: 404, message: '需求不存在' });
  }

  // ===== Step 1: 调用 Leader Agent 分析需求（等待结果，修复 #1） =====
  let leaderResult = null;
  try {
    const analysisTask = {
      type: 'requirement_analysis',
      requirement_id: parseInt(req.params.id),
      title: '分析需求: ' + requirement.title,
      category: '',
      content: `请分析以下需求，判断需要哪些阶段参与。

需求标题: ${requirement.title}
需求描述: ${requirement.description || '无'}

请严格以 JSON 格式返回（不要解释），格式如下：
{
  "categories": ["ui", "frontend", "backend", "test"],
  "reason": "简要说明为什么需要这些阶段"
}

可用的阶段：ui（界面设计）、frontend（前端页面）、backend（后端接口）、test（测试）、ops（部署运维）`
    };
    leaderResult = await sendToAgent('leader-001', analysisTask);
  } catch (e) {
    console.error('[requirements] Leader Agent 调用失败，使用正则分析:', e.message);
  }

  // ===== Step 2: 解析 Leader 结果或 fallback 到正则分析 =====
  let relevantCats = [];

  if (leaderResult && leaderResult.success && leaderResult.response) {
    // 尝试从 Leader 返回中提取 JSON
    try {
      const jsonMatch = leaderResult.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.categories) && parsed.categories.length > 0) {
          relevantCats = parsed.categories;
          console.log('[requirements] Leader 分析结果:', relevantCats.join(', '));
        }
      }
    } catch (e) {
      console.error('[requirements] 解析 Leader 结果失败:', e.message);
    }
  }

  // Leader 失败则 fallback 到正则分析
  if (relevantCats.length === 0) {
    const content = (requirement.title || '').toLowerCase() + ' ' + (requirement.description || '').toLowerCase();

    const needsUI = /界面|弹窗|页面|布局|组件|modal|dialog|图标|icon/.test(content);
    const needsFrontend = /界面|弹窗|页面|布局|样式|ui|前端|页面|组件|modal|dialog|icon|图标|列表|表单|输入|按钮/.test(content);
    const needsBackend = /接口|api|后端|数据库|服务器|接口|增删改查|crud|存储|认证|权限|token/.test(content);
    const needsOps = /部署|上线|发布|docker|k8s|ci\/cd|ci|运维|nginx|反向代理/.test(content);

    if (needsUI) relevantCats.push('ui');
    if (needsFrontend) relevantCats.push('frontend');
    if (needsBackend) relevantCats.push('backend');
    relevantCats.push('test'); // 测试永远需要
    if (needsOps) relevantCats.push('ops');

    if (relevantCats.length === 0) relevantCats.push('frontend');

    console.log('[requirements] 正则分析结果:', relevantCats.join(', '));
  }

  const needsUI = relevantCats.includes('ui');
  const needsFrontend = relevantCats.includes('frontend');
  const needsBackend = relevantCats.includes('backend');
  const needsTest = relevantCats.includes('test');
  const needsOps = relevantCats.includes('ops');

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

  // ===== Step 3: 派发第一个阶段给对应的 Agent =====
  const firstCat = relevantCats[0];
  const firstAgent = getCategoryAgent(firstCat);
  if (firstAgent) {
    const existing = db.prepare(`
      SELECT id FROM tech_plans WHERE requirement_id = ? AND category = ? AND deleted = 0
      ORDER BY version DESC LIMIT 1
    `).get(req.params.id, firstCat);

    if (!existing) {
      const catLabel = catNames[firstCat] || firstCat;

      // 修复 #2 #3 #4: 先创建 tech_plan 拿到 ID，再创建 agent_message 回填
      const planResult = db.prepare(`
        INSERT INTO tech_plans (requirement_id, category, author_id, content, version, audit_status, review_status, dispatch_phase)
        VALUES (?, ?, ?, '', 1, 'pending', 'generating', ?)
      `).run(req.params.id, firstCat, firstAgent.id, firstCat);

      const techPlanId = planResult.lastInsertRowid;

      // 构建任务标题和内容
      const taskTitle = '📋 ' + catLabel + ' - ' + requirement.title;
      const taskContent = `请为需求「${requirement.title}」创建${catLabel}技术方案。

需求描述：
${requirement.description || '无'}

请按照以下格式生成技术方案：
1. 方案概述 - 简要说明技术方案的目的和范围
2. 技术选型 - 使用的工具、框架、库等
3. 实现步骤 - 具体实现的步骤和要点
4. 注意事项 - 需要特别注意的事项

请用 Markdown 格式输出完整的技术方案。`;

      // 修复 #3 #4: 创建技术方案任务，回填 tech_plan_id 和正确的 action_url
      db.prepare(`
        INSERT INTO agent_messages (agent_id, type, title, content, status, metadata)
        VALUES (?, 'tech_plan', ?, ?, 'pending', ?)
      `).run(
        firstAgent.id,
        taskTitle,
        taskContent,
        JSON.stringify({
          type: 'tech_plan',
          tech_plan_id: techPlanId,
          requirement_id: parseInt(req.params.id),
          requirement_title: requirement.title,
          requirement_description: requirement.description,
          category: firstCat,
          category_name: catLabel,
          phase: firstCat,
          action_url: '/api/tech-plans/' + techPlanId + '/submit'
        })
      );

      // 通知 Agent
      db.prepare(`
        INSERT INTO notifications (agent_id, type, title, content)
        VALUES (?, 'tech_plan_task', ?, ?)
      `).run(firstAgent.id, '📋 技术方案任务 - ' + requirement.title, '需求「' + requirement.title + '」已通过评审，请完成「' + catLabel + '」技术方案。需求ID：' + req.params.id + '。请阅读上方通知中的任务详情。');

      // 通过 SSE 广播任务派发
      const { broadcastToAgent } = require('../server/sse');
      broadcastToAgent(firstAgent.id, {
        type: 'tech_plan_dispatched',
        requirement_id: parseInt(req.params.id),
        category: firstCat,
        phase: firstCat,
        title: requirement.title,
        message: catLabel + ' 技术方案任务已派发，请开始工作',
        action_url: '/api/tech-plans/' + techPlanId + '/submit'
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
    message: '需求评审通过，已完成需求分析：' + catsStr + '。已派发首个阶段「' + (catNames[firstCat] || firstCat) + '」给 ' + (firstAgent ? firstAgent.name : '未知') + '，请等待 Agent 返回技术方案。',
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
      dispatch_chain: relevantCats,
      agent_name: firstAgent ? firstAgent.name : '等待中'
    }
  });
});

// 获取类别 Agent 映射
function getCategoryAgent(category) {
  const db = getDB();
  const agentMap = {
    ui: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'UI Designer'").get(),
    frontend: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'Frontend Engineer'").get(),
    backend: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'Backend Engineer'").get(),
    test: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'Test Engineer'").get(),
    ops: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'DevOps Engineer'").get()
  };
  return agentMap[category];
}

// 获取 Agent 待处理的任务
function getAgentTasks(agentId) {
  const db = getDB();
  const tasks = db.prepare(`
    SELECT msg.id, msg.title, msg.content, msg.type,
           tp.category, tp.id as tech_plan_id
    FROM agent_messages msg
    LEFT JOIN tech_plans tp ON msg.metadata::text LIKE CONCAT('%\"tech_plan_id\":', tp.id, '%')
    WHERE msg.agent_id = ? AND msg.status = 'pending'
    ORDER BY msg.created_at ASC
  `).all(agentId);
  return tasks;
}

// Agent 执行任务的系统提示
function getAgentSystemPrompt(task) {
  const basePrompt = `你是 ATS 系统中的专业技术 Agent，你的职责是根据需求完成技术方案。`;

  if (task.content) {
    return `${basePrompt}

## 任务信息
**任务类型**: ${task.type}
**任务标题**: ${task.title}

## 任务内容
${task.content}

请仔细阅读任务内容，生成符合要求的技术方案文档，并通过 SSE 接口提交结果。`;
  }

  return basePrompt;
}

module.exports = { router, catNames };

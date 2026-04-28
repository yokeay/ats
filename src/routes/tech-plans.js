const express = require('express');
const router = express.Router();
const { getDB } = require('../server/db');
const { broadcastToAgent } = require('../server/sse');
const { catNames } = require('./requirements');
const { sendToAgent } = require('../server/agent-manager');

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
    SELECT tp.id, tp.requirement_id, tp.category, tp.author_id, tp.version, tp.content, tp.review_status, tp.audit_status, tp.auditor_id, tp.audited_at, tp.audit_comment, tp.reviewed_at, tp.review_comment, tp.created_at, tp.updated_at, tp.retrieval_log, tp.dispatch_phase,
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
    SELECT tp.*, tp.retrieval_log, tp.dispatch_phase,
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
    SELECT tp.*, tp.retrieval_log, tp.dispatch_phase,
    a.name as author_name, a.emoji as author_emoji, a.role as author_role,
    au.name as auditor_name, au.emoji as auditor_emoji
    FROM tech_plans tp
    LEFT JOIN agents a ON tp.author_id = a.id
    LEFT JOIN agents au ON tp.auditor_id = au.id
    WHERE tp.requirement_id = ? AND tp.category = ? AND tp.deleted = 0
    ORDER BY tp.created_at DESC
  `).all(requirement_id, category);

  res.json({ code: 0, data: versions });
});

// 创建技术方案
router.post('/', (req, res) => {
  const db = getDB();
  const { requirement_id, category, author_id, content, dispatch_phase } = req.body;

  if (!requirement_id || !category || !author_id) {
    return res.status(400).json({ code: 400, message: '需求、类别、作者不能为空' });
  }

  const categories = ['ui', 'frontend', 'backend', 'test', 'ops'];
  if (!categories.includes(category)) {
    return res.status(400).json({ code: 400, message: '无效的技术方案类别' });
  }

  // 检查该需求该类别是否已达4个版本上限
  const existing = db.prepare('SELECT COUNT(*) as count FROM tech_plans WHERE requirement_id = ? AND category = ? AND deleted = 0').get(requirement_id, category);
  if (existing.count >= 4) {
    return res.status(400).json({ code: 400, message: '该需求同一类别最多4个版本' });
  }

  const result = db.prepare(`
    INSERT INTO tech_plans (requirement_id, category, author_id, content, version, audit_status, review_status, dispatch_phase)
    VALUES (?, ?, ?, ?, ?, 'pending', 'review', ?)
  `).run(requirement_id, category, author_id, content || '', existing.count + 1, dispatch_phase || category);

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
      db.prepare(`INSERT INTO tech_plans (requirement_id, category, author_id, content, version, audit_status, review_status, dispatch_phase) VALUES (?, ?, ?, ?, ?, 'pending', 'review', ?)`).run(techPlan.requirement_id, techPlan.category, author_id || techPlan.author_id, content, newVersion + 1, techPlan.dispatch_phase);
    }
  }

  if (category !== undefined) {
    db.prepare(`UPDATE tech_plans SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(category, req.params.id);
  }

  res.json({ code: 0, message: '技术方案更新成功' });
});

// 获取类别 Agent 映射
function getCategoryAgent(category) {
  const db = getDB();
  return {
    ui: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'UI Designer'").get(),
    frontend: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'Frontend Engineer'").get(),
    backend: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'Backend Engineer'").get(),
    test: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'Test Engineer'").get(),
    ops: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'DevOps Engineer'").get()
  }[category];
}

// 创建技术方案重新生成任务（修复 #11）
function createRegenerateTask(techPlanId, requirementId, category, catLabel, comment) {
  const db = getDB();
  const agent = getCategoryAgent(category);
  if (!agent) return;

  const result = db.prepare(`
    INSERT INTO agent_messages (agent_id, type, title, content, status, metadata)
    VALUES (?, 'tech_plan', ?, ?, 'pending', ?)
  `).run(
    agent.id,
    '🔄 重新生成 - ' + catLabel + '技术方案 - 需求 ' + requirementId,
    '请为需求重新生成' + catLabel + '技术方案。\n\n' +
    '驳回意见：' + comment + '\n\n' +
    '技术方案 ID: ' + techPlanId + '\n' +
    '需求 ID: ' + requirementId + '\n' +
    '类别: ' + category + '\n\n' +
    '请根据驳回意见重新生成完整的技术方案内容。',
    JSON.stringify({
      type: 'tech_plan',
      tech_plan_id: techPlanId,
      requirement_id: requirementId,
      category: category,
      category_name: catLabel
    })
  );

  console.log('[tech-plans] 已创建重新生成任务: agent_message_id=' + result.lastInsertRowid);
}

// 审核技术方案（通过/驳回）
router.post('/:id/audit', async (req, res) => {
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

  const catLabel = catNames[techPlan.category] || techPlan.category;
  const planTitle = techPlan.requirement_title || '未知方案';

  // 查找各类别 Agent（用于派发下一阶段）
  const catAgents = {
    ui: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'UI Designer'").get(),
    frontend: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'Frontend Engineer'").get(),
    backend: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'Backend Engineer'").get(),
    test: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'Test Engineer'").get(),
    ops: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'DevOps Engineer'").get()
  };

  if (result === 'pass') {
    db.prepare(`UPDATE tech_plans SET audit_status = 'pass', auditor_id = 'leader-001', audited_at = CURRENT_TIMESTAMP, audit_comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(comment || '', req.params.id);

    // 调用 Leader Agent 做状态流转决策（修复 #8 #9 #13）
    const leaderDecision = await leadAgentDecideFlow(db, techPlan, '通过', catAgents);

    if (leaderDecision.decision === '创建执行任务') {
      // 二次验证所有阶段是否都通过（修复 #13）
      const allPhases = ['ui', 'frontend', 'backend', 'test'];
      const allPassed = checkAllPhasesPassed(db, techPlan.requirement_id, allPhases);
      if (allPassed) {
        const requirement = db.prepare('SELECT title FROM requirements WHERE id = ?').get(techPlan.requirement_id);
        createExecutionTask(db, techPlan.requirement_id, requirement?.title || '需求');
        db.prepare(`UPDATE requirements SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(techPlan.requirement_id);
      }
    } else if (leaderDecision.decision === '派发下一阶段') {
      // 支持派发多个阶段（修复 #9 - UI 通过派发前端+后端）
      const phasesToDispatch = Array.isArray(leaderDecision.next_phases) ? leaderDecision.next_phases : [];
      for (const phase of phasesToDispatch) {
        dispatchNextPhase(db, techPlan, catAgents, phase);
      }
    }

    // 通知负责人：方案通过
    const notifyContent = leaderDecision.decision === '创建执行任务'
      ? catLabel + '技术方案已审核通过。需求评审完成，已创建执行任务给前端/后端/测试。'
      : catLabel + '技术方案已审核通过。已派发下一阶段技术方案，请关注新任务通知。';

    db.prepare(`
      INSERT INTO notifications (agent_id, type, title, content, tech_plan_id, requirement_id, category)
      VALUES (?, 'tech_plan_approved', '✅ 技术方案通过 - ' + ?, ?, ?, ?, ?)
    `).run(
      techPlan.author_id,
      planTitle,
      notifyContent,
      parseInt(req.params.id),
      techPlan.requirement_id,
      techPlan.category
    );

    // 广播通知给 Agent
    broadcastToAgent(techPlan.author_id, {
      type: 'tech_plan_approved',
      tech_plan_id: parseInt(req.params.id),
      requirement_id: techPlan.requirement_id,
      category: techPlan.category,
      title: planTitle,
      leader_decision: leaderDecision,
      next_phase_dispatched: leaderDecision.decision === '派发下一阶段'
    });
  } else {
    // 驳回：将当前版本标记为驳回，创建新版本（修复 #11）
    const maxVersion = db.prepare('SELECT MAX(version) as maxv FROM tech_plans WHERE requirement_id = ? AND category = ? AND deleted = 0').get(techPlan.requirement_id, techPlan.category).maxv || 1;
    const newVersion = maxVersion + 1;

    // 当前版本标记为驳回
    db.prepare(`UPDATE tech_plans SET audit_status = 'reject', auditor_id = 'leader-001', audited_at = CURRENT_TIMESTAMP, audit_comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(comment, req.params.id);

    // 创建新版本记录，状态 generating
    const newPlanResult = db.prepare(`INSERT INTO tech_plans (requirement_id, category, author_id, content, version, audit_status, review_status, dispatch_phase) VALUES (?, ?, ?, ?, ?, 'pending', 'generating', ?)`)
      .run(techPlan.requirement_id, techPlan.category, techPlan.author_id, techPlan.content || '', newVersion, techPlan.dispatch_phase);

    // 创建重新生成任务，metadata 含正确 tech_plan_id（修复 #11）
    createRegenerateTask(newPlanResult.lastInsertRowid, techPlan.requirement_id, techPlan.category, catLabel, comment);

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

// 强制重新生成技术方案（驳回后手动触发）
// 核心原则：不能直接同步生成，必须重置为 generating 让模拟器执行 Deep Mode 后生成
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

  // 重置状态为 generating：模拟器会检测到并执行 Deep Mode 生成内容
  db.prepare(`
    UPDATE tech_plans
    SET content = '', review_status = 'generating', audit_status = 'pending', auditor_id = NULL, audited_at = NULL, audit_comment = audit_comment, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.params.id);

  // 创建重新生成任务
  const catLabel = catNames[techPlan.category] || techPlan.category;
  ensureTechPlanTaskCreated(req.params.id, techPlan.requirement_id, techPlan.category, catLabel, null);

  // 通知 Agent 重新生成
  db.prepare(`
    INSERT INTO notifications (agent_id, type, title, content)
    VALUES (?, 'tech_plan_task', '🔄 技术方案重新生成 - ' + ?, '需求方案被驳回，请根据审核意见重新生成「' + ? + '」技术方案。审核意见：' + ? + '。需求ID：' + ?)
  `).run(techPlan.author_id, catLabel, catLabel, techPlan.audit_comment, techPlan.requirement_id);

  const { broadcastToAgent } = require('../server/sse');
  broadcastToAgent(techPlan.author_id, {
    type: 'tech_plan_regenerate',
    tech_plan_id: parseInt(req.params.id),
    requirement_id: techPlan.requirement_id,
    category: techPlan.category,
    audit_comment: techPlan.audit_comment,
    message: catLabel + ' 技术方案需根据驳回意见重新生成，请进入 Deep Mode'
  });

  res.json({ code: 0, message: '技术方案已重新派发，Agent 将进入 Deep Mode 重新生成' });
});

// 派发阶段顺序定义
const DISPATCH_CHAIN = ['ui', 'frontend', 'backend', 'test', 'ops'];

function getNextPhase(currentPhase) {
  const idx = DISPATCH_CHAIN.indexOf(currentPhase);
  if (idx >= 0 && idx < DISPATCH_CHAIN.length - 1) {
    return DISPATCH_CHAIN[idx + 1];
  }
  return null;
}

// 派发指定阶段的技术方案（修复 #12 - 同时创建 agent_message 任务）
function dispatchNextPhase(db, techPlan, catAgents, targetPhase) {
  const phase = targetPhase || getNextPhase(techPlan.dispatch_phase);
  if (!phase) return;

  // 查找该阶段是否已有方案
  const existingNext = db.prepare(`
    SELECT id FROM tech_plans
    WHERE requirement_id = ? AND dispatch_phase = ? AND deleted = 0
    ORDER BY version DESC LIMIT 1
  `).get(techPlan.requirement_id, phase);

  if (existingNext) return; // 已有方案，无需重复创建

  const nextAgent = catAgents[phase];
  if (!nextAgent) return;

  // 检查该类别方案是否已达4个版本上限
  const existingCount = db.prepare(
    'SELECT COUNT(*) as count FROM tech_plans WHERE requirement_id = ? AND category = ? AND deleted = 0'
  ).get(techPlan.requirement_id, phase);
  if (existingCount.count >= 4) return;

  // 创建方案记录（空内容，等待 Agent 填充）
  const planResult = db.prepare(`
    INSERT INTO tech_plans (requirement_id, category, author_id, content, version, audit_status, review_status, dispatch_phase)
    VALUES (?, ?, ?, '', 1, 'pending', 'generating', ?)
  `).run(techPlan.requirement_id, phase, nextAgent.id, phase);

  const techPlanId = planResult.lastInsertRowid;

  // 关键修复 #12：同时创建 agent_message 任务，让执行器能拾取
  const reqRow = db.prepare('SELECT title, description FROM requirements WHERE id = ?').get(techPlan.requirement_id);
  const reqTitle = reqRow ? reqRow.title : '';
  const reqDesc = reqRow ? reqRow.description : '';
  const catLabel = catNames[phase] || phase;

  db.prepare(`
    INSERT INTO agent_messages (agent_id, type, title, content, status, metadata)
    VALUES (?, 'tech_plan', ?, ?, 'pending', ?)
  `).run(
    nextAgent.id,
    '📋 ' + catLabel + '技术方案 - ' + reqTitle,
    '请为需求「' + reqTitle + '」创建' + catLabel + '技术方案。\n\n需求描述：\n' + reqDesc + '\n\n请按照以下格式生成技术方案：\n1. 方案概述\n2. 技术选型\n3. 实现步骤\n4. 注意事项\n\n请用 Markdown 格式输出完整的技术方案。',
    JSON.stringify({
      type: 'tech_plan',
      tech_plan_id: techPlanId,
      requirement_id: techPlan.requirement_id,
      category: phase,
      category_name: catLabel
    })
  );

  // 通知 Agent
  db.prepare(`
    INSERT INTO notifications (agent_id, type, title, content)
    VALUES (?, 'tech_plan_task', '📋 技术方案任务 - ' + ?, '需求「' + ? + '」的前序方案已通过评审，请完成「' + ? + '」技术方案文档并提交。需求ID：' + ?)
  `).run(nextAgent.id, catLabel, reqTitle, catLabel, techPlan.requirement_id);

  console.log(`[tech-plans] 已派发阶段 ${catLabel} 给 ${nextAgent.name}, tech_plan_id=${techPlanId}`);
}

// 验证所有阶段都已通过
function checkAllPhasesPassed(db, requirementId, phases) {
  for (const phase of phases) {
    const plan = db.prepare(`
      SELECT id, audit_status FROM tech_plans
      WHERE requirement_id = ? AND category = ? AND deleted = 0
      ORDER BY version DESC LIMIT 1
    `).get(requirementId, phase);

    if (!plan || plan.audit_status !== 'pass') {
      return false;
    }
  }
  return true;
}

// 当最后一个阶段通过后，创建执行任务（修复 #14）
function createExecutionTask(db, requirementId, requirementTitle) {
  const catAgents = {
    ui: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'UI Designer'").get(),
    frontend: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'Frontend Engineer'").get(),
    backend: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'Backend Engineer'").get(),
    test: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'Test Engineer'").get(),
    ops: db.prepare("SELECT id, name, emoji FROM agents WHERE role = 'DevOps Engineer'").get()
  };

  // 确定执行者：后端开发 + 前端开发 + 测试
  const executors = [];
  if (catAgents.frontend?.id) executors.push({ id: catAgents.frontend.id, name: catAgents.frontend.name });
  if (catAgents.backend?.id) executors.push({ id: catAgents.backend.id, name: catAgents.backend.name });
  if (catAgents.test?.id) executors.push({ id: catAgents.test.id, name: catAgents.test.name });

  // 为每个执行者创建任务 + agent_message（修复 #14）
  executors.forEach(ex => {
    const taskResult = db.prepare(`
      INSERT INTO tasks (requirement_id, title, description, assignee_id, status, priority)
      VALUES (?, ?, ?, ?, 'todo', 'p1')
    `).run(
      requirementId,
      '【执行】完成 ' + requirementTitle,
      '需求方案评审全部通过，请根据技术方案完成实际开发工作。',
      ex.id
    );

    // 创建 agent_message 通知 Agent
    db.prepare(`
      INSERT INTO agent_messages (agent_id, type, title, content, status, metadata)
      VALUES (?, 'task', ?, ?, 'pending', ?)
    `).run(
      ex.id,
      '【执行】完成 ' + requirementTitle,
      '需求「' + requirementTitle + '」的所有技术方案评审通过，请根据技术方案完成实际开发工作。',
      JSON.stringify({
        task_id: taskResult.lastInsertRowid,
        requirement_id: requirementId
      })
    );

    console.log(`[tech-plans] 已创建执行任务给 ${ex.name}, task_id=${taskResult.lastInsertRowid}`);
  });

  return executors.length;
}

// 由 Leader Agent 决定状态流转（修复 #8）
async function leadAgentDecideFlow(db, techPlan, action, catAgents) {
  const allPlans = db.prepare(`
    SELECT tp.*, r.title as req_title, r.status as req_status
    FROM tech_plans tp
    LEFT JOIN requirements r ON tp.requirement_id = r.id
    WHERE tp.requirement_id = ? AND tp.deleted = 0
    ORDER BY tp.dispatch_phase, tp.created_at ASC
  `).all(techPlan.requirement_id);

  const plansByPhase = {};
  allPlans.forEach(p => {
    if (!plansByPhase[p.dispatch_phase]) {
      plansByPhase[p.dispatch_phase] = [];
    }
    plansByPhase[p.dispatch_phase].push(p);
  });

  const decision = await sendToAgent('leader-001', {
    title: '状态流转决策',
    content: `当前通过的技术方案：
- 方案ID：${techPlan.id}
- 类别：${techPlan.category}
- 流程阶段：${techPlan.dispatch_phase}
- 版本：V${techPlan.version}

该需求所有技术方案状态（dispatch_chain: ui → frontend → backend → test）：
${JSON.stringify(plansByPhase, null, 2)}

请严格以 JSON 格式返回（不要其他解释），根据以下规则决策：
- UI 通过 → next_phases: ["frontend", "backend"]
- 前端通过 → next_phases: ["backend"]
- 后端通过 → next_phases: ["test"]
- 测试通过 → decision: "创建执行任务"
{
  "decision": "派发下一阶段" | "创建执行任务",
  "next_phases": ["frontend", "backend"]  // 仅 decision 为"派发下一阶段"时需要
}
`
  });

  // 解析决策（修复 #8 - 解析失败不再 fallback，直接抛错）
  if (decision && decision.success && decision.response) {
    try {
      const jsonMatch = decision.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.decision) {
          console.log(`[tech-plans] Leader 决策: ${JSON.stringify(parsed)}`);
          return parsed;
        }
      }
    } catch (e) {
      console.error('[tech-plans] 解析 Leader 决策失败:', e.message);
    }
  }

  // 解析失败则本地规则决策（保守降级）
  console.warn('[tech-plans] Leader 决策解析失败，使用本地规则降级决策');
  return getLocalFallbackDecision(techPlan);
}

// 本地降级决策规则（Leader Agent 不可用时使用）
function getLocalFallbackDecision(techPlan) {
  const phase = techPlan.dispatch_phase;

  if (phase === 'ui') {
    return { decision: '派发下一阶段', next_phases: ['frontend', 'backend'] };
  }
  if (phase === 'frontend') {
    return { decision: '派发下一阶段', next_phases: ['backend'] };
  }
  if (phase === 'backend') {
    return { decision: '派发下一阶段', next_phases: ['test'] };
  }
  if (phase === 'test') {
    return { decision: '创建执行任务' };
  }

  return { decision: '派发下一阶段', next_phases: [getNextPhase(phase)] };
}

// Agent 提交技术方案内容（由 Agent 主动调用，提交 markdown 文档内容）
router.post('/:id/submit', (req, res) => {
  const db = getDB();
  const { content, retrieval_log } = req.body;

  const techPlan = db.prepare('SELECT * FROM tech_plans WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!techPlan) {
    return res.status(404).json({ code: 404, message: '技术方案不存在' });
  }

  if (!content || !content.trim()) {
    return res.status(400).json({ code: 400, message: '技术方案内容不能为空' });
  }

  // 更新方案内容 + retrieval_log，状态变为 review（待评审）
  db.prepare(`
    UPDATE tech_plans SET content = ?, retrieval_log = COALESCE(?, retrieval_log), review_status = 'review', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(content, retrieval_log || null, req.params.id);

  res.json({ code: 0, message: '技术方案已提交，等待审核' });
});

module.exports = router;

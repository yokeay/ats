const express = require('express');
const router = express.Router();
const { getDB } = require('../server/db');
const { broadcastToAgent } = require('../server/sse');
const { catNames } = require('./requirements');

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

    // 闭环：审核通过 → 自动创建执行任务
    const taskTitle = '【' + catLabel + '】技术方案执行 - ' + planTitle;
    const taskResult = db.prepare(`
      INSERT INTO tasks (requirement_id, title, description, assignee_id, status, priority)
      VALUES (?, ?, ?, ?, 'todo', 'p1')
    `).run(
      techPlan.requirement_id,
      taskTitle,
      '技术方案ID：' + techPlan.id + '\n类别：' + catLabel + '\n\n请严格按照技术方案执行开发，完成后更新任务状态为已完成。',
      techPlan.author_id
    );

    // 通知负责人：方案通过，已自动创建执行任务
    db.prepare(`
      INSERT INTO notifications (agent_id, type, title, content, tech_plan_id, requirement_id, category)
      VALUES (?, 'tech_plan_approved', '✅ 技术方案通过 - ' + ?, ?, ?, ?, ?)
    `).run(
      techPlan.author_id,
      planTitle,
      catLabel + '技术方案已审核通过，已自动创建任务【' + taskTitle + '】，请前往任务管理查看并执行。',
      parseInt(req.params.id),
      techPlan.requirement_id,
      techPlan.category
    );

    // 广播通知给 Agent，含任务ID
    broadcastToAgent(techPlan.author_id, {
      type: 'tech_plan_approved',
      tech_plan_id: parseInt(req.params.id),
      requirement_id: techPlan.requirement_id,
      category: techPlan.category,
      title: planTitle,
      task_id: taskResult.lastInsertRowid,
      task_title: taskTitle
    });

    // 派发下一阶段（根据 dispatch_phase 链）
    dispatchNextPhase(db, techPlan, catAgents);
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

  // 通知 Agent 重新生成
  const catLabel = catNames[techPlan.category] || techPlan.category;
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

function dispatchNextPhase(db, techPlan, catAgents) {
  const nextPhase = getNextPhase(techPlan.dispatch_phase);
  if (!nextPhase) return;

  // 查找下一个阶段是否已有方案
  const existingNext = db.prepare(`
    SELECT id FROM tech_plans
    WHERE requirement_id = ? AND dispatch_phase = ? AND deleted = 0
    ORDER BY version DESC LIMIT 1
  `).get(techPlan.requirement_id, nextPhase);

  if (existingNext) return; // 已有方案，无需重复创建

  const nextAgent = catAgents[nextPhase];
  if (!nextAgent) return;

  // 检查该类别方案是否已达4个版本上限
  const existingCount = db.prepare(
    'SELECT COUNT(*) as count FROM tech_plans WHERE requirement_id = ? AND category = ? AND deleted = 0'
  ).get(techPlan.requirement_id, nextPhase);
  if (existingCount.count >= 4) return;

  // 创建新方案记录（空内容，等待 Agent 填充）
  db.prepare(`
    INSERT INTO tech_plans (requirement_id, category, author_id, content, version, audit_status, review_status, dispatch_phase)
    VALUES (?, ?, ?, '', 1, 'pending', 'generating', ?)
  `).run(techPlan.requirement_id, nextPhase, nextAgent.id, nextPhase);

  const catLabel = catNames[nextPhase] || nextPhase;
  const reqTitle = db.prepare('SELECT title FROM requirements WHERE id = ?').get(techPlan.requirement_id);
  db.prepare(`
    INSERT INTO notifications (agent_id, type, title, content)
    VALUES (?, 'tech_plan_task', '📋 技术方案任务 - ' + ?, '需求「' + ? + '」的前序方案已通过评审，请完成「' + ? + '」技术方案文档并提交。需求ID：' + ?)
  `).run(nextAgent.id, catLabel, reqTitle ? reqTitle.title : '', catLabel, techPlan.requirement_id);
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

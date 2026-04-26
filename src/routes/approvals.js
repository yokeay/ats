const express = require('express');
const router = express.Router();
const { getDB } = require('../server/db');
const { broadcastToAgent } = require('../server/sse');

// 获取所有待审批申请
router.get('/', (req, res) => {
  const db = getDB();
  const { status, agent_id } = req.query;

  let sql = `
    SELECT ar.*,
           a.name as agent_name,
           a.emoji as agent_emoji,
           t.title as task_title,
           r.title as requirement_title
    FROM approval_requests ar
    LEFT JOIN agents a ON ar.agent_id = a.id
    LEFT JOIN tasks t ON ar.task_id = t.id
    LEFT JOIN requirements r ON ar.requirement_id = r.id
    WHERE 1=1
  `;
  const params = [];

  if (status) {
    sql += ' AND ar.status = ?';
    params.push(status);
  }
  if (agent_id) {
    sql += ' AND ar.agent_id = ?';
    params.push(agent_id);
  }

  sql += ' ORDER BY ar.created_at DESC';

  const approvals = db.prepare(sql).all(...params);
  res.json({ code: 0, data: approvals });
});

// 创建审批申请
router.post('/', (req, res) => {
  const db = getDB();
  const { agent_id, type, title, content, task_id, requirement_id } = req.body;

  if (!agent_id || !type || !title || !content) {
    return res.status(400).json({ code: 400, message: '缺少必要参数' });
  }

  if (!['type_decision', 'resource', 'time', 'clarification'].includes(type)) {
    return res.status(400).json({ code: 400, message: '无效的申请类型' });
  }

  const result = db.prepare(`
    INSERT INTO approval_requests (agent_id, type, title, content, task_id, requirement_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(agent_id, type, title, content, task_id || null, requirement_id || null);

  // 暂停Agent
  db.prepare(`UPDATE agents SET status = 'pause' WHERE id = ?`).run(agent_id);

  // 记录日志
  db.prepare(`
    INSERT INTO agent_logs (agent_id, level, message, context)
    VALUES (?, 'warn', ?, ?)
  `).run(agent_id, `发起审批申请: ${title}`, JSON.stringify({ type, approval_id: result.lastInsertRowid }));

  // 获取Agent名称
  const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agent_id);

  // 广播通知
  broadcastToAgent(agent_id, {
    type: 'approval_submitted',
    approval_id: result.lastInsertRowid,
    title,
    agent_name: agent?.name
  });

  res.json({ code: 0, data: { id: result.lastInsertRowid }, message: '审批申请已提交' });
});

// 获取单个审批申请
router.get('/:id', (req, res) => {
  const db = getDB();
  const approval = db.prepare(`
    SELECT ar.*,
           a.name as agent_name,
           a.emoji as agent_emoji,
           t.title as task_title,
           r.title as requirement_title,
           reviewer.name as reviewer_name,
           reviewer.emoji as reviewer_emoji
    FROM approval_requests ar
    LEFT JOIN agents a ON ar.agent_id = a.id
    LEFT JOIN tasks t ON ar.task_id = t.id
    LEFT JOIN requirements r ON ar.requirement_id = r.id
    LEFT JOIN agents reviewer ON ar.reviewer_id = reviewer.id
    WHERE ar.id = ?
  `).get(req.params.id);

  if (!approval) {
    return res.status(404).json({ code: 404, message: '审批申请不存在' });
  }

  res.json({ code: 0, data: approval });
});

// 审批通过
router.post('/:id/approve', (req, res) => {
  const db = getDB();
  const { reviewer_id, review_comment } = req.body;

  const approval = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(req.params.id);
  if (!approval) {
    return res.status(404).json({ code: 404, message: '审批申请不存在' });
  }

  if (approval.status !== 'pending') {
    return res.status(400).json({ code: 400, message: '申请不在待审批状态' });
  }

  db.prepare(`
    UPDATE approval_requests
    SET status = 'approved', reviewer_id = ?, reviewed_at = CURRENT_TIMESTAMP, review_comment = ?
    WHERE id = ?
  `).run(reviewer_id, review_comment || '', req.params.id);

  // 恢复Agent状态
  db.prepare(`UPDATE agents SET status = 'busy' WHERE id = ?`).run(approval.agent_id);

  // 如果有关联任务，更新任务状态
  if (approval.task_id) {
    db.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`).run(approval.task_id);
  }

  // 模拟工作状态：审批通过后自动开始工作
  db.prepare(`
    UPDATE agent_work_status
    SET current_action = '执行任务中',
        current_detail = ?,
        progress = 0,
        start_time = CURRENT_TIMESTAMP,
        last_update = CURRENT_TIMESTAMP
    WHERE agent_id = ?
  `).run(approval.title, approval.agent_id);

  // 广播工作状态更新（供前端实时显示）
  broadcastToAgent(approval.agent_id, {
    type: 'work_started',
    title: approval.title,
    current_action: '执行任务中',
    current_detail: approval.title
  });

  // 记录开始执行日志
  db.prepare(`
    INSERT INTO agent_logs (agent_id, level, message, context)
    VALUES (?, 'info', ?, ?)
  `).run(approval.agent_id, `▶ 开始执行: ${approval.title}`, JSON.stringify({type:'work_start', task: approval.title}));

  // 记录审批日志
  db.prepare(`
    INSERT INTO agent_logs (agent_id, level, message, context)
    VALUES (?, 'info', ?, ?)
  `).run(approval.agent_id, `审批已通过: ${approval.title}`, JSON.stringify({
    type: 'approval_approved',
    approval_id: req.params.id,
    reviewer_id
  }));

  // 发送通知
  db.prepare(`
    INSERT INTO notifications (agent_id, type, title, content)
    VALUES (?, 'approval_approved', '审批已通过', ?)
  `).run(approval.agent_id, review_comment || '您的审批申请已通过，可以继续工作了');

  // 通过SSE通知Agent
  broadcastToAgent(approval.agent_id, {
    type: 'approval_result',
    result: 'approved',
    approval_id: req.params.id,
    title: approval.title,
    comment: review_comment
  });

  res.json({ code: 0, message: '审批已通过' });
});

// 审批拒绝
router.post('/:id/reject', (req, res) => {
  const db = getDB();
  const { reviewer_id, review_comment } = req.body;

  if (!review_comment) {
    return res.status(400).json({ code: 400, message: '请填写拒绝原因' });
  }

  const approval = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(req.params.id);
  if (!approval) {
    return res.status(404).json({ code: 404, message: '审批申请不存在' });
  }

  if (approval.status !== 'pending') {
    return res.status(400).json({ code: 400, message: '申请不在待审批状态' });
  }

  db.prepare(`
    UPDATE approval_requests
    SET status = 'rejected', reviewer_id = ?, reviewed_at = CURRENT_TIMESTAMP, review_comment = ?
    WHERE id = ?
  `).run(reviewer_id, review_comment, req.params.id);

  // 恢复Agent状态（但不自动恢复任务）
  db.prepare(`UPDATE agents SET status = 'idle' WHERE id = ?`).run(approval.agent_id);

  // 记录日志
  db.prepare(`
    INSERT INTO agent_logs (agent_id, level, message, context)
    VALUES (?, 'error', ?, ?)
  `).run(approval.agent_id, `审批被拒绝: ${approval.title}`, JSON.stringify({
    type: 'approval_rejected',
    approval_id: req.params.id,
    reviewer_id,
    reason: review_comment
  }));

  // 发送通知
  db.prepare(`
    INSERT INTO notifications (agent_id, type, title, content)
    VALUES (?, 'approval_rejected', '审批被拒绝', ?)
  `).run(approval.agent_id, review_comment);

  // 通过SSE通知Agent
  broadcastToAgent(approval.agent_id, {
    type: 'approval_result',
    result: 'rejected',
    approval_id: req.params.id,
    title: approval.title,
    comment: review_comment
  });

  res.json({ code: 0, message: '审批已拒绝' });
});

// Agent获取自己的通知 (SSE)
router.get('/:id/notifications', (req, res) => {
  const agentId = req.params.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // 获取未读通知
  const db = getDB();
  const notifications = db.prepare(`
    SELECT * FROM notifications
    WHERE agent_id = ? AND read = 0
    ORDER BY created_at DESC
  `).all(agentId);

  res.write(`data: ${JSON.stringify({ type: 'init', notifications })}\n\n`);

  // 定期检查新通知
  const checkInterval = setInterval(() => {
    try {
      const unread = db.prepare(`
        SELECT * FROM notifications
        WHERE agent_id = ? AND read = 0
        ORDER BY created_at DESC
      `).all(agentId);

      if (unread.length > 0) {
        res.write(`data: ${JSON.stringify({ type: 'notifications', notifications: unread })}\n\n`);
      }
    } catch (e) {
      // 忽略错误
    }
  }, 2000);

  req.on('close', () => {
    clearInterval(checkInterval);
  });
});

// 标记通知已读
router.patch('/notifications/:notificationId/read', (req, res) => {
  const db = getDB();
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(req.params.notificationId);
  res.json({ code: 0, message: '通知已标记为已读' });
});

module.exports = router;

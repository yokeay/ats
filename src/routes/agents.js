const express = require('express');
const router = express.Router();
const { getDB } = require('../server/db');
const { registerSSE, unregisterSSE, broadcastToAgent } = require('../server/sse');

// 获取所有 Agent
router.get('/', (req, res) => {
  const db = getDB();
  const agents = db.prepare(`
    SELECT a.*,
           aws.current_action,
           aws.current_detail,
           aws.progress,
           aws.start_time,
           aws.last_update
    FROM agents a
    LEFT JOIN agent_work_status aws ON a.id = aws.agent_id
    ORDER BY a.role
  `).all();

  res.json({ code: 0, data: agents });
});

// 获取单个 Agent
router.get('/:id', (req, res) => {
  const db = getDB();
  const agent = db.prepare(`
    SELECT a.*,
           aws.current_action,
           aws.current_detail,
           aws.progress,
           aws.start_time,
           aws.last_update
    FROM agents a
    LEFT JOIN agent_work_status aws ON a.id = aws.agent_id
    WHERE a.id = ?
  `).get(req.params.id);

  if (!agent) {
    return res.status(404).json({ code: 404, message: 'Agent不存在' });
  }

  res.json({ code: 0, data: agent });
});

// 更新 Agent 状态
router.patch('/:id/status', (req, res) => {
  const db = getDB();
  const { status } = req.body;

  if (!['idle', 'busy', 'pause'].includes(status)) {
    return res.status(400).json({ code: 400, message: '无效的状态' });
  }

  db.prepare('UPDATE agents SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(status, req.params.id);

  // 记录日志
  const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(req.params.id);
  db.prepare(`
    INSERT INTO agent_logs (agent_id, level, message, context)
    VALUES (?, 'info', ?, ?)
  `).run(req.params.id, `状态变更为: ${status}`, JSON.stringify({ changedBy: 'system' }));

  res.json({ code: 0, message: '状态更新成功' });
});

// 更新工作状态（实时）
router.patch('/:id/work-status', (req, res) => {
  const db = getDB();
  const { current_action, current_detail, progress } = req.body;

  const stmt = db.prepare(`
    UPDATE agent_work_status
    SET current_action = ?,
        current_detail = ?,
        progress = ?,
        last_update = CURRENT_TIMESTAMP
    WHERE agent_id = ?
  `);

  stmt.run(current_action || '空闲中', current_detail || '', progress || 0, req.params.id);

  // 更新 Agent 状态
  if (progress > 0 && progress < 100) {
    db.prepare('UPDATE agents SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('busy', req.params.id);
  }

  res.json({ code: 0, message: '工作状态更新成功' });
});

// 获取 Agent 日志 (SSE)
router.get('/:id/logs', (req, res) => {
  const agentId = req.params.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  registerSSE(agentId, res);

  // 立即发送一次初始数据
  const db = getDB();
  const logs = db.prepare(`
    SELECT * FROM agent_logs
    WHERE agent_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(agentId);

  res.write(`data: ${JSON.stringify({ type: 'init', logs })}\n\n`);

  // 定期发送心跳
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 30000);

  // 定期检查新日志
  const checkLogs = setInterval(() => {
    try {
      const newLogs = db.prepare(`
        SELECT * FROM agent_logs
        WHERE agent_id = ?
        ORDER BY created_at DESC
        LIMIT 20
      `).all(agentId);

      res.write(`data: ${JSON.stringify({ type: 'logs', logs: newLogs })}\n\n`);
    } catch (e) {
      // 忽略错误
    }
  }, 3000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(checkLogs);
    unregisterSSE(agentId, res);
  });
});

// 获取 Agent 通知 (SSE)
router.get('/:id/notifications', (req, res) => {
  const agentId = req.params.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  registerSSE(agentId, res);

  // 立即发送未读通知
  const db = getDB();
  const notifications = db.prepare(`
    SELECT * FROM notifications
    WHERE agent_id = ? AND read = 0
    ORDER BY created_at DESC
  `).all(agentId);

  res.write(`data: ${JSON.stringify({ type: 'init', notifications })}\n\n`);

  // 定期检查新通知
  const checkNotifications = setInterval(() => {
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
    clearInterval(checkNotifications);
    unregisterSSE(agentId, res);
  });
});

// 添加日志
router.post('/:id/logs', (req, res) => {
  const db = getDB();
  const { level, message, context } = req.body;

  db.prepare(`
    INSERT INTO agent_logs (agent_id, level, message, context)
    VALUES (?, ?, ?, ?)
  `).run(req.params.id, level || 'info', message, JSON.stringify(context || {}));

  res.json({ code: 0, message: '日志添加成功' });
});

// 获取所有 Agent 的最新日志
router.get('/logs/all', (req, res) => {
  const db = getDB();
  const logs = db.prepare(`
    SELECT al.*, a.name as agent_name, a.emoji as agent_emoji
    FROM agent_logs al
    JOIN agents a ON al.agent_id = a.id
    ORDER BY al.created_at DESC
    LIMIT 100
  `).all();

  res.json({ code: 0, data: logs });
});

// 发送任务给 Agent（API方式）
router.post('/:agentId/send-task', async (req, res) => {
  const { getDB } = require('../server/db');
  const { sendToAgent } = require('../server/agent-manager');

  const db = getDB();
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.agentId);
  if (!agent) {
    return res.status(404).json({ code: 404, message: 'Agent 不存在' });
  }

  const { title, content } = req.body;
  if (!title || !content) {
    return res.status(400).json({ code: 400, message: '缺少任务参数' });
  }

  const messageId = await sendToAgent(req.params.agentId, { title, content });

  res.json({ code: 0, data: { messageId }, message: '任务已发送给 Agent' });
});

module.exports = router;

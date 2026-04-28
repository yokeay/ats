const express = require('express');
const router = express.Router();
const { getDB } = require('../server/db');

// Agent 实时输出 SSE 端点
router.get('/:agentId', (req, res) => {
  const db = getDB();
  const agentId = req.params.agentId;

  // 验证 Agent 是否存在
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
  if (!agent) {
    return res.status(404).json({ code: 404, message: 'Agent 不存在' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // 初始化 Agent 状态为在线
  db.prepare('UPDATE agents SET status = ?, current_action = ?, current_detail = ? WHERE id = ?')
    .run('working', '待工作', '空闲中', agentId);

  db.prepare(`
    INSERT OR REPLACE INTO agent_work_status (agent_id, current_action, current_detail, progress, last_update)
    VALUES (?, '待工作', '空闲中', 0, CURRENT_TIMESTAMP)
  `).run(agentId);

  // 初始化消息队列
  db.prepare(`INSERT OR REPLACE INTO agent_messages (agent_id, type, title, content, status) VALUES (?, 'status', 'SSE连接建立', '开始监听Agent输出', 'processing')`)
    .run(agentId);

  // 立即发送初始数据
  res.write(`data: ${JSON.stringify({ type: 'init', agent_id: agentId, agent_name: agent.name })}\n\n`);

  // 实时推送 Agent 输出
  const interval = setInterval(() => {
    const outputs = db.prepare(`
      SELECT * FROM agent_outputs
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(agentId);

    for (const output of outputs) {
      res.write(`data: ${JSON.stringify({
        type: output.message_type,
        content: output.content,
        created_at: output.created_at
      })}\n\n`);
    }
  }, 1000);

  req.on('close', () => {
    clearInterval(interval);
    db.prepare('UPDATE agents SET status = ?, current_action = ?, current_detail = ? WHERE id = ?')
      .run('idle', '空闲中', '等待分配任务', agentId);
    db.prepare('DELETE FROM agent_outputs WHERE agent_id = ?').run(agentId);
    res.end();
  });
});

module.exports = router;

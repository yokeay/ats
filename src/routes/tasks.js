const express = require('express');
const router = express.Router();
const { getDB } = require('../server/db');
const { broadcastToAll, broadcastToAgent } = require('../server/sse');

// 获取所有任务
router.get('/', (req, res) => {
  const db = getDB();
  const { status, assignee_id, requirement_id } = req.query;

  let sql = `
    SELECT t.*,
           r.title as requirement_title,
           a.name as assignee_name,
           a.emoji as assignee_emoji,
           (SELECT COUNT(*) FROM task_results tr WHERE tr.task_id = t.id) > 0 as has_result
    FROM tasks t
    LEFT JOIN requirements r ON t.requirement_id = r.id
    LEFT JOIN agents a ON t.assignee_id = a.id
    WHERE t.deleted = 0
  `;
  const params = [];

  if (status) {
    sql += ' AND t.status = ?';
    params.push(status);
  }
  if (assignee_id) {
    sql += ' AND t.assignee_id = ?';
    params.push(assignee_id);
  }
  if (requirement_id) {
    sql += ' AND t.requirement_id = ?';
    params.push(requirement_id);
  }

  sql += ' ORDER BY t.priority ASC, t.created_at ASC';

  const tasks = db.prepare(sql).all(...params);
  res.json({ code: 0, data: tasks });
});

// 获取单个任务
router.get('/:id', (req, res) => {
  const db = getDB();
  const task = db.prepare(`
    SELECT t.*,
           r.title as requirement_title,
           a.name as assignee_name,
           a.emoji as assignee_emoji
    FROM tasks t
    LEFT JOIN requirements r ON t.requirement_id = r.id
    LEFT JOIN agents a ON t.assignee_id = a.id
    WHERE t.id = ? AND t.deleted = 0
  `).get(req.params.id);

  if (!task) {
    return res.status(404).json({ code: 404, message: '任务不存在' });
  }

  res.json({ code: 0, data: task });
});

// 更新任务
router.patch('/:id', (req, res) => {
  const db = getDB();
  const { status, title, description, assignee_id, priority, estimated_hours, actual_hours, start_time, end_time } = req.body;

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) {
    return res.status(404).json({ code: 404, message: '任务不存在' });
  }

  const updates = [];
  const params = [];

  if (status !== undefined) {
    updates.push('status = ?');
    params.push(status);
    if (status === 'in_progress' && !task.start_time) {
      updates.push('start_time = CURRENT_TIMESTAMP');
    }
    if (status === 'done' && !task.end_time) {
      updates.push('end_time = CURRENT_TIMESTAMP');
    }
  }
  if (title !== undefined) {
    updates.push('title = ?');
    params.push(title);
  }
  if (description !== undefined) {
    updates.push('description = ?');
    params.push(description);
  }
  if (assignee_id !== undefined) {
    updates.push('assignee_id = ?');
    params.push(assignee_id);
  }
  if (priority !== undefined) {
    updates.push('priority = ?');
    params.push(priority);
  }
  if (estimated_hours !== undefined) {
    updates.push('estimated_hours = ?');
    params.push(estimated_hours);
  }
  if (actual_hours !== undefined) {
    updates.push('actual_hours = ?');
    params.push(actual_hours);
  }
  if (start_time !== undefined) {
    updates.push('start_time = ?');
    params.push(start_time);
  }
  if (end_time !== undefined) {
    updates.push('end_time = ?');
    params.push(end_time);
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);

  db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  broadcastToAll({ type: 'task_updated', task_id: req.params.id });
  res.json({ code: 0, message: '任务更新成功' });
});

// Agent申请暂停
router.post('/:id/pause', (req, res) => {
  const db = getDB();
  const { agent_id, reason } = req.body;

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) {
    return res.status(404).json({ code: 404, message: '任务不存在' });
  }

  // 更新任务状态
  db.prepare(`UPDATE tasks SET status = 'paused' WHERE id = ?`).run(req.params.id);

  // 更新Agent状态
  db.prepare(`UPDATE agents SET status = 'pause' WHERE id = ?`).run(agent_id);

  // 记录日志
  db.prepare(`
    INSERT INTO agent_logs (agent_id, level, message, context)
    VALUES (?, 'warn', ?, ?)
  `).run(agent_id, `任务暂停: ${task.title}`, JSON.stringify({ task_id: req.params.id, reason }));

  res.json({ code: 0, message: '任务已暂停，等待审批' });
});

// Agent继续任务
router.post('/:id/resume', (req, res) => {
  const db = getDB();
  const { agent_id } = req.body;

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) {
    return res.status(404).json({ code: 404, message: '任务不存在' });
  }

  // 更新任务状态
  db.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`).run(req.params.id);

  // 更新Agent状态
  db.prepare(`UPDATE agents SET status = 'busy' WHERE id = ?`).run(agent_id);

  // 记录日志
  db.prepare(`
    INSERT INTO agent_logs (agent_id, level, message, context)
    VALUES (?, 'info', ?, ?)
  `).run(agent_id, `任务继续: ${task.title}`, JSON.stringify({ task_id: req.params.id }));

  res.json({ code: 0, message: '任务已恢复' });
});

// 创建任务
router.post('/', (req, res) => {
  const db = getDB();
  const { title, description, requirement_id, assignee_id, priority, estimated_hours } = req.body;

  if (!title) {
    return res.status(400).json({ code: 400, message: '任务标题不能为空' });
  }

  // 如果分配了任务，直接设为进行中
  var taskStatus = assignee_id ? 'in_progress' : 'todo';

  // 创建任务
  const result = db.prepare(`
    INSERT INTO tasks (title, description, requirement_id, assignee_id, priority, estimated_hours, status, start_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    title,
    description || '',
    requirement_id || null,
    assignee_id || null,
    priority || 'p2',
    estimated_hours || null,
    taskStatus,
    assignee_id ? 'CURRENT_TIMESTAMP' : null
  );

  const taskId = result.lastInsertRowid;

  // 如果分配了任务，立即让对方开始工作
  if (assignee_id) {
    // 更新 Agent 状态为工作中
    db.prepare(`UPDATE agents SET status = 'busy' WHERE id = ?`).run(assignee_id);

    // 更新 Agent 工作状态
    db.prepare(`
      UPDATE agent_work_status
      SET current_action = '执行任务中',
          current_detail = ?,
          progress = 0,
          start_time = CURRENT_TIMESTAMP,
          last_update = CURRENT_TIMESTAMP
      WHERE agent_id = ?
    `).run(title, assignee_id);

    // 发送通知
    db.prepare(`
      INSERT INTO notifications (agent_id, type, title, content)
      VALUES (?, 'task_assigned', '新任务分配', ?)
    `).run(assignee_id, `你被分配了任务: ${title}`);

    // 记录日志
    db.prepare(`
      INSERT INTO agent_logs (agent_id, level, message, context)
      VALUES (?, 'info', ?, ?)
    `).run(assignee_id, `▶ 开始执行: ${title}`, JSON.stringify({ type: 'work_start', task: title, task_id: taskId }));

    // 广播工作状态
    const agent = db.prepare('SELECT name, emoji FROM agents WHERE id = ?').get(assignee_id);
    broadcastToAgent(assignee_id, {
      type: 'work_started',
      title: title,
      current_action: '执行任务中',
      current_detail: title,
      task_id: taskId
    });
  }

  broadcastToAll({ type: 'task_created', task_id: taskId });
  res.json({ code: 0, data: { id: taskId }, message: '任务创建成功' });
});

// 分配任务
router.post('/:id/assign', (req, res) => {
  const db = getDB();
  const { assignee_id } = req.body;

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) {
    return res.status(404).json({ code: 404, message: '任务不存在' });
  }

  db.prepare(`UPDATE tasks SET assignee_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(assignee_id, req.params.id);

  // 让对方开始工作
  db.prepare(`UPDATE agents SET status = 'busy' WHERE id = ?`).run(assignee_id);
  db.prepare(`
    UPDATE agent_work_status
    SET current_action = '执行任务中',
        current_detail = ?,
        progress = 0,
        start_time = CURRENT_TIMESTAMP,
        last_update = CURRENT_TIMESTAMP
    WHERE agent_id = ?
  `).run(task.title, assignee_id);

  // 发送通知
  db.prepare(`
    INSERT INTO notifications (agent_id, type, title, content)
    VALUES (?, 'task_assigned', '新任务分配', ?)
  `).run(assignee_id, `你被分配了任务: ${task.title}`);

  // 记录日志
  db.prepare(`
    INSERT INTO agent_logs (agent_id, level, message, context)
    VALUES (?, 'info', ?, ?)
  `).run(assignee_id, `▶ 开始执行: ${task.title}`, JSON.stringify({ type: 'work_start', task: task.title, task_id: req.params.id }));

  // 广播工作状态
  broadcastToAgent(assignee_id, {
    type: 'work_started',
    title: task.title,
    current_action: '执行任务中',
    current_detail: task.title,
    task_id: req.params.id
  });

  broadcastToAll({ type: 'task_assigned', task_id: req.params.id, assignee_id });
  res.json({ code: 0, message: '任务分配成功' });
});

// 获取任务结果
router.get('/:id/results', (req, res) => {
  const db = getDB();
  const results = db.prepare(`
    SELECT * FROM task_results
    WHERE task_id = ?
    ORDER BY created_at DESC
  `).all(req.params.id);

  res.json({ code: 0, data: results });
});

// 提交任务结果
router.post('/:id/submit', (req, res) => {
  const db = getDB();
  const { content, result_type, files, agent_id } = req.body;

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) {
    return res.status(404).json({ code: 404, message: '任务不存在' });
  }

  // 如果有文件，保存文件
  if (files && Array.isArray(files)) {
    const insertFile = db.prepare(`
      INSERT INTO task_results (task_id, file_name, file_path, content, content_type)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const file of files) {
      insertFile.run(req.params.id, file.name, file.path || '', file.content || '', file.type || 'text');
    }
  } else if (content) {
    // 保存文本内容
    db.prepare(`
      INSERT INTO task_results (task_id, content, content_type)
      VALUES (?, ?, ?)
    `).run(req.params.id, content, result_type || 'text');
  }

  // 更新任务状态为已完成
  db.prepare(`UPDATE tasks SET status = 'done', end_time = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(req.params.id);

  // 更新 Agent 状态为空闲
  db.prepare(`UPDATE agents SET status = 'idle' WHERE id = ?`).run(task.assignee_id);
  db.prepare(`UPDATE agent_work_status SET current_action = '已完成任务', current_detail = '等待分配新任务', progress = 100 WHERE agent_id = ?`).run(task.assignee_id);

  // 记录日志
  db.prepare(`
    INSERT INTO agent_logs (agent_id, level, message, context)
    VALUES (?, 'info', ?, ?)
  `).run(task.assignee_id, `✓ 完成任务: ${task.title}`, JSON.stringify({ type: 'task_completed', task_id: req.params.id }));

  // 广播
  broadcastToAll({ type: 'task_completed', task_id: req.params.id });
  broadcastToAgent(task.assignee_id, { type: 'work_completed', agent_name: task.assignee_name });

  res.json({ code: 0, message: '任务已完成' });
});

// 获取单个任务结果
router.get('/results/:resultId', (req, res) => {
  const db = getDB();
  const result = db.prepare('SELECT * FROM task_results WHERE id = ?').get(req.params.resultId);

  if (!result) {
    return res.status(404).json({ code: 404, message: '结果不存在' });
  }

  res.json({ code: 0, data: result });
});

// 删除任务
router.delete('/:id', (req, res) => {
  const db = getDB();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) {
    return res.status(404).json({ code: 404, message: '任务不存在' });
  }

  db.prepare(`UPDATE tasks SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
  broadcastToAll({ type: 'task_deleted', task_id: req.params.id });
  res.json({ code: 0, message: '任务已删除' });
});

module.exports = router;

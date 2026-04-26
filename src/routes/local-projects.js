const express = require('express');
const router = express.Router();
const { getDB } = require('../server/db');
const { broadcastToAll } = require('../server/sse');
const { spawn } = require('child_process');
const path = require('path');

// 存储活跃的子进程
const activeProcesses = new Map();

// 获取或创建本地项目记录
function getOrCreateLocalProject(projectId) {
  const db = getDB();
  let lp = db.prepare('SELECT * FROM local_projects WHERE project_id = ?').get(projectId);
  if (!lp) {
    const result = db.prepare('INSERT INTO local_projects (project_id) VALUES (?)').run(projectId);
    lp = db.prepare('SELECT * FROM local_projects WHERE id = ?').get(result.lastInsertRowid);
  }
  return lp;
}

// 获取本地项目（不存在则自动创建）
router.get('/:projectId', (req, res) => {
  const db = getDB();
  const lp = getOrCreateLocalProject(req.params.projectId);
  const items = db.prepare('SELECT * FROM local_project_items WHERE local_project_id = ? ORDER BY created_at ASC').all(lp.id);
  res.json({ code: 0, data: { ...lp, items } });
});

// 更新本地项目基础信息
router.patch('/:projectId', (req, res) => {
  const db = getDB();
  const lp = getOrCreateLocalProject(req.params.projectId);
  const { name, start_command, work_dir } = req.body;
  const updates = [];
  const params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (start_command !== undefined) { updates.push('start_command = ?'); params.push(start_command); }
  if (work_dir !== undefined) { updates.push('work_dir = ?'); params.push(work_dir); }
  if (updates.length === 0) return res.json({ code: 0, data: lp });
  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(lp.id);
  db.prepare(`UPDATE local_projects SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const updated = db.prepare('SELECT * FROM local_projects WHERE id = ?').get(lp.id);
  const items = db.prepare('SELECT * FROM local_project_items WHERE local_project_id = ? ORDER BY created_at ASC').all(lp.id);
  res.json({ code: 0, data: { ...updated, items } });
});

// 添加/更新 Key-Value 配置项
router.post('/:projectId/items', (req, res) => {
  const db = getDB();
  const lp = getOrCreateLocalProject(req.params.projectId);
  const { item_key, item_value } = req.body;
  if (!item_key) return res.status(400).json({ code: 400, message: 'key 不能为空' });
  const existing = db.prepare('SELECT id FROM local_project_items WHERE local_project_id = ? AND item_key = ?').get(lp.id, item_key);
  if (existing) {
    db.prepare('UPDATE local_project_items SET item_value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(item_value || '', existing.id);
  } else {
    db.prepare('INSERT INTO local_project_items (local_project_id, item_key, item_value) VALUES (?, ?, ?)').run(lp.id, item_key, item_value || '');
  }
  const items = db.prepare('SELECT * FROM local_project_items WHERE local_project_id = ? ORDER BY created_at ASC').all(lp.id);
  res.json({ code: 0, data: items });
});

// 删除配置项
router.delete('/:projectId/items/:itemId', (req, res) => {
  const db = getDB();
  const lp = getOrCreateLocalProject(req.params.projectId);
  db.prepare('DELETE FROM local_project_items WHERE id = ? AND local_project_id = ?').run(req.params.itemId, lp.id);
  const items = db.prepare('SELECT * FROM local_project_items WHERE local_project_id = ? ORDER BY created_at ASC').all(lp.id);
  res.json({ code: 0, data: items });
});

// 启动本地项目
router.post('/:projectId/start', (req, res) => {
  const db = getDB();
  const lp = getOrCreateLocalProject(req.params.projectId);

  if (lp.status === 'running') {
    return res.json({ code: 0, data: lp, message: '项目已在运行中' });
  }

  if (!lp.start_command) {
    return res.status(400).json({ code: 400, message: '请先配置启动命令' });
  }

  const workDir = lp.work_dir || path.join(__dirname, '../../../');

  // 解析启动命令和参数
  const parts = lp.start_command.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1);

  const child = spawn(cmd, args, {
    cwd: workDir,
    shell: true,
    env: { ...process.env }
  });

  let output = '';
  let started = false;

  child.stdout.on('data', (data) => {
    const text = data.toString();
    output += text;
    process.stdout.write(text);
    // 尝试从输出中提取端口
    if (!started) {
      const portMatch = text.match(/listen(?:ing)?\s*(?:on)?\s*(?:port[:\s]*)?(\d{4,5})/i)
        || text.match(/(?:port|http)[:\s]*(\d{4,5})/i)
        || text.match(/:(\d{4,5})/g);
      if (portMatch) {
        let port = Array.isArray(portMatch) ? parseInt(portMatch[portMatch.length - 1].replace(':', '')) : parseInt(portMatch[1]);
        if (!isNaN(port)) {
          started = true;
          db.prepare('UPDATE local_projects SET status = ?, pid = ?, port = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run('running', child.pid, port, lp.id);
          broadcastToAll({ type: 'local_project_started', project_id: lp.project_id, port });
        }
      }
    }
  });

  child.stderr.on('data', (data) => {
    const text = data.toString();
    output += text;
    process.stderr.write(text);
  });

  // 2秒后如果还没识别到端口，默认取3000
  setTimeout(() => {
    const lp2 = db.prepare('SELECT status, port FROM local_projects WHERE id = ?').get(lp.id);
    if (lp2.status !== 'running') {
      db.prepare('UPDATE local_projects SET status = ?, pid = ?, port = COALESCE(NULLIF(port, 0), 3000), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('running', child.pid || 0, lp.id);
      broadcastToAll({ type: 'local_project_started', project_id: lp.project_id, port: 3000 });
    }
  }, 2000);

  child.on('error', (err) => {
    db.prepare("UPDATE local_projects SET status = 'stopped', pid = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(lp.id);
    broadcastToAll({ type: 'local_project_stopped', project_id: lp.project_id });
    activeProcesses.delete(lp.id);
  });

  child.on('exit', (code) => {
    db.prepare("UPDATE local_projects SET status = 'stopped', pid = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(lp.id);
    broadcastToAll({ type: 'local_project_stopped', project_id: lp.project_id });
    activeProcesses.delete(lp.id);
  });

  activeProcesses.set(lp.id, child);

  res.json({ code: 0, message: '启动命令已执行' });
});

// 停止本地项目
router.post('/:projectId/stop', (req, res) => {
  const db = getDB();
  const lp = getOrCreateLocalProject(req.params.projectId);

  if (lp.status !== 'running') {
    return res.json({ code: 0, message: '项目未在运行' });
  }

  const child = activeProcesses.get(lp.id);
  if (child) {
    child.kill('SIGTERM');
    activeProcesses.delete(lp.id);
  }

  db.prepare("UPDATE local_projects SET status = 'stopped', pid = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(lp.id);
  broadcastToAll({ type: 'local_project_stopped', project_id: lp.project_id });
  res.json({ code: 0, message: '项目已停止' });
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { getDB } = require('../server/db');

// 生成6位随机大写字母编码
function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// 获取所有项目（支持搜索、排序、分页）
router.get('/', (req, res) => {
  const db = getDB();
  const { search, sort = 'desc', page = 1, pageSize = 20 } = req.query;

  let where = 'deleted = 0';
  const params = [];

  if (search) {
    // 编码精准匹配，名称和描述模糊搜索
    if (search.length === 6 && /^[A-Z]+$/.test(search)) {
      where += ' AND code = ?';
      params.push(search);
    } else {
      where += ' AND (name LIKE ? OR description LIKE ?)';
      params.push('%' + search + '%', '%' + search + '%');
    }
  }

  // 获取总数
  const total = db.prepare(`SELECT COUNT(*) as count FROM projects WHERE ${where}`).get(...params).count;

  // 分页
  const offset = (parseInt(page) - 1) * parseInt(pageSize);
  const order = sort === 'asc' ? 'ASC' : 'DESC';

  const projects = db.prepare(`
    SELECT * FROM projects WHERE ${where} ORDER BY created_at ${order} LIMIT ? OFFSET ?
  `).all(...params, parseInt(pageSize), offset);

  res.json({
    code: 0,
    data: {
      list: projects,
      total: total,
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      totalPages: Math.ceil(total / parseInt(pageSize))
    }
  });
});

// 获取单个项目
router.get('/:id', (req, res) => {
  const db = getDB();
  const project = db.prepare(`
    SELECT * FROM projects WHERE id = ? AND deleted = 0
  `).get(req.params.id);

  if (!project) {
    return res.status(404).json({ code: 404, message: '项目不存在' });
  }

  res.json({ code: 0, data: project });
});

// 创建项目
router.post('/', (req, res) => {
  const db = getDB();
  const { name, description, phase, status, start_command, work_dir, local_items } = req.body;

  if (!name) {
    return res.status(400).json({ code: 400, message: '项目名称不能为空' });
  }

  // 生成唯一编码
  let code = generateCode();
  while (db.prepare('SELECT id FROM projects WHERE code = ?').get(code)) {
    code = generateCode();
  }

  const result = db.prepare(`
    INSERT INTO projects (name, code, description, phase, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, code, description || '', phase || 'start', status || 'pending');

  const projectId = result.lastInsertRowid;

  // 创建本地项目记录
  const lpResult = db.prepare('INSERT INTO local_projects (project_id, name, start_command, work_dir) VALUES (?, ?, ?, ?)').run(projectId, name, start_command || '', work_dir || '');
  const lpId = lpResult.lastInsertRowid;

  // 写入配置项
  if (Array.isArray(local_items)) {
    for (const item of local_items) {
      if (item.item_key) {
        db.prepare('INSERT INTO local_project_items (local_project_id, item_key, item_value) VALUES (?, ?, ?)').run(lpId, item.item_key, item.item_value || '');
      }
    }
  }

  res.json({ code: 0, data: { id: projectId, code }, message: '项目创建成功' });
});

// 更新项目
router.patch('/:id', (req, res) => {
  const db = getDB();
  const { name, description, phase, status, start_command, work_dir } = req.body;

  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!project) {
    return res.status(404).json({ code: 404, message: '项目不存在' });
  }

  const updates = [];
  const params = [];

  if (name !== undefined) {
    updates.push('name = ?');
    params.push(name);
  }
  if (description !== undefined) {
    updates.push('description = ?');
    params.push(description);
  }
  if (phase !== undefined) {
    updates.push('phase = ?');
    params.push(phase);
  }
  if (status !== undefined) {
    updates.push('status = ?');
    params.push(status);
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);

  db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  // 更新本地项目
  if (start_command !== undefined || work_dir !== undefined) {
    let lpUpdates = [];
    let lpParams = [];
    if (start_command !== undefined) { lpUpdates.push('start_command = ?'); lpParams.push(start_command); }
    if (work_dir !== undefined) { lpUpdates.push('work_dir = ?'); lpParams.push(work_dir); }
    if (lpUpdates.length > 0) {
      lpUpdates.push('updated_at = CURRENT_TIMESTAMP');
      lpParams.push(req.params.id);
      db.prepare(`UPDATE local_projects SET ${lpUpdates.join(', ')} WHERE project_id = ?`).run(...lpParams);
    }
  }

  res.json({ code: 0, message: '项目更新成功' });
});

// 删除项目（软删除）
router.delete('/:id', (req, res) => {
  const db = getDB();

  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted = 0').get(req.params.id);
  if (!project) {
    return res.status(404).json({ code: 404, message: '项目不存在' });
  }

  db.prepare(`UPDATE projects SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);

  res.json({ code: 0, message: '项目已删除' });
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// 获取系统信息
router.get('/info', async (req, res) => {
  try {
    const os = require('os');
    const info = {
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      uptime: os.uptime(),
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        used: os.totalmem() - os.freemem()
      },
      cpuCount: os.cpus().length,
      hostname: os.hostname()
    };
    res.json({ code: 0, data: info });
  } catch (e) {
    res.status(500).json({ code: 500, message: '获取系统信息失败' });
  }
});

// 检查端口状态
router.get('/ports', async (req, res) => {
  const results = [];

  // 检查服务端口
  const SERVICE_PORT = process.env.PORT || 1888;

  try {
    const { stdout } = await execPromise(`ss -tlnp 2>/dev/null | grep ':${SERVICE_PORT}' || echo "port_check"`);
    results.push({
      port: parseInt(SERVICE_PORT),
      status: stdout.includes(SERVICE_PORT) ? 'listening' : 'not_listening',
      service: 'kanban-server'
    });
  } catch (e) {
    try {
      const { stdout } = await execPromise(`netstat -tlnp 2>/dev/null | grep ':${SERVICE_PORT}' || echo "not_found"`);
      results.push({
        port: parseInt(SERVICE_PORT),
        status: stdout.includes(SERVICE_PORT) ? 'listening' : 'not_listening',
        service: 'kanban-server'
      });
    } catch (e2) {
      results.push({
        port: parseInt(SERVICE_PORT),
        status: 'unknown',
        service: 'kanban-server'
      });
    }
  }

  res.json({ code: 0, data: results });
});

// 检查防火墙状态 (Linux)
router.get('/firewall', async (req, res) => {
  const results = {
    iptables: { available: false, status: 'unknown' },
    ufw: { available: false, status: 'unknown' }
  };

  try {
    // 检查 ufw
    const { stdout: ufwOut } = await execPromise('ufw status 2>/dev/null || echo "not_found"');
    if (!ufwOut.includes('not_found')) {
      results.ufw.available = true;
      results.ufw.status = ufwOut.includes('active') ? 'active' : 'inactive';
    }
  } catch (e) {
    // ufw 不可用
  }

  try {
    // 检查 iptables
    const { stdout: iptOut } = await execPromise('iptables -L -n 2>/dev/null | head -5 || echo "not_found"');
    if (!iptOut.includes('not_found')) {
      results.iptables.available = true;
    }
  } catch (e) {
    // iptables 不可用
  }

  res.json({ code: 0, data: results });
});

// 健康检查增强版
router.get('/health', (req, res) => {
  const { getDB } = require('../server/db');

  try {
    const db = getDB();
    const stats = {
      agents: db.prepare('SELECT COUNT(*) as count FROM agents').get(),
      requirements: db.prepare('SELECT COUNT(*) as count FROM requirements').get(),
      tasks: db.prepare('SELECT COUNT(*) as count FROM tasks').get(),
      pendingApprovals: db.prepare(`SELECT COUNT(*) as count FROM approval_requests WHERE status = 'pending'`).get()
    };

    res.json({
      code: 0,
      data: {
        status: 'ok',
        timestamp: new Date().toISOString(),
        stats
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, status: 'error', message: e.message });
  }
});

// 获取系统信息 (从 system_info 表)
router.get('/config', (req, res) => {
  const { getDB } = require('../server/db');

  try {
    const db = getDB();
    const infoList = db.prepare('SELECT * FROM system_info ORDER BY info_key').all();

    res.json({ code: 0, data: infoList });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 更新系统信息
router.put('/config/:key', (req, res) => {
  const { getDB } = require('../server/db');
  const { key } = req.params;
  const { value } = req.body;

  if (!value) {
    return res.status(400).json({ code: 400, message: '值不能为空' });
  }

  try {
    const db = getDB();
    db.prepare(`
      INSERT OR REPLACE INTO system_info (info_key, info_value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).run(key, value);

    res.json({ code: 0, message: '更新成功' });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

// 系统事件流 (全局 SSE)
router.get('/stream', (req, res) => {
  const { registerSSE, unregisterSSE } = require('../server/sse');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  registerSSE(null, res);

  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Ready' })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unregisterSSE(null, res);
  });
});

module.exports = router;

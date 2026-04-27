const express = require('express');
const path = require('path');
const { initDB } = require('./server/db');
const { registerSSE, unregisterSSE, broadcastToAgent, broadcastToAll } = require('./server/sse');

// 初始化数据库
initDB();

const app = express();
const PORT = process.env.PORT || 1888;

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 视图引擎
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

// 静态文件
app.use(express.static(path.join(__dirname, '../public')));

// 路由
const agentsRouter = require('./routes/agents');
const { router: requirementsRouter } = require('./routes/requirements');
const tasksRouter = require('./routes/tasks');
const approvalsRouter = require('./routes/approvals');
const systemRouter = require('./routes/system');
const projectsRouter = require('./routes/projects');
const techPlansRouter = require('./routes/tech-plans');
const localProjectsRouter = require('./routes/local-projects');

app.use('/api/agents', agentsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/requirements', requirementsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/approvals', approvalsRouter);
app.use('/api/system', systemRouter);
app.use('/api/tech-plans', techPlansRouter);
app.use('/api/local-projects', localProjectsRouter);

// 主页面
app.get('/', (req, res) => {
  res.render('index', {
    title: 'ATS',
    agents: require('./server/db').getDB().prepare('SELECT * FROM agents').all()
  });
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 导出
module.exports = { app, registerSSE, unregisterSSE, broadcastToAgent, broadcastToAll };

// 启动服务器
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════╗
║     ATS 已启动                                    ║
╠════════════════════════════════════════════════════╣
║  🌐 http://localhost:${PORT}                          ║
║  📊 健康检查: http://localhost:${PORT}/health         ║
║  👥 Agent数量: 5                                    ║
╚════════════════════════════════════════════════════╝
    `);

  });
}


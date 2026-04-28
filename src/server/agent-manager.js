const { Anthropic } = require('@anthropic-ai/sdk');
const { getDB } = require('./db');
const { broadcastToAgent, broadcastToAll } = require('./sse');

const AGENTS = [
  { id: 'leader-001', name: 'Leader', role: 'Team Lead', emoji: '🤖', color: '#6366F1' },
  { id: 'ui-001', name: 'Maya', role: 'UI Designer', emoji: '🎨', color: '#8B5CF6' },
  { id: 'fe-001', name: 'Alex', role: 'Frontend Engineer', emoji: '💻', color: '#3B82F6' },
  { id: 'be-001', name: 'Ryan', role: 'Backend Engineer', emoji: '⚙️', color: '#10B981' },
  { id: 'te-001', name: 'Casey', role: 'Test Engineer', emoji: '🧪', color: '#EF4444' },
  { id: 'ops-001', name: 'Devin', role: 'DevOps Engineer', emoji: '🚀', color: '#F97316' }
];

const agents = new Map();
let executionInterval = null;

// 初始化 Agent API 客户端
function initAgentAPI(agentId, name, role, emoji) {
  // 先清除旧的 agent 实例，以便重新初始化
  if (agents.has(agentId)) {
    const oldAgent = agents.get(agentId);
    oldAgent.client = null;
    oldAgent.status = 'idle';
    oldAgent.currentAction = '空闲中';
    oldAgent.currentDetail = '等待任务';
    oldAgent.progress = 0;
    oldAgent.messages = [];
    agents.delete(agentId);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;

  if (!apiKey) {
    console.error(`[${name}] 无法初始化 API: 未设置 API Key`);
    return null;
  }

  const agent = {
    id: agentId,
    name,
    role,
    emoji,
    client: new Anthropic({ apiKey }),
    messages: [], // 维护每个 Agent 的对话历史
    status: 'idle',
    currentAction: '空闲中',
    currentDetail: '等待任务',
    progress: 0,
    currentTask: null
  };

  agents.set(agentId, agent);
  console.log(`✓ [${name}] API 客户端已就绪`);
  return agent;
}

// 启动所有 Agent
function startAllAgents() {
  console.log('正在启动 5 个 Agent API 客户端...');

  for (const agent of AGENTS) {
    initAgentAPI(agent.id, agent.name, agent.role, agent.emoji);
  }

  console.log(`✓ 5 个 Agent API 客户端已就绪`);
}

// 执行单个 Agent 任务
async function executeAgentTask(taskMsg) {
  const db = getDB();
  const agent = agents.get(taskMsg.agent_id);

  if (!agent || !agent.client) {
    console.log(`[Agent] ${agent?.name || taskMsg.agent_id} 未运行，跳过任务`);
    db.prepare(`UPDATE agent_messages SET status = 'error' WHERE id = ?`).run(taskMsg.id);
    return;
  }

  // 更新任务状态
  db.prepare(`UPDATE agent_messages SET status = 'processing' WHERE id = ?`).run(taskMsg.id);

  try {
    // 每个新任务清空对话上下文（修复 #7）
    agent.messages = [];

    const systemPrompt = taskMsg.content || `你是一个专业的技术 Agent，请根据任务要求完成工作。`;

    console.log(`[Agent] ${agent.name} 开始执行任务: ${taskMsg.title}`);

    // 更新工作状态
    db.prepare(`
      UPDATE agents
      SET status = 'busy', current_action = ?, current_detail = '工作中', progress = 10
      WHERE id = ?
    `).run(taskMsg.title, taskMsg.agent_id);

    // 调用 Claude API
    const response = await agent.client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: agent.messages,
      temperature: 0.7
    });

    // 解析响应
    let responseText = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        responseText += block.text;
      }
    }

    // 保存输出
    db.prepare(`
      INSERT INTO agent_outputs (agent_id, message_type, content)
      VALUES (?, 'output', ?)
    `).run(taskMsg.agent_id, responseText.replace(/\n/g, ' | '));

    // 添加 AI 响应到对话
    agent.messages.push({
      role: 'assistant',
      content: responseText
    });

    // 更新状态
    db.prepare(`
      UPDATE agents
      SET status = 'idle', current_action = '空闲中', current_detail = '完成任务', progress = 100
      WHERE id = ?
    `).run(taskMsg.agent_id);

    // 广播任务完成
    broadcastToAgent(taskMsg.agent_id, {
      type: 'task_completed',
      message_id: taskMsg.id,
      title: taskMsg.title,
      response_preview: responseText.substring(0, 100) + '...'
    });

    // 如果是技术方案任务，保存内容到 tech_plans 表（修复 #6）
    if (taskMsg.type === 'tech_plan') {
      let meta = {};
      try { meta = JSON.parse(taskMsg.metadata || '{}'); } catch (e) {}

      const techPlanId = meta.tech_plan_id;

      if (techPlanId) {
        // 直接根据 tech_plan_id 写回内容
        db.prepare(`
          UPDATE tech_plans SET content = ?, review_status = 'review', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND deleted = 0
        `).run(responseText, techPlanId);

        console.log(`[Agent] 已保存技术方案内容到 DB，tech_plan_id: ${techPlanId}`);
      } else {
        // fallback: 根据 requirement_id + category 查找
        const requirementId = meta.requirement_id;
        const category = meta.category;
        if (requirementId && category) {
          const existing = db.prepare(`
            SELECT id FROM tech_plans
            WHERE requirement_id = ? AND category = ? AND deleted = 0
            ORDER BY version DESC LIMIT 1
          `).get(requirementId, category);

          if (existing) {
            db.prepare(`
              UPDATE tech_plans SET content = ?, review_status = 'review', updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND deleted = 0
            `).run(responseText, existing.id);
            console.log(`[Agent] fallback 保存技术方案内容，tech_plan_id: ${existing.id}`);
          }
        }
      }

      // 广播通知
      broadcastToAll({
        type: 'tech_plan_generated',
        requirement_id: meta.requirement_id,
        category: meta.category,
        content: responseText,
        tech_plan_id: meta.tech_plan_id,
        message_id: taskMsg.id
      });
    }

    console.log(`[Agent] ${agent.name} 任务执行完成`);

  } catch (error) {
    console.error(`[Agent] ${agent?.name || taskMsg.agent_id} 执行失败:`, error.message);

    db.prepare(`
      INSERT INTO agent_outputs (agent_id, message_type, content)
      VALUES (?, 'error', ?)
    `).run(taskMsg.agent_id, error.message);

    db.prepare(`UPDATE agent_messages SET status = 'error' WHERE id = ?`).run(taskMsg.id);

    db.prepare(`
      UPDATE agents
      SET status = 'error', current_action = '执行失败', current_detail = ?, progress = 0
      WHERE id = ?
    `).run(error.message, taskMsg.agent_id);
  }
}

// 启动 Agent 任务执行器
function startAgentTaskExecutor() {
  if (executionInterval) return;

  console.log('[Agent] 启动任务执行器...');

  executionInterval = setInterval(() => {
    const db = getDB();

    // 获取所有有 pending 消息的 Agent
    const agentsWithPending = db.prepare(`
      SELECT DISTINCT agent_id FROM agent_messages WHERE status = 'pending'
    `).all();

    for (const { agent_id } of agentsWithPending) {
      const pendingMessages = db.prepare(`
        SELECT * FROM agent_messages
        WHERE agent_id = ? AND status = 'pending'
        ORDER BY created_at ASC
      `).all(agent_id);

      if (pendingMessages.length > 0) {
        for (const msg of pendingMessages) {
          executeAgentTask(msg);
        }
      }
    }
  }, 5000); // 每5秒检查一次
}

// 停止 Agent 任务执行器
function stopAgentTaskExecutor() {
  if (executionInterval) {
    clearInterval(executionInterval);
    executionInterval = null;
    console.log('[Agent] 任务执行器已停止');
  }
}

// 准备 Agent 系统提示
function getAgentSystemPrompt(agent) {
  const basePrompt = `你是一个专业的${agent.role}。你的目标是高效地完成技术工作。`;

  const specificPrompt = {
    'UI Designer': `擅长用户界面设计，能够创建美观、易用的原型和界面设计。你专注于用户体验、色彩搭配、排版布局和交互设计。`,
    'Frontend Engineer': `擅长前端开发，精通 HTML、CSS、JavaScript 和现代框架。能够实现响应式设计、组件开发和性能优化。`,
    'Backend Engineer': `擅长后端开发，精通 Node.js、Python 或其他后端技术栈。能够设计 RESTful API、数据库架构和业务逻辑。`,
    'Test Engineer': `擅长软件测试，能够编写测试用例、执行自动化测试并分析测试结果。关注代码质量和稳定性。`,
    'DevOps Engineer': `擅长 DevOps 和基础设施，能够进行容器化部署、CI/CD 流程配置、监控和故障排查。`,
    'Team Lead': `你是技术团队的领导者，负责技术方案的审核、状态流转决策和任务分配。你的职责：

1. 审核技术方案（UI/前端/后端/测试）
2. 根据审核结果做状态流转决策：
   - 技术方案通过 → 决定下一步是派发哪个阶段的技术方案
   - 技术方案驳回 → 决定是否需要重新生成
3. 确定执行任务分配：
   - 最后阶段（测试）通过后 → 创建前端/后端/测试执行任务
   - 中间阶段通过后 → 派发下一阶段设计任务

决策原则：
- UI 通过 → 派发前端 + 后端技术方案
- 前端通过 → 派发后端技术方案
- 后端通过 → 派发测试技术方案
- 测试通过 → 创建执行任务，需求完成
- 方案驳回 → 重新生成当前方案

你需要提供清晰的决策理由。`
  };

  const rolePrompt = specificPrompt[agent.role] || '';

  return `${basePrompt}\n\n${rolePrompt}\n\n你需要在工作中保持专注，及时输出结果。完成工作时请提供清晰的总结。`;
}

// 向 Agent 发送消息
async function sendToAgent(agentId, message) {
  const db = getDB();
  const agent = agents.get(agentId);

  if (!agent || !agent.client) {
    console.error(`Agent ${agentId} 未运行`);
    db.prepare(`
      INSERT INTO agent_messages (agent_id, type, title, content, status, metadata)
      VALUES (?, 'command', ?, ?, 'pending', ?)
    `).run(agentId, message.title || '任务', JSON.stringify(message), JSON.stringify(message));
    return null;
  }

  // 保存消息到数据库
  const result = db.prepare(`
    INSERT INTO agent_messages (agent_id, type, title, content, status, metadata)
    VALUES (?, 'command', ?, ?, 'pending', ?)
  `).run(agentId, message.title || '任务', JSON.stringify(message), JSON.stringify(message));

  const messageId = result.lastInsertRowid;

  // 添加用户消息到 Agent 对话
  agent.messages.push({
    role: 'user',
    content: `【${message.title || '任务'}】\n${message.content || ''}`
  });

  // 保存输出记录
  db.prepare(`
    INSERT INTO agent_outputs (agent_id, message_type, content)
    VALUES (?, 'input', ?)
  `).run(agentId, `【${message.title || '任务'}】\n${message.content || ''}`.replace(/\n/g, ' | '));

  // 更新 Agent 状态
  db.prepare(`
    UPDATE agents
    SET status = 'busy', current_action = ?, current_detail = '工作中', progress = 10
    WHERE id = ?
  `).run(message.title || '工作', agentId);

  // 执行任务
  try {
    const systemPrompt = getAgentSystemPrompt(agent);

    // 调用 Claude API
    const response = await agent.client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: agent.messages,
      temperature: 0.7
    });

    // 解析响应
    let responseText = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        responseText += block.text;
      }
    }

    // 保存响应
    db.prepare(`
      INSERT INTO agent_outputs (agent_id, message_type, content)
      VALUES (?, 'output', ?)
    `).run(agentId, responseText.replace(/\n/g, ' | '));

    // 添加 AI 响应到对话
    agent.messages.push({
      role: 'assistant',
      content: responseText
    });

    // 更新状态
    db.prepare(`
      UPDATE agents
      SET status = 'idle', current_action = '空闲中', current_detail = '完成任务', progress = 100
      WHERE id = ?
    `).run(agentId);

    // 如果是技术方案任务，保存内容到 tech_plans 表
    if (message.type === 'tech_plan' || (message.content && message.content.includes('技术方案'))) {
      const requirementId = message.requirement_id;
      const category = message.category;
      if (requirementId && category) {
        db.prepare(`
          UPDATE tech_plans
          SET content = ?, review_status = 'review', updated_at = CURRENT_TIMESTAMP
          WHERE requirement_id = ? AND category = ? AND deleted = 0
        `).run(responseText, requirementId, category);
        console.log(`[Agent] 手动发送的任务内容已同步到技术方案: ${requirementId} - ${category}`);
      }
    }

    // 清空输入缓冲区
    db.prepare(`DELETE FROM agent_outputs WHERE agent_id = ? AND message_type = 'input'`).run(agentId);

    return {
      success: true,
      response: responseText,
      messageId
    };

  } catch (error) {
    console.error(`[${agent.name}] 执行失败:`, error.message);

    db.prepare(`
      INSERT INTO agent_outputs (agent_id, message_type, content)
      VALUES (?, 'error', ?)
    `).run(agentId, error.message);

    db.prepare(`
      UPDATE agents
      SET status = 'error', current_action = '执行失败', current_detail = ?, progress = 0
      WHERE id = ?
    `).run(error.message, agentId);

    // 保留部分对话历史，避免会话丢失
    agent.messages = agent.messages.slice(-5);

    return {
      success: false,
      error: error.message,
      messageId
    };
  }
}

// 批量发送给多个 Agent
async function sendToMultipleAgents(agentIds, message) {
  const promises = agentIds.map(id => sendToAgent(id, message));
  return Promise.all(promises);
}

// 停止所有 Agent
function stopAllAgents() {
  for (const agent of agents.values()) {
    agent.client = null;
  }
  agents.clear();
}

// 停止单个 Agent
function stopAgent(agentId) {
  const agent = agents.get(agentId);
  if (agent) {
    agent.client = null;
    agents.delete(agentId);
  }
}

// 获取待处理消息
function getPendingMessages(agentId) {
  const db = getDB();
  const pending = db.prepare(`
    SELECT * FROM agent_messages
    WHERE agent_id = ? AND status = 'pending'
    ORDER BY created_at ASC
  `).all(agentId);

  for (const msg of pending) {
    db.prepare(`UPDATE agent_messages SET status = 'processing' WHERE id = ?`).run(msg.id);
  }

  return pending;
}

// 获取 Agent 最近输出
function getRecentOutputs(agentId, limit = 20) {
  const db = getDB();
  return db.prepare(`
    SELECT * FROM agent_outputs
    WHERE agent_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(agentId, limit);
}

// 获取所有活跃 Agent
function getActiveAgents() {
  const db = getDB();
  const agentsList = db.prepare('SELECT * FROM agents WHERE deleted = 0').all();
  return agentsList.map(a => {
    const apiAgent = agents.get(a.id);
    return {
      ...a,
      isOnline: !!apiAgent && !!apiAgent.client,
      currentAction: apiAgent?.currentAction || a.current_action,
      currentDetail: apiAgent?.currentDetail || a.current_detail,
      progress: apiAgent?.progress || a.progress
    };
  });
}

// 获取 API 状态
function getAgentAPIStatus() {
  const results = [];
  for (const [id, agent] of agents) {
    results.push({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      emoji: agent.emoji,
      isOnline: !!agent.client,
      hasMessages: agent.messages.length > 0
    });
  }
  return results;
}

module.exports = {
  AGENTS,
  startAllAgents,
  stopAllAgents,
  stopAgent,
  sendToAgent,
  sendToMultipleAgents,
  getPendingMessages,
  getRecentOutputs,
  getActiveAgents,
  getAgentAPIStatus,
  agents,
  startAgentTaskExecutor,
  stopAgentTaskExecutor,
  executeAgentTask
};

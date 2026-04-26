// SSE 连接管理器（独立模块避免循环依赖）
const sseConnections = new Map(); // Agent 特定连接
const globalConnections = new Set(); // 全局连接

// 注册 SSE 连接
function registerSSE(agentId, res) {
  if (!agentId) {
    globalConnections.add(res);
    return;
  }
  if (!sseConnections.has(agentId)) {
    sseConnections.set(agentId, new Set());
  }
  sseConnections.get(agentId).add(res);
}

// 取消注册 SSE 连接
function unregisterSSE(agentId, res) {
  if (!agentId) {
    globalConnections.delete(res);
    return;
  }
  const connections = sseConnections.get(agentId);
  if (connections) {
    connections.delete(res);
    if (connections.size === 0) {
      sseConnections.delete(agentId);
    }
  }
}

// 广播消息到 Agent 的所有 SSE 连接
function broadcastToAgent(agentId, data) {
  const message = `data: ${JSON.stringify({ ...data, agentId })}\n\n`;

  // 发送到特定 Agent 的连接
  const connections = sseConnections.get(agentId);
  if (connections) {
    connections.forEach(res => {
      res.write(message);
    });
  }

  // 同时发送到所有全局连接
  globalConnections.forEach(res => {
    res.write(message);
  });
}

// 广播到所有连接
function broadcastToAll(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;

  // 全局
  globalConnections.forEach(res => {
    res.write(message);
  });

  // 个体
  sseConnections.forEach((connections) => {
    connections.forEach(res => {
      res.write(message);
    });
  });
}

module.exports = { registerSSE, unregisterSSE, broadcastToAgent, broadcastToAll };

# 技术方案：流程修复方案

> 编写时间：2026-04-28
> 关联问题：docs/flow_issues_report.md
> 原则：不新增需求/功能，只修复现有流程使其按业务要求正确流转

---

## 一、目标流程设计

```
┌─────────────────────────────────────────────────────────────────────┐
│  需求评审通过                                                        │
│  requirements.js :/:id/review                                        │
│  1. 调用 Leader Agent 分析需求（等待结果）                            │
│  2. 根据 Leader 返回决定 dispatch_chain 阶段                         │
│  3. 按链派发第一个阶段                                                │
└──────────────┬──────────────────────────────────────────────────────┘
               ↓
┌─────────────────────────────────────────────────────────────────────┐
│  阶段派发（每个阶段）                                                │
│  1. 创建 tech_plans 记录 (review_status='generating')               │
│  2. 创建 agent_messages (metadata 含 tech_plan_id)                  │
│  3. 通知对应 Agent                                                  │
└──────────────┬──────────────────────────────────────────────────────┘
               ↓
┌─────────────────────────────────────────────────────────────────────┐
│  Agent 生成技术方案                                                  │
│  executeAgentTask() 拾取 pending 任务                                │
│  1. 调用 Claude API 生成内容                                         │
│  2. 写回 tech_plans 对应 tech_plan_id                                │
│  3. 更新 review_status='review'（待审核）                             │
│  4. 更新 agent_messages status='completed'                           │
└──────────────┬──────────────────────────────────────────────────────┘
               ↓
┌─────────────────────────────────────────────────────────────────────┐
│  人工审核技术方案                                                     │
│  tech-plans.js :/:id/audit                                           │
│                                                                      │
│  ┌──── 驳回 ────┐    ┌──── 通过 ───────────────────────────────┐    │
│  │ · 标记 reject │    │ · 标记 audit_status='pass'              │    │
│  │ · 创建新任务   │    │ · 调用 Leader Agent 决策                │    │
│  │ · 状态 pending │    │                                         │    │
│  │ · 执行器拾取   │    │ UI 通过  → 派发前端 + 后端              │    │
│  └───────────────┘    │ 前端通过 → 派发后端                      │    │
│                       │ 后端通过 → 派发测试                      │    │
│                       │ 测试通过 → 所有阶段完成 → 创建执行任务     │    │
│                       └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
               ↓
┌─────────────────────────────────────────────────────────────────────┐
│  执行任务创建                                                        │
│  1. 验证所有 dispatch_chain 阶段 audit_status='pass'                 │
│  2. 为前端/后端/测试创建 tasks                                       │
│  3. 创建 agent_messages 通知各 Agent                                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 二、修复方案

### 修复 1：需求分析等待 Leader Agent 结果（问题 #1）

**文件**: `src/routes/requirements.js`

**现状**: `sendToAgent('leader-001', analysisTask)` 不等待结果，直接用正则硬编码判断。

**方案**:
- `sendToAgent` 已返回 promise，直接 await 获取 Leader 分析结果
- 解析 Leader 返回的 JSON，提取 categories 数组
- 如果 Leader 调用失败，fallback 到正则分析（降级策略）
- 将 Leader 返回的 categories 保存到 requirement_analysis 表

```
修改范围：第 292-312 行
影响面：需求评审接口
```

---

### 修复 2：统一 tech_plan 状态值（问题 #2）

**文件**: `src/routes/requirements.js`

**现状**: 创建 tech_plan 时 `review_status='pending'`，任务执行器查 `status='pending'`。

**方案**: 统一为以下状态值：
- `review_status='generating'` - 生成中，Agent 正在生成内容
- `review_status='review'` - 待审核，内容已生成等人工审核
- `review_status='in_progress'` - 进行中，审核通过后进入开发
- `review_status='done'` - 已完成

```
修改范围：requirements.js 第 342 行
影响面：创建 tech_plan 时初始状态
```

---

### 修复 3：回填 tech_plan_id 到 agent_messages（问题 #3, #4）

**文件**: `src/routes/requirements.js`

**现状**: 先创建 tech_plan，再创建 agent_message，但 metadata 里 tech_plan_id 为 null，action_url 用 requirement_id。

**方案**: 调整顺序 - 先创建 tech_plan，拿到 lastInsertRowid 后再创建 agent_message：

```javascript
// 1. 创建 tech_plan
const planResult = db.prepare(`INSERT INTO tech_plans ...`).run(...);
const techPlanId = planResult.lastInsertRowid;

// 2. 用 techPlanId 创建 agent_message
db.prepare(`INSERT INTO agent_messages ...`).run(
  ...,
  JSON.stringify({
    type: 'tech_plan',
    tech_plan_id: techPlanId,    // 回填真实 ID
    requirement_id: req.params.id,
    category: firstCat,
    action_url: '/api/tech-plans/' + techPlanId + '/submit'  // 正确 URL
  })
);
```

```
修改范围：requirements.js 第 338-380 行
影响面：需求评审派发逻辑
```

---

### 修复 4：Agent 任务执行器 - 简化 tech_plan_id 获取（问题 #5, #6）

**文件**: `src/server/agent-manager.js`

**现状**: 用 LIKE 匹配 JSON 字符串找 tech_plan_id，逻辑复杂且易出错。

**方案**: 直接从 metadata JSON 解析 tech_plan_id：

```javascript
// 第 236 行：改写查询，不再 LEFT JOIN tech_plans
const pendingMessages = db.prepare(`
  SELECT * FROM agent_messages
  WHERE agent_id = ? AND status = 'pending'
  ORDER BY created_at ASC
`).all(agent_id);

// 第 139 行：简化保存逻辑
if (taskMsg.type === 'tech_plan') {
  const meta = JSON.parse(taskMsg.metadata);
  const techPlanId = meta.tech_plan_id;

  if (techPlanId) {
    // 直接写回
    db.prepare(`
      UPDATE tech_plans
      SET content = ?, review_status = 'review', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND deleted = 0
    `).run(responseText, techPlanId);
  }
}
```

```
修改范围：agent-manager.js 第 236-248 行（查询），第 139-197 行（保存）
影响面：任务执行器核心逻辑
```

---

### 修复 5：Agent 对话上下文管理（问题 #7）

**文件**: `src/server/agent-manager.js`

**现状**: messages 数组只 push 不清空，多个任务共享同一对话。

**方案**: 每个新任务开始时清空旧对话，保留最近一轮：

```javascript
// 在 executeAgentTask 开始时
agent.messages = []; // 清空历史，每个任务独立对话
```

```
修改范围：agent-manager.js 第 85 行附近
影响面：Agent 对话质量
```

---

### 修复 6：Leader Agent 决策 - 去掉硬编码 fallback（问题 #8）

**文件**: `src/routes/tech-plans.js`

**现状**: Leader 返回解析失败后，默认派发下一阶段（第 593-596 行）。

**方案**: 解析失败时返回错误，前端提示用户重试，不自动 fallback：

```javascript
// 解析失败不再 fallback
if (!leaderDecision || !leaderDecision.decision) {
  throw new Error('Leader Agent 决策解析失败，请重试');
}
```

同时优化 `leadAgentDecideFlow` 的 prompt，明确：
- UI 通过 → 派发前端 + 后端
- 前端通过 → 派发后端
- 后端通过 → 派发测试
- 测试通过 → 创建执行任务

```
修改范围：tech-plans.js 第 501-596 行
影响面：Leader 决策逻辑
```

---

### 修复 7：UI 通过后派发前端+后端（问题 #9）

**文件**: `src/routes/tech-plans.js`

**现状**: `dispatchNextPhase` 只派发一个阶段。

**方案**: 修改 `leadAgentDecideFlow` 返回 `next_phases` 数组，审核通过逻辑批量派发：

```javascript
if (leaderDecision.decision === '派发下一阶段' && leaderDecision.next_phases) {
  for (const phase of leaderDecision.next_phases) {
    dispatchNextPhase(db, techPlan, catAgents, phase);
  }
}
```

```
修改范围：tech-plans.js 第 272-277 行，432-465 行
影响面：阶段派发逻辑
```

---

### 修复 8：统一最后阶段定义（问题 #10）

**文件**: `src/workflows/tech-plan-flow.js`

**现状**: `isLastPhase` 返回 backend，但实际 test 才是最后。

**方案**:

```javascript
// DISPATCH_CHAIN: ['ui', 'frontend', 'backend', 'test']
function isLastPhase(phase) {
  return phase === 'test';  // test 是最后一个设计阶段
}
```

```
修改范围：tech-plan-flow.js 第 137-139 行
影响面：最后阶段判断
```

---

### 修复 9：驳回后任务可被拾取（问题 #11）

**文件**: `src/routes/tech-plans.js`

**现状**: 驳回后创建新版本 `review_status='generating'`，但创建的任务 status 是否正确？

**方案**: 确保 `ensureTechPlanTaskCreated` 创建的任务 status='pending'，且 metadata 含正确的 tech_plan_id：

```javascript
// tech-plans.js:315 行附近，驳回逻辑
const newPlanResult = db.prepare(`INSERT INTO tech_plans ...`).run(...);
const newTechPlanId = newPlanResult.lastInsertRowid;

// 确保创建的 agent_message metadata 里有新版本的 tech_plan_id
ensureTechPlanTaskCreated(newTechPlanId, ...);
```

同时修改 `ensureTechPlanTaskCreated`（第 195-232 行），去掉重复检查逻辑，直接用新 tech_plan_id。

```
修改范围：tech-plans.js 第 195-232 行，307-319 行
影响面：驳回重新生成流程
```

---

### 修复 10：派发下一阶段时创建 agent_message 任务（问题 #12）

**文件**: `src/routes/tech-plans.js`

**现状**: `dispatchNextPhase` 只创建 tech_plan 记录，不创建 agent_message，Agent 不会执行。

**方案**: 在 `dispatchNextPhase` 中，创建 tech_plan 后同时创建 agent_message：

```javascript
function dispatchNextPhase(db, techPlan, catAgents, targetPhase) {
  const nextAgent = catAgents[targetPhase];
  if (!nextAgent) return;

  // 1. 创建 tech_plan 记录
  const planResult = db.prepare(`INSERT INTO tech_plans ...`).run(...);
  const techPlanId = planResult.lastInsertRowid;

  // 2. 创建 agent_message 任务（关键！）
  db.prepare(`INSERT INTO agent_messages (agent_id, type, title, content, status, metadata)
    VALUES (?, 'tech_plan', ?, ?, 'pending', ?)`).run(
    nextAgent.id,
    '📋 ' + catNames[targetPhase] + '技术方案 - ' + reqTitle,
    taskContent,
    JSON.stringify({
      type: 'tech_plan',
      tech_plan_id: techPlanId,
      requirement_id: techPlan.requirement_id,
      category: targetPhase
    })
  );
}
```

```
修改范围：tech-plans.js 第 432-465 行
影响面：阶段派发核心逻辑（当前完全不创建任务，Agent 不知道要工作）
```

---

### 修复 11：创建执行任务前验证所有阶段（问题 #13）

**文件**: `src/routes/tech-plans.js`

**现状**: Leader 说创建就直接创建，不验证。

**方案**: 在 `createExecutionTask` 前先二次验证：

```javascript
if (leaderDecision.decision === '创建执行任务') {
  // 验证所有阶段都通过
  const allPassed = verifyAllPhasesPassed(db, techPlan.requirement_id);
  if (allPassed) {
    const requirement = db.prepare('SELECT title FROM requirements WHERE id = ?').get(techPlan.requirement_id);
    createExecutionTask(db, techPlan.requirement_id, requirement?.title || '需求');
    // 更新需求状态为 done
    db.prepare(`UPDATE requirements SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(techPlan.requirement_id);
  }
}
```

```
修改范围：tech-plans.js 第 272-274 行
影响面：执行任务创建
```

---

### 修复 12：执行任务创建后通知 Agent（问题 #14）

**文件**: `src/routes/tech-plans.js`

**现状**: INSERT tasks 但不创建 agent_messages。

**方案**: 在 `createExecutionTask` 中，为每个执行者同时创建 agent_message：

```javascript
executors.forEach(agentId => {
  // 创建 task
  const taskResult = db.prepare(`INSERT INTO tasks ...`).run(...);

  // 创建 agent_message 通知
  db.prepare(`INSERT INTO agent_messages (agent_id, type, title, content, status, metadata)
    VALUES (?, 'task', ?, ?, 'pending', ?)`).run(
    agentId,
    '【执行】完成 ' + requirementTitle,
    taskDescription,
    JSON.stringify({ task_id: taskResult.lastInsertRowid, requirement_id })
  );
});
```

```
修改范围：tech-plans.js 第 468-498 行
影响面：执行任务通知
```

---

### 修复 13：前端审核通过后刷新列表（问题 #15）

**文件**: `views/index.ejs`

**方案**: `submitAuditTechPlan` 成功后调用 `loadTechPlans()` 刷新列表。

```
修改范围：index.ejs 第 1959 行附近
影响面：前端 UX
```

---

## 三、修改文件清单

| 文件 | 修改内容 | 预估行数 |
|------|---------|---------|
| `src/routes/requirements.js` | 修复 #1 #2 #3 #4 | ~40 行 |
| `src/server/agent-manager.js` | 修复 #5 #6 #7 | ~60 行 |
| `src/routes/tech-plans.js` | 修复 #8 #9 #11 #12 #13 #14 | ~100 行 |
| `src/workflows/tech-plan-flow.js` | 修复 #10 | ~5 行 |
| `views/index.ejs` | 修复 #15 | ~10 行 |
| **合计** | | **~215 行** |

---

## 四、执行顺序

```
第 1 步：修复 agent-manager.js (#5 #6 #7)     - 核心执行逻辑，先修基础
第 2 步：修复 requirements.js (#1 #2 #3 #4)   - 入口流程
第 3 步：修复 tech-plan-flow.js (#10)          - 状态定义
第 4 步：修复 tech-plans.js (#8 #9 #11 #12 #13 #14) - 审核和派发
第 5 步：修复 index.ejs (#15)                 - 前端 UX
第 6 步：清理已删除数据并测试完整流程
```

---

## 五、风险点

1. **Leader Agent API 调用超时** - await sendToAgent 可能等待较长时间，需设置合理超时和错误处理
2. **修改 agent-manager.js 执行逻辑** - 影响所有 Agent 任务执行，需充分测试
3. **dispatchNextPhase 重写** - 当前只创建 tech_plan 不创建任务，修改后行为变化较大

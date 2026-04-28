# 流程问题排查报告

> 排查时间：2026-04-28
> 范围：需求评审 → 技术方案生成 → 阶段流转 → 执行任务创建

---

## 流程一：需求评审 → 技术方案派发

**文件**: `src/routes/requirements.js` (第 259-426 行)

| # | 问题 | 位置 | 严重程度 |
|---|------|------|---------|
| 1 | **需求分析靠正则硬编码** - 用 `/界面\|弹窗/` 等正则判断是否需要 UI/前端/后端，Leader Agent 调用后**不等待结果**就继续执行 | requirements.js:296-308 | 严重 |
| 2 | **Tech plan `review_status` 初始值不对** - 创建时设为 `'pending'`，应该是 `'generating'` 才能被任务执行器拾取 | requirements.js:342-343 | 严重 |
| 3 | **Tech_plan_id 没有回填** - 创建 tech_plan 后没有把 `lastInsertRowid` 写回 agent_messages 的 metadata | requirements.js:362-380 | 严重 |
| 4 | **`action_url` 错误** - 指向 `/api/tech-plans/:id/submit`，用的是 requirement_id 不是 tech_plan_id | requirements.js:378 | 中等 |

---

## 流程二：Agent 生成技术方案内容

**文件**: `src/server/agent-manager.js` (第 69-218 行)

| # | 问题 | 位置 | 严重程度 |
|---|------|------|---------|
| 5 | **tech_plan_id 匹配逻辑错误** - 用字符串 LIKE 匹配 JSON 找 tech_plan，但 metadata 里 tech_plan_id 是 null | agent-manager.js:236-238 | 严重 |
| 6 | **保存技术方案内容逻辑混乱** - 先查 tech_plan_id，找不到就用 requirement_id+category 查，版本上限判断复杂且易出错 | agent-manager.js:139-197 | 严重 |
| 7 | **Agent 对话不会重置** - messages 数组只 push 不清空，多个任务共享同一个对话上下文 | agent-manager.js:118-121 | 中等 |

---

## 流程三：技术方案审核 → 阶段流转

**文件**: `src/routes/tech-plans.js` (第 236-329 行)

| # | 问题 | 位置 | 严重程度 |
|---|------|------|---------|
| 8 | **Leader Agent 决策有 fallback 硬编码** - 如果 Leader 返回解析失败，默认派发下一阶段，违背"由 Leader 决策"的设计 | tech-plans.js:593-596 | 中等 |
| 9 | **UI 通过后应该同时派发前端+后端**，但 `dispatchNextPhase` 只派发一个阶段 | tech-plans.js:432-465 | 严重 |
| 10 | **最后阶段判断不统一** - `isLastPhase` 在 workflow 里是 backend，但实际流程 test 才是最后 | tech-plan-flow.js:137-139 | 严重 |
| 11 | **驳回后创建新版本 `review_status='generating'`**，但任务执行器查的是 `status='pending'`，不会触发生成 | tech-plans.js:315-316 | 严重 |
| 12 | **审核通过时 `dispatchNextPhase` 创建的方案 content 为空**，且没有创建对应的 agent_message 任务 | tech-plans.js:455-458 | 严重 |

---

## 流程四：技术方案全部通过 → 创建执行任务

**文件**: `src/routes/tech-plans.js` (第 468-498 行)

| # | 问题 | 位置 | 严重程度 |
|---|------|------|---------|
| 13 | **创建执行任务时不检查是否所有阶段都通过** - Leader 说创建就直接创建，没有二次验证 | tech-plans.js:272-274 | 中等 |
| 14 | **任务创建后没有通知相关 Agent** - INSERT tasks 但没有创建 agent_messages | tech-plans.js:485-495 | 中等 |

---

## 前端问题

**文件**: `views/index.ejs`

| # | 问题 | 位置 | 严重程度 |
|---|------|------|---------|
| 15 | **审核通过后 UI 无刷新** - `submitAuditTechPlan` 只关 drawer，不主动调用 `loadTechPlans()` | index.ejs:1959 附近 | 中等 |
| 16 | **所有数据被软删除** - 48 条 tech_plans 全部 `deleted=1`，页面显示为空 | DB | 已修复 |

---

## 问题汇总

| 严重程度 | 数量 | 问题编号 |
|---------|------|---------|
| 严重 | 8 | 1, 2, 3, 5, 6, 9, 10, 11, 12 |
| 中等 | 7 | 4, 7, 8, 13, 14, 15 |

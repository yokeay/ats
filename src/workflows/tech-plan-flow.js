// 技术方案流程状态机
// 定义所有状态及其转换规则
// 由Leader Agent根据当前状态和上下文做决策

const TECH_PLAN_FLOW_STATES = {
  // Requirement 状态
  requirement: {
    pending: { label: '待处理', color: '#94a3b8' },
    review: { label: '评审中', color: '#f59e0b' },
    in_progress: { label: '进行中', color: '#3b82f6' },
    done: { label: '已完成', color: '#10b981' }
  },

  // Tech Plan Audit 状态
  audit_status: {
    pending: { label: '待审核', color: '#94a3b8' },
    pass: { label: '已通过', color: '#10b981' },
    reject: { label: '已驳回', color: '#ef4444' },
    pending_audit: { label: '待评审', color: '#f59e0b' }
  },

  // Tech Plan Review 状态
  review_status: {
    pending: { label: '待评审', color: '#94a3b8' },
    review: { label: '待审核', color: '#f59e0b' },
    generating: { label: '生成中', color: '#8b5cf6' },
    in_progress: { label: '进行中', color: '#3b82f6' },
    completed: { label: '已完成', color: '#10b981' }
  },

  // Tasks 状态
  task_status: {
    todo: { label: '待办', color: '#94a3b8' },
    in_progress: { label: '进行中', color: '#3b82f6' },
    done: { label: '已完成', color: '#10b981' },
    pending: { label: '待处理', color: '#94a3b8' }
  },

  // Dispatch Phase (设计流程阶段)
  dispatch_phase: {
    ui: { label: 'UI设计', color: '#8b5cf6' },
    frontend: { label: '前端开发', color: '#3b82f6' },
    backend: { label: '后端开发', color: '#10b981' },
    test: { label: '测试', color: '#ef4444' },
    ops: { label: '运维', color: '#f97316' }
  }
};

// 技术方案审批流程 - 状态转换规则
const TECH_PLAN_AUDIT_TRANSITIONS = {
  // 需求阶段流转
  'requirement_pending': {
    from: 'pending',
    to: 'review',
    triggers: ['需求提审'],
    description: '需求提交审核'
  },
  'requirement_review_done': {
    from: 'review',
    to: 'done',
    triggers: ['需求完成'],
    description: '需求审核通过且所有方案完成'
  },
  'requirement_review_in_progress': {
    from: 'review',
    to: 'in_progress',
    triggers: ['需求评审通过'],
    description: '需求进入执行阶段'
  },

  // Tech Plan Audit 状态流转
  'audit_pending': {
    from: 'pending',
    to: 'pass',
    triggers: ['审核通过'],
    description: '技术方案审核通过',
    nextStep: 'check_dispatch_phase'  // 触发 Leader 决策下一步
  },
  'audit_pending_to_reject': {
    from: 'pending',
    to: 'reject',
    triggers: ['审核驳回'],
    description: '技术方案审核驳回',
    nextAction: 'create_regen_task'
  },
  'audit_pass_to_review': {
    from: 'pass',
    to: 'pending',  // 修改后
    triggers: ['方案修改完成'],
    description: '技术方案修改后重新提交审核',
    action: 'reset_for_review'
  }
};

// Tech Plan Review 状态流转
const TECH_PLAN_FLOW_TRANSITIONS = {
  'review_pending_to_review': {
    from: 'pending',
    to: 'review',
    triggers: ['方案提交审核'],
    description: '技术方案提交给审核人'
  },
  'review_review_to_generating': {
    from: 'review',
    to: 'generating',
    triggers: ['开始生成'],
    description: '进入方案生成阶段',
    assignAgent: 'ui'  // UI 设计师生成
  },
  'review_generating_to_review': {
    from: 'generating',
    to: 'review',
    triggers: ['生成完成'],
    description: 'UI 方案生成完成，提交审核'
  },
  'review_review_to_in_progress': {
    from: 'review',
    to: 'in_progress',
    triggers: ['评审通过'],
    description: '方案通过评审，进入进行中'
  }
};

// Dispatch Phase (设计流程) - 由 Leader Agent 决策
const DISPATCH_CHAIN = ['ui', 'frontend', 'backend', 'test'];

// 获取下一阶段
function getNextPhase(currentPhase) {
  const idx = DISPATCH_CHAIN.indexOf(currentPhase);
  if (idx >= 0 && idx < DISPATCH_CHAIN.length - 1) {
    return DISPATCH_CHAIN[idx + 1];
  }
  return null;
}

// 检查是否是最后一阶段
function isLastPhase(phase) {
  return phase === 'test';
}

// 获取所有阶段
function getAllPhases() {
  return DISPATCH_CHAIN;
}

module.exports = {
  TECH_PLAN_FLOW_STATES,
  TECH_PLAN_AUDIT_TRANSITIONS,
  TECH_PLAN_FLOW_TRANSITIONS,
  getNextPhase,
  isLastPhase,
  getAllPhases,
  DISPATCH_CHAIN
};

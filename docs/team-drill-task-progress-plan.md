# 团队演练规划：任务进度统计迷你功能

> 性质：团队协作演练（用户已确认：迷你功能 / 按专长指定 / 完整检查 / 仅最终汇报）
> 状态：已完成归档（T1、T2 均交付并通过 `npm run check` 完整验收；T3 因演练结束未启动）

## 一、目标概述

为插件客户端补充「任务进度统计与展示」能力：给定当前任务板的任务集合，能够统计各状态数量与完成率，并以中文文案展示。同时补齐 `labels.ts` 中任务状态的标签函数（与现有 `memberStatusLabel` 对称）。

**不改动**任何现有函数的行为与签名，只做纯增量扩展，全部位于 `src/client/` 层，符合架构守卫边界。

## 二、任务清单

| 编号 | 描述 | 依赖 | 优先级 | 负责人 |
|---|---|---|---|---|
| T1 | 新增 `src/client/task-progress.ts`：定义 `TaskProgressSummary` 类型与 `summarizeTaskProgress(tasks)` 统计函数；新增 `tests/client-task-progress.spec.ts` | 无 | P0 | Coder A（29447101） |
| T2 | 在 `src/client/labels.ts` 新增 `taskStatusLabel(status)`；新增 `tests/client-labels.spec.ts` | 无 | P0 | Coder B（319b49bb） |
| T3 | 在 `src/client/task-progress.ts` 补充 `formatTaskProgressSummary(summary)`（组合 T1 类型与 T2 标签），补充集成测试 | T1、T2 | P1 | 待 T1/T2 完成后指派 |

### 契约（两任务共同遵守）

```ts
// src/client/task-progress.ts（T1 建立）
export interface TaskProgressSummary {
  total: number
  completed: number
  inProgress: number
  pending: number
  assigned: number
  failed: number
  cancelled: number
  completionRate: number // 0-1，total 为 0 时为 0
}
export function summarizeTaskProgress(tasks: Record<string, { status: string }>): TaskProgressSummary
```

- 未知状态不计数但计入 `total`（容错，不抛错）。
- `taskStatusLabel` 复用现有 `TASK_STATE_LABELS`，未知状态原样返回。
- 【T1 交付约定，供 T3 参考】`completionRate` 四舍五入到两位小数（0-1 闭区间），`total` 为 0 时保持 0；`formatTaskProgressSummary` 若将来启动，请基于此约定实现。

### 文件边界（避免编辑冲突）

- T1 只改：`src/client/task-progress.ts`、`tests/client-task-progress.spec.ts`
- T2 只改：`src/client/labels.ts`、`tests/client-labels.spec.ts`
- T3 只改：`src/client/task-progress.ts`（追加）、`tests/client-task-progress.spec.ts`（追加）

## 三、分配建议

- T1 → Coder A：纯领域逻辑/统计计算，重点考察边界条件处理。
- T2 → Coder B：展示层/文案映射，重点考察与既有风格对称性。
- T3 → 先完成者优先承接，考察汇合集成能力。

## 四、整体验收标准

1. `npm test` 全绿，新增测试覆盖：空任务集、混合状态、完成率计算、未知状态容错、标签映射。
2. `npm run check`（架构守卫 + typecheck + 测试 + 构建）完整通过。
3. 无既有行为回归；代码风格符合仓库约定（两空格、单引号、无分号）。
4. 任务板所有任务状态流转完整可追溯。

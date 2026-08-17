# Agent Team 插件技术方案

本文档集定义一个面向 DeepSeek Harness 的团队协作插件。它允许用户先创建可复用的“助手模板”，再按任务手工组建由多个独立 Agent 组成的团队，并通过 Leader、任务板和异步信箱协作。

当前仓库已经进入实现阶段。本文档既是技术方案，也是实现约束；实际完成范围与验证结果见[实现状态与二次审核](./09-implementation-status.md)。

## 可实现性状态

已按 DeepSeek Harness commit `47f943859bef60e4160492346772ded9b24f765a` 的开发指南、生成 API 文档和公开 TypeScript 接口完成审核。外部 Web Profile 插件可完成团队解散：停止 Agent、detach Workspace Session、删除团队聚合、任务、消息和活动记录，同时保留助手模板与 Workspace 文件。公开 `SessionPersistence` 没有 delete 方法，所以旧 Session 物理日志保留在 Harness 底层，但插件不再恢复或展示它们。

## 已确认的产品边界

- 成员是彼此平级、拥有独立 Session 的 Agent，不是 Subagent。
- 助手模板和团队分离：先维护助手库，再把一个或多个助手实例加入团队。
- 一个助手模板可加入多个团队，也可在同一团队中实例化多次。
- 每个团队恰好有一个 Leader；更换 Leader 前必须先指定继任者。
- 团队运行中允许新增、移除成员。
- 所有成员操作同一个 Workspace。
- 团队解散是永久删除，不是归档；不删除助手模板，也不删除 Workspace 文件。
- 模型、Provider 和凭据复用 DeepSeek Harness 已有配置，不再建设另一套模型配置中心。
- UI 采用 Harness 扩展位实现，不修改 Harness 核心代码。

## 默认假设

用户默认与 Leader 对话，同时允许用户主动打开任意成员的独立会话直接沟通。这个行为应做成团队策略配置；如果后续决定只允许 Leader 接收用户消息，不影响底层架构。

## 文档索引

1. [需求、术语与决策](./00-requirements-and-decisions.md)
2. [总体技术架构](./01-technical-architecture.md)
3. [领域模型与持久化](./02-domain-model-and-persistence.md)
4. [助手与团队后端](./03-assistant-and-team-backend.md)
5. [Agent 运行时与协作协议](./04-agent-runtime-and-collaboration.md)
6. [Host API 与客户端 UI](./05-host-api-and-client-ui.md)
7. [测试、安全与发布](./06-testing-security-and-release.md)
8. [分阶段执行清单](./07-execution-checklist.md)
9. [DeepSeek Harness 插件可实现性审核](./08-harness-plugin-feasibility-audit.md)
10. [实现状态与二次审核](./09-implementation-status.md)
11. [完整团队 Conversation 工作台设计](./10-team-conversation-workbench.md)

## 推荐执行顺序

按外部插件 Spike、领域存储、助手库、团队生命周期、独立 Agent 运行时、协作协议、Web Host API、UI、团队解散和发布的顺序实施。Session 日志物理删除作为 Harness 上游可选增强，不阻塞插件的团队解散。每一步见[分阶段执行清单](./07-execution-checklist.md)。

## 参考基线

- DeepSeek Harness 开发文档：<https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/user/develop>
- DeepSeek Harness 源码：<https://github.com/deepseek-ai/deepseek-harness>
- AionUi 团队协作交互参考：<https://github.com/iOfficeAI/AionUi>

实现开始时应把 Harness 依赖固定到明确版本或提交，不依赖 `master` 的浮动行为。

# 07. 分阶段执行清单

Phase 0 的能力审计已经完成，但其中的 Harness 上游删除 seam 是独立发布门禁：它阻塞 Phase 9 和完整产品发布，不阻塞 Phase 0B–8 的可实现插件能力开发。其余 Phase 按退出标准顺序推进，不能通过降低测试标准绕过删除阻塞。

## Phase 0：固定基线与能力审计

### 已完成的文档审核

- [x] 固定审核基线：DeepSeek Harness commit `47f943859bef60e4160492346772ded9b24f765a`。
- [x] 核对 Cordis 插件入口、`inject`、`ctx.effect`、Config 和 bundle 安装流程。
- [x] 核对 `ctx.agents.create/resume`、`AgentHandle`、Agent 状态与消息投递。
- [x] 核对 Agent Preset、System Prompt、Tool restriction、Skill 和 Permission Preset。
- [x] 核对 `ctx.storageDomain`、`ctx.workspaceRegistry` 和 Session Persistence。
- [x] 核对 `dsh.client`、Slot 名称、Client `ctx.sessions.open` 和 WebServer。
- [x] 确认 Typert Remote 只是一元 RPC，严格生成链未在用户指南中证明支持树外插件。
- [x] 确认公开 Session Persistence 没有永久删除方法。

### Phase 9/发布前必须解决的阻塞

- [ ] Harness 增加公开、后端无关的 Session 删除 API。
- [ ] JSONL 和 SQLite Persistence Provider 都实现该 API。
- [ ] 删除 API 定义 live Session 拒绝/先 dispose、写入 drain、缓存失效和并发语义。
- [ ] Workspace、Projection、Feedback 等 Session sidecar 的删除或脱钩语义明确。
- [ ] Agent Team 插件通过公开 API 完成真实永久删除测试。

如果上游不接受该能力，只能重新与产品确认“归档/隐藏”语义；当前需求已明确永久删除，所以不能用归档替代。

## Phase 0B：最小外部插件 Spike

在 Session 删除能力并行推进期间，可以完成不产生业务代码承诺的技术 Spike：

- [x] 创建单 npm 包，声明 `dsh.bundle`、`dsh.client`、Host 和 Client exports。
- [x] 用 Schemastery 定义最小 Config。
- [ ] 通过 `dsh plugin --profile demo add` 安装、`--dump-config` 验证和 remove 卸载。
- [x] 注册 `settings.section`、`sidebar.footer.action` 和 `shell.overlay`；设置只管理助手，团队创建与二级列表位于侧栏底部入口。
- [x] 注册 `/agent-team/api` 与 `/agent-team/events`，实现 SSE teardown；真实回环请求仍待 Profile 冒烟。
- [x] 通过 `ctx.storageDomain` 打开/关闭领域并实现读写；双后端重载测试仍待完成。
- [x] 用 `workspaceRegistry` 选择同一 Workspace。
- [x] 组建团队弹窗可选择已有 Workspace，也可通过公开 `ctx.workspaces.pickDirectory/create` 流程选择文件夹并注册 Workspace。
- [x] 实现不同 provider/model、不同 Session 的独立根级 Agent 创建。
- [x] 为成员生成全局唯一的 `agent-team:` 命名空间 Session ID。
- [x] 在 `setup` 中 mount Preset、注册补充提示、restrict 工具、Skill guard 和 scope-local 团队工具。
- [x] 在 `setup` 中预组装 Prompt，验证团队助手/角色段未被 Preset 的 complete Prompt 排除。
- [x] attach Session 到 Workspace；多列工作台数据平面按 Phase 8A 实现，标准 `ctx.sessions.open` 仅作辅助入口。
- [x] 实现 dispose、flush、resume 和插件卸载顺序；真实 Profile 恢复测试仍待完成。

### 退出标准

- [ ] Spike 只使用公开 API，未导入 Harness 内部 `src/*`。
- [ ] Web Host/Client 插件可以安装、运行和完整卸载。
- [ ] 两个成员是独立 Agent，没有 Subagent 元数据或所有权关系。

## Phase 1：工程骨架

- [x] 建立 `src/domain`、`storage`、`service`、`runtime`、`transport`、`client`；团队工具由 Runtime 按 Agent scope 注册。
- [ ] 配置 TypeScript、tsdown、测试、Lint 和 CI（TypeScript、tsdown、Vitest 已完成；Lint/CI 未完成）。
- [x] 建立 Host/Client 分离构建，浏览器 bundle 不引入 Node 模块。
- [x] 编写 `cordis.patch.yml` 和安装产物清单。
- [x] 建立 Config 默认值与严格校验，部署参数可在 `cordis.yml` 覆盖。
- [x] 加入禁止 Subagent 元数据与服务依赖的静态守卫；其他安全扫描仍需继续扩充。

退出标准：空业务插件可以从 GitHub（含 `prepare` 授权）或 tarball 安装并卸载。

## Phase 2：领域存储

- [x] 用 `defineDomain` 声明 `agent_team` Schema。
- [x] 固定首版 DomainSpec version；为记录加入应用级 `schemaVersion`，不依赖 Backend 原地 migration。
- [x] 实现 assistants、teams、messages、activities、operations 表。
- [x] 把 Team、成员、任务、Lease 和任务通知 Outbox 放入单 TeamAggregate。
- [x] 用 `KvTable.update` 实现 Revision 和原子聚合变更。
- [x] 任务分配与任务通知通过 Aggregate Outbox 同事务保存；投递失败可恢复重试。
- [ ] 实现跨记录 Operation 状态机和崩溃恢复，不假设跨表事务。
- [ ] 实现可中断、幂等的记录级升级；descriptor 不兼容变更另做新 Domain 复制 Spike。
- [ ] 注册 `domain/changed` 监听并在卸载时自动移除。
- [ ] 对 JSON 和 SQLite Storage Route 运行同一契约测试。

退出标准：插件不直接访问任何存储文件或 Backend Facet，重启后领域状态一致。

## Phase 3：助手库后端

- [ ] 实现模板 CRUD、复制、搜索和引用检查。
- [x] 通过 `ctx.llm` 暴露 Provider/Model Catalog 和最终模型解析。
- [x] 通过 `ctx.agentPresets.list` 与 `permissionPresets` 暴露可选项。
- [x] 校验 Provider/Model 必填、Preset 存在；工具名在 Agent setup 的官方 restriction 边界校验。
- [x] 实现不可变成员快照。
- [x] 对 Skill 白名单采用 Agent-scope Catalog 校验和 `tools.guard()`，不假设 Registry 白名单。

退出标准：服务层可完整管理模板，不保存 Provider 凭据。

## Phase 4：团队生命周期领域服务

- [x] 实现 Draft、Start、Pause、Resume。
- [x] 实现唯一 Leader、同模板多实例和动态新增成员。
- [x] 实现原子换 Leader。
- [ ] 实现移除成员时任务等待/取消/转派状态机（当前要求先由任务工具完成、失败、取消或转派，存在开放任务时拒绝移除）。
- [x] 移除成员时 dispose Agent、detach Workspace，并把 Session 索引转入 `retiredSessions` 只读历史。
- [ ] 实现模板同步的保留/新建 Session 策略。
- [x] 未启动 Draft 可安全删除；已启动团队在 Session delete 缺失时返回 `SESSION_DELETE_UNSUPPORTED`，拒绝伪完成。

退出标准：并发命令不能制造无 Leader、双 Leader或悬空任务 Owner。

## Phase 5：独立 Agent Runtime

- [x] 实现 `(teamId, slotId) -> AgentHandle` Registry。
- [x] 使用 `ctx.agents.create`，写入 `meta.cwd` 和完整 `agentOptions`。
- [x] 在 `setup` 中依次 mount Preset、提示段落、工具 restriction、Skill guard 和团队工具。
- [x] 用 `assembleContextFor` 预检补充段确实生效，不兼容 Preset 在发布前回滚。
- [x] 在未发布 setup 中应用 Permission Preset，发布后 attach Workspace。
- [x] 实现 `idle/running` 监听及插件派生状态。
- [x] 实现 `cancel -> whenIdle -> sessions.flush -> handle.dispose`。
- [x] 实现 `ctx.agents.resume` 冷恢复，不生成替代 Session。
- [x] 检测 live bare Agent 与 Handle Registry 不一致的 `ownership_conflict`。
- [x] 暂停让 Agent idle 并保留 Handle；所有 Team API 新投递都受 active 状态 gate。
- [x] 把所有顺序相关清理放入同一个 `ctx.effect` disposer。

退出标准：Codex/GLM 等两个已配置路由能在同一 Workspace 并行运行，Session 不串线。

## Phase 6：任务板、信箱与团队工具

- [x] 用 `defineTool` 实现任务板、创建/更新任务和成员消息工具。
- [x] 从 `exec.agent.id` 解析成员身份，不相信模型参数。
- [x] 实现基础任务指派、进展、结果和成员消息。
- [x] 用稳定 MessageId、queued 记录和 Session inbox 事件检查实现恢复投递去重。
- [x] 普通消息使用 Agent `followup` 队列，不随意 `steer/inject`。
- [ ] 实现文件范围 Lease 和冲突告警。
- [ ] 实现 Agent 回到 idle 但未更新任务时的兜底阻塞状态。

退出标准：Leader 指派立即返回；崩溃恢复不会重复插入同一业务 MessageId。

## Phase 7：Web Host API 与 SSE

- [x] 使用 `ctx.webServer.register` 注册固定 exact 路由。
- [ ] 实现严格 DTO Schema、Body 限制、错误码、Revision 和幂等键。
- [ ] 默认只支持 `127.0.0.1`；LAN 模式完成 Host/Origin/CSRF 审计后再开放。
- [x] 实现 SSE Cursor、心跳、断线和 effect-owned teardown。
- [x] Client 重连/变化后查询快照，不依赖事件重放。
- [ ] 完成 API、SSE 和恶意输入测试。

退出标准：`dsh web` 下 Host/Client 可通信，插件卸载不会留下路由或长连接。

## Phase 8：Client UI

- [x] 注册 `settings.section`、`sidebar.footer.action` 和 `shell.overlay`。
- [x] 设置页只保留助手库；侧栏“团队 +”负责组建，已创建团队作为二级菜单。
- [ ] 将全部 UI 文案接入 Harness `zh/en` Locale；中文名称为“Agent 团队”，英文为“Agent Team”。
- [x] 实现助手创建/复制/删除和基础团队组建器。
- [ ] 实现完整多列 Conversation 工作台、任务板和管理抽屉。
- [ ] 可选注册 `conversation.session.header.actions`，提供从标准单 Session 返回团队的入口。
- [ ] 为 Approval/Question 提供安全衔接；首版跳转标准 Session，不能伪造交互响应。
- [ ] 实现换 Leader、增删成员和模板同步交互（换 Leader、增删成员已完成；模板同步未完成）。
- [x] 永久删除能力缺失时显示阻塞，不为已启动团队提供误导性完成按钮。
- [ ] 完成键盘、焦点、小窗口和断线恢复测试。

退出标准：Web UI 能完成除被上游阻塞的永久删除外的全生命周期，并准确表达限制。

### Phase 8A：完整团队 Conversation 工作台

- [ ] 按 [`10-team-conversation-workbench.md`](./10-team-conversation-workbench.md) 实现成员 Conversation Projector。
- [ ] 用 `session/event` 驱动 text/reasoning/tool-call 流式 patch。
- [ ] 用 `sessionPersistence.inspect/readFrom` 恢复历史和断点。
- [ ] 实现三列独立对话、独立 Composer、停止和单列放大。
- [ ] 实现通用 ToolCard，未知工具不能丢失参数或结果。
- [ ] 实现 Bash、Read、Edit/Diff、Search 等首批专用 ToolCard。
- [ ] 实现共享 Workspace 文件树和变更面板。
- [ ] 完成三 Session 并行、重连、冷恢复、响应式和可访问性测试。

退出标准：三名成员可以同时流式输出并展示工具调用，刷新与重启后历史一致，任何一列操作都不串到其他成员。

## Phase 9：永久删除接入

仅在 Phase 0 的 Harness 删除能力发布后开始：

- [ ] 停止团队新工作并进入 `deleting`。
- [ ] cancel、whenIdle、flush、dispose 所有成员。
- [ ] 通过公开 API 删除现任成员和 `retiredSessions` 中每个 Session 及规定的 sidecar。
- [ ] detach Workspace Session 关联。
- [ ] 删除消息、活动、任务、成员和 TeamAggregate。
- [ ] 清除 Operation；保留助手模板和 Workspace 文件。
- [ ] 验证解散流程没有调用 AssistantService 删除路径，也没有按引用计数清理助手模板。
- [ ] 在每一步注入崩溃并验证可恢复清理。

退出标准：JSONL/SQLite 两种 Session Provider 都无法再 list/load 已删除 Session，且模板和 Workspace 文件完整。

## Phase 10：发布

- [ ] 固定 Harness 兼容版本和 Peer Dependency。
- [ ] 运行类型、单元、存储、Runtime、API、UI、E2E 和安全测试。
- [ ] 验证 GitHub 安装的 `prepare` 与 npm/tarball 预构建安装。
- [ ] 编写安装、配置、升级、回滚、卸载和诊断说明。
- [ ] 标明首版 Web-only、LAN 限制和兼容矩阵。
- [ ] 完成 Codex Leader + GLM Member 的真实 Provider 冒烟测试。

## 全局完成定义

- [ ] 成员始终是独立根级 Agent，不是 Subagent。
- [ ] 一个助手模板可跨团队、同团队多实例使用。
- [ ] 每个团队恰好一个 Leader且可原子更换。
- [ ] 所有成员 Session 使用同一规范 Workspace cwd。
- [ ] 插件生命周期、配置、存储、工具和 UI 均使用公开 Harness API。
- [ ] 永久解散真实删除成员 Session 和团队数据，保留模板与 Workspace 文件。
- [ ] 不支持的平台和能力不以静默降级或伪完成方式呈现。

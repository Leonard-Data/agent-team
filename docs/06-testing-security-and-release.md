# 06. 测试、安全与发布

## 测试策略

测试从领域不变量开始，向存储、Harness 适配、Host API 和 UI 逐层扩展。真实模型只用于少量冒烟测试；大多数自动化测试使用可控的假 Provider/Agent，以保证可重复和低成本。

## 单元测试

### 领域与状态机

- 助手模板创建、修订冲突、被引用时禁止删除。
- 同一模板跨团队和同团队多实例。
- 无 Leader、双 Leader、删除当前 Leader均被拒绝。
- 原子更换 Leader在并发修改时只有一个成功。
- 团队进入 `deleting` 后拒绝所有新命令。
- 任务状态、依赖环、Owner 和文件范围校验。
- 消息收件人、发送者身份和幂等去重。

### 解散流程

- Draft 团队无需运行时即可直接删除团队领域记录。
- 已启动团队依次停止 Runtime、释放 Handle、解除 Workspace 关联并删除团队领域数据。
- 在停止 Runtime、解除关联、删除领域数据前后分别注入失败，验证进入 `delete_blocked` 并可重试。
- 重启后不重复激活删除中团队，不误删模板和 Workspace。
- 无论助手仅被当前团队使用还是同时被其他团队使用，解散都不删除 AssistantTemplate。

## 存储契约测试

通过 Harness 的 JSON 与 SQLite Storage Route 对同一个 `ctx.storageDomain` 适配层运行契约测试：

- 单 TeamAggregate 的 `KvTable.update` 原子性与并发 revision 冲突。
- 进程异常后的 Domain 状态和 Operation 恢复一致性。
- Event Cursor 连续性和 Outbox 恢复。
- 应用级记录 Schema 升级的中断续跑与重复执行；验证 Domain descriptor version 不一致会被明确拒绝，而不是假设 Backend 自动迁移。
- 路径、Unicode、长内容和附件引用边界。

## Harness 适配集成测试

- 根级上下文创建两个独立 Agent，不调用任何 Subagent API。
- 两个 Agent 使用不同 Provider/模型和不同 Session。
- 两个 Agent 获得同一个规范化 Workspace。
- `setup(agentCtx)` 正确挂载 Preset、补充提示段落、工具 restriction 和团队工具。
- `complete: true` Preset 排除团队提示段时，Prompt 预检使原子创建回滚且不发布半配置 Agent。
- `followup` 投递、忙碌排队、取消、审批等待和 `whenIdle` 行为。
- 重启后 `resume` 回到原 Session，不生成替代 Session。
- 解散后团队不再 list/get，成员 Handle 不再存活，现任与已移除 Session 均解除 Workspace 活动关联。
- Harness 底层 Session 日志即使保留，也不会被插件恢复、展示或重新归属给已解散团队。

## 协作端到端场景

1. 创建 Codex Leader 模板和 GLM 编码助手模板。
2. 创建共享 Workspace 的团队并启动两个成员。
3. 用户把目标发给 Leader。
4. Leader 创建任务并异步指派 GLM 成员。
5. Leader 在成员工作时仍可接收用户消息。
6. 成员更新进度和结果，Leader 汇总。
7. 再添加一个同模板成员实例并行执行另一任务。
8. 更换 Leader，验证原 Leader变为普通成员且 Session 不丢失。
9. 在当前基线移除一个普通成员，验证其 Agent 停止、Session 进入只读历史、索引进入 `retiredSessions`，其他成员继续运行。
10. 解散运行中团队，验证团队数据和成员运行时消失、Workspace Session 关联解除、模板与 Workspace 文件保留；底层 Session 日志可以保留但不再归属团队。

## UI 测试

- 助手库、团队组建器、工作台核心流程组件测试。
- 三个成员 Session 同时流式输出 text/reasoning，字符顺序正确且互不串线。
- `tool-call-delta`、`tool/call`、`tool/result` 的 running/success/error 展示和 `callId` 关联。
- 未识别工具落入通用 ToolCard，不出现空白节点或丢失结果。
- Conversation 历史刷新、SSE 断线重连、插件冷恢复前后一致且无重复节点。
- 键盘操作、焦点、可读状态和小窗口布局。
- 修订冲突、断线重连、Provider 失效、Workspace 丢失。
- 当前 Leader不能移除、删除名称不匹配不能提交。
- 删除进行中页面不可恢复团队，只能重试清理。
- 事件流丢失后重新拉取快照并恢复一致视图。

## 静态守卫

CI 增加禁止模式扫描和架构测试：

- 禁止导入或调用 `ctx.subagents`、`dsh-tool-subagent`。
- 禁止成员元数据出现 `origin: "subagent"` 或 `parentSession`。
- 禁止 Client UI 直接访问领域存储或 Agent Handle。
- 禁止持久化 Provider Token、API Key 或原始凭据。
- 禁止解散逻辑直接执行文件系统递归删除 Workspace。
- 禁止把 `SessionPersistence.locate().path` 用作删除目标或导入 Harness 私有 `src/*` 绕过公开接口。

静态扫描不能代替运行测试，但能防止架构在迭代中悄然退化。

## 安全设计

### 权限边界

- 所有 Team Tool 调用从当前 Agent 上下文派生 `teamId/slotId`，不相信模型传入的身份。
- 普通成员只能修改自己的任务或明确授权的数据。
- Broadcast、成员管理和跨成员任务变更按角色校验。
- 永久解散和助手删除只允许用户管理入口调用，Agent 不能直接执行。

### Workspace 与工具

- 路径解析后必须位于团队 Workspace 内，拒绝 `..`、符号链接逃逸和非授权绝对路径。
- 文件范围 Lease 不提升文件权限。
- Shell、写文件和网络等危险工具继续服从 Harness 审批。
- UI 不把 Workspace 内容或成员消息发送到无关 Provider。

### 数据与日志

- 不复制 Provider 凭据到助手快照、团队事件或日志。
- 日志默认记录实体 ID、状态和错误码，不记录完整 Prompt、消息和文件内容。
- 导出诊断包前做敏感字段脱敏并由用户确认。
- 永久删除后不在普通事件日志保留可重建对话的内容。

### Web Transport

- 首版默认只在 `127.0.0.1` 验证；`0.0.0.0` 部署必须补充 Host/Origin/CSRF 策略。
- API 只接受明确 Method、Content-Type 和大小上限内的严格 Schema Body。
- SSE 连接受容量、心跳和 Fiber disposer 管理，插件卸载后不能残留长连接。
- WebServer 路由不自动等同于 Harness Connection 的 Trusted Host 边界，测试不能沿用错误假设。

## 性能与稳定性基线

初始目标在 Phase 0/1 用基准测试校准，不把模型响应耗时计入插件本身：

- 团队列表和工作台快照在本地存储规模下保持交互级响应。
- 事件流采用增量 Cursor，不重复推送完整任务板。
- Agent 启动采用可配置并发上限，避免一次组建大量成员耗尽 Provider 或系统资源。
- 消息队列有容量、退避和死信策略，不能无限占用内存。
- Runtime Handle 在暂停时继续由 Team Runtime 持有且最终 idle；在移除和解散的 RuntimeStopped 阶段可证明已释放。

## 发布流程

1. 固定 Harness 兼容版本和 Peer Dependency 范围。
2. 运行格式化、类型检查、单元、存储契约、集成、UI 和 E2E 测试。
3. 在临时用户数据目录执行新装、升级、崩溃恢复和卸载测试。
4. 生成插件清单与 bundle，验证 Host/Client 贡献点均加载。
5. 发布说明列出 Schema 迁移、已知限制、删除语义和兼容矩阵。
6. 提供最小安装、升级、回滚和故障诊断文档。

## 发布门槛

- Phase 0 所有公开 API 与生命周期门禁通过。
- 完整 E2E 场景通过，且无 Subagent 使用痕迹。
- 永久解散故障注入测试通过。
- Provider 凭据和 Workspace 安全审计通过。
- UI 可访问性和断线恢复达到验收标准。
- 首版只宣称 Web Profile 支持；自定义 Web API 的回环/LAN 信任边界通过安全测试。

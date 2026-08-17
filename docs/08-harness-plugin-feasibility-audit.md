# 08. DeepSeek Harness 插件可实现性审核

## 审核基线

- 本地源码：`/private/tmp/deepseek-harness-reference`
- Commit：`47f943859bef60e4160492346772ded9b24f765a`
- 主要指南：`docs/user/develop/`
- API 权威补充：生成的 `docs/subsystems/*.zh.md` 与对应 TypeScript 公开接口
- 审核日期：2026-08-17

开发指南明确要求内置服务以生成的 Subsystem 页面和 TypeScript 接口为准，因此本审核没有只凭教程示例推断高级能力。

## 开发指南到方案的映射

| 开发指南 | 本方案采用的约束 |
| --- | --- |
| `basic/index.zh.md` | Cordis 插件入口、`inject` 依赖声明、资源由 `ctx.effect` 生命周期托管 |
| `basic/config.zh.md` | 导出同名 `Config` 类型与 Schemastery Schema；默认值进 Schema，配置错误响亮失败 |
| `basic/publish.zh.md` | 使用带 `dsh.bundle` 的组合包、Profile patch、GitHub `prepare` 或预构建发布物 |
| `basic/tool.zh.md` | 团队工具用 `defineTool`，参数与输出都由 Schema 校验 |
| `framework/index.zh.md`、`framework/service.zh.md` | Host 业务层作为 Cordis Service；依赖通过公开 Service seam 注入 |
| `framework/events.zh.md` | Cordis 事件只作进程内通知，监听器随 effect 清理，不把它误当 Session 持久记录 |
| `practice/index.zh.md` | 首版一个包承担 Definition/Provider/Consumer；只有出现独立替换需求时才拆包 |
| `practice/llm-adapter.zh.md` | Provider/Model 仍由 Harness LLM Adapter 路由；本插件消费已有适配器，不另存凭据、不自行实现模型后端 |

## 结论

团队、助手、独立 Agent、共享 Workspace、任务信箱、Web UI、插件持久化和产品层团队解散都能由外部组合包实现。唯一缺少的公开能力是 **Session 持久化日志的物理删除**，但团队解散不要求越权擦除 Harness 自身日志。

因此当前状态是：

- 技术架构主体可行。
- 可以完整实现团队生命周期与解散。
- 解散会删除插件团队数据与运行时归属，保留助手模板和 Workspace 文件。
- 旧 Session 日志可能继续存在于 Harness 底层，但不再被恢复、展示或归属为团队成员。

## 能力矩阵

| 需求 | 公开插件能力 | 结论 |
| --- | --- | --- |
| 安装一个插件包 | `dsh.bundle` + `cordis.patch.yml` + `dsh plugin add` | 可实现 |
| 同包 Host + Web Client | `exports["./client"]` + `dsh.client.platform = web` | 可实现 |
| 配置校验 | Schemastery `Config` + Cordis HMR | 可实现 |
| 服务与生命周期 | `inject`、`Service`、`ctx.effect` | 可实现 |
| 创建平级独立 Agent | `ctx.agents.create` 返回 `AgentHandle` | 可实现 |
| 恢复成员 | `ctx.agents.resume` | 可实现 |
| 不使用 Subagent | 不设置 `origin/parentSession/delegationDepth`，不调用 Subagent 服务 | 可实现 |
| 不同 Provider/Model | `AgentOptions.provider/model` | 可实现，要求路由已配置；输出上限沿用模型与 Harness 配置 |
| Preset | `ctx.agentPresets.mount(agentCtx, id)` | 可实现 |
| 助手提示词 | Agent scope `ctx.systemPrompt.section` | 可实现，需避开名称冲突 |
| Prompt 兼容性预检 | `assembleContextFor` + `systemPrompt.assemble` | 可实现；拒绝排除团队段的 complete Prompt |
| Agent 工具 | 直接继承 Agent Preset，并追加团队协作工具 | 可实现；助手模板不二次限制 |
| 助手可用 Skills | Preset standing scope Catalog + Agent 最近层同名遮蔽 + `ctx.tools.guard()` 兜底 | 可实现；Harness 在调用 `skill(name)` 时按需加载正文 |
| 权限预设 | `ctx.permissionPresets.set(session, name)` | 可实现 |
| 共享 Workspace | `workspaceRegistry` + `CreateAgentOptions.meta.cwd` | 可实现 |
| 多列完整成员对话 | `session/event` + `sessionPersistence.inspect/readFrom` + `shell.overlay` 自定义 renderer | 可实现；官方 Conversation 内部组件不直接复用 |
| 团队领域数据 | `ctx.storageDomain` + `defineDomain` | 可实现，无跨表事务 |
| 记录 Schema 升级 | 记录级 `schemaVersion` + Operation | 可实现；Domain descriptor 无原地 migration |
| 团队工具 | `defineTool` + Agent scope 注册 | 可实现 |
| 异步投递 | `Agent.followup(UserMessage)` | 可实现，方法本身不返回任务结果 |
| 状态观察 | `agent/status` 只有 `idle/running`；其他状态由插件派生 | 可实现 |
| Web API/SSE | `ctx.webServer.register` | 可实现，仅 Web Host |
| Web UI | Slots + `dsh.client` | 可实现 |
| Electron 自定义 API | WebServer 不覆盖 Electron IPC | 当前方案不承诺 |
| Typert Remote | 内建严格生成链存在，树外包流程未在用户指南证明 | 可做 Spike，不作为首版依赖 |
| Dispose 运行成员 | `AgentHandle.dispose` | 可实现，只删除 live 实例 |
| 移除活动成员 | dispose + Workspace detach + 团队 `retiredSessions` | 可实现，团队索引保留到解散 |
| 解散团队 | dispose + detach + 删除 Team Domain 数据 | 可实现；不删除助手模板与 Workspace 文件 |
| 永久删除 Session 日志 | `SessionPersistence` 无 delete | **不可由当前公开插件 API 实现** |

## 已修正文档中的不实假设

### 存储

原方案提出插件自管 JSONL/SQLite 和跨表事务。Harness 已有 `ctx.storageDomain`，且明确要求产品包不直接触碰 Backend。修正后：

- 使用 `ctx.storageDomain`。
- 把强不变量放进单 `TeamAggregate`，用 `KvTable.update` 原子更新。
- 跨记录流程使用 Operation 状态机，不宣称不存在的事务能力。
- JSON/SQLite Backend 对 descriptor version 不一致会拒绝打开，不提供原地 migration；因此固定首版 DomainSpec version，并用记录级 `schemaVersion` 和可恢复 Operation 做应用迁移。

### Client Slot

修正为源码中存在的精确名称：

- `settings.section`
- `sidebar.footer.action`
- `shell.overlay`
- `conversation.session.header.actions`（可选标准单 Session 返回入口）

所有注册先通过 `ctx.slots.inject` 等待父 Slot。

### Agent 状态

Harness `AgentStatus` 只有 `idle | running`，dispose 后从 Registry 移除。`starting/offline/waiting_approval/error` 是插件领域投影，不再写成 Harness 原生状态。

### Agent 创建

修正后的必需行为：

- `meta.cwd = workspace.path`
- `provider` 和 `model` 在可启动模板中必填
- `setup` 只组合，不驱动 Agent
- `followup` 使用完整 `UserMessage`，而不是字符串
- `AgentHandle.dispose` 是 Handle 所有者能力

### Transport

Typert Remote 只支持一元方法，严格 Client contribution 依赖生成工件。外部组合包构建流程尚未由用户指南保证。首版改为公开 WebServer JSON + SSE，并明确 Web-only 和 LAN 信任边界。

## Session 日志物理删除边界的证据

公开 `SessionPersistence` 包含：

- `locate`
- `readRaw`
- `create`
- `append`
- `prepare`
- `load`
- `inspect`
- `readFrom`
- `list`
- `listSnapshots`

没有 `delete`。此外：

- `AgentHandle.dispose()` 停止 Agent、移出 live Registry/Session Store 并释放 scope，不删除持久日志。
- `Workspace.detachSession()` 和 `archiveSession()` 不删除持久日志。
- `SessionPersistence.locate()` 文档明确是 location hint，不是 authorization token。
- SQLite Persistence 对单 Session `locate()` 返回 `undefined`。

所以直接 `unlink` JSONL 文件既违反公开边界，也不兼容 SQLite、缓存和并发恢复。

## 推荐的 Harness 上游能力

建议在 Session Persistence Service Definition 增加类似以下语义，而不是让 Agent Team 猜后端：

```ts
abstract delete(id: SessionId, options?: {
  signal?: AbortSignal;
  expectedRevision?: SessionPersistenceRevision;
}): Promise<'deleted' | 'absent'>
```

最终签名由 Harness 项目决定，但必须定义：

- live/prepared Session 的拒绝或协调规则。
- pending append、flush、repair 和缓存的串行化。
- JSONL 与 SQLite 的一致行为。
- Workspace、Projection Cache、Feedback 等 sidecar 的清理职责。
- 幂等、Revision、取消和崩溃恢复语义。

这项能力不是团队解散的前提。`dissolve` 通过公开 API 停止并释放成员、解除 Workspace 关联、删除团队领域记录后即可成功；只有这些实际清理步骤失败时才进入 `delete_blocked`。插件不得把成功表述为底层日志已被物理擦除。

## 审核后的实现边界

- 首版：DeepSeek Harness Web Profile 外部组合包。
- 不修改 Harness 核心 UI 或路由。
- 不使用 Subagent、Job 或父子 Session。
- 不自建模型凭据中心。
- 不直接访问 Harness 内部文件、私有源码入口或 Storage Backend。
- Typert Remote、Electron 和 LAN 暴露均在额外能力验证后再启用。

## 最终审核标准

Phase 0B Spike 必须证明安装、Host/Client、Storage、Agent、Workspace、Slot 和卸载流程。发布前还要验证解散在两种 Storage Provider 上都能删除团队领域数据、释放运行时并解除 Workspace 关联，同时明确记录 Session 日志物理删除不受支持。

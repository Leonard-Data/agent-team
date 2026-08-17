# 03. 助手与团队后端

## 目标

提供不依赖 UI 的应用服务层，实现助手模板和团队生命周期。Host API、成员协作工具和未来 CLI 都只调用该服务层，避免出现多套业务规则。团队解散删除插件拥有的团队领域数据与运行时归属；Harness Session 物理日志不在插件删除能力范围内。

## 服务边界

```ts
interface AssistantService {
  create(input: CreateAssistant, ctx: CommandContext): Promise<AssistantTemplate>;
  update(id: string, input: UpdateAssistant, ctx: CommandContext): Promise<AssistantTemplate>;
  clone(id: string, input: CloneAssistant, ctx: CommandContext): Promise<AssistantTemplate>;
  delete(id: string, ctx: CommandContext): Promise<void>;
  get(id: string): Promise<AssistantTemplate>;
  list(filter?: AssistantFilter): Promise<Page<AssistantTemplate>>;
}

interface TeamService {
  createDraft(input: CreateTeamDraft, ctx: CommandContext): Promise<Team>;
  start(teamId: string, ctx: CommandContext): Promise<Team>;
  pause(teamId: string, ctx: CommandContext): Promise<Team>;
  resume(teamId: string, ctx: CommandContext): Promise<Team>;
  addMember(teamId: string, input: AddMember, ctx: CommandContext): Promise<TeamMemberSlot>;
  removeMember(teamId: string, slotId: string, ctx: CommandContext): Promise<void>;
  changeLeader(teamId: string, successorSlotId: string, ctx: CommandContext): Promise<Team>;
  syncMember(teamId: string, slotId: string, input: SyncMember, ctx: CommandContext): Promise<TeamMemberSlot>;
  dissolve(teamId: string, confirmation: string, ctx: CommandContext): Promise<void>;
}
```

所有命令都包含调用者、幂等键、期望修订、关联请求和审计信息。

## 助手模板流程

### 创建

1. 校验名称、补充指令、必填 Provider/模型、Agent Preset、Permission Preset 和工具策略。
2. 使用 `ctx.llm.listProviders/listModels/resolveModelInfo` 验证路由；目录未列出的模型不自动判错，以适配器最终解析为准。
3. 保存时校验 Skill 名称语法；成员启动、Preset mount 完成后从 Agent scope Catalog 校验可访问性，并由 Agent-scope `tools.guard()` 对 `skill` 工具参数执行白名单。
4. 静态目录无法证明 Preset 没有完整 Prompt 覆盖；保存模板时标注“启动时执行 Prompt 兼容性预检”。
5. 保存模板修订 1，发布 `assistant.created`。

### 编辑

1. 使用期望修订进行乐观锁校验。
2. 保存新模板修订。
3. 查询活动成员引用并返回“存在旧快照”的提示，但不修改这些成员。

### 删除

- 无活动成员引用时允许删除。
- 有团队成员引用时拒绝，并返回团队与成员列表。
- 已成功解散的团队不构成引用，因为其成员记录已经删除；`deleting`、`delete_blocked` 和删除失败的团队仍然构成引用。

## 创建并启动团队

### Draft 阶段

1. 选择或通过 `ctx.workspaceRegistry` 创建 Workspace，使用其规范 `id/path` 并验证 `status()`。
2. 添加成员实例；每次添加都复制模板快照并生成唯一 `slotId` 和 `sessionId`。
3. 指定且只指定一个 Leader。
4. 校验成员显示名在团队内可区分；模板 ID 可以重复。
5. 保存 Draft，不启动 Agent。

### Start 阶段

1. 使用一次 TeamAggregate `KvTable.update` 把团队改为 `starting` 并写入启动意图。
2. Team Runtime 逐个或限流并发创建独立 Agent，传入 `meta.cwd = workspace.path` 和完整 `agentOptions`。
3. 每个成员完成 `setup` 后才标记为 `idle`。
4. 全部成员可用后团队进入 `active`。
5. 部分失败时团队进入 `error`，保留已成功成员，支持“重试失败成员”或返回 Draft；不能悄悄替换模型。

## 动态成员管理

### 新增成员

- 允许从同一模板再次创建实例。
- 先保存 `starting` 成员和快照，再启动 Agent。
- 启动失败只回滚或标记该成员，不影响已有团队成员。

### 移除普通成员

1. 检查该成员不是当前 Leader。
2. 展示其运行中任务，要求选择重新指派、取消或等待完成。
3. cancel、等待 idle、flush 并释放成员 Agent Handle。
4. detach Workspace 活动关联；保留 Session 持久历史，不把“移出团队”冒充“永久删除”。
5. 用一次 TeamAggregate 更新删除活动成员和信箱地址、释放 Lease，并把 `sessionId/formerSlotId/displayName/removedAt` 移入 `retiredSessions`；任务保留历史作者快照。

移除后该 Session 不再恢复成 Agent，团队 UI 只提供只读历史入口。团队解散必须遍历 `members + retiredSessions`，解除所有团队和 Workspace 活动归属。Harness 没有公开 Session 物理删除接口，因此底层历史日志可能保留，但不会再被恢复为团队成员。

## 更换 Leader

更换 Leader 是一个原子领域命令：

1. 目标成员必须存在、状态可用且不是当前 Leader。
2. 在同一次 TeamAggregate `KvTable.update` 中把旧 Leader 改为 `member`、目标改为 `leader`、更新 `leaderSlotId`。
3. 发布单个 `team.leader_changed` 事件。
4. Runtime 刷新两个成员的角色上下文和团队工具权限；需要重启时先保存状态并在 UI 明示短暂中断。

不得通过“删除旧 Leader 后再创建新 Leader”完成更换。

## 暂停与恢复

- 暂停阻止新任务投递，可选择等待当前执行完成或取消执行；为保留 Handle 所有权，暂停后成员保持 live/idle，不 dispose。
- 暂停不删除 Session、成员、任务或信箱。
- 恢复时校验 Workspace 和 Provider 可用性，再恢复所有成员 Handle。
- 单成员恢复失败不会把其他成员的 Session 替换为新 Session。
- 如果 `ctx.agents.get(sessionId)` 存在但 Team Runtime 没有对应 Handle，团队进入 `ownership_conflict` 并阻止变更，不能越权销毁由其他 Fiber 拥有的 Agent。

## 解散

`dissolve` 只接受团队名称精确确认，不能用普通布尔确认。运行团队先进入 `deleting`，UI 禁止其他变更；服务停止成员、清空待处理输入、等待空闲、尽力 flush、释放 AgentHandle、解除现任与已移除 Session 的 Workspace 活动关联，最后删除团队消息、活动和 TeamAggregate。任一清理步骤失败时进入 `delete_blocked`，UI 提供重试入口。

团队一旦进入 `deleting`：

- 不能取消删除。
- 不能重新接收任务或消息。
- 不能恢复、改名、换 Leader 或添加成员。
- 后台只能继续解散清理。

解散命令只清理这个 `teamId` 拥有的聚合、成员运行时归属、消息和活动。它不得调用 `AssistantService.delete`，不得删除 Workspace 文件，也不得按引用计数自动删除助手模板。Harness 底层 Session 日志可能保留，但不再归属、恢复或展示为已删除团队。

## 错误模型

错误码至少包括：

- `ASSISTANT_IN_USE`
- `ASSISTANT_REVISION_CONFLICT`
- `TEAM_INVALID_LEADER`
- `TEAM_REVISION_CONFLICT`
- `TEAM_NOT_ACTIVE`
- `TEAM_DELETING`
- `MEMBER_IS_LEADER`
- `MEMBER_BUSY`
- `WORKSPACE_UNAVAILABLE`
- `MODEL_REFERENCE_INVALID`
- `PRESET_PROMPT_INCOMPATIBLE`
- `SESSION_CREATE_FAILED`
- `AGENT_HANDLE_OWNERSHIP_CONFLICT`
- `TEAM_DELETE_FAILED`

错误对象需要携带可展示消息、是否可重试、关联实体和结构化修复建议。

## 权限

- 用户/UI：可执行完整管理操作，但危险操作需要确认。
- Leader Agent：可创建和指派任务、发送消息、请求增加或移除成员；成员管理默认需要用户批准。
- 普通成员 Agent：只可读取本团队必要状态、更新自己的任务、发送团队消息。
- 任意 Agent 均不能直接调用永久解散、删除助手模板或绕过 Harness 工具审批。

## 验收标准

- 服务层在无 UI 条件下可以完成完整团队生命周期测试，包括运行中团队解散、运行时释放和团队领域数据删除。
- 同模板多实例、多团队引用、模板快照和 Leader 原子切换均通过测试。
- 所有破坏性操作都有明确确认、审计和幂等行为。
- 运行时失败不会破坏领域不变量或覆盖原 Session 映射。

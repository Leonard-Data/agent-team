# 05. Host API 与客户端 UI

## 首版平台和传输

首版明确支持 `dsh web`。Host 插件注入 `webServer` 并使用公开 API 注册：

- `POST /agent-team/api`：JSON 一元命令和查询。
- `GET /agent-team/events`：SSE 事件通知。

Client 插件通过同源 `fetch` 和 `EventSource` 调用。HTTP handler、SSE 连接和后台 pump 都必须由 `ctx.effect` 管理，插件卸载时关闭。

Electron 不在首版承诺范围内：Harness 文档明确说明 Electron 通过 `file://` 和 IPC Bridge 请求，不使用 `ctx.webServer`。要支持 Electron，必须先提供被其 Connection 信任边界承载的第三方 API 扩展，不能假设 Web 路由自动可用。

## 请求协议

统一请求包：

```ts
type AgentTeamRequest = {
  requestId: string;
  method: AgentTeamMethod;
  idempotencyKey?: string;
  expectedRevision?: number;
  payload: unknown;
};
```

每个 `method` 有独立的严格 Schema。Host 限制 HTTP Method、Content-Type、Body 字节数和字段集合；错误统一为判别式结果，不把内部堆栈返回浏览器。

如果 Web Host 绑定到 `0.0.0.0`，自定义路由本身不会自动获得 Harness Connection 的 Trusted Host 检查。首版默认只允许回环部署；若要支持 LAN，必须实现与当前 Web 组合一致的 Host/Origin/CSRF 信任策略后才能开放。

## API 分组

### 查询

| 方法 | Host 实现依据 |
| --- | --- |
| `catalog.providers` | `ctx.llm.listProviders()` |
| `catalog.models` | `ctx.llm.listModels(provider)` |
| `catalog.modelInfo` | `ctx.llm.resolveModelInfo(provider, model)` |
| `catalog.agentPresets` | `ctx.agentPresets.list()` |
| `catalog.permissionPresets` | `ctx.permissionPresets.names/optionOf()` |
| `catalog.tools` | Host 工具 Schema 摘要；不返回 execute 函数 |

助手表单中的 Provider 与模型选择联动：模型控件是原生下拉框，只展示所选 Provider 由 `listModels()` 返回的真实候选项及数量，不接受自定义模型 ID。

内置权限预设在中文界面显示为“只读”“工作区可写”“完全访问”，提交与持久化仍使用 Harness 原始 ID：`read-only`、`workspace-write`、`danger-full-access`。

“助手规则”是模板级长期指令，会在成员 Agent 启动时加入其系统提示词；它用于定义职责、约束、代码规范和汇报方式，不承载某次团队任务。插件不持有 `maxTokens` 字段，输出上限完全交由所选模型和 Harness 配置决定。

客户端界面直接使用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`、`Button`，组件样式集中在 CSS Module，并且颜色只引用 Harness 的 `--dsw-alias-*` 语义 Tokens。插件不定义独立明暗色板，主题变化由 Harness 自动传递。助手库保持纯列表布局；点击“新建助手”后，在主面板之上打开独立标准弹窗，宽屏为两列表单，窄屏自动切换为单列。
| `assistant.list/get` | Agent Team Domain |
| `assistant.builder.list/draft.get/draft.configure/start/get` | 列出历史、读取或配置未落地草稿、以首条消息创建 Session，或返回指定内置助手 Session 的 Conversation 投影 |
| `team.list/get` | TeamAggregate 快照 |
| `team.messages` | Message 表分页 |
| `deleteOperation.get` | Operation 表 |

### 命令

| 方法 | 用途 |
| --- | --- |
| `skill.catalog` | 按 Agent Preset standing scope 返回创建助手时可选择的模型可调用 Skills |
| `mcp.catalog` | 按 Agent Preset standing scope 将 `mcp__<server>__<tool>` 工具分组为可选 MCP Servers |
| `assistant.create/update/clone/delete` | 助手模板生命周期 |
| `assistant.builder.configure/send/stop/archive` | 按 Session 选择模型、驱动、停止或通过 Workspace Registry 归档内置“团队 Agent 小助手”对话 |
| `team.createDraft/start` | 团队创建与启动；`start` 也用于启动失败后的重试 |
| `team.addMember/removeMember` | 动态成员管理 |
| `team.changeLeader` | 原子更换 Leader |
| `team.syncMember` | 同步模板快照 |
| `team.sendUserMessage` | 向 Leader 或允许的成员发送用户消息 |
| `team.member.setPermissionPreset` | 切换单个成员当前 Session 权限，不修改助手模板默认值 |
| `task.create/assign/cancel/retry` | 用户侧任务管理 |
| `team.dissolve` | 警示确认后携带当前团队名称解散团队；停止成员、解除关联并删除团队领域数据 |

## SSE 事件

SSE 只承担“有变化”的通知，不是真相来源。事件至少包含 `cursor`、`entityType`、`entityId`、`revision` 和 `kind`。Client 收到后按需重新查询快照。

Domain 的 `domain/changed` 只在进程内有效；Host 将与 `agent/status`、`agent/disposed`、`session/event` 等信号归一化后发送 SSE。断线期间不保证完整重放，因此 Client 重连后必须先全量刷新打开的团队，再接受新事件。

Typert Remote 可作为后续优化一元调用的可选 Spike，但不用于 SSE。只有外部组合包完成严格生成 `./typert`/`./remote` 工件并在 Client `ctx.remote.$mount()` 成功后才能启用。

## Client 插件清单

`package.json` 的 `dsh.client` 注入 Client Runtime、UI Slots、UI Layout/Sidebar/Settings/Primitives；完成多语言时再增加 Locale 客户端依赖。Browser 入口导出标准 Cordis `apply(ctx)`，所有 Store、EventSource、监听器和 Slot 注册都由 Fiber 生命周期拥有。

## UI 扩展位

使用以下真实 Slot 名称：

- `settings.section`：注册“Agent 团队”设置页，只管理助手库。
- `sidebar.footer.action`：注册“团队 +”一级入口和已创建团队的二级菜单。
- `shell.overlay`：注册团队列表、组建器、管理抽屉和完整多列 Conversation 工作台。
- `conversation.session.header.actions`：可选地在标准单 Session 页面增加“返回团队”入口；它不是工作台数据平面。

调用形式为：

```ts
ctx.slots.inject('settings.section', () =>
  ctx.slots.register(
    { name: 'settings.section', id: 'agent-team', label: 'Agent 团队' },
    AgentTeamSettingsSection,
  ),
)

ctx.slots.inject('sidebar.footer.action', () =>
  ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'agent-team-teams' },
    TeamSidebarEntry,
  ),
)

ctx.slots.inject('shell.overlay', () =>
  ctx.slots.register(
    { name: 'shell.overlay', id: 'agent-team' },
    AgentTeamOverlay,
  ),
)
```

Harness rc.6 不提供 `sidebar.workspaces` 内部扩展 Slot。当前确认使用公开的底部 `sidebar.footer.action`；插件不修改 Harness 源码，不使用 DOM/CSS 注入。

多列工作台不依赖全局当前 Session，也不接管官方 `conversation.composer`。它通过 Team API 把每列输入投递到对应成员 Session，并从 Host Conversation Projector 接收历史和流式 patch。`ctx.sessions.open(SessionId(member.sessionId))` 只用于“在标准会话中打开”辅助入口，特别是首版处理 Harness Approval/Question 时。

## UI 信息架构

```text
┌─────────────────────────────────────────────────────────────────┐
│ 设置 → Agent 团队（只管理助手库）                 │
├──────────────┬──────────────────────────────────────────────────┤
│ 助手库       │  助手列表 / 新建助手弹窗                   │
└──────────────┴──────────────────────────────────────────────────┘

侧栏底部
└─ 团队 [+]
   ├─ 团队 A
   └─ 团队 B
```

### 助手库

- 顶部固定显示不进入模板存储的“团队 Agent 小助手”。弹窗左侧列出独立 Session 历史，打开时恢复最近会话；点击“新对话”只进入客户端草稿，首次发送通过 `assistant.builder.start` 原子创建 Session 并投递消息。未发送草稿不进入历史、不能归档，历史列表同时过滤旧版本遗留的空 Session。用户可通过项目内确认弹窗调用 Harness 官方 `workspaceRegistry.archiveSession` 归档闲置历史；当前会话正在生成时必须先停止。归档会话依据 `archivedSessionIds` 从列表和恢复入口中排除，底层日志保留。会话间切换会先 flush 并释放当前 Agent Handle，再恢复目标 Session；正在生成时禁止切换。创建助手模板使用服务端强制两阶段工具：`assistant_builder_prepare` 只校验并按 Session 在内存暂存草稿；用户必须在后续新消息中用自然语言明确同意最终配置，`assistant_builder_commit` 才能落库。语义判断由小助手依照提示词完成，服务端继续强制校验消息时序与真实用户来源；同轮提交、非用户来源或已被新草稿替代的旧草稿都会被拒绝，进程重启后需重新准备。每个对话可选择 Provider/模型，选择持久化到独立偏好 Domain；历史会话恢复自己的模型，新对话草稿继承最近一次选择。同一会话可连续创建多个助手。
- Provider/Model 由 Host Catalog API 返回。
- Provider 和 Model 必填；模型只能从 Host 返回的真实候选项中选择。
- 助手列表统一按创建时间正序展示，先创建的助手排在最前；设置页、团队组建器和添加成员入口共用 `assistant.list` 的顺序。
- 设置页的助手卡片主体和“编辑”按钮都会打开编辑弹窗；编辑复用新建表单，并携带当前 Revision 调用 `assistant.update`，避免覆盖并发修改。模板更新只影响之后启动的成员，既有团队成员继续使用加入团队时的助手快照。
- 选择 Agent Preset、Permission Preset，以及该 Preset 下这个助手可以使用的 Skills 和 MCP Servers；两者都可以不选。普通工具直接使用 Agent Preset 的能力集合，创建界面不提供二次限制。MCP 连接与凭据由 Harness Profile/Preset 管理，界面只保存 Server 选择。
- 编辑后提示活动成员仍使用旧快照。

### 团队组建器

1. 输入团队名称；从下拉列表选择已有 Workspace，或点击“选择文件夹”调用 Harness 原生目录选择器。选中的目录通过 `ctx.workspaces.create({ path })` 注册或复用为真实 Workspace，并自动成为当前选择。
2. 从助手库添加成员实例，可重复选择同一模板。
3. 成员名称直接使用助手模板名称，只需指定唯一 Leader，不提供成员别名输入。
4. 审核模型、权限、工具和模板 Revision。
5. 确认组建后先保存 Draft，随后自动调用 `team.start`；启动成功后关闭组建器并直接进入该团队工作台。左侧顶部“团队”品牌按钮返回全部团队列表。

### 团队工作台

团队主界面采用全屏多成员 Conversation 工作台，而不是任务板摘要卡：每个可见成员拥有独立的 Session 对话列，支持历史、Markdown、流式 text/reasoning、工具调用与结果、错误、停止和独立 Composer；右侧显示共享 Workspace 文件与变更。工作台默认打开全部成员，不设置成员列数量上限；列宽不足时横向滚动，顶部标签可独立隐藏或恢复任意成员。

成员 Tab 在鼠标悬停或键盘聚焦时显示快捷操作：普通成员可通过“×”打开自定义移出确认弹窗；Leader 不显示移出操作。助手模板只在“设置 → Agent 团队”中编辑，避免让用户误以为模板修改会立即覆盖当前成员快照。

工作台通过 `shell.overlay` 实现，不覆盖 `conversation` single Slot，也不复制官方内部组件。Host 监听公开 `session/event` 并用 `sessionPersistence.inspect/readFrom` 恢复历史，向 Browser 输出稳定 Conversation DTO。完整数据流、工具卡、响应式布局、Approval 边界和分阶段验收见[完整团队 Conversation 工作台设计](./10-team-conversation-workbench.md)。

## 关键交互

- 更换 Leader：只提交 `team.changeLeader` 一个原子命令。
- 同步模板：展示差异；选择等待/取消和保留/新建 Session。
- 移除成员：当前 Leader 禁止移除；普通成员通过插件自定义警示弹窗确认后停止运行并进入只读历史，Session 索引保留到团队解散。UI 不调用浏览器系统确认框，也不把“移出活动成员列表”描述成删除历史。
- 清空任务与上下文：使用插件自定义警示弹窗确认，无需输入团队名称；停止所有成员、清空任务板与待处理消息并轮换全新 Session，同时保留 Workspace 文件、团队配置和旧 Session 日志。
- 解散团队：使用插件自定义警示弹窗二次确认，无需输入团队名称；弹窗明确列出“将停止所有成员并删除团队、任务、消息和配置；不会删除助手模板和 Workspace 文件”。底层 Session 日志可能由 Harness 保留，但不再归属团队。失败时显示错误并允许重试。

## 错误与断线

- API/SSE 断开：保留最后快照但禁用写操作，重连后重新查询。
- Revision 冲突：显示最新对象并要求用户重新确认。
- Workspace missing：禁止启动，允许修复 Workspace 选择。
- Provider/Model 不可解析：禁止启动对应成员。
- Agent 启动失败：保留其他成员和失败诊断，不替换 Session ID。
- Delete blocked：保留团队和成员索引，修复当前清理错误后重试。

## 验收标准

- 插件在 `dsh web` 通过一个组合包加载 Host 与 Browser 入口。
- Slot 注册不覆盖 `root`、`sidebar` 或 `conversation` 的 single seat。
- 多列工作台通过 `shell.overlay` 和公开 Session 事件实现；`ctx.sessions.open` 仅作为标准单 Session 辅助入口。
- API 输入、SSE 生命周期、回环/LAN 安全边界均有测试。
- 不支持的平台和 Session 日志保留边界在 UI 中清楚、真实地表达。

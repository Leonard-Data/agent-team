# 09. 实现状态与二次审核

## 审核结论

当前代码以 npm 发布的 DeepSeek Harness `0.1.0-rc.6` 类型接口为编译基线，并用本地参考树 `/private/tmp/deepseek-harness-reference/docs/user/develop` 及其公开源码接口逐项复核。现有代码只调用包入口公开 API，没有导入 Harness 私有 `src/*`。

已实现的主链路是：创建助手模板 → 创建团队草稿 → 为每个成员创建独立根级 Agent → 在同一 Workspace attach 各自 Session → Leader/Member 通过任务板和信箱协作 → 进程重启后按原 Session ID 冷恢复。成员没有父子 Session、Subagent origin 或级联所有权。

## 已实现

- Web UI 使用 Harness UI Primitives 与语义主题 Tokens，不含插件自有色板；新建助手/团队使用独立弹窗，团队工作台则通过公开 `shell.overlay` Slot 直接全屏渲染，不修改 Harness 核心布局。

- 单包 Host/Client 插件清单、Cordis patch、Schemastery Config 和 Web-only Client 注入。
- Assistant CRUD 服务、复制、引用保护、Provider/Model/Preset/Permission Catalog 与不可变成员快照。
- 内置“团队 Agent 小助手”：左侧多 Session 历史栏、懒创建的新对话草稿、打开恢复最近会话、官方 Workspace Session 归档、可选 Provider/模型、持久化模型偏好、默认提示词策略、缺参追问、真实目录查询，以及“准备草稿 → 新用户消息自然语言确认 → 提交创建”的两阶段工具流程；未发送首条消息前不创建 Session、不进入历史且不能归档，首次发送才创建 Session，历史列表过滤旧版空 Session。历史会话恢复自己的模型，新会话继承最近一次选择。语义确认由小助手依照提示词判断，服务端强制校验消息时序和真实用户来源。草稿按 Session 隔离，同轮提交和非用户确认会被拒绝，同一 Session 的新草稿会替代旧草稿。切换模型保留历史，小助手本身不占用助手库记录，也不进入团队成员生命周期。
- 团队草稿、唯一 Leader、同模板多实例、动态增删成员、原子换 Leader、启动和启动失败重试。
- 独立 `AgentHandle` Registry、并发限流启动、Prompt 兼容性预检、Workspace attach、状态同步和冷恢复。
- 组建团队时可直接选择已有 Workspace，或使用 Harness 原生目录选择器添加文件夹；插件不读取浏览器伪路径，也不修改 Harness 源码。
- 普通工具直接继承 Agent Preset，不做助手模板级限制；Skills 在创建助手时按 Agent Preset 目录勾选。成员运行时只向模型和用户直接调用暴露所选 Skills，并由 Harness 的 `skill(name)` 在任务需要时加载正文。
- 设置页支持点击助手卡片或“编辑”按钮修改完整模板配置；更新带 Revision 并发校验，不追溯修改已加入团队的成员快照。
- MCP 使用 Harness 官方 `@deepseek-ai/dsh-mcp-client` 在 Profile/Preset 建立连接。新建助手可按 Preset 选择 Server，模板不保存凭据；成员启动时只暴露已选 Server 的 `mcp__<server>__<tool>` 工具。
- `team_get_task_board`、`team_create_task`、`team_update_task`、`team_send_message`；任务指派自动唤醒负责人，成员状态/结果更新自动通知 Leader。
- 用户向 Leader 或策略允许的普通成员发送消息。
- 普通消息先写 queued 记录再投递；任务与通知通过 Team Aggregate Outbox 原子保存。两条链路都使用稳定 MessageId，恢复时检查 Session inbox 事件，避免重复插入。
- 固定 JSON API、同源检查、Body 限制、Revision、SSE 心跳和有序 teardown。
- Web Overlay：助手创建/复制/删除、团队组建/启动、增删成员、换 Leader、成员消息和解散失败重试提示。
- 团队没有暂停状态。用户可停止单个成员，或清空团队全部任务与上下文。
- 团队工作台首版：默认展示全部成员的独立 Conversation，不限制列数并在空间不足时横向滚动；每列支持独立输入/停止、真实 Session 历史与流式文本/推理投影、通用工具调用卡、成员状态、团队管理悬浮窗及自适应成员网格。添加成员和更改 Leader 使用可滚动列表直接操作，不再使用下拉选择后二次确认。
- 全屏工作台左侧团队导航：可在不关闭工作台的情况下切换团队，并显示团队运行状态、任务完成数、进行中数量和完成度。
- 团队级“清空任务与上下文”：停止所有成员、清空任务/文件租约/待投递信箱，将旧 Session 转入保留索引，为每个成员轮换全新 Session 并在团队原为运行状态时自动重启。成员、Leader、助手快照、权限和 Workspace 保留，Workspace 文件不回滚。
- 团队解散：通过自定义警示弹窗确认后停止所有成员，释放 AgentHandle，detach 现任与已移除成员 Session，删除团队任务、消息、活动和 TeamAggregate。助手模板与 Workspace 文件保留；底层 Session 日志不再恢复。
- Assistant 正文复用 Harness 公开的 `MarkdownText`，支持 GFM 标题/列表/表格、围栏代码与高亮、TeX、安全外链及流式增量解析；用户消息保持字面文本。
- 只读 Workspace 树：后端按团队 Workspace 重新校验路径，拒绝绝对路径、`..` 与符号链接逃逸；Browser 按目录逐层展开。
- Conversation SSE 使用独立事件类型，Host 以约 48ms 窗口推送单成员实时快照；Client 直接替换对应列并拒绝过期全量请求覆盖，不让流式 token 触发团队 Catalog 全量刷新。
- Client 通过单例事件 Hub 复用一条 Agent Team SSE，侧栏、团队列表和工作台不再各自占用同源长连接；普通 API 请求带超时保护，团队/助手核心列表不等待模型目录发现。
- 发送消息提供使用服务端 MessageId 去重的即时反馈；发送与停止按钮并存。停止会清理待处理 Inbox、等待 Agent 空闲并推送最终快照。
- 助手模板权限仅作为成员初始默认值；每个成员的 Composer 可独立切换当前 Session 权限，变更持久化到成员运行配置且不修改模板或助手快照。
- 架构守卫验证 `src` 不引用 Subagent 包、服务或父子 Session 元数据。

## 尚未完成但公开 API 可实现

- 移除成员时的交互式任务等待/取消/转派状态机、模板同步及对应 UI。
- 文件范围 Lease、冲突告警和成员标准 Session 辅助入口。
- API 持久幂等请求表、Operation 崩溃恢复状态机、分页/搜索。
- JSON/SQLite 双 Storage Provider 契约测试、真实 Codex Leader + GLM Member 冒烟、Profile 安装/HMR/E2E。
- 字段级增量 Conversation Patch（当前为合并后的单成员快照）、专用 Bash/Read/Edit/Search 工具卡、文件内容/变更 Diff 和 Approval/Question 安全衔接。
- Lint、CI、键盘/小窗口和恶意请求完整测试。

这些项目都有已审核的公开扩展 seam，不需要修改 Harness 核心。

## 已知上游边界

`SessionPersistence` rc.6 公开接口没有单 Session delete。团队解散会完成插件自身的永久删除和运行时释放，但 Harness 底层的旧 Session 物理日志仍可能存在。插件不使用 `locate().path`、内部文件路径或 Backend 私有接口绕过限制，也不再恢复、展示或将这些日志归属给已解散团队。

## 当前验证

仓库的 `npm run check` 执行架构守卫、严格 TypeScript、Vitest 和 Host/Client 双构建。`npm pack --dry-run` 用于检查发布清单。真实 Harness Profile 与 Provider 冒烟尚未完成，不能用单元测试结果替代。

# dsh-agent-team

DeepSeek Harness Web Profile 插件，用于创建助手模板、手工组建由多个平级独立 Agent 组成的团队，并让成员在同一个 Workspace 中协作。

当前实现以 DeepSeek Harness `0.1.0-rc.6` 为兼容基线。详细技术设计和分阶段清单见 [`docs/README.md`](./docs/README.md)。

已实现内置“团队 Agent 小助手”对话创建助手模板、创建时选择可用 Skills 和 MCP Servers、手工组建团队、独立 Agent 启动、共享 Workspace、基础任务板、成员信箱、Web UI 和冷恢复。MCP 连接由 Harness Profile/Preset 通过官方 `@deepseek-ai/dsh-mcp-client` 统一配置，助手模板只保存允许使用的 Server 名称，不保存凭据。当前完成范围与尚未完成项见 [`docs/09-implementation-status.md`](./docs/09-implementation-status.md)。

内置小助手使用独立的多 Session 对话历史：打开弹窗时恢复最近会话，用户可从左侧历史栏切换，或显式新建对话。每个会话通过当前 Profile 的默认可用模型启动，并优先采用 `read-only` 权限预设；对话窗口可选择 Provider/模型，选择会持久化，每个历史会话恢复自己的模型，新会话继承最近一次选择。也可用 `assistantBuilderProvider`、`assistantBuilderModel`、`assistantBuilderAgentPresetId` 和 `assistantBuilderPermissionPresetId` 设置首次使用的默认运行配置。它只允许执行目录读取、草稿校验和确认提交三个专用工具。创建采用服务端强制两阶段流程：草稿按 Session 隔离，先暂存已校验草稿，再等待用户在新消息中用自然语言明确同意最终配置后提交；进程重启或同一 Session 重新准备草稿会使旧草稿失效。

## 开发

```sh
npm install
npm run check
```

## 安装到 Harness Profile

```sh
dsh plugin --profile <profile-name> add github:limuyang2/agent-team
```

首版只支持 `dsh web`。团队可以解散：插件会停止成员、解除 Workspace Session 关联并删除团队领域数据，但不删除助手模板或 Workspace 文件。Harness 当前公开 Session Persistence API 不支持删除历史日志，因此旧 Session 日志会保留在 Harness 底层，但不再归属、恢复或展示于已解散团队。

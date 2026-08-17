# dsh-agent-team

DeepSeek Harness Web Profile 插件，用于创建助手模板、手工组建由多个平级独立 Agent 组成的团队，并让成员在同一个 Workspace 中协作。

当前实现以 DeepSeek Harness `0.1.0-rc.6` 为兼容基线。详细技术设计和分阶段清单见 [`docs/README.md`](./docs/README.md)。

已实现助手模板、手工组建团队、独立 Agent 启动/暂停/恢复、共享 Workspace、基础任务板、成员信箱、Skill/工具白名单、Web UI 和冷恢复。当前完成范围与尚未完成项见 [`docs/09-implementation-status.md`](./docs/09-implementation-status.md)。

## 开发

```sh
npm install
npm run check
```

## 安装到 Harness Profile

```sh
dsh plugin --profile <profile-name> add github:limuyang2/agent-team
```

首版只支持 `dsh web`。Harness 当前公开 Session Persistence API 尚不支持永久删除 Session 日志，因此团队永久解散会明确返回能力阻塞，不会直接操作 Harness 内部存储文件。

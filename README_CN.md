# DeepSeek Harness Agent Team

[English](./README.md) | 简体中文

[![npm version](https://img.shields.io/npm/v/@limuyang2/dsh-agent-team.svg)](https://www.npmjs.com/package/@limuyang2/dsh-agent-team)
[![license](https://img.shields.io/npm/l/@limuyang2/dsh-agent-team.svg)](https://www.npmjs.com/package/@limuyang2/dsh-agent-team)

当前版本：`0.1.1`

在 DeepSeek Harness 中组建由多个独立 AI Agent 构成的团队。你可以混用不同模型和 Provider，指定唯一 Leader，让每位成员拥有独立对话和上下文，同时在同一个 Workspace 中协作。

Agent Team **不是 Subagent 方案**。每位成员都是独立的根级 Agent，拥有自己的模型、Session、上下文、权限、思考模式和工具调用；团队任务、消息和共享 Workspace 构成协作层。

![Agent Team 多成员工作台](./demo/4.png)

## 为什么选择独立 Agent 团队

Agent Team 的核心理念是：**专业的事情交给专业的 Agent 做**。

常见的父 Agent / Subagent 工作流会复用或继承较多父级运行配置。这样虽然方便，却容易让每个任务都携带同一套高成本模型、庞大工具目录和不断增长的上下文。例如，只是生成一条提交信息，也可能继续使用负责架构规划和复杂编码的高等级模型，造成不必要的成本。

Agent Team 允许为每位成员设置明确、专注的配置：

| 维度 | 常见父 Agent / Subagent 模式 | Agent Team |
| --- | --- | --- |
| 模型 | 通常复用父模型或统一模型策略 | 每位成员独立选择 Provider 和模型 |
| Skills 与 MCP | 容易继承或暴露一套庞大工具目录 | 每个角色只加载自己需要的 Skills 和 MCP Servers |
| 上下文 | 规划、执行、工具输出和结果不断堆积在一起 | 每位成员拥有独立 Session 和上下文窗口 |
| 成本 | 简单任务也可能消耗昂贵的通用模型 | 常规任务可交给更小、更快或更专业的模型 |
| 权限 | 一套较宽权限可能扩散到整个工作流 | 每位成员独立设置最小默认权限和运行时权限 |

这种隔离让 Leader 专注规划和验收，让专业成员专注执行；既减少无关工具选择和提示词负担，也避免整个团队的细节全部挤入单个 Agent，缓解上下文爆炸。成员之间只显式传递任务、进度和结果，不共享一份无限膨胀的对话历史。

> 不同框架的 Subagent 行为并不完全相同。上面的对比针对常见的父级配置继承模式；Agent Team 的优势是把每位成员的模型、工具、权限和上下文隔离做成明确的产品能力。

### 示例：让合适的模型负责合适的任务

例如，可以组建一个包含三位专业成员的软件开发团队：

| 角色 | 模型 | 专属配置与职责 |
| --- | --- | --- |
| 架构 Leader | GPT | 理解需求、设计方案、拆解任务、协调成员并验收结果 |
| 编码 Agent | GLM | 加载编码 Skills 和开发类 MCP 工具，修改 Workspace 并执行测试 |
| Commit 助手 | DeepSeek Flash | 使用只读权限查看 Git 状态和 Diff，生成符合规范的提交信息 |

GPT Leader 的上下文只保留关键决策、任务状态和验收结果，不必塞入所有编码细节；GLM 获取代码执行所需的仓库上下文和工具；DeepSeek Flash 快速处理范围明确的 Commit 任务，无需继续消耗 Leader 的高等级模型，也不必加载编码 Agent 的庞大工具目录。

完整协作链路是显式的：

```text
用户目标 → GPT Leader 规划并分派任务
        → GLM 编码 Agent 实现并回报测试结果
        → GPT Leader 验收产出
        → DeepSeek Flash Commit 助手根据 Git Diff 生成提交信息
```

## 你可以做什么

- 创建用于规划、编码、测试、评审、文档等职责的可复用助手。
- 在一个团队中混用不同 Provider 和模型，例如 Codex Leader 配合 GLM 编码成员。
- 手动创建助手，或向内置的“团队 Agent 小助手”描述角色，由它协助生成配置。
- 多次添加同一个助手，每次都会成为独立的团队成员实例。
- 并排查看所有成员的流式输出、Markdown、Think 和工具调用。
- 让 Leader 创建任务、分派成员、跟踪进度并收集结果。
- 与 Leader 直接沟通；启用对应策略后，也可直接与普通成员沟通。
- 在运行时调整单个成员当前 Session 的权限和思考模式。
- 查看已加载 Skills、上下文占用、Token 统计和缓存命中率。
- 浏览共享 Workspace，并预览 Git 文件变更和 Diff。
- 动态添加或移出成员、更换 Leader、清空全部上下文或解散团队。

## 界面预览

### 通过对话创建助手

描述你需要的角色。内置小助手会补充询问必要配置、整理长期指令，并在你确认后创建助手。

![通过对话创建助手](./demo/1.png)

### 可复用助手库

在 **设置 → Agent 团队** 中管理助手。每个助手可独立配置 Provider、模型、Agent Preset、默认权限、思考模式、Skills、MCP Servers 和角色规则。

![助手库](./demo/2.png)

### 组建团队

选择成员、指定唯一 Leader、选择 Workspace，并决定是否允许用户直接与普通成员通信。

![组建团队](./demo/3.png)

### 侧边栏入口

团队会直接显示在 Harness 侧边栏中。点击 `+` 可以创建团队，也可以在不离开 Harness 日常工作流的情况下切换不同团队。

<img src="./demo/5.png" alt="Harness 侧边栏中的 Agent Team" width="320" />

## 环境要求

- Node.js `22.19.0+` 或 `24.0.0+`
- DeepSeek Harness `0.1.0-rc.7`
- 终端中可以使用 `pnpm`（Harness 使用它管理 Profile 插件）

如果尚未安装 pnpm：

```bash
npm install -g pnpm
```

## 安装

将插件安装到 Harness 的 `web` Profile：

```bash
npx @deepseek-ai/dsh plugin --profile web add @limuyang2/dsh-agent-team
```

启动 Harness：

```bash
npx @deepseek-ai/dsh web
```

打开终端输出的地址，通常是 <http://127.0.0.1:3080/>。安装或替换插件后，请重启 Harness。

## 快速开始

### 1. 在 Harness 中准备模型

先配置需要使用的 Provider、模型和凭据。Agent Team 读取当前 Profile 的模型目录，不保存 Provider API Key。

### 2. 创建助手

进入 **设置 → Agent 团队**，选择：

- **开始对话**：通过聊天设计助手。
- **手动新建**：直接填写完整配置。

一个实用的初始团队通常包含：

- 一个 **Leader**：理解目标、规划工作、分派成员并验收结果。
- 一个或多个 **成员**：分别负责编码、测试、评审或文档。

### 3. 组建团队

点击 Harness 左侧 **团队** 旁的 `+`：

1. 从助手列表添加成员；同一助手可以添加多次。
2. 指定且仅指定一个 Leader。
3. 输入团队名称并选择 Workspace。
4. 选择是否允许用户直接与普通成员通信。
5. 点击 **创建并启动**。

创建成功后，团队会自动启动并进入全屏工作台。

### 4. 向 Leader 描述目标

把完整目标发送给 Leader。Leader 可以拆分任务、分派成员、接收进度并验收最终产出。团队策略允许时，你也可以直接与某个普通成员沟通。

## 工作台说明

每一列都是一个真实、独立的 Harness Session。

- **成员标签**：控制对话列的显示与隐藏；鼠标悬停在非 Leader 标签上可以移出成员。
- **对话标题**：展示角色、Provider、模型、思考模式和实时状态；双击可以放大该成员对话。
- **输入框**：发送消息、添加本地文件、引用 Workspace 文件、停止输出和修改运行配置。
- **权限**：只影响当前成员的当前 Session；助手模板仅提供初始默认值。
- **思考模式**：从下一轮开始生效，只展示当前模型支持的档位。
- **Info**：查看成员当前加载的 Skills。
- **上下文圆环**：查看上下文占用、输入/输出 Token 和缓存命中率。
- **Workspace**：浏览文件、手动刷新、自动跟踪文件变化并预览 Git Diff。

## Agent 如何协作

Leader 和成员通过明确的团队工具与消息通信：

- Leader 创建任务并分派给具体成员实例。
- 成员在自己的 Session 中收到任务。
- 成员回报执行中、已完成或失败状态，并附带结果。
- 进度和结果会自动通知 Leader。
- 需要澄清时，成员可以发送团队消息。
- 成员加入或移出会携带稳定成员 ID 通知 Leader。

成员共享 Workspace，但不共享聊天上下文。这样既能在同一份文件上工作，又能保持角色和模型上下文相互隔离。

## 团队管理

- **添加成员**：基于助手快照启动新的独立成员，并通知 Leader。
- **移出成员**：停止并归档该成员 Session，从团队中移除并通知 Leader。
- **更换 Leader**：只变更团队角色，不替换成员当前 Session。
- **清空任务与上下文**：停止所有成员，清空任务和排队消息，为所有保留成员换用全新 Session；团队配置和 Workspace 文件不变。
- **解散团队**：永久删除团队、任务和团队消息，但不会删除助手模板或 Workspace 文件。

助手加入团队时会生成配置快照。之后编辑助手不会热更新已经运行的成员；要应用新配置，需要移出旧成员并重新添加。

## 重要行为

- 助手模板中的权限只是成员首次启动的默认权限。
- 思考模式来源于 Harness 返回的模型能力，插件不会伪造模型不支持的参数。
- MCP 凭据保留在 Harness Profile 中，助手模板只保存允许使用的 Server 名称。
- 从 Workspace 外选择的文件会复制到 `.agent-team/uploads/`，确保 Agent 可以稳定读取。
- “变更”页签要求 Workspace 本身是 Git 仓库，普通目录仍可浏览文件。
- Harness 当前没有物理删除单个 Session 日志的公开 API。清空或解散后的旧 Session 不再由 Agent Team 恢复或使用，但日志可能继续保留在 Harness 存储中。

## 常见问题

### 提示 `pnpm not found on PATH`

执行 `npm install -g pnpm`，确认 `pnpm --version` 能正常输出后，重新安装插件。

### 端口 `3080` 已被占用

已有 Harness 进程正在运行。在旧终端按 `Ctrl+C` 停止，然后重新执行 `npx @deepseek-ai/dsh web`。

### 找不到模型或思考模式

刷新助手目录并检查 Harness 模型配置。只有 Provider 声明对应能力时，插件才会展示思考模式档位。

### 助手无法删除

该助手仍被团队成员引用。先移出对应成员或解散相关团队。

### 没有显示 Git 变更

确认所选 Workspace 本身就是 Git 仓库。位于普通 Workspace 子目录中的仓库不会被当作 Workspace 仓库。

## 用户文档

- [文档首页](./docs/README.md)
- [安装与启动](./docs/installation.md)
- [助手库](./docs/assistants.md)
- [创建团队](./docs/creating-teams.md)
- [工作台与协作](./docs/workbench.md)
- [Workspace 与 Git 变更](./docs/workspace.md)
- [团队管理](./docs/team-management.md)
- [故障排查](./docs/troubleshooting.md)

## 相关链接

- [npm 包](https://www.npmjs.com/package/@limuyang2/dsh-agent-team)
- [GitHub 仓库](https://github.com/limuyang2/agent-team)
- [问题反馈](https://github.com/limuyang2/agent-team/issues)

## License

MIT

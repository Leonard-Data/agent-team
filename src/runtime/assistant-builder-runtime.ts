import type { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.js'
import { AgentTeamError } from '../domain/errors.js'
import type { CreateAssistantInput } from '../domain/types.js'
import type { AgentTeamService } from '../service/agent-team-service.js'
import type { AssistantBuilderConversationView } from '../transport/contracts.js'
import { projectConversation } from './conversation-projector.js'

export const ASSISTANT_BUILDER_SESSION_ID = 'agent-team:assistant-builder'

export const ASSISTANT_BUILDER_PROMPT = `
你是“团队 Agent 小助手”，负责通过对话帮助用户创建可复用的 Agent 助手模板。

工作规则：
1. 先理解用户希望这个助手承担的职责、工作边界、输出方式和协作习惯。
2. 创建前必须收集名称、Provider、模型、Agent Preset、权限预设和长期提示词。说明按需要收集；可用 Skills 和 MCP Servers 由用户从真实目录中选择，都可以不选。
3. 必须先调用 assistant_builder_get_catalog 获取当前真实可选项；Provider、模型、Preset 和权限只能使用目录中存在的标识，不能编造。确定 Agent Preset 后，再携带 agentPresetId 调用一次目录工具，取得该 Preset 可用的 Skills 和 MCP Servers。
4. 参数不完整或意图含糊时，一次只追问最关键的少量问题，并给出基于目录的简短选项和建议。
5. 长期提示词应描述稳定职责、约束、工作流程和验收要求，不要写入用户眼前的一次性任务。
6. 只保存用户明确选择的 Skills 和 MCP Servers；未选择就表示不使用，不能猜测名称。不要询问或限制普通工具，工具能力由 Agent Preset 提供。
7. 配置完整后调用 assistant_builder_prepare 校验并暂存草稿；此步骤不会创建助手，新草稿会替代旧草稿。
8. 用简洁清单复述最终配置，并要求用户精确回复“确认创建”。必须等待新的用户消息，不得在同一轮代替用户确认。
9. 只有用户按要求明确回复后才能调用 assistant_builder_commit。不得把其他表达理解为确认。
10. 创建成功后明确告知助手名称，并提示它现在可以加入团队。
11. 你只能帮助设计和创建助手模板，不创建团队、不修改或删除已有助手，也不执行 Workspace 任务。

保持中文、简洁、主动，但不要替用户猜测会显著影响成本、权限或能力范围的参数。
`.trim()

interface AssistantBuilderConfiguration {
  provider: string
  model: string
  agentPresetId: string
  permissionPresetId: string
}

interface PendingAssistantDraft {
  input: CreateAssistantInput
  preparedThroughSeq: number
}

export class AssistantBuilderRuntime {
  private handle: AgentHandle | undefined
  private starting: Promise<AgentHandle> | undefined
  private reconfiguring: Promise<void> | undefined
  private configuration: AssistantBuilderConfiguration | undefined
  private selectedProvider: string | undefined
  private selectedModel: string | undefined
  private pendingDraft: PendingAssistantDraft | undefined
  private publishTimer: ReturnType<typeof setTimeout> | undefined
  private readonly disposeStatusListener: () => void
  private readonly disposeConversationListener: () => void
  private closing = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly service: AgentTeamService,
  ) {
    this.disposeStatusListener = ctx.on('agent/status', ({ agent }) => {
      if (String(agent.id) !== ASSISTANT_BUILDER_SESSION_ID || this.closing) return
      this.publishCurrent()
    })
    this.disposeConversationListener = ctx.on('session/event', session => {
      if (String(session.id) !== ASSISTANT_BUILDER_SESSION_ID || this.closing || this.publishTimer !== undefined) return
      this.publishTimer = setTimeout(() => {
        this.publishTimer = undefined
        this.publishCurrent()
      }, 48)
    })
  }

  async getConversation(): Promise<AssistantBuilderConversationView> {
    const handle = await this.ensureOnline()
    return this.project(handle.agent.session.events, handle.agent.status)
  }

  async sendMessage(rawContent: string): Promise<{ messageId: string }> {
    const content = rawContent.trim()
    if (content.length === 0) throw new AgentTeamError('INVALID_REQUEST', 'Message content is required')
    const handle = await this.ensureOnline()
    const message = createUserMessage({
      content: [{ type: 'text', text: content }],
      source: { kind: 'user' },
    })
    handle.agent.followup(message)
    return { messageId: String(message.id) }
  }

  async configure(rawProvider: string, rawModel: string): Promise<AssistantBuilderConversationView> {
    if (this.closing) throw new Error('Assistant Builder runtime is closing')
    if (this.reconfiguring !== undefined) await this.reconfiguring
    const provider = rawProvider.trim()
    const model = rawModel.trim()
    if (provider.length === 0 || model.length === 0) {
      throw new AgentTeamError('INVALID_REQUEST', 'Assistant Builder provider and model are required')
    }
    const reconfiguring = this.reconfigure(provider, model)
    this.reconfiguring = reconfiguring
    try {
      await reconfiguring
    } finally {
      if (this.reconfiguring === reconfiguring) this.reconfiguring = undefined
    }
    return this.getConversation()
  }

  async stop(): Promise<void> {
    const handle = this.handle
    if (handle === undefined) return
    handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
    await handle.agent.whenIdle()
    this.publishCurrent()
  }

  async dispose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.disposeStatusListener()
    this.disposeConversationListener()
    if (this.publishTimer !== undefined) clearTimeout(this.publishTimer)
    this.publishTimer = undefined
    await this.reconfiguring?.catch(() => undefined)
    await this.starting?.catch(() => undefined)
    const handle = this.handle
    if (handle === undefined) return
    handle.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
    await handle.agent.whenIdle().catch(() => undefined)
    try {
      await this.ctx.sessions.flush(handle.agent.session)
    } catch (error) {
      this.ctx.logger.warn('agent-team: assistant builder session flush failed', error)
    }
    await handle.dispose()
    this.handle = undefined
  }

  private async ensureOnline(): Promise<AgentHandle> {
    if (this.closing) throw new Error('Assistant Builder runtime is closing')
    if (this.reconfiguring !== undefined) await this.reconfiguring
    if (this.handle !== undefined) return this.handle
    if (this.starting !== undefined) return this.starting
    const starting = this.start()
    this.starting = starting
    try {
      const handle = await starting
      this.handle = handle
      return handle
    } catch (error) {
      if (error instanceof AgentTeamError) throw error
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`agent-team: assistant builder activation failed: ${message}`, error)
      throw new AgentTeamError(
        'SESSION_CREATE_FAILED',
        `团队 Agent 小助手启动失败：${message}`,
        { cause: message },
        { cause: error },
      )
    } finally {
      if (this.starting === starting) this.starting = undefined
    }
  }

  private async reconfigure(provider: string, model: string): Promise<void> {
    try {
      await this.ctx.llm.resolveModelInfo(provider, model)
    } catch (error) {
      throw new AgentTeamError(
        'MODEL_REFERENCE_INVALID',
        `Cannot resolve Assistant Builder model '${provider}/${model}'`,
        undefined,
        { cause: error },
      )
    }
    await this.starting?.catch(() => undefined)
    const current = this.handle
    if (current !== undefined && current.agent.status === 'running') {
      throw new AgentTeamError(
        'INVALID_REQUEST',
        '请先停止团队 Agent 小助手当前回复，再切换模型',
      )
    }
    if (
      this.configuration?.provider === provider
      && this.configuration.model === model
    ) return

    if (current !== undefined) {
      await this.ctx.sessions.flush(current.agent.session)
      await current.dispose()
      if (this.handle === current) this.handle = undefined
    }
    this.selectedProvider = provider
    this.selectedModel = model
    this.configuration = undefined
  }

  private async start(): Promise<AgentHandle> {
    const sessionId = SessionId(ASSISTANT_BUILDER_SESSION_ID)
    if (this.ctx.agents.get(sessionId) !== undefined) {
      throw new AgentTeamError(
        'AGENT_HANDLE_OWNERSHIP_CONFLICT',
        `Session '${ASSISTANT_BUILDER_SESSION_ID}' is live without this plugin's AgentHandle`,
      )
    }
    const configuration = await this.resolveConfiguration()
    this.configuration = configuration
    const setup = async (agentCtx: Context): Promise<void> => {
      await this.ctx.agentPresets.mount(agentCtx, configuration.agentPresetId)
      agentCtx.tools.presentAs('native')
      const agent = agentCtx.agent
      if (agent === undefined) throw new Error('Harness did not bind the unpublished Assistant Builder Agent')
      const allowedTools = new Set([
        'assistant_builder_get_catalog',
        'assistant_builder_prepare',
        'assistant_builder_commit',
      ])
      agentCtx.tools.guard(execution => allowedTools.has(execution.name)
        ? undefined
        : 'The built-in Assistant Builder may only read its catalog, prepare a draft, and commit an explicitly confirmed draft.')
      this.registerTools(agentCtx)
      const promptSection = 'agent-team:assistant-builder'
      agentCtx.systemPrompt.section({
        name: promptSection,
        order: 10,
        text: ASSISTANT_BUILDER_PROMPT,
      })
      this.ctx.permissionPresets.set(agent.session, configuration.permissionPresetId)
      const assembly = await agentCtx.systemPrompt.assemble(assembleContextFor(agent))
      if (!assembly.sections.some(section => section.name === promptSection)) {
        throw new AgentTeamError(
          'PRESET_PROMPT_INCOMPATIBLE',
          `Preset '${configuration.agentPresetId}' replaced the Assistant Builder prompt`,
        )
      }
    }
    const agentOptions = { provider: configuration.provider, model: configuration.model }
    const persisted = (await this.ctx.sessionPersistence.list())
      .some(header => String(header.id) === ASSISTANT_BUILDER_SESSION_ID)
    return persisted
      ? this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      : this.ctx.agents.create({
        sessionId,
        meta: { agentPreset: configuration.agentPresetId },
        agentOptions,
        setup,
      })
  }

  private async resolveConfiguration(): Promise<AssistantBuilderConfiguration> {
    const requestedProvider = this.selectedProvider ?? this.config.assistantBuilderProvider.trim()
    const requestedModel = this.selectedModel ?? this.config.assistantBuilderModel.trim()
    if (requestedModel.length > 0 && requestedProvider.length === 0) {
      throw new AgentTeamError('INVALID_REQUEST', 'assistantBuilderModel requires assistantBuilderProvider')
    }
    const providers = this.ctx.llm.listProviders()
    const candidates = requestedProvider.length > 0
      ? providers.filter(provider => provider.id === requestedProvider)
      : providers
    if (candidates.length === 0) {
      throw new AgentTeamError(
        'MODEL_REFERENCE_INVALID',
        requestedProvider.length > 0
          ? `Unknown Assistant Builder provider '${requestedProvider}'`
          : 'No model provider is available for the Assistant Builder',
      )
    }

    let provider = ''
    let model = ''
    for (const candidate of candidates) {
      const models = await this.ctx.llm.listModels(candidate.id)
      const selected = requestedModel.length > 0
        ? models.find(item => item.id === requestedModel)
        : models[0]
      if (selected === undefined) continue
      provider = candidate.id
      model = selected.id
      break
    }
    if (provider.length === 0 || model.length === 0) {
      throw new AgentTeamError(
        'MODEL_REFERENCE_INVALID',
        requestedModel.length > 0
          ? `Unknown Assistant Builder model '${requestedProvider}/${requestedModel}'`
          : 'No catalog model is available for the Assistant Builder',
      )
    }
    await this.ctx.llm.resolveModelInfo(provider, model)

    const agentPresetId = this.config.assistantBuilderAgentPresetId.trim() || this.ctx.agentPresets.defaultId
    await this.ctx.agentPresets.resolve(agentPresetId)
    const permissionPresetId = this.config.assistantBuilderPermissionPresetId.trim()
      || (this.ctx.permissionPresets.names.includes('read-only')
        ? 'read-only'
        : this.ctx.permissionPresets.defaultPreset)
    if (!this.ctx.permissionPresets.names.includes(permissionPresetId)) {
      throw new AgentTeamError(
        'PERMISSION_PRESET_INVALID',
        `Unknown Assistant Builder permission preset '${permissionPresetId}'`,
      )
    }
    return { provider, model, agentPresetId, permissionPresetId }
  }

  private registerTools(agentCtx: Context): void {
    agentCtx.tools.register(defineTool({
      name: 'assistant_builder_get_catalog',
      description: 'Read exact creation options. Pass agentPresetId after choosing a preset to also return its available Skills and MCP Servers.',
      parameters: {
        agentPresetId: { type: 'string', description: 'Chosen Agent Preset id used to discover available Skills and MCP Servers.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        this.assertToolIdentity(exec.agent?.id)
        const catalog = await this.service.catalog()
        const skillCatalog = args.agentPresetId === undefined
          ? undefined
          : await this.service.skillCatalog(args.agentPresetId)
        const mcpCatalog = args.agentPresetId === undefined
          ? undefined
          : await this.service.mcpCatalog(args.agentPresetId)
        return {
          providers: catalog.providers.map(provider => ({ id: provider.id, name: provider.name })),
          models: catalog.models,
          agentPresets: catalog.agentPresets.filter(preset => preset.broken === undefined),
          permissionPresets: catalog.permissionPresets.map(preset => ({
            value: preset.value,
            name: preset.name,
            ...(preset.description === undefined ? {} : { description: preset.description }),
          })),
          existingAssistants: this.service.listAssistants().items.map(assistant => assistant.name),
          ...(skillCatalog === undefined ? {} : { skills: skillCatalog.skills }),
          ...(mcpCatalog === undefined ? {} : {
            mcpServers: mcpCatalog.servers.map(server => ({
              name: server.name,
              toolCount: server.tools.length,
              tools: server.tools,
            })),
          }),
        }
      },
    }))
    agentCtx.tools.register(defineTool({
      name: 'assistant_builder_prepare',
      description: 'Validate and temporarily store one complete assistant draft. Replaces any older draft; this tool does not create the assistant.',
      parameters: {
        name: { type: 'string', required: true, description: 'Unique, user-facing assistant name.' },
        description: { type: 'string', description: 'Short user-facing purpose.' },
        instructions: { type: 'string', required: true, description: 'Stable responsibilities, constraints, workflow, and acceptance rules.' },
        provider: { type: 'string', required: true },
        model: { type: 'string', required: true },
        agentPresetId: { type: 'string', required: true },
        permissionPresetId: { type: 'string', required: true },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact Skill names explicitly selected by the user from the chosen preset catalog.',
        },
        mcpServers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact MCP Server names explicitly selected by the user from the chosen preset catalog.',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{
          type: 'text',
          text: `草稿“${value.name}”已校验。必须等待用户在新的消息中精确回复：确认创建`,
        }],
      },
      execute: async (args, exec) => {
        this.assertToolIdentity(exec.agent?.id)
        if (exec.agent === undefined) {
          throw new AgentTeamError('INVALID_REQUEST', 'Assistant Builder Agent is unavailable')
        }
        const input = await this.service.validateAssistantDraft({
          name: args.name,
          ...(args.description === undefined ? {} : { description: args.description }),
          instructions: args.instructions,
          provider: args.provider,
          model: args.model,
          agentPresetId: args.agentPresetId,
          permissionPresetId: args.permissionPresetId,
          toolAllowlist: [],
          skillAllowlist: args.skills ?? [],
          mcpServers: args.mcpServers ?? [],
        })
        this.pendingDraft = {
          input,
          preparedThroughSeq: exec.agent.session.events.at(-1)?.seq ?? -1,
        }
        return {
          name: input.name,
          confirmationText: '确认创建',
        }
      },
    }))
    agentCtx.tools.register(defineTool({
      name: 'assistant_builder_commit',
      description: 'Create the currently prepared assistant only after a later, real user message exactly says 确认创建.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', required: true },
            name: { type: 'string', required: true },
            revision: { type: 'number', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: `助手“${value.name}”已创建。` }],
      },
      execute: async (_args, exec) => {
        this.assertToolIdentity(exec.agent?.id)
        if (exec.agent === undefined) {
          throw new AgentTeamError('INVALID_REQUEST', 'Assistant Builder Agent is unavailable')
        }
        const pending = this.pendingDraft
        if (pending === undefined) {
          throw new AgentTeamError(
            'INVALID_REQUEST',
            '没有等待确认的助手草稿，请先重新校验草稿',
          )
        }
        if (!hasExplicitAssistantDraftConfirmation(
          exec.agent.session.events,
          pending.preparedThroughSeq,
        )) {
          throw new AgentTeamError(
            'INVALID_REQUEST',
            '必须等待用户在新的消息中精确回复“确认创建”',
          )
        }
        const assistant = await this.service.createAssistant(pending.input)
        if (this.pendingDraft === pending) this.pendingDraft = undefined
        return { id: assistant.id, name: assistant.name, revision: assistant.revision }
      },
    }))
  }

  private assertToolIdentity(id: unknown): void {
    if (String(id) !== ASSISTANT_BUILDER_SESSION_ID) {
      throw new AgentTeamError('INVALID_REQUEST', 'Assistant Builder tool called outside its owned Agent')
    }
  }

  private project(
    events: readonly SessionEvent[],
    status: 'idle' | 'running',
  ): AssistantBuilderConversationView {
    if (this.configuration === undefined) throw new Error('Assistant Builder configuration is unavailable')
    return {
      schemaVersion: 1,
      sessionId: ASSISTANT_BUILDER_SESSION_ID,
      status,
      ...projectConversation(events),
      configuration: this.configuration,
    }
  }

  private publishCurrent(): void {
    const handle = this.handle
    if (handle === undefined || this.configuration === undefined || this.closing) return
    this.service.publishAssistantBuilderConversation(
      this.project(handle.agent.session.events, handle.agent.status),
    )
  }
}

export function hasExplicitAssistantDraftConfirmation(
  events: readonly SessionEvent[],
  preparedThroughSeq: number,
): boolean {
  const latestUserMessage = events.findLast(event => (
    event.seq > preparedThroughSeq
    && event.type === 'user/message'
    && event.data.source.kind === 'user'
  ))
  if (latestUserMessage?.type !== 'user/message') return false
  return textOf(latestUserMessage.data.content).trim() === '确认创建'
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.js'
import { AgentTeamError } from '../src/domain/errors.js'
import type {
  AssistantTemplate,
  Operation,
  TeamActivity,
  TeamAggregate,
  TeamMessage,
} from '../src/domain/types.js'
import { AgentTeamService } from '../src/service/agent-team-service.js'
import type { AgentTeamStore } from '../src/storage/store.js'
import { TeamRuntime } from '../src/runtime/team-runtime.js'
import { ASSISTANT_BUILDER_PROMPT } from '../src/runtime/assistant-builder-runtime.js'

const config: Config = {
  maxRequestBytes: 128 * 1024,
  sseHeartbeatMs: 20_000,
  runtimeConcurrency: 4,
  directMemberChatDefault: true,
  assistantBuilderProvider: '',
  assistantBuilderModel: '',
  assistantBuilderAgentPresetId: '',
  assistantBuilderPermissionPresetId: '',
}

describe('AgentTeamService', () => {
  it('delegates the built-in assistant builder conversation without storing it as a template', async () => {
    const { service, store } = createHarness()
    const conversation = {
      schemaVersion: 1 as const,
      sessionId: 'agent-team:assistant-builder',
      status: 'idle' as const,
      throughSeq: -1,
      nodes: [],
      configuration: {
        provider: 'test-provider',
        model: 'test-model',
        agentPresetId: 'standard',
        permissionPresetId: 'workspace-write',
      },
    }
    const builder = {
      listConversations: vi.fn(async () => ({ items: [], total: 0 })),
      createConversation: vi.fn(async () => conversation),
      getConversation: vi.fn(async () => conversation),
      configure: vi.fn(async () => ({
        ...conversation,
        configuration: {
          ...conversation.configuration,
          provider: 'another-provider',
          model: 'another-model',
        },
      })),
      sendMessage: vi.fn(async () => ({ messageId: 'message-1' })),
      stop: vi.fn(async () => {}),
    }
    service.attachAssistantBuilderRuntime(builder as never)

    await expect(service.listAssistantBuilderConversations()).resolves.toEqual({ items: [], total: 0 })
    await expect(service.createAssistantBuilderConversation()).resolves.toEqual(conversation)
    await expect(service.getAssistantBuilderConversation(conversation.sessionId)).resolves.toEqual(conversation)
    await expect(service.configureAssistantBuilder(conversation.sessionId, 'another-provider', 'another-model')).resolves.toMatchObject({
      configuration: { provider: 'another-provider', model: 'another-model' },
    })
    await expect(service.sendAssistantBuilderMessage(conversation.sessionId, 'Create a reviewer')).resolves.toEqual({ messageId: 'message-1' })
    await service.stopAssistantBuilder(conversation.sessionId)

    expect(builder.sendMessage).toHaveBeenCalledWith(conversation.sessionId, 'Create a reviewer')
    expect(builder.configure).toHaveBeenCalledWith(conversation.sessionId, 'another-provider', 'another-model')
    expect(builder.stop).toHaveBeenCalledWith(conversation.sessionId)
    expect(store.listAssistants()).toHaveLength(0)
    expect(ASSISTANT_BUILDER_PROMPT).toContain('assistant_builder_get_catalog')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('assistant_builder_prepare')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('assistant_builder_commit')
    expect(ASSISTANT_BUILDER_PROMPT).not.toContain('assistant_builder_create')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('必须等待新的用户消息')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('不要要求固定口令')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('明确表达同意')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('不要询问或限制普通工具')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('MCP Servers')
    expect(ASSISTANT_BUILDER_PROMPT).toContain('不调用 ask_user_question')
  })

  it('lists only model-invocable Skills for the chosen Agent Preset', async () => {
    const { service } = createHarness()

    await expect(service.skillCatalog('default')).resolves.toEqual({
      agentPresetId: 'default',
      skills: [{
        name: 'code-review',
        description: 'Review code changes.',
        source: 'user-agents',
      }],
    })
  })

  it('groups MCP tools by Server for the chosen Agent Preset', async () => {
    const { service } = createHarness()

    await expect(service.mcpCatalog('default')).resolves.toEqual({
      agentPresetId: 'default',
      servers: [
        {
          name: 'figma',
          tools: [{ name: 'mcp__figma__inspect', description: 'Inspect a Figma node.' }],
        },
        {
          name: 'github',
          tools: [
            { name: 'mcp__github__create_issue', description: 'Create an issue.' },
            { name: 'mcp__github__list_issues', description: 'List issues.' },
          ],
        },
      ],
    })
  })

  it('localizes built-in permission preset names while preserving their ids', async () => {
    const { service } = createHarness()

    await expect(service.catalog()).resolves.toMatchObject({
      permissionPresets: [
        { value: 'standard', name: '标准' },
        { value: 'workspace-write', name: '工作区可写' },
      ],
    })
  })

  it('validates an assistant draft without storing it', async () => {
    const { service, store } = createHarness()

    await expect(service.validateAssistantDraft({
      ...assistantInput(),
      name: '  Codex Lead  ',
    })).resolves.toMatchObject({ name: 'Codex Lead' })

    expect(store.listAssistants()).toHaveLength(0)
  })

  it('creates a multi-member draft and dissolves only the team', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const team = await service.createTeamDraft({
      name: 'Compiler Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, displayName: 'Lead', role: 'leader' },
        { assistantId: assistant.id, displayName: 'Coder', role: 'member' },
      ],
    })

    expect(Object.values(team.members)).toHaveLength(2)
    expect(Object.values(team.members).map(member => member.displayName)).toEqual(['Codex Lead', 'Codex Lead'])
    expect(new Set(Object.values(team.members).map(member => member.sessionId)).size).toBe(2)
    expect(() => service.getAssistant(assistant.id)).not.toThrow()

    await expect(service.dissolveTeam(team.id, 'wrong')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await service.dissolveTeam(team.id, team.name)

    expect(store.getTeam(team.id)).toBeUndefined()
    expect(store.listMessages(team.id)).toHaveLength(0)
    expect(store.listActivities(team.id)).toHaveLength(0)
    expect(service.getAssistant(assistant.id).name).toBe('Codex Lead')
  })

  it('rejects malformed Skill names before storing a template', async () => {
    const { service } = createHarness()
    await expect(service.createAssistant({
      ...assistantInput(),
      skillAllowlist: ['Not A Skill'],
    })).rejects.toMatchObject({ code: 'SKILL_REFERENCE_INVALID' })
  })

  it('rejects MCP Servers that are malformed or unavailable to the Agent Preset', async () => {
    const { service } = createHarness()

    await expect(service.createAssistant({
      ...assistantInput(),
      mcpServers: ['bad server'],
    })).rejects.toMatchObject({ code: 'MCP_REFERENCE_INVALID' })
    await expect(service.createAssistant({
      ...assistantInput(),
      mcpServers: ['missing'],
    })).rejects.toMatchObject({ code: 'MCP_REFERENCE_INVALID' })
  })

  it('persists selected MCP Servers into new team member snapshots', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant({
      ...assistantInput(),
      mcpServers: ['github', 'github'],
    })
    const team = await service.createTeamDraft({
      name: 'MCP Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, displayName: 'Lead', role: 'leader' }],
    })

    expect(assistant.mcpServers).toEqual(['github'])
    expect(Object.values(team.members)[0]?.assistantSnapshot.mcpServers).toEqual(['github'])
  })

  it('rejects the removed maxTokens field', async () => {
    const { service } = createHarness()
    await expect(service.createAssistant({
      ...assistantInput(),
      maxTokens: 4096,
    } as never)).rejects.toThrow()
  })

  it('discards legacy tool restrictions from assistant input', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant({
      ...assistantInput(),
      toolAllowlist: ['bash', 'skill'],
    })

    expect(assistant.toolAllowlist).toEqual([])
  })

  it('migrates legacy team state and tool restrictions exactly once', async () => {
    const { service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    await store.updateAssistant(assistant.id, current => ({
      ...current,
      toolAllowlist: ['bash'],
    }))
    const draft = await service.createTeamDraft({
      name: 'Legacy Paused Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, displayName: 'Lead', role: 'leader' }],
    })
    const legacy = await store.updateTeam(draft.id, team => ({
      ...team,
      state: 'paused',
      members: Object.fromEntries(Object.entries(team.members).map(([slotId, member]) => [
        slotId,
        { ...member, displayName: 'Legacy Alias' },
      ])),
    }))

    await service.migrateLegacyData()
    const migrated = service.getTeam(draft.id)
    await service.migrateLegacyData()

    expect(migrated.state).toBe('active')
    expect(Object.values(migrated.members).map(member => member.displayName)).toEqual(['Codex Lead'])
    expect(Object.values(migrated.members).map(member => member.assistantSnapshot.toolAllowlist)).toEqual([[]])
    expect(service.getAssistant(assistant.id).toolAllowlist).toEqual([])
    expect(migrated.revision).toBe(legacy.revision + 1)
    expect(service.getTeam(draft.id).revision).toBe(migrated.revision)
  })

  it('dissolves a started team while preserving its assistant template', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Durable Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, displayName: 'Lead', role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const agent = fakeAgent()
    runtimeInternals(runtime).owned.set(member.sessionId, fakeOwned(agent))

    await service.dissolveTeam(team.id, team.name)

    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(agent.whenIdle).toHaveBeenCalledOnce()
    expect(runtimeInternals(runtime).owned.size).toBe(0)
    expect(store.getTeam(draft.id)).toBeUndefined()
    expect(store.getAssistant(assistant.id)).toBeDefined()
  })

  it('keeps a failed started-team dissolution retryable', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Retryable Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, displayName: 'Lead', role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const agent = fakeAgent()
    runtimeInternals(runtime).owned.set(member.sessionId, {
      teamId: team.id,
      slotId: member.id,
      handle: {
        agent,
        dispose: vi.fn(async () => { throw new Error('dispose failed') }),
      },
    })

    await expect(service.dissolveTeam(team.id, team.name)).rejects.toMatchObject({ code: 'TEAM_DELETE_FAILED' })

    expect(store.getTeam(team.id)?.state).toBe('delete_blocked')
    expect(store.getAssistant(assistant.id)).toBeDefined()
  })

  it('adds, promotes, and removes draft members without changing templates', async () => {
    const { service } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Mutable Draft',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, displayName: 'Original Lead', role: 'leader' }],
    })
    const added = await service.addMember(draft.id, {
      assistantId: assistant.id,
      displayName: 'Second Instance',
    }, { expectedRevision: draft.revision })
    const second = Object.values(added.members).find(member => member.id !== draft.leaderSlotId)!
    const promoted = await service.changeLeader(added.id, second.id, { expectedRevision: added.revision })
    const original = promoted.members[draft.leaderSlotId]!
    const removed = await service.removeMember(promoted.id, original.id, { expectedRevision: promoted.revision })

    expect(Object.values(removed.members).map(member => member.displayName)).toEqual(['Codex Lead'])
    expect(service.getAssistant(assistant.id).revision).toBe(1)
  })

  it('atomically queues an assigned task and wakes its owner', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Dispatch Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, displayName: 'Lead', role: 'leader' },
        { assistantId: assistant.id, displayName: 'Coder', role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const runtime = runtimeInternals(new TeamRuntime(ctx, config, service))
    const leaderAgent = fakeAgent()
    const memberAgent = fakeAgent()
    runtime.owned.set(team.members[team.leaderSlotId]!.sessionId, fakeOwned(leaderAgent))
    runtime.owned.set(member.sessionId, fakeOwned(memberAgent))

    const created = await runtime.createTask(team.id, team.leaderSlotId, {
      title: 'Implement parser',
      description: 'Add the parser implementation.',
      ownerSlotId: member.id,
      fileScopes: ['src/parser.ts'],
    })

    expect(created).toMatchObject({ status: 'assigned', deliveryState: 'delivered' })
    expect(memberAgent.followup).toHaveBeenCalledOnce()
    expect(Object.keys(service.getTeam(team.id).outbox)).toHaveLength(0)
    const assignment = service.listMessages(team.id).items[0]!
    expect(assignment).toMatchObject({
      deliveryState: 'delivered',
      recipient: { kind: 'member', slotId: member.id },
      relatedTaskId: created.taskId,
    })

    const updated = await runtime.updateTask(team.id, member.id, {
      taskId: created.taskId,
      status: 'completed',
      result: 'Parser implemented and tested.',
    })

    expect(updated.deliveryState).toBe('delivered')
    expect(leaderAgent.followup).toHaveBeenCalledOnce()
    expect(service.listMessages(team.id).items[1]).toMatchObject({
      type: 'result',
      recipient: { kind: 'leader', slotId: team.leaderSlotId },
      relatedTaskId: created.taskId,
    })
  })

  it('keeps failed assignment delivery in the durable outbox and recovers it', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Recovery Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, displayName: 'Lead', role: 'leader' },
        { assistantId: assistant.id, displayName: 'Coder', role: 'member' },
      ],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = Object.values(team.members).find(value => value.role === 'member')!
    const runtime = runtimeInternals(new TeamRuntime(ctx, config, service))
    const memberAgent = fakeAgent()
    memberAgent.followup.mockImplementationOnce(() => { throw new Error('temporary inbox failure') })
    runtime.owned.set(member.sessionId, fakeOwned(memberAgent))

    const created = await runtime.createTask(team.id, team.leaderSlotId, {
      title: 'Recoverable assignment',
      ownerSlotId: member.id,
    })

    expect(created.deliveryState).toBe('queued')
    expect(Object.keys(service.getTeam(team.id).outbox)).toHaveLength(1)
    expect(service.listMessages(team.id).items[0]?.deliveryState).toBe('failed')

    memberAgent.followup.mockImplementation(message => {
      memberAgent.session.events.push({
        type: 'agent/inbox/spliced',
        data: { inserted: [message] },
      })
    })
    await runtime.recoverPendingMessages(service.getTeam(team.id))

    expect(memberAgent.followup).toHaveBeenCalledTimes(2)
    expect(Object.keys(service.getTeam(team.id).outbox)).toHaveLength(0)
    expect(service.listMessages(team.id).items[0]?.deliveryState).toBe('delivered')
  })

  it('stops the active member, clears pending inbox work, and waits for idle', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Stop Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, displayName: 'Lead', role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({
      ...team,
      state: 'active',
      members: Object.fromEntries(Object.entries(team.members).map(([id, member]) => [
        id,
        { ...member, lastRuntimeState: 'running' },
      ])),
    }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    const runtime = runtimeInternals(new TeamRuntime(ctx, config, service))
    const agent = fakeAgent()
    agent.status = 'running'
    agent.whenIdle.mockImplementation(async () => { agent.status = 'idle' })
    runtime.owned.set(member.sessionId, fakeOwned(agent))

    await runtime.stopMember(team.id, member.id)

    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(agent.whenIdle).toHaveBeenCalledOnce()
    expect(service.getTeam(team.id).members[member.id]?.lastRuntimeState).toBe('idle')
  })

  it('changes a live member permission without modifying the assistant default', async () => {
    const { ctx, service, store, permissionSet } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Permission Team',
      workspaceId: 'workspace-1',
      members: [{ assistantId: assistant.id, displayName: 'Lead', role: 'leader' }],
    })
    await store.updateTeam(draft.id, team => ({ ...team, state: 'active' }))
    const team = service.getTeam(draft.id)
    const member = team.members[team.leaderSlotId]!
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    runtimeInternals(runtime).owned.set(member.sessionId, fakeOwned(fakeAgent()))

    const changed = await service.setMemberPermissionPreset(team.id, member.id, 'workspace-write')

    expect(permissionSet).toHaveBeenCalledWith(expect.anything(), 'workspace-write')
    expect(changed.members[member.id]?.permissionPresetId).toBe('workspace-write')
    expect(changed.members[member.id]?.assistantSnapshot.permissionPresetId).toBe('standard')
    expect(service.getAssistant(assistant.id).permissionPresetId).toBe('standard')
  })

  it('clears every task and rotates every member onto a fresh Session', async () => {
    const { ctx, service, store } = createHarness()
    const assistant = await service.createAssistant(assistantInput())
    const draft = await service.createTeamDraft({
      name: 'Fresh Context Team',
      workspaceId: 'workspace-1',
      members: [
        { assistantId: assistant.id, displayName: 'Lead', role: 'leader' },
        { assistantId: assistant.id, displayName: 'Coder', role: 'member' },
      ],
    })
    const taskId = 'task-1'
    await store.updateTeam(draft.id, team => ({
      ...team,
      state: 'active',
      tasks: {
        [taskId]: {
          id: taskId,
          title: 'Old work',
          description: 'Must not survive the reset.',
          status: 'running',
          ownerSlotId: Object.values(team.members).find(member => member.role === 'member')?.id,
          dependencyIds: [],
          fileScopes: ['src/old.ts'],
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    }))
    const before = service.getTeam(draft.id)
    const oldSessionIds = Object.values(before.members).map(member => member.sessionId)
    const runtime = new TeamRuntime(ctx, config, service)
    service.attachRuntime(runtime)
    const ensureMembersOnline = vi.fn(async () => {})
    runtimeInternals(runtime).ensureMembersOnline = ensureMembersOnline
    for (const member of Object.values(before.members)) {
      runtimeInternals(runtime).owned.set(member.sessionId, fakeOwned(fakeAgent()))
    }

    await expect(service.resetTeam(before.id, 'wrong')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const reset = await service.resetTeam(before.id, before.name)

    expect(reset.state).toBe('active')
    expect(Object.keys(reset.tasks)).toHaveLength(0)
    expect(Object.keys(reset.leases)).toHaveLength(0)
    expect(Object.keys(reset.outbox)).toHaveLength(0)
    const newSessionIds = Object.values(reset.members).map(member => member.sessionId)
    expect(newSessionIds).toHaveLength(oldSessionIds.length)
    expect(newSessionIds.every(id => !oldSessionIds.includes(id))).toBe(true)
    expect(oldSessionIds.every(id => reset.retiredSessions[id] !== undefined)).toBe(true)
    expect(runtimeInternals(runtime).owned.size).toBe(0)
    expect(ensureMembersOnline).toHaveBeenCalledOnce()
  })
})

function createHarness(): {
  ctx: Context
  service: AgentTeamService
  store: MemoryStore
  permissionSet: ReturnType<typeof vi.fn>
} {
  const ctx = new Context()
  ctx.provide('llm', {
    listProviders: () => [{ id: 'openai', name: 'OpenAI' }],
    listModels: async () => [{ id: 'codex', name: 'Codex' }],
    resolveModelInfo: async (provider: string, model: string) => ({ provider, model }),
  } as never)
  ctx.provide('agentPresets', {
    list: async () => [{ id: 'default', name: 'Default' }],
    resolve: async (id: string) => ({ id, name: id }),
    standingKeyFor: async () => ({ kind: 'preset-scope' }),
  } as never)
  ctx.provide('tools', {
    get: (name: string) => name === 'skill' ? { name: 'skill' } : undefined,
    schemas: () => [
      { name: 'skill', description: 'Load one Skill.' },
      { name: 'mcp__github__list_issues', description: 'List issues.' },
      { name: 'mcp__figma__inspect', description: 'Inspect a Figma node.' },
      { name: 'mcp__github__create_issue', description: 'Create an issue.' },
    ],
  } as never)
  ctx.provide('skills', {
    list: async () => [
      {
        name: 'code-review',
        description: 'Review code changes.',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'user-agents',
        provider: 'filesystem',
      },
      {
        name: 'manual-only',
        description: 'Only users may invoke this.',
        invocation: { modelInvocable: false, userInvocable: true },
        source: 'user-agents',
        provider: 'filesystem',
      },
    ],
  } as never)
  const permissionSet = vi.fn()
  ctx.provide('permissionPresets', {
    names: ['standard', 'workspace-write'],
    optionOf: (name: string) => ({ value: name, name }),
    set: permissionSet,
  } as never)
  ctx.provide('agents', {
    get: () => undefined,
  } as never)
  ctx.provide('sessions', {
    flush: async () => {},
  } as never)
  const workspace = {
    id: 'workspace-1',
    path: '/tmp/agent-team-workspace',
    title: 'Workspace',
    status: async () => 'ok' as const,
    attachSession: async () => {},
    detachSession: async () => {},
  }
  ctx.provide('workspaceRegistry', {
    get: (id: string) => id === workspace.id ? workspace : undefined,
    list: () => [workspace],
  } as never)
  const store = new MemoryStore()
  return { ctx, service: new AgentTeamService(ctx, config, store), store, permissionSet }
}

interface FakeAgent {
  followup: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  whenIdle: ReturnType<typeof vi.fn>
  status: 'idle' | 'running'
  session: { events: Array<{ type: string; data: { inserted: unknown[] } }> }
}

interface RuntimeInternals {
  owned: Map<string, unknown>
  ensureMembersOnline: (team: TeamAggregate) => Promise<void>
  createTask(
    teamId: string,
    creatorSlotId: string,
    input: { title: string; description?: string; ownerSlotId?: string; fileScopes?: string[] },
  ): Promise<{ taskId: string; status: string; deliveryState?: 'queued' | 'delivered' }>
  updateTask(
    teamId: string,
    callerSlotId: string,
    input: {
      taskId: string
      status: 'pending' | 'assigned' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'
      result?: string
      error?: string
      ownerSlotId?: string
    },
  ): Promise<{ taskId: string; status: string; deliveryState?: 'queued' | 'delivered' }>
  recoverPendingMessages(team: TeamAggregate): Promise<void>
  stopMember(teamId: string, slotId: string): Promise<void>
}

function runtimeInternals(runtime: TeamRuntime): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

function fakeAgent(): FakeAgent {
  const session: FakeAgent['session'] = { events: [] }
  return {
    session,
    status: 'idle',
    followup: vi.fn(message => {
      session.events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
    }),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  }
}

function fakeOwned(agent: FakeAgent): unknown {
  return { teamId: 'test-team', slotId: 'test-slot', handle: { agent, dispose: vi.fn(async () => {}) } }
}

function assistantInput() {
  return {
    name: 'Codex Lead',
    instructions: 'Coordinate the team.',
    provider: 'openai',
    model: 'codex',
    agentPresetId: 'default',
    permissionPresetId: 'standard',
    toolAllowlist: [],
    skillAllowlist: [],
    mcpServers: [],
  }
}

class MemoryStore implements AgentTeamStore {
  private assistants = new Map<string, AssistantTemplate>()
  private teams = new Map<string, TeamAggregate>()
  private messages = new Map<string, TeamMessage>()
  private activities = new Map<string, TeamActivity>()
  private operations = new Map<string, Operation>()

  getAssistant(id: string) { return this.assistants.get(id) }
  listAssistants() { return [...this.assistants.values()] }
  async putAssistant(value: AssistantTemplate) { this.assistants.set(value.id, value) }
  updateAssistant(id: string, update: (current: AssistantTemplate) => AssistantTemplate) {
    return updateMap(this.assistants, id, update)
  }
  async deleteAssistant(id: string) { return this.assistants.delete(id) }

  getTeam(id: string) { return this.teams.get(id) }
  listTeams() { return [...this.teams.values()] }
  async putTeam(value: TeamAggregate) { this.teams.set(value.id, value) }
  updateTeam(id: string, update: (current: TeamAggregate) => TeamAggregate) {
    return updateMap(this.teams, id, update)
  }
  async deleteTeam(id: string) { return this.teams.delete(id) }

  listMessages(teamId: string) { return [...this.messages.values()].filter(value => value.teamId === teamId) }
  async putMessage(value: TeamMessage) { this.messages.set(value.id, value) }
  async deleteMessage(id: string) { return this.messages.delete(id) }

  listActivities(teamId: string) { return [...this.activities.values()].filter(value => value.teamId === teamId) }
  async putActivity(value: TeamActivity) { this.activities.set(value.id, value) }
  async deleteActivity(id: string) { return this.activities.delete(id) }

  getOperation(id: string) { return this.operations.get(id) }
  listOperations() { return [...this.operations.values()] }
  async putOperation(value: Operation) { this.operations.set(value.id, value) }
  updateOperation(id: string, update: (current: Operation) => Operation) {
    return updateMap(this.operations, id, update)
  }
  async deleteOperation(id: string) { return this.operations.delete(id) }
}

async function updateMap<T>(map: Map<string, T>, id: string, update: (current: T) => T): Promise<T> {
  const current = map.get(id)
  if (current === undefined) throw new AgentTeamError('INVALID_REQUEST', `Unknown record '${id}'`)
  const next = update(current)
  map.set(id, next)
  return next
}

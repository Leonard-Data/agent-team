import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { isModelInvocable, isSkillName } from '@deepseek-ai/dsh-skill'
import type { Config } from '../config.js'
import { AgentTeamError } from '../domain/errors.js'
import { isMcpServerName, mcpServerFromToolName } from '../domain/mcp.js'
import {
  createAssistantInputSchema,
  addTeamMemberInputSchema,
  createTeamDraftInputSchema,
  updateAssistantInputSchema,
} from '../domain/schemas.js'
import {
  snapshotAssistant,
  type AddTeamMemberInput,
  type AssistantTemplate,
  type CreateAssistantInput,
  type CreateTeamDraftInput,
  type Operation,
  type Page,
  type TeamActivity,
  type TeamAggregate,
  type TeamMemberSlot,
  type TeamMessage,
  type UpdateAssistantInput,
} from '../domain/types.js'
import type { AgentTeamStore } from '../storage/store.js'
import type { AssistantBuilderRuntime } from '../runtime/assistant-builder-runtime.js'
import type { TeamRuntime } from '../runtime/team-runtime.js'
import { readWorkspaceGitDiff, readWorkspaceGitStatus, WorkspaceTracker } from './workspace-tracker.js'
import { renderWorkspaceGitDiff } from './workspace-diff-renderer.js'
import type {
  AssistantBuilderConversationView,
  AssistantBuilderConversationListView,
  AssistantBuilderDraftView,
  MemberConversationView,
  TeamWorkbenchView,
  WorkspaceEntryView,
  WorkspaceGitStatusView,
  WorkspaceGitDiffView,
  WorkspaceUploadView,
} from '../transport/contracts.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeam: AgentTeamService
  }
}

export interface MutationOptions {
  expectedRevision?: number
}

export interface AgentTeamChange {
  cursor: number
  entityType: 'assistant' | 'assistant-builder' | 'team' | 'operation' | 'conversation' | 'workspace'
  entityId: string
  revision: number
  kind: string
  conversation?: MemberConversationView
  assistantBuilderConversation?: AssistantBuilderConversationView
}

export interface CatalogSnapshot {
  providers: ReturnType<Context['llm']['listProviders']>
  models: Record<string, Array<{ id: string; name: string; description?: string }>>
  agentPresets: Array<{ id: string; name: string; description?: string; broken?: string }>
  permissionPresets: Array<ReturnType<Context['permissionPresets']['optionOf']>>
  workspaces: Array<{
    id: string
    path: string
    title: string
    status: 'ok' | 'missing-dir'
  }>
}

export interface SkillCatalogSnapshot {
  agentPresetId: string
  skills: Array<{
    name: string
    description: string
    source: string
  }>
}

export interface McpCatalogSnapshot {
  agentPresetId: string
  servers: Array<{
    name: string
    tools: Array<{ name: string; description: string }>
  }>
}

const PERMISSION_PRESET_LABELS: Readonly<Record<string, string>> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
  standard: '标准',
}

export class AgentTeamService extends Service {
  private readonly listeners = new Set<(change: AgentTeamChange) => void>()
  private cursor = 0
  private runtime?: TeamRuntime
  private assistantBuilderRuntime?: AssistantBuilderRuntime
  private readonly workspaceTracker: WorkspaceTracker

  constructor(
    ctx: Context,
    readonly config: Config,
    private readonly store: AgentTeamStore,
  ) {
    super(ctx, 'agentTeam')
    this.workspaceTracker = new WorkspaceTracker(
      teamId => {
        const team = this.store.getTeam(teamId)
        if (team !== undefined) this.publish('workspace', teamId, team.revision, 'workspace.changed')
      },
      (teamId, error) => {
        this.ctx.logger.warn(`agent-team: Workspace watcher failed for team '${teamId}'`, error)
      },
    )
  }

  subscribe(listener: (change: AgentTeamChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  attachRuntime(runtime: TeamRuntime): void {
    if (this.runtime !== undefined) throw new Error('Agent Team runtime is already attached')
    this.runtime = runtime
  }

  attachAssistantBuilderRuntime(runtime: AssistantBuilderRuntime): void {
    if (this.assistantBuilderRuntime !== undefined) throw new Error('Assistant Builder runtime is already attached')
    this.assistantBuilderRuntime = runtime
  }

  startWorkspaceTracking(): void {
    for (const team of this.store.listTeams()) this.workspaceTracker.watch(team.id, team.workspacePath)
  }

  disposeWorkspaceTracking(): Promise<void> {
    return this.workspaceTracker.dispose()
  }

  async catalog(): Promise<CatalogSnapshot> {
    const providers = this.ctx.llm.listProviders()
    const modelEntries = await Promise.all(providers.map(async provider => [
      provider.id,
      (await this.ctx.llm.listModels(provider.id)).map(model => ({
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
      })),
    ] as const))
    const presets = await this.ctx.agentPresets.list()
    const workspaces = await Promise.all(this.ctx.workspaceRegistry.list().map(async workspace => ({
      id: String(workspace.id),
      path: workspace.path,
      title: workspace.title,
      status: await workspace.status(),
    })))
    return {
      providers,
      models: Object.fromEntries(modelEntries),
      agentPresets: presets.map(preset => ({
        id: preset.id,
        name: preset.name ?? preset.id,
        ...(preset.description === undefined ? {} : { description: preset.description }),
        ...(preset.broken === undefined ? {} : { broken: preset.broken }),
      })),
      permissionPresets: this.ctx.permissionPresets.names.map(name => {
        const option = this.ctx.permissionPresets.optionOf(name)
        return {
          ...option,
          name: PERMISSION_PRESET_LABELS[option.value] ?? option.name,
        }
      }),
      workspaces,
    }
  }

  async skillCatalog(agentPresetId: string): Promise<SkillCatalogSnapshot> {
    try {
      await this.ctx.agentPresets.resolve(agentPresetId)
      const scope = await this.ctx.agentPresets.standingKeyFor(agentPresetId)
      if (this.ctx.tools.get('skill', scope) === undefined) {
        return { agentPresetId, skills: [] }
      }
      const skills = await this.ctx.skills.list({ scope })
      return {
        agentPresetId,
        skills: skills.filter(isModelInvocable).map(skill => ({
          name: skill.name,
          description: skill.description,
          source: skill.source,
        })),
      }
    } catch (error) {
      if (error instanceof AgentTeamError) throw error
      throw new AgentTeamError(
        'PRESET_REFERENCE_INVALID',
        `Cannot read Skills for agent preset '${agentPresetId}'`,
        undefined,
        { cause: error },
      )
    }
  }

  async mcpCatalog(agentPresetId: string): Promise<McpCatalogSnapshot> {
    try {
      await this.ctx.agentPresets.resolve(agentPresetId)
      const scope = await this.ctx.agentPresets.standingKeyFor(agentPresetId)
      const servers = new Map<string, Array<{ name: string; description: string }>>()
      for (const tool of this.ctx.tools.schemas(scope)) {
        const serverName = mcpServerFromToolName(tool.name)
        if (serverName === undefined) continue
        const entries = servers.get(serverName) ?? []
        entries.push({ name: tool.name, description: tool.description })
        servers.set(serverName, entries)
      }
      return {
        agentPresetId,
        servers: [...servers.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, tools]) => ({
          name,
          tools: tools.sort((left, right) => left.name.localeCompare(right.name)),
        })),
      }
    } catch (error) {
      if (error instanceof AgentTeamError) throw error
      throw new AgentTeamError(
        'PRESET_REFERENCE_INVALID',
        `Cannot read MCP Servers for agent preset '${agentPresetId}'`,
        undefined,
        { cause: error },
      )
    }
  }

  getAssistant(id: string): AssistantTemplate {
    return requireAssistant(this.store, id)
  }

  listAssistants(): Page<AssistantTemplate> {
    const items = this.store.listAssistants()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    return { items, total: items.length }
  }

  async createAssistant(raw: CreateAssistantInput): Promise<AssistantTemplate> {
    const input = await this.validateAssistantDraft(raw)
    const now = new Date().toISOString()
    const assistant: AssistantTemplate = {
      schemaVersion: 1,
      id: randomUUID(),
      ...input,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.putAssistant(assistant)
    await this.activity('assistant.created', assistant.id, assistant.revision, `Assistant ${assistant.name} created`)
    this.publish('assistant', assistant.id, assistant.revision, 'assistant.created')
    return assistant
  }

  async validateAssistantDraft(raw: CreateAssistantInput): Promise<CreateAssistantInput> {
    const input = normalizeAssistantInput(createAssistantInputSchema.parse(raw))
    await this.validateAssistantReferences(input)
    return input
  }

  async updateAssistant(
    id: string,
    raw: UpdateAssistantInput,
    options: MutationOptions = {},
  ): Promise<AssistantTemplate> {
    const patch = updateAssistantInputSchema.parse(raw)
    const current = requireAssistant(this.store, id)
    assertRevision('assistant', current.revision, options.expectedRevision)
    const candidate = normalizeAssistantInput(createAssistantInputSchema.parse({
      ...assistantInputOf(current),
      ...patch,
    }))
    await this.validateAssistantReferences(candidate)
    const next = await this.store.updateAssistant(id, value => ({
      ...value,
      ...candidate,
      revision: value.revision + 1,
      updatedAt: new Date().toISOString(),
    }))
    await this.activity('assistant.updated', next.id, next.revision, `Assistant ${next.name} updated`)
    this.publish('assistant', next.id, next.revision, 'assistant.updated')
    return next
  }

  async cloneAssistant(id: string, name?: string): Promise<AssistantTemplate> {
    const source = requireAssistant(this.store, id)
    return this.createAssistant({
      ...assistantInputOf(source),
      name: name?.trim() || `${source.name} Copy`,
    })
  }

  async deleteAssistant(id: string): Promise<void> {
    const assistant = requireAssistant(this.store, id)
    const references = this.store.listTeams()
      .filter(team => Object.values(team.members).some(member => member.assistantId === id))
      .map(team => ({ id: team.id, name: team.name }))
    if (references.length > 0) {
      throw new AgentTeamError(
        'ASSISTANT_IN_USE',
        `Assistant '${assistant.name}' is used by active team members`,
        { teams: references },
      )
    }
    await this.store.deleteAssistant(id)
    await this.activity('assistant.deleted', id, assistant.revision + 1, `Assistant ${assistant.name} deleted`)
    this.publish('assistant', id, assistant.revision + 1, 'assistant.deleted')
  }

  listAssistantBuilderConversations(): Promise<AssistantBuilderConversationListView> {
    return this.requireAssistantBuilderRuntime().listConversations()
  }

  getAssistantBuilderDraft(): Promise<AssistantBuilderDraftView> {
    return this.requireAssistantBuilderRuntime().getDraft()
  }

  configureAssistantBuilderDraft(provider: string, model: string): Promise<AssistantBuilderDraftView> {
    return this.requireAssistantBuilderRuntime().configureDraft(provider, model)
  }

  startAssistantBuilderConversation(
    provider: string,
    model: string,
    content: string,
  ): Promise<AssistantBuilderConversationView> {
    return this.requireAssistantBuilderRuntime().startConversation(provider, model, content)
  }

  getAssistantBuilderConversation(sessionId: string): Promise<AssistantBuilderConversationView> {
    return this.requireAssistantBuilderRuntime().getConversation(sessionId)
  }

  configureAssistantBuilder(
    sessionId: string,
    provider: string,
    model: string,
  ): Promise<AssistantBuilderConversationView> {
    return this.requireAssistantBuilderRuntime().configure(sessionId, provider, model)
  }

  sendAssistantBuilderMessage(sessionId: string, content: string): Promise<{ messageId: string }> {
    return this.requireAssistantBuilderRuntime().sendMessage(sessionId, content)
  }

  stopAssistantBuilder(sessionId: string): Promise<void> {
    return this.requireAssistantBuilderRuntime().stop(sessionId)
  }

  archiveAssistantBuilderConversation(sessionId: string): Promise<void> {
    return this.requireAssistantBuilderRuntime().archiveConversation(sessionId)
  }

  getTeam(id: string): TeamAggregate {
    return requireTeam(this.store, id)
  }

  listTeams(): Page<TeamAggregate> {
    const items = this.store.listTeams()
    return { items, total: items.length }
  }

  async createTeamDraft(raw: CreateTeamDraftInput): Promise<TeamAggregate> {
    const input = createTeamDraftInputSchema.parse(raw)
    const leaders = input.members.filter(member => member.role === 'leader')
    if (leaders.length !== 1) {
      throw new AgentTeamError('TEAM_INVALID_LEADER', 'A team must contain exactly one leader')
    }
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(input.workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok') {
      throw new AgentTeamError('WORKSPACE_UNAVAILABLE', `Workspace '${input.workspaceId}' is unavailable`)
    }

    const now = new Date().toISOString()
    const members: Record<string, TeamMemberSlot> = {}
    let leaderSlotId = ''
    for (const item of input.members) {
      const assistant = requireAssistant(this.store, item.assistantId)
      const slotId = randomUUID()
      members[slotId] = {
        id: slotId,
        assistantId: assistant.id,
        displayName: assistant.name,
        role: item.role,
        assistantSnapshot: snapshotAssistant(assistant),
        permissionPresetId: assistant.permissionPresetId,
        sessionId: `agent-team:${randomUUID()}`,
        desiredState: 'offline',
        lastRuntimeState: 'offline',
        joinedAt: now,
      }
      if (item.role === 'leader') leaderSlotId = slotId
    }

    const team: TeamAggregate = {
      schemaVersion: 1,
      id: randomUUID(),
      name: input.name.trim(),
      workspaceId: String(workspace.id),
      workspacePath: workspace.path,
      leaderSlotId,
      state: 'draft',
      directMemberChat: input.directMemberChat ?? this.config.directMemberChatDefault,
      members,
      retiredSessions: {},
      tasks: {},
      leases: {},
      outbox: {},
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.putTeam(team)
    this.workspaceTracker.watch(team.id, team.workspacePath)
    await this.activity('team.created', team.id, team.revision, `Team ${team.name} draft created`)
    this.publish('team', team.id, team.revision, 'team.created')
    return team
  }

  async changeLeader(
    teamId: string,
    successorSlotId: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const current = requireTeam(this.store, teamId)
    assertTeamMutable(current)
    assertRevision('team', current.revision, options.expectedRevision)
    if (current.members[successorSlotId] === undefined) {
      throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${successorSlotId}'`)
    }
    if (current.leaderSlotId === successorSlotId) {
      throw new AgentTeamError('INVALID_REQUEST', 'The selected member is already the team leader')
    }
    const next = await this.store.updateTeam(teamId, team => ({
      ...team,
      members: Object.fromEntries(Object.entries(team.members).map(([slotId, member]) => [
        slotId,
        { ...member, role: slotId === successorSlotId ? 'leader' : 'member' },
      ])),
      leaderSlotId: successorSlotId,
      revision: team.revision + 1,
      updatedAt: new Date().toISOString(),
    }))
    await this.activity('team.leader_changed', teamId, next.revision, 'Team leader changed')
    this.publish('team', teamId, next.revision, 'team.leader_changed')
    return next
  }

  async addMember(
    teamId: string,
    raw: AddTeamMemberInput,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const input = addTeamMemberInputSchema.parse(raw)
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    assertRevision('team', team.revision, options.expectedRevision)
    if (team.state !== 'draft' && team.state !== 'active') {
      throw new AgentTeamError('TEAM_NOT_ACTIVE', `Cannot add a member while team is '${team.state}'`)
    }
    const assistant = requireAssistant(this.store, input.assistantId)
    const displayName = assistant.name
    const now = new Date().toISOString()
    const member = createMemberSlot(assistant, displayName, 'member', now, team.state === 'draft' ? 'offline' : 'online')
    const next = await this.store.updateTeam(teamId, current => ({
      ...current,
      members: { ...current.members, [member.id]: member },
      revision: current.revision + 1,
      updatedAt: now,
    }))
    await this.activity('team.member_added', teamId, next.revision, `Member ${displayName} added`)
    this.publish('team', teamId, next.revision, 'team.member_added')
    if (next.state !== 'draft') return this.requireRuntime().activateMember(teamId, member.id)
    return next
  }

  async removeMember(
    teamId: string,
    slotId: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    assertRevision('team', team.revision, options.expectedRevision)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    if (slotId === team.leaderSlotId) {
      throw new AgentTeamError('MEMBER_IS_LEADER', 'Choose a successor before removing the current leader')
    }
    assertMemberHasNoOpenTasks(team, slotId)
    if (team.state === 'draft') {
      const next = await this.store.updateTeam(teamId, current => {
        const members = { ...current.members }
        delete members[slotId]
        return { ...current, members, revision: current.revision + 1, updatedAt: new Date().toISOString() }
      })
      await this.activity('team.member_removed', teamId, next.revision, `Member ${member.displayName} removed`)
      this.publish('team', teamId, next.revision, 'team.member_removed')
      return next
    }
    return this.requireRuntime().removeMember(teamId, slotId)
  }

  async startTeam(teamId: string, options: MutationOptions = {}): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertRevision('team', team.revision, options.expectedRevision)
    return this.requireRuntime().startTeam(teamId)
  }

  async resetTeam(
    teamId: string,
    confirmation: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    assertRevision('team', team.revision, options.expectedRevision)
    if (confirmation !== team.name) {
      throw new AgentTeamError('INVALID_REQUEST', 'Team name confirmation does not match')
    }
    return this.requireRuntime().resetTeam(teamId)
  }

  async sendUserMessage(
    teamId: string,
    content: string,
    targetSlotId?: string,
  ): Promise<TeamMessage> {
    return this.requireRuntime().sendUserMessage(teamId, content, targetSlotId)
  }

  getWorkbench(teamId: string): Promise<TeamWorkbenchView> {
    requireTeam(this.store, teamId)
    return this.requireRuntime().getWorkbench(teamId)
  }

  stopMember(teamId: string, slotId: string): Promise<void> {
    requireTeam(this.store, teamId)
    return this.requireRuntime().stopMember(teamId, slotId)
  }

  async setMemberPermissionPreset(
    teamId: string,
    slotId: string,
    rawPermissionPresetId: string,
    options: MutationOptions = {},
  ): Promise<TeamAggregate> {
    const permissionPresetId = rawPermissionPresetId.trim()
    const team = requireTeam(this.store, teamId)
    assertTeamMutable(team)
    assertRevision('team', team.revision, options.expectedRevision)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    if (!this.ctx.permissionPresets.names.includes(permissionPresetId)) {
      throw new AgentTeamError(
        'PERMISSION_PRESET_INVALID',
        `Unknown permission preset '${permissionPresetId}'`,
      )
    }
    if (member.permissionPresetId === permissionPresetId) return team
    if (team.state === 'draft') {
      const next = await this.store.updateTeam(teamId, current => ({
        ...current,
        members: Object.fromEntries(Object.entries(current.members).map(([id, currentMember]) => [
          id,
          id === slotId ? { ...currentMember, permissionPresetId } : currentMember,
        ])),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }))
      await this.activity(
        'team.member_permission_changed',
        teamId,
        next.revision,
        `Member ${member.displayName} permission changed to ${permissionPresetId}`,
      )
      this.publish('team', teamId, next.revision, 'team.member_permission_changed')
      return next
    }
    return this.requireRuntime().setMemberPermissionPreset(teamId, slotId, permissionPresetId)
  }

  publishConversation(teamId: string, revision: number, conversation?: MemberConversationView): void {
    this.publish('conversation', teamId, revision, 'member.conversation', conversation)
  }

  publishAssistantBuilderConversation(conversation: AssistantBuilderConversationView): void {
    const change: AgentTeamChange = {
      cursor: ++this.cursor,
      entityType: 'assistant-builder',
      entityId: conversation.sessionId,
      revision: Math.max(0, conversation.throughSeq + 1),
      kind: 'assistant.builder.conversation',
      assistantBuilderConversation: conversation,
    }
    for (const listener of this.listeners) listener(change)
  }

  async listWorkspace(teamId: string, rawPath = ''): Promise<WorkspaceEntryView[]> {
    const team = requireTeam(this.store, teamId)
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(team.workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok' || workspace.path !== team.workspacePath) {
      throw new AgentTeamError('WORKSPACE_UNAVAILABLE', `Workspace '${team.workspaceId}' is unavailable or changed`)
    }
    this.workspaceTracker.watch(team.id, team.workspacePath)
    if (isAbsolute(rawPath)) throw new AgentTeamError('INVALID_REQUEST', 'Workspace path must be relative')
    const root = await realpath(team.workspacePath)
    const requested = resolve(root, rawPath)
    if (requested !== root && !requested.startsWith(`${root}${sep}`)) {
      throw new AgentTeamError('INVALID_REQUEST', 'Workspace path escapes the team Workspace')
    }
    const target = await realpath(requested)
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new AgentTeamError('INVALID_REQUEST', 'Workspace path resolves outside the team Workspace')
    }
    const entries = await readdir(target, { withFileTypes: true })
    return entries
      .filter(entry => entry.name !== '.git' && entry.name !== 'node_modules')
      .map(entry => {
        const path = relative(root, resolve(target, entry.name)).split(sep).join('/')
        return {
          name: entry.name,
          path,
          kind: entry.isSymbolicLink() ? 'symlink' as const
            : entry.isDirectory() ? 'directory' as const
              : 'file' as const,
        }
      })
      .sort((left, right) => {
        if (left.kind === 'directory' && right.kind !== 'directory') return -1
        if (left.kind !== 'directory' && right.kind === 'directory') return 1
        return left.name.localeCompare(right.name)
      })
      .slice(0, 500)
  }

  async getWorkspaceChanges(teamId: string): Promise<WorkspaceGitStatusView> {
    const team = requireTeam(this.store, teamId)
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(team.workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok' || workspace.path !== team.workspacePath) {
      throw new AgentTeamError('WORKSPACE_UNAVAILABLE', `Workspace '${team.workspaceId}' is unavailable or changed`)
    }
    this.workspaceTracker.watch(team.id, team.workspacePath)
    try {
      return await readWorkspaceGitStatus(team.workspacePath)
    } catch (error) {
      throw new AgentTeamError(
        'WORKSPACE_GIT_UNAVAILABLE',
        'Unable to read Git changes for this Workspace',
        undefined,
        { cause: error },
      )
    }
  }

  async getWorkspaceDiff(
    teamId: string,
    path: string,
    scope: 'staged' | 'unstaged',
    layout: 'unified' | 'split',
    theme: 'light' | 'dark',
  ): Promise<WorkspaceGitDiffView> {
    const team = requireTeam(this.store, teamId)
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(team.workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok' || workspace.path !== team.workspacePath) {
      throw new AgentTeamError('WORKSPACE_UNAVAILABLE', `Workspace '${team.workspaceId}' is unavailable or changed`)
    }
    this.workspaceTracker.watch(team.id, team.workspacePath)
    try {
      const diff = await readWorkspaceGitDiff(team.workspacePath, path, scope)
      return {
        path: diff.path,
        scope: diff.scope,
        layout,
        theme,
        binary: diff.binary,
        html: diff.binary || !diff.patch.includes('@@')
          ? ''
          : await renderWorkspaceGitDiff(diff.patch, layout, theme),
      }
    } catch (error) {
      throw new AgentTeamError(
        'WORKSPACE_GIT_UNAVAILABLE',
        error instanceof Error ? error.message : 'Unable to read the Git diff for this Workspace',
        undefined,
        { cause: error },
      )
    }
  }

  async uploadWorkspaceFile(
    teamId: string,
    rawName: string,
    data: Uint8Array,
  ): Promise<WorkspaceUploadView> {
    const team = requireTeam(this.store, teamId)
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(team.workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok' || workspace.path !== team.workspacePath) {
      throw new AgentTeamError('WORKSPACE_UNAVAILABLE', `Workspace '${team.workspaceId}' is unavailable or changed`)
    }
    const root = await realpath(team.workspacePath)
    const uploadDirectory = resolve(root, '.agent-team', 'uploads')
    await mkdir(uploadDirectory, { recursive: true })
    const resolvedUploadDirectory = await realpath(uploadDirectory)
    if (!resolvedUploadDirectory.startsWith(`${root}${sep}`)) {
      throw new AgentTeamError('INVALID_REQUEST', 'Workspace upload directory resolves outside the team Workspace')
    }
    const name = safeUploadName(rawName)
    for (let index = 0; index < 1_000; index += 1) {
      const candidate = uploadCandidateName(name, index)
      const target = resolve(resolvedUploadDirectory, candidate)
      try {
        await writeFile(target, data, { flag: 'wx' })
        return {
          name: candidate,
          path: relative(root, target).split(sep).join('/'),
          bytes: data.byteLength,
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          const existing = await readFile(target)
          if (existing.equals(data)) {
            return {
              name: candidate,
              path: relative(root, target).split(sep).join('/'),
              bytes: existing.byteLength,
            }
          }
          continue
        }
        throw error
      }
    }
    throw new AgentTeamError('INVALID_REQUEST', `Unable to allocate a unique upload name for '${name}'`)
  }

  listMessages(teamId: string): Page<TeamMessage> {
    requireTeam(this.store, teamId)
    const items = this.store.listMessages(teamId)
    return { items, total: items.length }
  }

  async updateRuntimeTeam(
    teamId: string,
    update: (team: TeamAggregate) => TeamAggregate,
    kind: string,
    summary: string,
  ): Promise<TeamAggregate> {
    const next = await this.store.updateTeam(teamId, current => {
      const candidate = update(current)
      return {
        ...candidate,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }
    })
    await this.activity(kind, teamId, next.revision, summary)
    this.publish('team', teamId, next.revision, kind)
    return next
  }

  async putRuntimeMessage(message: TeamMessage): Promise<void> {
    await this.store.putMessage(message)
    const team = requireTeam(this.store, message.teamId)
    this.publish('team', team.id, team.revision, 'team.message')
  }

  async retireQueuedMessages(teamId: string): Promise<void> {
    requireTeam(this.store, teamId)
    const queued = this.store.listMessages(teamId).filter(message => message.deliveryState === 'queued')
    await Promise.all(queued.map(message => this.store.putMessage({ ...message, deliveryState: 'failed' })))
  }

  async dissolveTeam(
    teamId: string,
    confirmation: string,
    options: MutationOptions = {},
  ): Promise<void> {
    const team = requireTeam(this.store, teamId)
    assertRevision('team', team.revision, options.expectedRevision)
    if (confirmation !== team.name) {
      throw new AgentTeamError('INVALID_REQUEST', 'Team name confirmation does not match')
    }
    if (team.state !== 'draft') return this.requireRuntime().dissolveTeam(teamId)
    await this.deleteTeamRecords(teamId)
  }

  async deleteTeamRecords(teamId: string): Promise<void> {
    const team = requireTeam(this.store, teamId)
    await Promise.all(this.store.listMessages(teamId).map(message => this.store.deleteMessage(message.id)))
    await Promise.all(this.store.listActivities(teamId).map(activity => this.store.deleteActivity(activity.id)))
    await this.store.deleteTeam(teamId)
    await this.workspaceTracker.unwatch(teamId)
    this.publish('team', teamId, team.revision + 1, 'team.deleted')
  }

  getOperation(id: string): Operation {
    const operation = this.store.getOperation(id)
    if (operation === undefined) {
      throw new AgentTeamError('INVALID_REQUEST', `Unknown operation '${id}'`)
    }
    return operation
  }

  private async validateAssistantReferences(input: CreateAssistantInput): Promise<void> {
    const invalidSkill = input.skillAllowlist.find(name => !isSkillName(name))
    if (invalidSkill !== undefined) {
      throw new AgentTeamError('SKILL_REFERENCE_INVALID', `Invalid Skill name '${invalidSkill}'`)
    }
    const invalidMcpServer = input.mcpServers.find(name => !isMcpServerName(name))
    if (invalidMcpServer !== undefined) {
      throw new AgentTeamError('MCP_REFERENCE_INVALID', `Invalid MCP Server name '${invalidMcpServer}'`)
    }
    try {
      await this.ctx.llm.resolveModelInfo(input.provider, input.model)
    } catch (error) {
      throw new AgentTeamError(
        'MODEL_REFERENCE_INVALID',
        `Cannot resolve model '${input.provider}/${input.model}'`,
        undefined,
        { cause: error },
      )
    }
    try {
      await this.ctx.agentPresets.resolve(input.agentPresetId)
    } catch (error) {
      throw new AgentTeamError(
        'PRESET_REFERENCE_INVALID',
        `Unknown agent preset '${input.agentPresetId}'`,
        undefined,
        { cause: error },
      )
    }
    if (!this.ctx.permissionPresets.names.includes(input.permissionPresetId)) {
      throw new AgentTeamError(
        'PERMISSION_PRESET_INVALID',
        `Unknown permission preset '${input.permissionPresetId}'`,
      )
    }
    if (input.mcpServers.length > 0) {
      const catalog = await this.mcpCatalog(input.agentPresetId)
      const available = new Set(catalog.servers.map(server => server.name))
      const missing = input.mcpServers.filter(name => !available.has(name))
      if (missing.length > 0) {
        throw new AgentTeamError(
          'MCP_REFERENCE_INVALID',
          `Agent Preset '${input.agentPresetId}' cannot access MCP Server(s): ${missing.join(', ')}`,
          { missing },
        )
      }
    }
  }

  private async activity(kind: string, entityId: string, revision: number, summary: string): Promise<void> {
    const activity: TeamActivity = {
      schemaVersion: 1,
      id: randomUUID(),
      teamId: kind.startsWith('team.') ? entityId : 'assistant-library',
      kind,
      entityId,
      summary,
      revision,
      createdAt: new Date().toISOString(),
    }
    try {
      await this.store.putActivity(activity)
    } catch (error) {
      this.ctx.logger.warn('agent-team: activity write failed after primary mutation', error)
    }
  }

  private publish(
    entityType: AgentTeamChange['entityType'],
    entityId: string,
    revision: number,
    kind: string,
    conversation?: MemberConversationView,
  ): void {
    const change: AgentTeamChange = {
      cursor: ++this.cursor,
      entityType,
      entityId,
      revision,
      kind,
      ...(conversation === undefined ? {} : { conversation }),
    }
    for (const listener of this.listeners) listener(change)
  }

  private requireRuntime(): TeamRuntime {
    if (this.runtime === undefined) throw new Error('Agent Team runtime is not attached')
    return this.runtime
  }


  private requireAssistantBuilderRuntime(): AssistantBuilderRuntime {
    if (this.assistantBuilderRuntime === undefined) throw new Error('Assistant Builder runtime is not attached')
    return this.assistantBuilderRuntime
  }
}

function requireAssistant(store: AgentTeamStore, id: string): AssistantTemplate {
  const assistant = store.getAssistant(id)
  if (assistant === undefined) {
    throw new AgentTeamError('ASSISTANT_NOT_FOUND', `Unknown assistant '${id}'`)
  }
  return assistant
}

function requireTeam(store: AgentTeamStore, id: string): TeamAggregate {
  const team = store.getTeam(id)
  if (team === undefined) throw new AgentTeamError('TEAM_NOT_FOUND', `Unknown team '${id}'`)
  return team
}

function assertRevision(entity: string, actual: number, expected?: number): void {
  if (expected !== undefined && expected !== actual) {
    throw new AgentTeamError(
      entity === 'assistant' ? 'ASSISTANT_REVISION_CONFLICT' : 'TEAM_REVISION_CONFLICT',
      `${entity} revision conflict: expected ${expected}, current ${actual}`,
      { expected, actual },
    )
  }
}

function assertTeamMutable(team: TeamAggregate): void {
  if (team.state === 'deleting' || team.state === 'delete_blocked') {
    throw new AgentTeamError('TEAM_DELETING', `Team '${team.id}' is deleting`)
  }
}

function assistantInputOf(assistant: AssistantTemplate): CreateAssistantInput {
  return {
    name: assistant.name,
    ...(assistant.description === undefined ? {} : { description: assistant.description }),
    ...(assistant.icon === undefined ? {} : { icon: assistant.icon }),
    instructions: assistant.instructions,
    provider: assistant.provider,
    model: assistant.model,
    agentPresetId: assistant.agentPresetId,
    permissionPresetId: assistant.permissionPresetId,
    skillAllowlist: [...assistant.skillAllowlist],
    mcpServers: [...assistant.mcpServers],
  }
}

function normalizeAssistantInput(input: CreateAssistantInput): CreateAssistantInput {
  return {
    ...input,
    name: input.name.trim(),
    provider: input.provider.trim(),
    model: input.model.trim(),
    agentPresetId: input.agentPresetId.trim(),
    permissionPresetId: input.permissionPresetId.trim(),
    skillAllowlist: unique(input.skillAllowlist),
    mcpServers: unique(input.mcpServers),
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function safeUploadName(rawName: string): string {
  const name = basename(rawName)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .trim()
  if (name.length === 0 || name === '.' || name === '..') {
    throw new AgentTeamError('INVALID_REQUEST', 'Uploaded file name is invalid')
  }
  const extension = extname(name).slice(0, 40)
  const stem = name.slice(0, name.length - extension.length).slice(0, 180) || 'file'
  return `${stem}${extension}`
}

function uploadCandidateName(name: string, index: number): string {
  if (index === 0) return name
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  return `${stem} (${index})${extension}`
}

function createMemberSlot(
  assistant: AssistantTemplate,
  displayName: string,
  role: 'leader' | 'member',
  now: string,
  desiredState: 'online' | 'offline',
): TeamMemberSlot {
  const slotId = randomUUID()
  return {
    id: slotId,
    assistantId: assistant.id,
    displayName,
    role,
    assistantSnapshot: snapshotAssistant(assistant),
    permissionPresetId: assistant.permissionPresetId,
    sessionId: `agent-team:${randomUUID()}`,
    desiredState,
    lastRuntimeState: desiredState === 'online' ? 'starting' : 'offline',
    joinedAt: now,
  }
}

function assertMemberHasNoOpenTasks(team: TeamAggregate, slotId: string): void {
  const open = Object.values(team.tasks).filter(task =>
    task.ownerSlotId === slotId && !['completed', 'failed', 'cancelled'].includes(task.status))
  if (open.length > 0) {
    throw new AgentTeamError(
      'MEMBER_BUSY',
      'Reassign, complete, fail, or cancel this member’s open tasks before removal',
      { taskIds: open.map(task => task.id) },
    )
  }
}

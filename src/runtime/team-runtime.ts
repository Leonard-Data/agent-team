import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  assembleContextFor,
  type Agent,
  type AgentHandle,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage, freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { isModelInvocable } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Config } from '../config.js'
import { AgentTeamError } from '../domain/errors.js'
import type {
  TeamAggregate,
  TeamMemberSlot,
  TeamMessage,
} from '../domain/types.js'
import type { AgentTeamService } from '../service/agent-team-service.js'
import type { MemberConversationView, TeamWorkbenchView } from '../transport/contracts.js'
import { projectConversation } from './conversation-projector.js'

interface OwnedAgent {
  teamId: string
  slotId: string
  handle: AgentHandle
}

export class TeamRuntime {
  private readonly owned = new Map<string, OwnedAgent>()
  private readonly activating = new Map<string, { teamId: string; slotId: string }>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly disposeStatusListener: () => void
  private readonly disposeConversationListener: () => void
  private readonly conversationPublishes = new Map<string, ReturnType<typeof setTimeout>>()
  private closing = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly service: AgentTeamService,
  ) {
    this.disposeStatusListener = ctx.on('agent/status', ({ agent, status }) => {
      const owned = this.owned.get(String(agent.id))
      if (owned === undefined) return
      void this.setMemberRuntimeState(owned.teamId, owned.slotId, status)
        .catch(error => this.ctx.logger.warn('agent-team: failed to persist agent status', error))
    })
    this.disposeConversationListener = ctx.on('session/event', (session) => {
      const owned = this.owned.get(String(session.id))
      if (owned === undefined || this.conversationPublishes.has(String(session.id))) return
      const timer = setTimeout(() => {
        this.conversationPublishes.delete(String(session.id))
        try {
          const team = this.service.getTeam(owned.teamId)
          const member = team.members[owned.slotId]
          const current = this.owned.get(String(session.id))
          if (member === undefined || current === undefined) return
          this.service.publishConversation(
            team.id,
            team.revision,
            this.projectMemberConversation(team, member, current.handle.agent.session.events),
          )
        } catch (error) {
          this.ctx.logger.warn('agent-team: failed to publish conversation update', error)
        }
      }, 48)
      this.conversationPublishes.set(String(session.id), timer)
    })
  }

  async getWorkbench(teamId: string): Promise<TeamWorkbenchView> {
    const team = this.service.getTeam(teamId)
    const conversations = await Promise.all(Object.values(team.members).map(async member => {
      const owned = this.owned.get(member.sessionId)
      let events = owned?.handle.agent.session.events
      if (events === undefined) {
        try {
          events = (await this.ctx.sessionPersistence.inspect(SessionId(member.sessionId))).events
        } catch {
          events = []
        }
      }
      return this.projectMemberConversation(team, member, events)
    }))
    return {
      schemaVersion: 1,
      teamId: team.id,
      revision: team.revision,
      conversations,
    }
  }

  async stopMember(teamId: string, slotId: string): Promise<void> {
    const team = this.service.getTeam(teamId)
    if (team.state !== 'active') throw new AgentTeamError('TEAM_NOT_ACTIVE', `Team '${team.name}' is not active`)
    const member = team.members[slotId]
    if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    const owned = this.requireOwned(member.sessionId)
    owned.handle.agent.cancel({ kind: 'user' })
    await owned.handle.agent.whenIdle()
    await this.setMemberRuntimeState(teamId, slotId, 'idle')
    const current = this.service.getTeam(teamId)
    const currentMember = current.members[slotId]
    if (currentMember !== undefined) {
      this.service.publishConversation(
        teamId,
        current.revision,
        this.projectMemberConversation(current, currentMember, owned.handle.agent.session.events),
      )
    }
  }

  setMemberPermissionPreset(
    teamId: string,
    slotId: string,
    permissionPresetId: string,
  ): Promise<TeamAggregate> {
    return this.exclusive(teamId, async () => {
      const team = this.service.getTeam(teamId)
      if (team.state !== 'active' && team.state !== 'error') {
        throw new AgentTeamError(
          'TEAM_NOT_ACTIVE',
          `Cannot change member permission while team is '${team.state}'`,
        )
      }
      const member = team.members[slotId]
      if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
      const owned = this.requireOwned(member.sessionId)
      const previous = member.permissionPresetId ?? member.assistantSnapshot.permissionPresetId
      this.ctx.permissionPresets.set(owned.handle.agent.session, permissionPresetId)
      try {
        return await this.service.updateRuntimeTeam(
          teamId,
          current => ({
            ...current,
            members: mapMembers(current, currentMember => currentMember.id === slotId
              ? { ...currentMember, permissionPresetId }
              : currentMember),
          }),
          'team.member_permission_changed',
          `Member ${member.displayName} permission changed to ${permissionPresetId}`,
        )
      } catch (error) {
        this.ctx.permissionPresets.set(owned.handle.agent.session, previous)
        throw error
      }
    })
  }

  private projectMemberConversation(
    team: TeamAggregate,
    member: TeamMemberSlot,
    events: readonly SessionEvent[],
  ): MemberConversationView {
    const owned = this.owned.get(member.sessionId)
    const status: MemberConversationView['status'] = owned?.handle.agent.status ?? member.lastRuntimeState
    return {
      slotId: member.id,
      sessionId: member.sessionId,
      status,
      ...projectConversation(events),
    }
  }

  startTeam(teamId: string): Promise<TeamAggregate> {
    return this.exclusive(teamId, () => this.startTeamUnlocked(teamId))
  }

  activateMember(teamId: string, slotId: string): Promise<TeamAggregate> {
    return this.exclusive(teamId, async () => {
      const team = this.service.getTeam(teamId)
      const member = team.members[slotId]
      if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
      const materialized = new Set((await this.ctx.sessionPersistence.list()).map(header => String(header.id)))
      try {
        await this.ensureMemberOnline(team, member, materialized.has(member.sessionId))
        return this.service.getTeam(teamId)
      } catch (error) {
        await this.markTeamError(teamId, error)
        throw error
      }
    })
  }

  removeMember(teamId: string, slotId: string): Promise<TeamAggregate> {
    return this.exclusive(teamId, async () => {
      const team = this.service.getTeam(teamId)
      if (team.state !== 'active' && team.state !== 'error') {
        throw new AgentTeamError('TEAM_NOT_ACTIVE', `Cannot remove a runtime member while team is '${team.state}'`)
      }
      const member = team.members[slotId]
      if (member === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
      if (slotId === team.leaderSlotId) {
        throw new AgentTeamError('MEMBER_IS_LEADER', 'Choose a successor before removing the current leader')
      }
      const openTasks = Object.values(team.tasks).filter(task =>
        task.ownerSlotId === slotId && !['completed', 'failed', 'cancelled'].includes(task.status))
      if (openTasks.length > 0) {
        throw new AgentTeamError('MEMBER_BUSY', 'Resolve this member’s open tasks before removal', {
          taskIds: openTasks.map(task => task.id),
        })
      }

      const owned = this.owned.get(member.sessionId)
      const sessionId = SessionId(member.sessionId)
      if (owned === undefined && this.ctx.agents.get(sessionId) !== undefined) {
        throw new AgentTeamError(
          'AGENT_HANDLE_OWNERSHIP_CONFLICT',
          `Session '${member.sessionId}' is live without this plugin's AgentHandle`,
        )
      }
      if (owned !== undefined) {
        owned.handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
        await owned.handle.agent.whenIdle()
        await this.ctx.sessions.flush(owned.handle.agent.session)
        this.owned.delete(member.sessionId)
        await owned.handle.dispose()
      }
      const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(team.workspaceId))
      if (workspace !== undefined) await workspace.detachSession(sessionId)
      const removedAt = new Date().toISOString()
      return this.service.updateRuntimeTeam(
        teamId,
        current => {
          const members = { ...current.members }
          delete members[slotId]
          return {
            ...current,
            members,
            retiredSessions: {
              ...current.retiredSessions,
              [member.sessionId]: {
                formerSlotId: member.id,
                sessionId: member.sessionId,
                displayName: member.displayName,
                removedAt,
              },
            },
          }
        },
        'team.member_removed',
        `Member ${member.displayName} removed; Session history retained`,
      )
    })
  }

  resetTeam(teamId: string): Promise<TeamAggregate> {
    return this.exclusive(teamId, async () => {
      const team = this.service.getTeam(teamId)
      if (!['draft', 'active', 'error'].includes(team.state)) {
        throw new AgentTeamError('TEAM_NOT_ACTIVE', `Cannot reset team in state '${team.state}'`)
      }

      const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(team.workspaceId))
      if (workspace === undefined || await workspace.status() !== 'ok' || workspace.path !== team.workspacePath) {
        throw new AgentTeamError('WORKSPACE_UNAVAILABLE', `Workspace '${team.workspaceId}' is unavailable or changed`)
      }

      const members = Object.values(team.members)
      for (const member of members) {
        const sessionId = SessionId(member.sessionId)
        if (this.owned.get(member.sessionId) === undefined && this.ctx.agents.get(sessionId) !== undefined) {
          throw new AgentTeamError(
            'AGENT_HANDLE_OWNERSHIP_CONFLICT',
            `Session '${member.sessionId}' is live without this plugin's AgentHandle`,
          )
        }
      }

      const owned = members
        .map(member => ({ member, owned: this.owned.get(member.sessionId) }))
        .filter((entry): entry is { member: TeamMemberSlot; owned: OwnedAgent } => entry.owned !== undefined)
      for (const entry of owned) {
        entry.owned.handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
      }
      await Promise.all(owned.map(entry => entry.owned.handle.agent.whenIdle()))

      for (const entry of owned) {
        try {
          await this.ctx.sessions.flush(entry.owned.handle.agent.session)
        } catch (error) {
          this.ctx.logger.warn(`agent-team: old session flush failed during reset for ${entry.member.sessionId}`, error)
        }
        this.owned.delete(entry.member.sessionId)
        await entry.owned.handle.dispose()
      }
      for (const member of members) {
        try {
          await workspace.detachSession(SessionId(member.sessionId))
        } catch (error) {
          this.ctx.logger.warn(`agent-team: old workspace session detach failed during reset for ${member.sessionId}`, error)
        }
      }

      await this.service.retireQueuedMessages(teamId)
      const resetAt = new Date().toISOString()
      const shouldRestart = team.state !== 'draft'
      const next = await this.service.updateRuntimeTeam(
        teamId,
        current => ({
          ...current,
          state: shouldRestart ? 'starting' : 'draft',
          tasks: {},
          leases: {},
          outbox: {},
          retiredSessions: current.state === 'draft'
            ? current.retiredSessions
            : {
              ...current.retiredSessions,
              ...Object.fromEntries(Object.values(current.members).map(member => [
                member.sessionId,
                {
                  formerSlotId: member.id,
                  sessionId: member.sessionId,
                  displayName: member.displayName,
                  removedAt: resetAt,
                },
              ])),
            },
          members: mapMembers(current, member => ({
            ...member,
            sessionId: `agent-team:${randomUUID()}`,
            desiredState: current.state === 'draft' ? 'offline' : 'online',
            lastRuntimeState: shouldRestart ? 'starting' : 'offline',
          })),
        }),
        'team.context_reset',
        `Team ${team.name} task board and member contexts reset`,
      )

      if (!shouldRestart) return next
      try {
        await this.ensureMembersOnline(next)
        return await this.service.updateRuntimeTeam(
          teamId,
          current => ({ ...current, state: 'active' }),
          'team.context_reset_completed',
          `Team ${team.name} restarted with fresh member contexts`,
        )
      } catch (error) {
        await this.markTeamError(teamId, error)
        throw error
      }
    })
  }

  dissolveTeam(teamId: string): Promise<void> {
    return this.exclusive(teamId, async () => {
      let team = this.service.getTeam(teamId)
      const members = Object.values(team.members)
      for (const member of members) {
        const sessionId = SessionId(member.sessionId)
        if (this.owned.get(member.sessionId) === undefined && this.ctx.agents.get(sessionId) !== undefined) {
          throw new AgentTeamError(
            'AGENT_HANDLE_OWNERSHIP_CONFLICT',
            `Session '${member.sessionId}' is live without this plugin's AgentHandle`,
          )
        }
      }

      if (team.state !== 'deleting') {
        team = await this.service.updateRuntimeTeam(
          teamId,
          current => ({ ...current, state: 'deleting' }),
          'team.deleting',
          `Team ${team.name} dissolution started`,
        )
      }

      try {
        const owned = members
          .map(member => ({ member, owned: this.owned.get(member.sessionId) }))
          .filter((entry): entry is { member: TeamMemberSlot; owned: OwnedAgent } => entry.owned !== undefined)
        for (const entry of owned) {
          entry.owned.handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
        }
        await Promise.all(owned.map(entry => entry.owned.handle.agent.whenIdle()))

        for (const entry of owned) {
          try {
            await this.ctx.sessions.flush(entry.owned.handle.agent.session)
          } catch (error) {
            this.ctx.logger.warn(`agent-team: final session flush failed during dissolution for ${entry.member.sessionId}`, error)
          }
          await entry.owned.handle.dispose()
          this.owned.delete(entry.member.sessionId)
        }

        const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(team.workspaceId))
        if (workspace !== undefined) {
          const sessionIds = new Set([
            ...members.map(member => member.sessionId),
            ...Object.keys(team.retiredSessions),
          ])
          for (const sessionId of sessionIds) {
            await workspace.detachSession(SessionId(sessionId))
          }
        }

        await this.service.deleteTeamRecords(teamId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        try {
          await this.service.updateRuntimeTeam(
            teamId,
            current => ({ ...current, state: 'delete_blocked' }),
            'team.delete_blocked',
            message,
          )
        } catch (updateError) {
          this.ctx.logger.warn(`agent-team: failed to persist blocked dissolution for ${teamId}`, updateError)
        }
        throw error instanceof AgentTeamError
          ? error
          : new AgentTeamError(
            'TEAM_DELETE_FAILED',
            `团队“${team.name}”解散失败：${message}`,
            { teamId, cause: message },
            { cause: error },
          )
      }
    })
  }

  async sendUserMessage(
    teamId: string,
    rawContent: string,
    targetSlotId?: string,
  ): Promise<TeamMessage> {
    const team = this.service.getTeam(teamId)
    if (team.state !== 'active') {
      throw new AgentTeamError('TEAM_NOT_ACTIVE', `Team '${team.name}' is not active`)
    }
    const slotId = targetSlotId ?? team.leaderSlotId
    const target = team.members[slotId]
    if (target === undefined) throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown member '${slotId}'`)
    if (slotId !== team.leaderSlotId && !team.directMemberChat) {
      throw new AgentTeamError('INVALID_REQUEST', 'Direct member chat is disabled for this team')
    }
    const content = requireContent(rawContent)
    const owned = this.requireOwned(target.sessionId)
    const message = createUserMessage({
      content: [{ type: 'text', text: content }],
      source: { kind: 'user' },
    })
    const record = teamMessage({
      id: String(message.id),
      teamId,
      sender: { kind: 'user', id: 'local-user' },
      recipient: slotId === team.leaderSlotId
        ? { kind: 'leader', slotId }
        : { kind: 'member', slotId },
      type: 'instruction',
      content,
      idempotencyKey: String(message.id),
    })
    await this.service.putRuntimeMessage(record)
    try {
      owned.handle.agent.followup(message)
      const delivered = { ...record, deliveryState: 'delivered' as const }
      await this.service.putRuntimeMessage(delivered)
      return delivered
    } catch (error) {
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
      throw error
    }
  }

  async recoverTeams(): Promise<void> {
    const recoverable = this.service.listTeams().items.filter(team =>
      team.state === 'active'
      || team.state === 'starting'
      || team.state === 'error')
    await mapConcurrent(recoverable, this.config.runtimeConcurrency, async team => {
      try {
        await this.exclusive(team.id, async () => {
          await this.ensureMembersOnline(team)
          await this.recoverPendingMessages(this.service.getTeam(team.id))
          await this.service.updateRuntimeTeam(
            team.id,
            current => ({ ...current, state: 'active' }),
            'team.recovered',
            `Team ${team.name} recovered after plugin startup`,
          )
        })
      } catch (error) {
        this.ctx.logger.warn(`agent-team: failed to recover team ${team.id}`, error)
        await this.markTeamError(team.id, error)
      }
    })
  }

  async dispose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.disposeStatusListener()
    this.disposeConversationListener()
    for (const timer of this.conversationPublishes.values()) clearTimeout(timer)
    this.conversationPublishes.clear()
    await Promise.allSettled([...this.operations.values()])
    const owned = [...this.owned.values()]
    for (const entry of owned) entry.handle.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
    await Promise.allSettled(owned.map(entry => entry.handle.agent.whenIdle()))
    for (const entry of owned) {
      try {
        await this.ctx.sessions.flush(entry.handle.agent.session)
      } catch (error) {
        this.ctx.logger.warn(`agent-team: session flush failed for ${entry.handle.agent.id}`, error)
      }
    }
    await Promise.allSettled(owned.map(entry => entry.handle.dispose()))
    this.owned.clear()
  }

  private async startTeamUnlocked(teamId: string): Promise<TeamAggregate> {
    const team = this.service.getTeam(teamId)
    if (team.state !== 'draft' && team.state !== 'error') {
      throw new AgentTeamError('TEAM_NOT_ACTIVE', `Cannot start team in state '${team.state}'`)
    }
    await this.service.updateRuntimeTeam(
      teamId,
      current => ({
        ...current,
        state: 'starting',
        members: mapMembers(current, member => ({
          ...member,
          desiredState: 'online',
          lastRuntimeState: this.owned.has(member.sessionId) ? member.lastRuntimeState : 'starting',
        })),
      }),
      'team.starting',
      `Team ${team.name} is starting`,
    )
    try {
      await this.ensureMembersOnline(this.service.getTeam(teamId))
      await this.recoverPendingMessages(this.service.getTeam(teamId))
      return await this.service.updateRuntimeTeam(
        teamId,
        current => ({ ...current, state: 'active' }),
        'team.started',
        `Team ${team.name} started`,
      )
    } catch (error) {
      await this.markTeamError(teamId, error)
      throw error
    }
  }

  private async ensureMembersOnline(team: TeamAggregate): Promise<void> {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(team.workspaceId))
    if (workspace === undefined || await workspace.status() !== 'ok' || workspace.path !== team.workspacePath) {
      throw new AgentTeamError('WORKSPACE_UNAVAILABLE', `Workspace '${team.workspaceId}' is unavailable or changed`)
    }
    const materialized = new Set((await this.ctx.sessionPersistence.list()).map(header => String(header.id)))
    await mapConcurrent(Object.values(team.members), this.config.runtimeConcurrency, async member => {
      if (member.desiredState === 'removing') return
      await this.ensureMemberOnline(team, member, materialized.has(member.sessionId))
    })
  }

  private async ensureMemberOnline(
    team: TeamAggregate,
    member: TeamMemberSlot,
    persisted: boolean,
  ): Promise<void> {
    const prior = this.owned.get(member.sessionId)
    if (prior !== undefined) return
    const sessionId = SessionId(member.sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) {
      await this.service.updateRuntimeTeam(
        team.id,
        current => ({ ...current, state: 'ownership_conflict' }),
        'team.ownership_conflict',
        `Session ${member.sessionId} is live but not owned by Agent Team`,
      )
      throw new AgentTeamError(
        'AGENT_HANDLE_OWNERSHIP_CONFLICT',
        `Session '${member.sessionId}' is live without this plugin's AgentHandle`,
      )
    }

    try {
      this.activating.set(member.sessionId, { teamId: team.id, slotId: member.id })
      const setup = async (agentCtx: Context): Promise<void> => {
        await this.ctx.agentPresets.mount(agentCtx, member.assistantSnapshot.agentPresetId)
        const identitySection = `agent-team:identity:${member.id}`
        const rosterSection = `agent-team:roster:${team.id}`
        agentCtx.systemPrompt.section({
          name: identitySection,
          order: 10,
          text: () => {
            const latest = this.service.getTeam(team.id)
            const latestMember = latest.members[member.id]
            return latestMember === undefined
              ? 'This Agent Team membership is no longer active.'
              : memberPrompt(latest, latestMember)
          },
        })
        agentCtx.systemPrompt.section({
          name: rosterSection,
          order: 11,
          text: () => rosterPrompt(this.service.getTeam(team.id)),
        })
        this.registerTeamTools(agentCtx, team, member)
        const agent = agentCtx.agent
        if (agent === undefined) throw new Error('Harness did not bind the unpublished agent context')
        const selectedSkills = new Set(member.assistantSnapshot.skillAllowlist)
        const skills = await this.ctx.skills.list({
          cwd: team.workspacePath,
          scope: agent,
        })
        const available = new Set(skills.filter(isModelInvocable).map(skill => skill.name))
        const missing = [...selectedSkills].filter(name => !available.has(name))
        if (missing.length > 0) {
          throw new AgentTeamError(
            'SKILL_REFERENCE_INVALID',
            `Member '${member.displayName}' cannot access selected Skill(s): ${missing.join(', ')}`,
            { memberId: member.id, missing },
          )
        }
        if (selectedSkills.size > 0 && agentCtx.tools.get('skill', agent) === undefined) {
          throw new AgentTeamError(
            'SKILL_REFERENCE_INVALID',
            `Member '${member.displayName}' selected Skills, but its Agent Preset does not expose the skill loader`,
            { memberId: member.id },
          )
        }
        const presetScope = await this.ctx.agentPresets.standingKeyFor(
          member.assistantSnapshot.agentPresetId,
        )
        const skillSelectionProvider = `agent-team-selection-${member.id}`
        agentCtx.skills.registerProvider(() => ({
          name: skillSelectionProvider,
          list: async options => {
            const inherited = await this.ctx.skills.list({
              cwd: options.cwd,
              signal: options.signal,
              scope: presetScope,
            })
            return inherited.filter(skill => !selectedSkills.has(skill.name)).map(skill => ({
              name: skill.name,
              description: skill.description,
              invocation: { modelInvocable: false, userInvocable: false },
              source: 'runtime',
              provider: skillSelectionProvider,
              rank: 0,
              locator: skill.name,
            }))
          },
          get: async candidate => ({
            name: candidate.name,
            description: candidate.description,
            invocation: { modelInvocable: false, userInvocable: false },
            source: 'runtime',
            provider: skillSelectionProvider,
            content: '',
          }),
        }))
        agentCtx.tools.guard(execution => {
          if (execution.name !== 'skill') return undefined
          const name = skillNameFromArguments(execution.arguments)
          return name !== undefined && selectedSkills.has(name)
            ? undefined
            : 'This Skill is not selected for the assistant.'
        })
        this.ctx.permissionPresets.set(
          agent.session,
          member.permissionPresetId ?? member.assistantSnapshot.permissionPresetId,
        )
        const assembly = await agentCtx.systemPrompt.assemble(assembleContextFor(agent))
        const names = new Set(assembly.sections.map(section => section.name))
        if (!names.has(identitySection) || !names.has(rosterSection)) {
          throw new AgentTeamError(
            'PRESET_PROMPT_INCOMPATIBLE',
            `Preset '${member.assistantSnapshot.agentPresetId}' replaced Agent Team prompt sections`,
          )
        }
      }
      const agentOptions = {
        provider: member.assistantSnapshot.provider,
        model: member.assistantSnapshot.model,
      }
      const handle = persisted
        ? await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
        : await this.ctx.agents.create({
          sessionId,
          meta: { cwd: team.workspacePath, agentPreset: member.assistantSnapshot.agentPresetId },
          agentOptions,
          setup,
        })
      const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(team.workspaceId))
      if (workspace === undefined) {
        await handle.dispose()
        throw new AgentTeamError('WORKSPACE_UNAVAILABLE', 'Workspace disappeared during start')
      }
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        await handle.dispose()
        throw error
      }
      this.owned.set(member.sessionId, { teamId: team.id, slotId: member.id, handle })
      this.activating.delete(member.sessionId)
      await this.setMemberRuntimeState(team.id, member.id, handle.agent.status)
    } catch (error) {
      this.activating.delete(member.sessionId)
      const causeMessage = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(
        `agent-team: member '${member.displayName}' activation failed: ${causeMessage}`,
        error,
      )
      throw error instanceof AgentTeamError
        ? error
        : new AgentTeamError(
          'SESSION_CREATE_FAILED',
          `成员“${member.displayName}”启动失败：${causeMessage}`,
          { memberId: member.id, cause: causeMessage },
          { cause: error },
        )
    }
  }

  private registerTeamTools(agentCtx: Context, team: TeamAggregate, member: TeamMemberSlot): void {
    agentCtx.tools.register(defineTool({
      name: 'team_get_task_board',
      description: 'Read the current shared task board for this Agent Team.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (_args, exec) => {
        this.assertToolIdentity(exec.agent, team.id, member.id)
        const latest = this.service.getTeam(team.id)
        const tasks = JSON.parse(JSON.stringify(Object.values(latest.tasks))) as Array<Record<string, string | number | string[]>>
        return { teamId: latest.id, revision: latest.revision, tasks }
      },
    }))
    agentCtx.tools.register(defineTool({
      name: 'team_create_task',
      description: 'Create and optionally assign a task on the shared team task board. Only the current leader may call this.',
      parameters: {
        title: { type: 'string', required: true },
        description: { type: 'string' },
        ownerSlotId: { type: 'string', description: 'Current member slot id to assign.' },
        fileScopes: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative file scopes.' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', required: true },
            status: { type: 'string', required: true },
            deliveryState: { type: 'string', enum: ['queued', 'delivered'] },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: `Created team task ${value.taskId} (${value.status})${value.deliveryState === undefined ? '' : `; assignment ${value.deliveryState}`}`,
        }],
      },
      execute: async (args, exec) => {
        this.assertToolIdentity(exec.agent, team.id, member.id)
        return this.createTask(team.id, member.id, args)
      },
    }))
    agentCtx.tools.register(defineTool({
      name: 'team_update_task',
      description: 'Update a task you own; the team leader may update any task.',
      parameters: {
        taskId: { type: 'string', required: true },
        status: {
          type: 'string',
          required: true,
          enum: ['pending', 'assigned', 'running', 'blocked', 'completed', 'failed', 'cancelled'],
        },
        result: { type: 'string' },
        error: { type: 'string' },
        ownerSlotId: { type: 'string', description: 'Leader-only reassignment target.' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', required: true },
            status: { type: 'string', required: true },
            deliveryState: { type: 'string', enum: ['queued', 'delivered'] },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: 'text',
          text: `Updated team task ${value.taskId} (${value.status})${value.deliveryState === undefined ? '' : `; notification ${value.deliveryState}`}`,
        }],
      },
      execute: async (args, exec) => {
        this.assertToolIdentity(exec.agent, team.id, member.id)
        return this.updateTask(team.id, member.id, args)
      },
    }))
    agentCtx.tools.register(defineTool({
      name: 'team_send_message',
      description: 'Send a message to another member in this Agent Team and wake that member.',
      parameters: {
        recipientSlotId: { type: 'string', required: true, description: 'Recipient member slot id.' },
        content: { type: 'string', required: true, description: 'Message content.' },
        type: {
          type: 'string',
          enum: ['instruction', 'progress', 'result', 'question', 'warning'],
          description: 'Message purpose.',
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            messageId: { type: 'string', required: true },
            deliveryState: { type: 'string', const: 'delivered', required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: `Delivered team message ${value.messageId}` }],
      },
      execute: async (args, exec) => {
        this.assertToolIdentity(exec.agent, team.id, member.id)
        return this.sendMemberMessage(team.id, member.id, args.recipientSlotId, args.content, args.type)
      },
    }))
  }

  private async createTask(
    teamId: string,
    creatorSlotId: string,
    input: { title: string; description?: string; ownerSlotId?: string; fileScopes?: string[] },
  ): Promise<{ taskId: string; status: string; deliveryState?: 'queued' | 'delivered' }> {
    const team = this.service.getTeam(teamId)
    if (team.leaderSlotId !== creatorSlotId) {
      throw new AgentTeamError('INVALID_REQUEST', 'Only the current team leader may create tasks')
    }
    if (input.ownerSlotId !== undefined && team.members[input.ownerSlotId] === undefined) {
      throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown task owner '${input.ownerSlotId}'`)
    }
    const title = requireShortText(input.title, 'Task title', 500)
    const now = new Date().toISOString()
    const taskId = randomUUID()
    const status = input.ownerSlotId === undefined ? 'pending' as const : 'assigned' as const
    const owner = input.ownerSlotId === undefined ? undefined : team.members[input.ownerSlotId]
    const assignment = owner === undefined || owner.id === creatorSlotId
      ? undefined
      : taskDispatchMessage({
        team,
        senderSlotId: creatorSlotId,
        recipientSlotId: owner.id,
        taskId,
        type: 'instruction',
        content: assignmentContent(title, input.description?.trim() ?? '', uniqueStrings(input.fileScopes ?? [])),
      })
    await this.service.updateRuntimeTeam(
      teamId,
      current => ({
        ...current,
        tasks: {
          ...current.tasks,
          [taskId]: {
            id: taskId,
            title,
            description: input.description?.trim() ?? '',
            status,
            ...(input.ownerSlotId === undefined ? {} : { ownerSlotId: input.ownerSlotId }),
            createdBySlotId: creatorSlotId,
            dependencyIds: [],
            fileScopes: uniqueStrings(input.fileScopes ?? []),
            revision: 1,
            createdAt: now,
            updatedAt: now,
          },
        },
        outbox: assignment === undefined
          ? current.outbox
          : { ...current.outbox, [assignment.id]: assignment },
      }),
      'team.task_created',
      `Task ${title} created`,
    )
    if (assignment === undefined) return { taskId, status }
    const delivered = await this.tryDeliverOutboxMessage(teamId, assignment.id)
    return { taskId, status, deliveryState: delivered ? 'delivered' : 'queued' }
  }

  private async updateTask(
    teamId: string,
    callerSlotId: string,
    input: {
      taskId: string
      status: 'pending' | 'assigned' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'
      result?: string
      error?: string
      ownerSlotId?: string
    },
  ): Promise<{ taskId: string; status: string; deliveryState?: 'queued' | 'delivered' }> {
    const team = this.service.getTeam(teamId)
    const task = team.tasks[input.taskId]
    if (task === undefined) throw new AgentTeamError('INVALID_REQUEST', `Unknown task '${input.taskId}'`)
    if (callerSlotId !== team.leaderSlotId && task.ownerSlotId !== callerSlotId) {
      throw new AgentTeamError('INVALID_REQUEST', 'A member may update only its own task')
    }
    if (input.ownerSlotId !== undefined) {
      if (callerSlotId !== team.leaderSlotId) {
        throw new AgentTeamError('INVALID_REQUEST', 'Only the team leader may reassign tasks')
      }
      if (team.members[input.ownerSlotId] === undefined) {
        throw new AgentTeamError('MEMBER_NOT_FOUND', `Unknown task owner '${input.ownerSlotId}'`)
      }
    }
    const nextOwnerSlotId = input.ownerSlotId ?? task.ownerSlotId
    const ownerChanged = input.ownerSlotId !== undefined && input.ownerSlotId !== task.ownerSlotId
    const shouldDispatchAssignment = ownerChanged
      && nextOwnerSlotId !== undefined
      && nextOwnerSlotId !== callerSlotId
    const shouldNotifyLeader = callerSlotId !== team.leaderSlotId
    const notification = shouldDispatchAssignment
      ? taskDispatchMessage({
        team,
        senderSlotId: callerSlotId,
        recipientSlotId: nextOwnerSlotId!,
        taskId: task.id,
        type: 'instruction',
        content: reassignmentContent(task.title, input.result, input.error),
      })
      : shouldNotifyLeader
        ? taskDispatchMessage({
          team,
          senderSlotId: callerSlotId,
          recipientSlotId: team.leaderSlotId,
          taskId: task.id,
          type: taskMessageType(input.status),
          content: taskUpdateContent(task.title, input.status, input.result, input.error),
        })
        : undefined
    await this.service.updateRuntimeTeam(
      teamId,
      current => ({
        ...current,
        tasks: {
          ...current.tasks,
          [input.taskId]: {
            ...current.tasks[input.taskId]!,
            status: input.status,
            ...(input.result === undefined ? {} : { result: input.result }),
            ...(input.error === undefined ? {} : { error: input.error }),
            ...(input.ownerSlotId === undefined ? {} : { ownerSlotId: input.ownerSlotId }),
            revision: current.tasks[input.taskId]!.revision + 1,
            updatedAt: new Date().toISOString(),
          },
        },
        outbox: notification === undefined
          ? current.outbox
          : { ...current.outbox, [notification.id]: notification },
      }),
      'team.task_updated',
      `Task ${task.title} entered ${input.status}`,
    )
    if (notification === undefined) return { taskId: input.taskId, status: input.status }
    const delivered = await this.tryDeliverOutboxMessage(teamId, notification.id)
    return {
      taskId: input.taskId,
      status: input.status,
      deliveryState: delivered ? 'delivered' : 'queued',
    }
  }

  private async sendMemberMessage(
    teamId: string,
    senderSlotId: string,
    recipientSlotId: string,
    rawContent: string,
    type: 'instruction' | 'progress' | 'result' | 'question' | 'warning' = 'progress',
  ): Promise<{ messageId: string; deliveryState: 'delivered' }> {
    const team = this.service.getTeam(teamId)
    const sender = team.members[senderSlotId]
    const recipient = team.members[recipientSlotId]
    if (sender === undefined || recipient === undefined) {
      throw new AgentTeamError('MEMBER_NOT_FOUND', 'Sender or recipient is not a current team member')
    }
    if (senderSlotId !== team.leaderSlotId && recipientSlotId !== team.leaderSlotId && !team.directMemberChat) {
      throw new AgentTeamError('INVALID_REQUEST', 'Direct member-to-member messages are disabled')
    }
    const content = requireContent(rawContent)
    const target = this.requireOwned(recipient.sessionId)
    const relay = createUserMessage({
      content: [{ type: 'text', text: `[Team message from ${sender.displayName}]\n${content}` }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-agent-team',
        form: 'relay',
      },
    })
    const record = teamMessage({
      id: String(relay.id),
      teamId,
      sender: { kind: 'member', id: senderSlotId },
      recipient: recipientSlotId === team.leaderSlotId
        ? { kind: 'leader', slotId: recipientSlotId }
        : { kind: 'member', slotId: recipientSlotId },
      type,
      content,
      idempotencyKey: String(relay.id),
    })
    await this.service.putRuntimeMessage(record)
    try {
      target.handle.agent.followup(relay)
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'delivered' })
      return { messageId: record.id, deliveryState: 'delivered' }
    } catch (error) {
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
      throw error
    }
  }

  private assertToolIdentity(agent: Agent | undefined, teamId: string, slotId: string): void {
    if (agent === undefined) throw new AgentTeamError('INVALID_REQUEST', 'Team tool requires an Agent caller')
    const owned = this.owned.get(String(agent.id))
    const identity = owned ?? this.activating.get(String(agent.id))
    if (identity === undefined || identity.teamId !== teamId || identity.slotId !== slotId) {
      throw new AgentTeamError('INVALID_REQUEST', 'Team tool caller identity does not match its scoped member')
    }
  }

  private requireOwned(sessionId: string): OwnedAgent {
    const owned = this.owned.get(sessionId)
    if (owned === undefined) {
      throw new AgentTeamError('TEAM_NOT_ACTIVE', `Team member session '${sessionId}' is not online`)
    }
    return owned
  }

  private async setMemberRuntimeState(
    teamId: string,
    slotId: string,
    state: 'idle' | 'running',
  ): Promise<void> {
    const current = this.service.getTeam(teamId)
    if (current.members[slotId]?.lastRuntimeState === state) return
    await this.service.updateRuntimeTeam(
      teamId,
      team => ({
        ...team,
        members: mapMembers(team, member => member.id === slotId
          ? { ...member, desiredState: 'online', lastRuntimeState: state }
          : member),
      }),
      'team.member_status',
      `Member ${slotId} entered ${state}`,
    )
  }

  private async markTeamError(teamId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    await this.service.updateRuntimeTeam(
      teamId,
      team => ({ ...team, state: team.state === 'ownership_conflict' ? team.state : 'error' }),
      'team.runtime_error',
      message,
    )
  }

  private async recoverPendingMessages(team: TeamAggregate): Promise<void> {
    for (const messageId of Object.keys(team.outbox)) {
      await this.tryDeliverOutboxMessage(team.id, messageId)
    }
    team = this.service.getTeam(team.id)
    const pending = this.service.listMessages(team.id).items.filter(message => message.deliveryState === 'queued')
    for (const record of pending) {
      const slotId = record.recipient.slotId
      if (slotId === undefined) continue
      const recipient = team.members[slotId]
      if (recipient === undefined) {
        await this.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
        continue
      }
      const owned = this.requireOwned(recipient.sessionId)
      if (!sessionHasMessage(owned.handle.agent, record.id)) {
        owned.handle.agent.followup(messageFromRecord(team, record))
      }
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'delivered' })
    }
  }

  private async tryDeliverOutboxMessage(teamId: string, messageId: string): Promise<boolean> {
    const current = this.service.getTeam(teamId)
    const record = current.outbox[messageId]
    if (record === undefined) return true
    const slotId = record.recipient.slotId
    const recipient = slotId === undefined ? undefined : current.members[slotId]
    if (recipient === undefined) {
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
      return false
    }
    try {
      // Re-write queued before every retry so the durable message table reflects
      // that the aggregate outbox still owns delivery.
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'queued' })
      const owned = this.requireOwned(recipient.sessionId)
      if (!sessionHasMessage(owned.handle.agent, record.id)) {
        owned.handle.agent.followup(messageFromRecord(current, record))
      }
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'delivered' })
      await this.service.updateRuntimeTeam(
        teamId,
        team => {
          if (team.outbox[messageId] === undefined) return team
          const outbox = { ...team.outbox }
          delete outbox[messageId]
          return { ...team, outbox }
        },
        'team.message_delivered',
        `Team message ${messageId} delivered`,
      )
      return true
    } catch (error) {
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'failed' })
      this.ctx.logger.warn(`agent-team: queued message ${messageId} delivery failed`, error)
      return false
    }
  }

  private exclusive<T>(teamId: string, operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Agent Team runtime is closing'))
    const prior = this.operations.get(teamId) ?? Promise.resolve()
    const current = prior.catch(() => undefined).then(operation)
    this.operations.set(teamId, current)
    void current.finally(() => {
      if (this.operations.get(teamId) === current) this.operations.delete(teamId)
    }).catch(() => undefined)
    return current
  }
}

function memberPrompt(team: TeamAggregate, member: TeamMemberSlot): string {
  return [
    `You are ${member.displayName}, an independent Agent in the team “${team.name}”.`,
    `Your role is ${member.role}. The leader coordinates work but does not own other Agents.`,
    'All team members operate in the same Workspace. Coordinate before editing overlapping files.',
    member.assistantSnapshot.instructions,
  ].filter(Boolean).join('\n\n')
}

function rosterPrompt(team: TeamAggregate): string {
  const roster = Object.values(team.members)
    .map(member => `- ${member.displayName} (${member.role}), slotId=${member.id}`)
    .join('\n')
  return [
    `Team roster:\n${roster}`,
    'The shared task board and durable team mailbox are the coordination protocol.',
    'Leaders assign work with team_create_task; assigning an owner automatically queues and delivers the task to that member.',
    'Members must use team_update_task for status and results; member updates automatically notify the Leader.',
    'Use team_send_message for questions and other explicit member communication.',
  ].join('\n')
}

function mapMembers(
  team: TeamAggregate,
  map: (member: TeamMemberSlot) => TeamMemberSlot,
): TeamAggregate['members'] {
  return Object.fromEntries(Object.entries(team.members).map(([id, member]) => [id, map(member)]))
}

function requireContent(value: string): string {
  const content = value.trim()
  if (content.length === 0) throw new AgentTeamError('INVALID_REQUEST', 'Message content cannot be empty')
  if (content.length > 100_000) throw new AgentTeamError('INVALID_REQUEST', 'Message content is too large')
  return content
}

function requireShortText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new AgentTeamError('INVALID_REQUEST', `${label} cannot be empty`)
  if (normalized.length > maxLength) throw new AgentTeamError('INVALID_REQUEST', `${label} is too long`)
  return normalized
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function teamMessage(input: Omit<TeamMessage, 'schemaVersion' | 'attachments' | 'deliveryState' | 'createdAt'>): TeamMessage {
  return {
    schemaVersion: 1,
    ...input,
    attachments: [],
    deliveryState: 'queued',
    createdAt: new Date().toISOString(),
  }
}

function taskDispatchMessage(input: {
  team: TeamAggregate
  senderSlotId: string
  recipientSlotId: string
  taskId: string
  type: 'instruction' | 'progress' | 'result' | 'question' | 'warning'
  content: string
}): TeamMessage {
  const id = String(MessageId(`agent-team:${randomUUID()}`))
  return teamMessage({
    id,
    teamId: input.team.id,
    sender: { kind: 'member', id: input.senderSlotId },
    recipient: input.recipientSlotId === input.team.leaderSlotId
      ? { kind: 'leader', slotId: input.recipientSlotId }
      : { kind: 'member', slotId: input.recipientSlotId },
    type: input.type,
    content: input.content,
    relatedTaskId: input.taskId,
    idempotencyKey: id,
  })
}

function assignmentContent(title: string, description: string, fileScopes: readonly string[]): string {
  return [
    `A team task has been assigned to you: ${title}`,
    description.length === 0 ? undefined : `Description: ${description}`,
    fileScopes.length === 0 ? undefined : `File scopes: ${fileScopes.join(', ')}`,
    'Read the task board for the task id, mark it running when you begin, and report progress or the final result with team_update_task.',
  ].filter((line): line is string => line !== undefined).join('\n')
}

function reassignmentContent(title: string, result?: string, error?: string): string {
  return [
    `A team task has been reassigned to you: ${title}`,
    result === undefined ? undefined : `Prior result: ${result}`,
    error === undefined ? undefined : `Prior error: ${error}`,
    'Read the task board for details and update the task with team_update_task.',
  ].filter((line): line is string => line !== undefined).join('\n')
}

function taskUpdateContent(
  title: string,
  status: 'pending' | 'assigned' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled',
  result?: string,
  error?: string,
): string {
  return [
    `Task update: ${title}`,
    `Status: ${status}`,
    result === undefined ? undefined : `Result: ${result}`,
    error === undefined ? undefined : `Error: ${error}`,
  ].filter((line): line is string => line !== undefined).join('\n')
}

function taskMessageType(
  status: 'pending' | 'assigned' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled',
): 'progress' | 'result' | 'question' | 'warning' {
  if (status === 'completed') return 'result'
  if (status === 'blocked') return 'question'
  if (status === 'failed' || status === 'cancelled') return 'warning'
  return 'progress'
}

function messageFromRecord(team: TeamAggregate, record: TeamMessage): UserMessage {
  const sender = record.sender.kind === 'member' ? team.members[record.sender.id] : undefined
  const text = sender === undefined
    ? record.content
    : `[Team message from ${sender.displayName}]\n${record.content}`
  return freezeMessage({
    id: MessageId(record.id),
    role: 'user',
    content: [{ type: 'text', text }],
    source: sender === undefined
      ? { kind: 'user' }
      : { kind: 'plugin', plugin: 'dsh-agent-team', form: 'relay' },
  })
}

function sessionHasMessage(agent: Agent, messageId: string): boolean {
  return agent.session.events.some(event => {
    if (event.type !== 'agent/inbox/spliced') return false
    return event.data.inserted.some(message => String(message.id) === messageId)
  })
}

function skillNameFromArguments(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('name' in value)) return undefined
  return typeof value.name === 'string' ? value.name : undefined
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++
      await run(values[index]!)
    }
  })
  await Promise.all(workers)
}

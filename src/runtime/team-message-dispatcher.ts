import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamAggregate } from '../domain/types.js'
import type { AgentTeamService } from '../service/agent-team-service.js'
import { messageFromRecord, sessionHasMessage } from './team-messages.js'

interface TeamMessageDispatcherPort {
  resolveAgent: (sessionId: string) => Agent
  warn: (message: string, error: unknown) => void
}

export class TeamMessageDispatcher {
  constructor(
    private readonly service: AgentTeamService,
    private readonly port: TeamMessageDispatcherPort,
  ) {}

  async recover(team: TeamAggregate): Promise<void> {
    for (const messageId of Object.keys(team.outbox)) {
      await this.deliver(team.id, messageId)
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
      const agent = this.port.resolveAgent(recipient.sessionId)
      if (!sessionHasMessage(agent, record.id)) agent.followup(messageFromRecord(team, record))
      await this.service.putRuntimeMessage({ ...record, deliveryState: 'delivered' })
    }
  }

  async deliver(teamId: string, messageId: string): Promise<boolean> {
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
      const agent = this.port.resolveAgent(recipient.sessionId)
      if (!sessionHasMessage(agent, record.id)) agent.followup(messageFromRecord(current, record))
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
      this.port.warn(`agent-team: queued message ${messageId} delivery failed`, error)
      return false
    }
  }
}

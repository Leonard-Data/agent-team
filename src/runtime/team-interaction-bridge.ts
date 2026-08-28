import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  RpcId,
  type MuxFrame,
  type RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy'
import { AgentTeamError } from '../domain/errors.js'
import type {
  InteractionResponseInput,
  PendingInteractionView,
  QuestionAnswerView,
  QuestionItemView,
} from '../transport/contracts.js'

type QuestionRequestedFrame = Extract<MuxFrame, { type: 'question/requested' }>
type ApprovalRequestedFrame = Extract<MuxFrame, { type: 'approval/requested' }>

type PendingInteractionRecord =
  | {
    id: string
    kind: 'question'
    rpcId: RpcRequest<MuxFrame>['rpcId']
    sessionId: QuestionRequestedFrame['sessionId']
    questions: QuestionItemView[]
  }
  | {
    id: string
    kind: 'approval'
    rpcId: RpcRequest<MuxFrame>['rpcId']
    sessionId: ApprovalRequestedFrame['sessionId']
    approvalId: ApprovalRequestedFrame['approvalId']
    toolName: string
    callId?: string
    reason?: string
  }

export interface TeamInteractionScope {
  acceptsSession: (sessionId: string) => boolean
  onChange: (sessionId: string) => void
}

export class TeamInteractionBridge {
  private readonly records = new Map<string, PendingInteractionRecord>()
  private readonly scopes = new Set<TeamInteractionScope>()
  private abortController: AbortController | undefined
  private consumeTask: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    scope?: TeamInteractionScope,
  ) {
    if (scope !== undefined) this.scopes.add(scope)
  }

  registerScope(scope: TeamInteractionScope): () => void {
    this.scopes.add(scope)
    return () => { this.scopes.delete(scope) }
  }

  start(): void {
    if (this.abortController !== undefined) return
    const controller = new AbortController()
    this.abortController = controller
    this.consumeTask = this.consume(controller.signal).catch(error => {
      if (!controller.signal.aborted) {
        this.ctx.logger.error('agent-team: interaction mux stopped unexpectedly', error)
      }
    })
  }

  list(sessionId: string): PendingInteractionView[] {
    return [...this.records.values()]
      .filter(record => String(record.sessionId) === sessionId)
      .map(toView)
  }

  forget(sessionId: string): void {
    for (const [id, record] of this.records) {
      if (String(record.sessionId) === sessionId) this.records.delete(id)
    }
  }

  async respond(
    sessionId: string,
    interactionId: string,
    response: InteractionResponseInput,
  ): Promise<void> {
    const record = this.records.get(interactionId)
    if (record === undefined) {
      throw new AgentTeamError('INTERACTION_NOT_FOUND', 'This interaction request has ended or does not exist')
    }
    if (String(record.sessionId) !== sessionId || !this.acceptsSession(sessionId)) {
      throw new AgentTeamError('INTERACTION_NOT_FOUND', 'This interaction request does not belong to the specified session')
    }
    let value: unknown
    if (record.kind === 'question') {
      if (response.kind !== 'question') {
        throw new AgentTeamError('INTERACTION_INVALID', 'The interaction response type does not match the pending request')
      }
      value = {
        sessionId: record.sessionId,
        answer: { answers: normalizeQuestionAnswers(record.questions, response.answers) },
      }
    } else {
      if (response.kind !== 'approval') {
        throw new AgentTeamError('INTERACTION_INVALID', 'The interaction response type does not match the pending request')
      }
      value = {
        sessionId: record.sessionId,
        approvalId: record.approvalId,
        outcome: response.outcome,
      }
    }
    const receipt = await this.ctx.apiProxy.respond({
      type: 'client-response',
      rpcId: record.rpcId,
      result: { ok: true, value },
    })
    if (receipt.accepted) return
    if (receipt.reason === 'not-pending') {
      this.records.delete(record.id)
      this.notifyChange(String(record.sessionId))
      throw new AgentTeamError('INTERACTION_NOT_PENDING', 'This interaction request was already handled on another page')
    }
    throw new AgentTeamError('INTERACTION_INVALID', 'Harness rejected the interaction response')
  }

  async dispose(): Promise<void> {
    const controller = this.abortController
    this.abortController = undefined
    controller?.abort()
    await this.consumeTask
    this.consumeTask = undefined
    this.records.clear()
  }

  private async consume(signal: AbortSignal): Promise<void> {
    const stream = this.ctx.apiProxy.events.mux({
      rpcId: RpcId(randomUUID()),
      payload: {},
    }, signal)
    for await (const envelope of stream) {
      if (signal.aborted) return
      this.accept(envelope)
    }
  }

  private accept(envelope: RpcRequest<MuxFrame>): void {
    const frame = envelope.payload
    if (frame.type === 'question/requested') {
      if (!this.acceptsSession(String(frame.sessionId))) return
      const record: PendingInteractionRecord = {
        id: `question:${String(envelope.rpcId)}`,
        kind: 'question',
        rpcId: envelope.rpcId,
        sessionId: frame.sessionId,
        questions: frame.questions.map(question => ({
          id: question.id,
          question: question.question,
          ...(question.detail === undefined ? {} : { detail: question.detail }),
          ...(question.header === undefined ? {} : { header: question.header }),
          ...(question.options === undefined ? {} : {
            options: question.options.map(option => ({
              label: option.label,
              ...(option.description === undefined ? {} : { description: option.description }),
            })),
          }),
          ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
          ...(question.intent === undefined ? {} : { intent: { ...question.intent } }),
        })),
      }
      this.records.set(record.id, record)
      this.notifyChange(String(frame.sessionId))
      return
    }
    if (frame.type === 'approval/requested') {
      if (!this.acceptsSession(String(frame.sessionId))) return
      const record: PendingInteractionRecord = {
        id: `approval:${String(frame.approvalId)}`,
        kind: 'approval',
        rpcId: envelope.rpcId,
        sessionId: frame.sessionId,
        approvalId: frame.approvalId,
        toolName: frame.toolName,
        ...(frame.callId === undefined ? {} : { callId: String(frame.callId) }),
        ...(frame.reason === undefined ? {} : { reason: frame.reason }),
      }
      this.records.set(record.id, record)
      this.notifyChange(String(frame.sessionId))
      return
    }
    if (frame.type === 'question/resolved') {
      this.remove(`question:${String(frame.questionRpcId)}`, String(frame.sessionId))
      return
    }
    if (frame.type === 'approval/resolved') {
      this.remove(`approval:${String(frame.approvalId)}`, String(frame.sessionId))
    }
  }

  private remove(id: string, sessionId: string): void {
    if (!this.records.delete(id)) return
    this.notifyChange(sessionId)
  }

  private acceptsSession(sessionId: string): boolean {
    return [...this.scopes].some(scope => scope.acceptsSession(sessionId))
  }

  private notifyChange(sessionId: string): void {
    for (const scope of this.scopes) {
      if (scope.acceptsSession(sessionId)) scope.onChange(sessionId)
    }
  }
}

export function normalizeQuestionAnswers(
  questions: readonly QuestionItemView[],
  answers: readonly QuestionAnswerView[],
): QuestionAnswerView[] {
  const byId = new Map<string, QuestionAnswerView>()
  for (const answer of answers) {
    if (byId.has(answer.id)) {
      throw new AgentTeamError('INTERACTION_INVALID', `Question "${answer.id}" has duplicate answers`)
    }
    byId.set(answer.id, answer)
  }
  if (byId.size !== questions.length) {
    throw new AgentTeamError('INTERACTION_INVALID', 'Answer every question before submitting')
  }
  return questions.map(question => {
    const answer = byId.get(question.id)
    if (answer === undefined) {
      throw new AgentTeamError('INTERACTION_INVALID', `Question "${question.id}" is missing an answer`)
    }
    const selected = [...answer.selected]
    if (new Set(selected).size !== selected.length) {
      throw new AgentTeamError('INTERACTION_INVALID', `Question "${question.id}" contains duplicate options`)
    }
    const allowed = new Set(question.options?.map(option => option.label) ?? [])
    if (selected.some(label => !allowed.has(label))) {
      throw new AgentTeamError('INTERACTION_INVALID', `Question "${question.id}" contains an invalid option`)
    }
    if (question.multiSelect !== true && selected.length > 1) {
      throw new AgentTeamError('INTERACTION_INVALID', `Question "${question.id}" allows only one option`)
    }
    const custom = answer.custom?.trim()
    if (question.multiSelect !== true && custom !== undefined && custom.length > 0 && selected.length > 0) {
      throw new AgentTeamError('INTERACTION_INVALID', `Question "${question.id}" cannot submit a custom answer together with a single-choice option`)
    }
    if (selected.length === 0 && (custom === undefined || custom.length === 0)) {
      throw new AgentTeamError('INTERACTION_INVALID', `Please answer the question "${question.question}"`)
    }
    return {
      id: question.id,
      selected,
      ...(custom === undefined || custom.length === 0 ? {} : { custom }),
    }
  })
}

function toView(record: PendingInteractionRecord): PendingInteractionView {
  if (record.kind === 'question') {
    return { id: record.id, kind: record.kind, questions: record.questions }
  }
  return {
    id: record.id,
    kind: record.kind,
    approvalId: String(record.approvalId),
    toolName: record.toolName,
    ...(record.callId === undefined ? {} : { callId: record.callId }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  }
}

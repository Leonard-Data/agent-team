import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { Config } from '../config.js'
import { AgentTeamError, isAgentTeamError } from '../domain/errors.js'
import type { AgentTeamService, AgentTeamChange } from '../service/agent-team-service.js'
import {
  AGENT_TEAM_API_PATH,
  AGENT_TEAM_EVENTS_PATH,
  type AgentTeamRequest,
  type AgentTeamResponse,
} from './contracts.js'

const requestSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  method: z.enum([
    'catalog.get',
    'skill.catalog',
    'mcp.catalog',
    'assistant.list',
    'assistant.get',
    'assistant.create',
    'assistant.update',
    'assistant.clone',
    'assistant.delete',
    'assistant.builder.list',
    'assistant.builder.create',
    'assistant.builder.get',
    'assistant.builder.configure',
    'assistant.builder.send',
    'assistant.builder.stop',
    'team.list',
    'team.get',
    'team.createDraft',
    'team.start',
    'team.addMember',
    'team.removeMember',
    'team.changeLeader',
    'team.reset',
    'team.message.list',
    'team.message.send',
    'team.workbench.get',
    'team.member.stop',
    'team.member.setPermissionPreset',
    'team.workspace.list',
    'team.dissolve',
  ]),
  expectedRevision: z.int().positive().optional(),
  payload: z.unknown(),
}).strict()

const idPayload = z.object({ id: z.string().trim().min(1) }).strict()

export interface WebTransport {
  dispose(): void
}

export function registerWebTransport(
  ctx: Context,
  config: Config,
  service: AgentTeamService,
): WebTransport {
  const clients = new Set<ServerResponse>()
  const unsubscribe = service.subscribe(change => broadcast(clients, change))
  const heartbeat = setInterval(() => {
    for (const response of clients) response.write(': heartbeat\n\n')
  }, config.sseHeartbeatMs)
  heartbeat.unref()

  const disposeApi = ctx.webServer.register({
    kind: 'exact',
    path: AGENT_TEAM_API_PATH,
    handler: async (request, response) => {
      await handleApi(request, response, config, service, ctx)
    },
  })
  const disposeEvents = ctx.webServer.register({
    kind: 'exact',
    path: AGENT_TEAM_EVENTS_PATH,
    handler: (request, response) => {
      handleEvents(request, response, clients)
    },
  })

  return {
    dispose() {
      disposeEvents()
      disposeApi()
      unsubscribe()
      clearInterval(heartbeat)
      for (const response of clients) response.end()
      clients.clear()
    },
  }
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  config: Config,
  service: AgentTeamService,
  ctx: Context,
): Promise<void> {
  if (request.method !== 'POST') {
    writeJson(response, 405, failure('unknown', 'METHOD_NOT_ALLOWED', 'Only POST is supported'))
    return
  }
  if (!sameOrigin(request)) {
    writeJson(response, 403, failure('unknown', 'ORIGIN_REJECTED', 'Cross-origin requests are not allowed'))
    return
  }
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    writeJson(response, 415, failure('unknown', 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'))
    return
  }

  let parsed: AgentTeamRequest
  try {
    const body = await readJson(request, config.maxRequestBytes)
    parsed = requestSchema.parse(body) as AgentTeamRequest
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request'
    writeJson(response, 400, failure('unknown', 'INVALID_REQUEST', message))
    return
  }

  try {
    const value = await dispatch(service, parsed)
    writeJson(response, 200, { requestId: parsed.requestId, ok: true, value })
  } catch (error) {
    if (!isAgentTeamError(error) && !(error instanceof z.ZodError)) {
      ctx.logger.error('agent-team: unhandled API error', error)
    }
    const normalized = normalizeError(parsed.requestId, error)
    const status = normalized.error.code.endsWith('_NOT_FOUND') ? 404
      : normalized.error.code.includes('REVISION_CONFLICT') ? 409
        : 400
    writeJson(response, status, normalized)
  }
}

function handleEvents(
  request: IncomingMessage,
  response: ServerResponse,
  clients: Set<ServerResponse>,
): void {
  if (request.method !== 'GET') {
    writeJson(response, 405, failure('unknown', 'METHOD_NOT_ALLOWED', 'Only GET is supported'))
    return
  }
  if (!sameOrigin(request)) {
    writeJson(response, 403, failure('unknown', 'ORIGIN_REJECTED', 'Cross-origin requests are not allowed'))
    return
  }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  })
  response.write('retry: 2000\n\n')
  clients.add(response)
  const close = () => { clients.delete(response) }
  request.once('close', close)
  response.once('close', close)
}

async function dispatch(service: AgentTeamService, request: AgentTeamRequest): Promise<unknown> {
  const options = request.expectedRevision === undefined
    ? {}
    : { expectedRevision: request.expectedRevision }
  switch (request.method) {
    case 'catalog.get': return service.catalog()
    case 'skill.catalog': {
      const payload = z.object({ agentPresetId: z.string().trim().min(1).max(200) }).strict().parse(request.payload)
      return service.skillCatalog(payload.agentPresetId)
    }
    case 'mcp.catalog': {
      const payload = z.object({ agentPresetId: z.string().trim().min(1).max(200) }).strict().parse(request.payload)
      return service.mcpCatalog(payload.agentPresetId)
    }
    case 'assistant.list': return service.listAssistants()
    case 'assistant.get': return service.getAssistant(idPayload.parse(request.payload).id)
    case 'assistant.create': return service.createAssistant(request.payload as never)
    case 'assistant.update': {
      const payload = z.object({ id: z.string().min(1), value: z.unknown() }).strict().parse(request.payload)
      return service.updateAssistant(payload.id, payload.value as never, options)
    }
    case 'assistant.clone': {
      const payload = z.object({ id: z.string().min(1), name: z.string().optional() }).strict().parse(request.payload)
      return service.cloneAssistant(payload.id, payload.name)
    }
    case 'assistant.delete': await service.deleteAssistant(idPayload.parse(request.payload).id); return null
    case 'assistant.builder.list': return service.listAssistantBuilderConversations()
    case 'assistant.builder.create': return service.createAssistantBuilderConversation()
    case 'assistant.builder.get': {
      const payload = z.object({ sessionId: z.string().trim().min(1).max(200).optional() }).strict().parse(request.payload)
      return service.getAssistantBuilderConversation(payload.sessionId)
    }
    case 'assistant.builder.configure': {
      const payload = z.object({
        sessionId: z.string().trim().min(1).max(200),
        provider: z.string().trim().min(1).max(200),
        model: z.string().trim().min(1).max(500),
      }).strict().parse(request.payload)
      return service.configureAssistantBuilder(payload.sessionId, payload.provider, payload.model)
    }
    case 'assistant.builder.send': {
      const payload = z.object({
        sessionId: z.string().trim().min(1).max(200),
        content: z.string().trim().min(1).max(32_000),
      }).strict().parse(request.payload)
      return service.sendAssistantBuilderMessage(payload.sessionId, payload.content)
    }
    case 'assistant.builder.stop': {
      const payload = z.object({ sessionId: z.string().trim().min(1).max(200) }).strict().parse(request.payload)
      await service.stopAssistantBuilder(payload.sessionId)
      return { accepted: true }
    }
    case 'team.list': return service.listTeams()
    case 'team.get': return service.getTeam(idPayload.parse(request.payload).id)
    case 'team.createDraft': return service.createTeamDraft(request.payload as never)
    case 'team.start': return service.startTeam(idPayload.parse(request.payload).id, options)
    case 'team.addMember': {
      const payload = z.object({ teamId: z.string().min(1), value: z.unknown() }).strict().parse(request.payload)
      return service.addMember(payload.teamId, payload.value as never, options)
    }
    case 'team.removeMember': {
      const payload = z.object({ teamId: z.string().min(1), slotId: z.string().min(1) }).strict().parse(request.payload)
      return service.removeMember(payload.teamId, payload.slotId, options)
    }
    case 'team.changeLeader': {
      const payload = z.object({ teamId: z.string().min(1), successorSlotId: z.string().min(1) }).strict().parse(request.payload)
      return service.changeLeader(payload.teamId, payload.successorSlotId, options)
    }
    case 'team.reset': {
      const payload = z.object({ teamId: z.string().min(1), confirmation: z.string() }).strict().parse(request.payload)
      return service.resetTeam(payload.teamId, payload.confirmation, options)
    }
    case 'team.message.list': return service.listMessages(idPayload.parse(request.payload).id)
    case 'team.message.send': {
      const payload = z.object({
        teamId: z.string().min(1),
        content: z.string(),
        targetSlotId: z.string().min(1).optional(),
      }).strict().parse(request.payload)
      return service.sendUserMessage(payload.teamId, payload.content, payload.targetSlotId)
    }
    case 'team.workbench.get': return service.getWorkbench(idPayload.parse(request.payload).id)
    case 'team.member.stop': {
      const payload = z.object({ teamId: z.string().min(1), slotId: z.string().min(1) }).strict().parse(request.payload)
      await service.stopMember(payload.teamId, payload.slotId)
      return { accepted: true }
    }
    case 'team.member.setPermissionPreset': {
      const payload = z.object({
        teamId: z.string().min(1),
        slotId: z.string().min(1),
        permissionPresetId: z.string().min(1),
      }).strict().parse(request.payload)
      return service.setMemberPermissionPreset(
        payload.teamId,
        payload.slotId,
        payload.permissionPresetId,
        options,
      )
    }
    case 'team.workspace.list': {
      const payload = z.object({
        teamId: z.string().min(1),
        path: z.string().max(4096).optional(),
      }).strict().parse(request.payload)
      return service.listWorkspace(payload.teamId, payload.path)
    }
    case 'team.dissolve': {
      const payload = z.object({ teamId: z.string().min(1), confirmation: z.string() }).strict().parse(request.payload)
      await service.dissolveTeam(payload.teamId, payload.confirmation, options)
      return null
    }
  }
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limit) throw new AgentTeamError('INVALID_REQUEST', `Request body exceeds ${limit} bytes`)
    chunks.push(buffer)
  }
  if (chunks.length === 0) throw new AgentTeamError('INVALID_REQUEST', 'Request body is empty')
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (origin === undefined) return true
  const host = request.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function broadcast(clients: Set<ServerResponse>, change: AgentTeamChange): void {
  const event = change.entityType === 'conversation' ? 'conversation'
    : change.entityType === 'assistant-builder' ? 'assistant-builder-conversation'
      : 'change'
  const frame = `id: ${change.cursor}\nevent: ${event}\ndata: ${JSON.stringify(change)}\n\n`
  for (const response of clients) response.write(frame)
}

function normalizeError(requestId: string, error: unknown): AgentTeamResponse & { ok: false } {
  if (isAgentTeamError(error)) {
    return failure(requestId, error.code, error.message, error.details)
  }
  if (error instanceof z.ZodError) {
    return failure(requestId, 'INVALID_REQUEST', 'Request validation failed', { issues: error.issues })
  }
  return failure(requestId, 'INTERNAL_ERROR', 'Agent Team encountered an internal error')
}

function failure(
  requestId: string,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AgentTeamResponse & { ok: false } {
  return {
    requestId,
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  }
}

function writeJson(response: ServerResponse, status: number, body: AgentTeamResponse): void {
  const json = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(json)
}

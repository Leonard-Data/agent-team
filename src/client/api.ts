import {
  AGENT_TEAM_API_PATH,
  AGENT_TEAM_EVENTS_PATH,
  type AgentTeamMethod,
  type AgentTeamResponse,
  type AssistantBuilderConversationView,
  type MemberConversationView,
} from '../transport/contracts.js'

export async function callAgentTeam<T>(
  method: AgentTeamMethod,
  payload: unknown = {},
  expectedRevision?: number,
): Promise<T> {
  const controller = new AbortController()
  const timeoutMs = method === 'team.reset' || method === 'team.dissolve' ? 60_000 : 10_000
  const timeout = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetch(AGENT_TEAM_API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        method,
        payload,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
    })
    const body = await response.json() as AgentTeamResponse
    if (!body.ok) {
      const error = new Error(body.error.message)
      Object.assign(error, { code: body.error.code, details: body.error.details })
      throw error
    }
    return body.value as T
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`请求超时：${method}`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

interface ChangeSubscription {
  onChange: () => void
  onError: () => void
}

interface ConversationSubscription {
  teamId: string
  onChange: (conversation?: MemberConversationView) => void
  onError: () => void
  onOpen?: () => void
}

interface AssistantBuilderSubscription {
  onChange: (conversation?: AssistantBuilderConversationView) => void
  onError: () => void
  onOpen?: () => void
}

const changeSubscriptions = new Set<ChangeSubscription>()
const conversationSubscriptions = new Set<ConversationSubscription>()
const assistantBuilderSubscriptions = new Set<AssistantBuilderSubscription>()
let sharedEventSource: EventSource | undefined

function eventSource(): EventSource {
  if (sharedEventSource !== undefined) return sharedEventSource
  const source = new EventSource(AGENT_TEAM_EVENTS_PATH)
  source.addEventListener('change', () => {
    for (const subscription of changeSubscriptions) subscription.onChange()
  })
  source.addEventListener('conversation', ((event: MessageEvent<string>) => {
    try {
      const change = JSON.parse(event.data) as {
        entityId?: string
        conversation?: MemberConversationView
      }
      for (const subscription of conversationSubscriptions) {
        if (subscription.teamId === change.entityId) subscription.onChange(change.conversation)
      }
    } catch {
      for (const subscription of conversationSubscriptions) subscription.onChange()
    }
  }) as EventListener)
  source.addEventListener('assistant-builder-conversation', ((event: MessageEvent<string>) => {
    try {
      const change = JSON.parse(event.data) as {
        assistantBuilderConversation?: AssistantBuilderConversationView
      }
      for (const subscription of assistantBuilderSubscriptions) {
        subscription.onChange(change.assistantBuilderConversation)
      }
    } catch {
      for (const subscription of assistantBuilderSubscriptions) subscription.onChange()
    }
  }) as EventListener)
  source.onerror = () => {
    for (const subscription of changeSubscriptions) subscription.onError()
    for (const subscription of conversationSubscriptions) subscription.onError()
    for (const subscription of assistantBuilderSubscriptions) subscription.onError()
  }
  source.onopen = () => {
    for (const subscription of conversationSubscriptions) subscription.onOpen?.()
    for (const subscription of assistantBuilderSubscriptions) subscription.onOpen?.()
  }
  sharedEventSource = source
  return source
}

function releaseEventSourceIfUnused(): void {
  if (
    changeSubscriptions.size > 0
    || conversationSubscriptions.size > 0
    || assistantBuilderSubscriptions.size > 0
  ) return
  sharedEventSource?.close()
  sharedEventSource = undefined
}

export function subscribeAgentTeam(onChange: () => void, onError: () => void): () => void {
  const subscription: ChangeSubscription = { onChange, onError }
  changeSubscriptions.add(subscription)
  eventSource()
  return () => {
    changeSubscriptions.delete(subscription)
    releaseEventSourceIfUnused()
  }
}

export function subscribeAgentTeamConversation(
  teamId: string,
  onChange: (conversation?: MemberConversationView) => void,
  onError: () => void,
  onOpen?: () => void,
): () => void {
  const subscription: ConversationSubscription = {
    teamId,
    onChange,
    onError,
    ...(onOpen === undefined ? {} : { onOpen }),
  }
  conversationSubscriptions.add(subscription)
  const source = eventSource()
  if (source.readyState === EventSource.OPEN) queueMicrotask(() => { onOpen?.() })
  return () => {
    conversationSubscriptions.delete(subscription)
    releaseEventSourceIfUnused()
  }
}

export function subscribeAssistantBuilderConversation(
  onChange: (conversation?: AssistantBuilderConversationView) => void,
  onError: () => void,
  onOpen?: () => void,
): () => void {
  const subscription: AssistantBuilderSubscription = {
    onChange,
    onError,
    ...(onOpen === undefined ? {} : { onOpen }),
  }
  assistantBuilderSubscriptions.add(subscription)
  const source = eventSource()
  if (source.readyState === EventSource.OPEN) queueMicrotask(() => { onOpen?.() })
  return () => {
    assistantBuilderSubscriptions.delete(subscription)
    releaseEventSourceIfUnused()
  }
}

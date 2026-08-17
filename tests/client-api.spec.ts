import { beforeEach, describe, expect, it, vi } from 'vitest'

class FakeEventSource {
  static readonly OPEN = 1
  static instances: FakeEventSource[] = []

  readonly listeners = new Map<string, Array<(event: unknown) => void>>()
  readyState = 0
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener as (event: unknown) => void)
    this.listeners.set(type, listeners)
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) })
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.()
  }

  close(): void {
    this.closed = true
  }
}

describe('Agent Team client event hub', () => {
  beforeEach(() => {
    vi.resetModules()
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  it('shares one EventSource across list and conversation subscribers', async () => {
    const {
      subscribeAgentTeam,
      subscribeAgentTeamConversation,
      subscribeAssistantBuilderConversation,
    } = await import('../src/client/api.js')
    const listChange = vi.fn()
    const conversationChange = vi.fn()
    const builderChange = vi.fn()
    const opened = vi.fn()

    const unsubscribeList = subscribeAgentTeam(listChange, vi.fn())
    const unsubscribeConversation = subscribeAgentTeamConversation(
      'team-1',
      conversationChange,
      vi.fn(),
      opened,
    )
    const unsubscribeBuilder = subscribeAssistantBuilderConversation(builderChange, vi.fn())

    expect(FakeEventSource.instances).toHaveLength(1)
    const source = FakeEventSource.instances[0]!
    source.open()
    source.emit('change', { entityId: 'team-1' })
    source.emit('conversation', {
      entityId: 'team-1',
      conversation: { slotId: 'slot-1', throughSeq: 3 },
    })
    source.emit('assistant-builder-conversation', {
      assistantBuilderConversation: {
        schemaVersion: 1,
        sessionId: 'agent-team:assistant-builder',
        status: 'running',
        throughSeq: 4,
        nodes: [],
      },
    })

    expect(opened).toHaveBeenCalledOnce()
    expect(listChange).toHaveBeenCalledOnce()
    expect(conversationChange).toHaveBeenCalledWith(expect.objectContaining({ slotId: 'slot-1' }))
    expect(builderChange).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'agent-team:assistant-builder',
    }))

    unsubscribeList()
    expect(source.closed).toBe(false)
    unsubscribeConversation()
    expect(source.closed).toBe(false)
    unsubscribeBuilder()
    expect(source.closed).toBe(true)
  })
})

describe('Agent Team client requests', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('requests the Skill catalog for one Agent Preset', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { skills: [] } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('skill.catalog', { agentPresetId: 'standard' })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'skill.catalog',
      payload: { agentPresetId: 'standard' },
    })
  })

  it('requests the MCP catalog for one Agent Preset', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      json: async () => ({ requestId: 'request-1', ok: true, value: { servers: [] } }),
    }))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    const { callAgentTeam } = await import('../src/client/api.js')

    await callAgentTeam('mcp.catalog', { agentPresetId: 'standard' })

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toMatchObject({
      method: 'mcp.catalog',
      payload: { agentPresetId: 'standard' },
    })
  })
})

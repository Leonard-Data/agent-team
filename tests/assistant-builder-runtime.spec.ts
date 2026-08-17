import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from '../src/config.js'
import {
  AssistantBuilderRuntime,
  hasExplicitAssistantDraftConfirmation,
} from '../src/runtime/assistant-builder-runtime.js'

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

describe('AssistantBuilderRuntime', () => {
  it('switches model by flushing and resuming the same Session', async () => {
    const first = fakeHandle()
    const second = fakeHandle()
    const resume = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const flush = vi.fn(async () => {})
    const ctx = {
      on: vi.fn(() => vi.fn()),
      agents: {
        get: vi.fn(() => undefined),
        resume,
        create: vi.fn(),
      },
      llm: {
        listProviders: vi.fn(() => [
          { id: 'deepseek-official', name: 'DeepSeek' },
          { id: 'zai-coding-cn', name: 'ZAI' },
        ]),
        listModels: vi.fn(async (provider: string) => provider === 'deepseek-official'
          ? [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }]
          : [{ id: 'glm-5.3', name: 'GLM 5.3' }]),
        resolveModelInfo: vi.fn(async () => ({})),
      },
      agentPresets: {
        defaultId: 'standard',
        resolve: vi.fn(async () => ({})),
        mount: vi.fn(async () => ({})),
      },
      permissionPresets: {
        names: ['read-only'],
        defaultPreset: 'read-only',
        set: vi.fn(),
      },
      sessionPersistence: {
        list: vi.fn(async () => [{ id: 'agent-team:assistant-builder' }]),
      },
      sessions: { flush },
      logger: { warn: vi.fn() },
    }
    const service = {
      publishAssistantBuilderConversation: vi.fn(),
    }
    const runtime = new AssistantBuilderRuntime(ctx as never, config, service as never)

    const initial = await runtime.getConversation()
    const switched = await runtime.configure('zai-coding-cn', 'glm-5.3')

    expect(initial.configuration).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledWith(first.agent.session)
    expect(resume).toHaveBeenLastCalledWith(expect.objectContaining({
      resumeSessionId: 'agent-team:assistant-builder',
      agentOptions: { provider: 'zai-coding-cn', model: 'glm-5.3' },
    }))
    expect(switched.configuration).toMatchObject({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
    })

    await runtime.dispose()
  })

  it('accepts only the latest exact user confirmation after preparation', () => {
    const beforePreparation = userEvent(4, '确认创建')
    const pluginRelay = userEvent(6, '确认创建', {
      kind: 'plugin',
      plugin: 'dsh-agent-team',
      form: 'relay',
    })
    const exactConfirmation = userEvent(7, '确认创建')

    expect(hasExplicitAssistantDraftConfirmation([beforePreparation], 5)).toBe(false)
    expect(hasExplicitAssistantDraftConfirmation([pluginRelay], 5)).toBe(false)
    expect(hasExplicitAssistantDraftConfirmation([exactConfirmation], 5)).toBe(true)
    expect(hasExplicitAssistantDraftConfirmation([
      exactConfirmation,
      userEvent(8, '先不要创建'),
    ], 5)).toBe(false)
    expect(hasExplicitAssistantDraftConfirmation([
      userEvent(7, '确认创建。'),
    ], 5)).toBe(false)
  })
})

function userEvent(seq: number, text: string, source: unknown = { kind: 'user' }): SessionEvent {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    type: 'user/message',
    data: {
      id: `message-${seq}`,
      content: [{ type: 'text', text }],
      source,
    },
  } as SessionEvent
}

function fakeHandle() {
  const agent = {
    id: 'agent-team:assistant-builder',
    status: 'idle' as const,
    session: { events: [] },
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  }
  return {
    agent,
    dispose: vi.fn(async () => {}),
  }
}

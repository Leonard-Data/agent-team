import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { RpcId, type RpcRequest, type MuxFrame } from '@deepseek-ai/dsh-host-apiproxy'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentTeamError } from '../src/domain/errors.js'
import {
  normalizeQuestionAnswers,
  TeamInteractionBridge,
} from '../src/runtime/team-interaction-bridge.js'

describe('TeamInteractionBridge', () => {
  it('projects and answers an official question request, then waits for resolved', async () => {
    const resolved = deferred<void>()
    const sessionId = SessionId('session-1')
    const rpcId = RpcId('question-rpc-1')
    const respond = vi.fn(async () => ({ accepted: true as const }))
    const onChange = vi.fn()
    const bridge = new TeamInteractionBridge(contextWithMux([
      {
        rpcId,
        payload: {
          type: 'question/requested',
          sessionId,
          questions: [{
            id: 'language',
            question: 'Choose a language?',
            options: [{ label: 'TypeScript', description: 'Recommended' }, { label: 'Rust' }],
          }],
        },
      },
      resolved.promise,
      {
        rpcId: RpcId('question-resolved-push'),
        payload: {
          type: 'question/resolved',
          sessionId,
          questionRpcId: rpcId,
          outcome: 'answered',
        },
      },
    ], respond), {
      acceptsSession: id => id === String(sessionId),
      onChange,
    })

    bridge.start()
    await vi.waitFor(() => {
      expect(bridge.list(String(sessionId))).toEqual([expect.objectContaining({
        id: 'question:question-rpc-1',
        kind: 'question',
      })])
    })

    await bridge.respond(String(sessionId), 'question:question-rpc-1', {
      kind: 'question',
      answers: [{ id: 'language', selected: ['TypeScript'] }],
    })
    expect(respond).toHaveBeenCalledWith({
      type: 'client-response',
      rpcId,
      result: {
        ok: true,
        value: {
          sessionId,
          answer: { answers: [{ id: 'language', selected: ['TypeScript'] }] },
        },
      },
    })
    expect(bridge.list(String(sessionId))).toHaveLength(1)

    resolved.resolve()
    await vi.waitFor(() => { expect(bridge.list(String(sessionId))).toEqual([]) })
    expect(onChange).toHaveBeenCalled()
    await bridge.dispose()
  })

  it('uses the official one-shot approval outcome and drops stale requests', async () => {
    const sessionId = SessionId('session-2')
    const respond = vi.fn(async () => ({ accepted: false as const, reason: 'not-pending' as const }))
    const bridge = new TeamInteractionBridge(contextWithMux([{
      rpcId: RpcId('approval-rpc-1'),
      payload: {
        type: 'approval/requested',
        sessionId,
        approvalId: 'approval-1' as never,
        toolName: 'bash',
        reason: 'Needs access outside the Workspace',
      },
    }], respond), {
      acceptsSession: () => true,
      onChange: vi.fn(),
    })

    bridge.start()
    await vi.waitFor(() => { expect(bridge.list(String(sessionId))).toHaveLength(1) })
    await expect(bridge.respond(String(sessionId), 'approval:approval-1', {
      kind: 'approval',
      outcome: 'allowed-once',
    })).rejects.toMatchObject({ code: 'INTERACTION_NOT_PENDING' })
    expect(bridge.list(String(sessionId))).toEqual([])
    await bridge.dispose()
  })
})

describe('normalizeQuestionAnswers', () => {
  it('rejects incomplete and forged option answers', () => {
    const questions = [{
      id: 'model',
      question: 'Choose a model?',
      options: [{ label: 'DeepSeek' }, { label: 'GLM' }],
    }]
    expect(() => normalizeQuestionAnswers(questions, [])).toThrow(AgentTeamError)
    expect(() => normalizeQuestionAnswers(questions, [{
      id: 'model',
      selected: ['Unknown'],
    }])).toThrow('contains an invalid option')
  })
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function contextWithMux(
  steps: Array<RpcRequest<MuxFrame> | Promise<void>>,
  respond: (message: unknown) => Promise<unknown>,
): Context {
  return {
    apiProxy: {
      events: {
        async *mux(_request: unknown, signal: AbortSignal): AsyncIterable<RpcRequest<MuxFrame>> {
          for (const step of steps) {
            if (step instanceof Promise) await step
            else yield step
          }
          if (!signal.aborted) {
            await new Promise<void>(resolve => signal.addEventListener('abort', () => { resolve() }, { once: true }))
          }
        },
      },
      respond,
    },
    logger: {
      error: vi.fn(),
    },
  } as unknown as Context
}

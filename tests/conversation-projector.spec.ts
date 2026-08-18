import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { projectConversation } from '../src/runtime/conversation-projector.js'

describe('projectConversation', () => {
  it('projects independent messages, streaming text, and reasoning', () => {
    const projected = projectConversation([
      event(0, 'user/message', {
        id: 'user-1', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'Build it' }],
      }),
      event(1, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Working' } }),
      event(2, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 1, text: 'Checking files' } }),
    ])

    expect(projected.throughSeq).toBe(2)
    expect(projected.nodes).toEqual([
      expect.objectContaining({ kind: 'user', text: 'Build it' }),
      expect.objectContaining({ kind: 'assistant', text: 'Working', reasoning: 'Checking files', streaming: true }),
    ])
  })

  it('pairs a tool call with its result and replaces the streaming assistant with the final message', () => {
    const projected = projectConversation([
      event(0, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Old partial' } }),
      event(1, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'openai', model: 'codex' },
          content: [{ type: 'text', text: 'Final answer' }],
        },
      }),
      event(2, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"a.ts"}' }),
      event(3, 'tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 'tool-result-1', role: 'user', source: { kind: 'tool', callId: 'call-1' },
          content: [{
            type: 'tool-result', toolCallId: 'call-1', isError: false,
            content: [{ type: 'text', text: 'file contents' }],
          }],
        },
      }),
    ])

    expect(projected.nodes).toEqual([
      expect.objectContaining({ kind: 'assistant', text: 'Final answer' }),
      expect.objectContaining({ kind: 'tool', name: 'read', status: 'success', result: 'file contents' }),
    ])
  })

  it('uses completed stream blocks when a provider does not emit deltas', () => {
    const projected = projectConversation([
      event(0, 'assistant/chunk', {
        turn: 2, step: 1,
        chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '完整思考' } },
      }),
      event(1, 'assistant/chunk', {
        turn: 2, step: 1,
        chunk: { type: 'block-end', index: 1, block: { type: 'text', text: '完整回复' } },
      }),
    ])

    expect(projected.nodes).toEqual([
      expect.objectContaining({
        kind: 'assistant',
        text: '完整回复',
        reasoning: '完整思考',
        streaming: true,
      }),
    ])
  })

  it('keeps model-facing context out of the visible conversation', () => {
    const projected = projectConversation([
      event(0, 'user/message', {
        id: 'context-snapshot', role: 'user',
        source: {
          kind: 'plugin', plugin: 'dsh-runtime-context', form: 'snapshot',
          sections: [{ name: 'policy', text: 'Current runtime context' }],
        },
        content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier snapshots.' }],
      }),
      event(1, 'user/message', {
        id: 'skills-catalog', role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-skills', form: 'catalog' },
        content: [{ type: 'text', text: '<system-reminder><available_skills>secret catalog</available_skills></system-reminder>' }],
      }),
      event(2, 'user/message', {
        id: 'user-1', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: '你好' }],
      }),
      event(3, 'user/message', {
        id: 'relay-1', role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-agent-team', form: 'relay' },
        content: [{ type: 'text', text: 'Leader 分配的任务' }],
      }),
      event(4, 'user/message', {
        id: 'foreign-relay', role: 'user',
        source: { kind: 'plugin', plugin: 'another-plugin', form: 'relay' },
        content: [{ type: 'text', text: '其他插件的内部转发' }],
      }),
    ])

    expect(projected.nodes).toEqual([
      expect.objectContaining({ kind: 'user', text: '你好' }),
      expect.objectContaining({ kind: 'user', text: 'Leader 分配的任务' }),
    ])
    expect(JSON.stringify(projected.nodes)).not.toContain('Current runtime context')
    expect(JSON.stringify(projected.nodes)).not.toContain('available_skills')
  })

  it('projects persisted member relays as structured compact team messages', () => {
    const projected = projectConversation([
      event(0, 'user/message', {
        id: 'relay-1', role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-agent-team', form: 'relay' },
        content: [{ type: 'text', text: '[Team message from Coder]\nParser implemented.' }],
      }),
    ], 240, {
      team: {
        leaderSlotId: 'leader-1',
        members: {
          'leader-1': { id: 'leader-1', displayName: 'Lead' },
          'member-1': { id: 'member-1', displayName: 'Coder' },
        },
        retiredSessions: {},
      } as never,
      messages: [{
        id: 'relay-1',
        sender: { kind: 'member', id: 'member-1' },
        type: 'result',
        content: 'Parser implemented.',
        relatedTaskId: 'task-1',
      } as never],
    })

    expect(projected.nodes).toEqual([{
      id: 'relay-1',
      kind: 'team-message',
      seq: 0,
      time: 1_700_000_000_000,
      text: 'Parser implemented.',
      senderName: 'Coder',
      senderId: 'member-1',
      senderRole: 'member',
      messageType: 'result',
      relatedTaskId: 'task-1',
    }])
  })
})

function event(seq: number, type: SessionEvent['type'], data: unknown): SessionEvent {
  return { seq, time: 1_700_000_000_000 + seq, type, data } as SessionEvent
}

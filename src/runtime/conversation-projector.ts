import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ConversationNode } from '../transport/contracts.js'

interface PartialAssistant {
  id: string
  seq: number
  time: number
  text: string
  reasoning: string
}

export function projectConversation(events: readonly SessionEvent[], limit = 240): {
  throughSeq: number
  nodes: ConversationNode[]
} {
  const nodes: ConversationNode[] = []
  const tools = new Map<string, number>()
  const partials = new Map<string, PartialAssistant>()

  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        if (!isVisibleUserSource(event.data.source)) break
        const text = textOf(event.data.content)
        if (text.length > 0) nodes.push({
          id: String(event.data.id),
          kind: 'user',
          seq: event.seq,
          time: event.time,
          text,
        })
        break
      }
      case 'assistant/chunk': {
        const key = `${event.data.turn}:${event.data.step}`
        const current = partials.get(key) ?? {
          id: `stream:${key}`,
          seq: event.seq,
          time: event.time,
          text: '',
          reasoning: '',
        }
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') current.text += chunk.text
        if (chunk.type === 'reasoning-delta') current.reasoning += chunk.text
        if (chunk.type === 'block-end' && chunk.block.type === 'text') current.text = chunk.block.text
        if (chunk.type === 'block-end' && chunk.block.type === 'reasoning') current.reasoning = chunk.block.text
        current.seq = event.seq
        partials.set(key, current)
        break
      }
      case 'assistant/message': {
        partials.delete(`${event.data.turn}:${event.data.step}`)
        const text = textOf(event.data.message.content)
        const reasoning = reasoningOf(event.data.message.content)
        if (text.length > 0 || reasoning.length > 0) nodes.push({
          id: String(event.data.message.id),
          kind: 'assistant',
          seq: event.seq,
          time: event.time,
          text,
          ...(reasoning.length === 0 ? {} : { reasoning }),
        })
        break
      }
      case 'tool/call': {
        const callId = String(event.data.callId)
        tools.set(callId, nodes.length)
        nodes.push({
          id: `tool:${callId}`,
          kind: 'tool',
          seq: event.seq,
          time: event.time,
          callId,
          name: event.data.name,
          arguments: event.data.arguments,
          status: 'running',
        })
        break
      }
      case 'tool/result': {
        const callId = String(event.data.message.content[0].toolCallId)
        const index = tools.get(callId)
        const result = textOf(event.data.message.content[0].content)
        const error = event.data.error === undefined
          ? undefined
          : `${event.data.error.name}: ${event.data.error.code}`
        if (index !== undefined) {
          const node = nodes[index]
          if (node?.kind === 'tool') nodes[index] = {
            ...node,
            seq: event.seq,
            status: event.data.message.content[0].isError === true || error !== undefined ? 'error' : 'success',
            ...(result.length === 0 ? {} : { result }),
            ...(error === undefined ? {} : { error }),
          }
        } else {
          nodes.push({
            id: `tool:${callId}`,
            kind: 'tool',
            seq: event.seq,
            time: event.time,
            callId,
            name: 'tool',
            arguments: '',
            status: event.data.message.content[0].isError === true || error !== undefined ? 'error' : 'success',
            ...(result.length === 0 ? {} : { result }),
            ...(error === undefined ? {} : { error }),
          })
        }
        break
      }
      case 'turn/end': {
        if (event.data.reason.kind === 'error') nodes.push({
          id: `turn-error:${event.seq}`,
          kind: 'notice',
          seq: event.seq,
          time: event.time,
          tone: 'error',
          text: event.data.reason.error.message,
        })
        if (event.data.reason.kind === 'max-tokens') nodes.push({
          id: `turn-warning:${event.seq}`,
          kind: 'notice',
          seq: event.seq,
          time: event.time,
          tone: 'warning',
          text: '本轮输出已达到模型长度上限。',
        })
        break
      }
    }
  }

  for (const partial of partials.values()) {
    if (partial.text.length === 0 && partial.reasoning.length === 0) continue
    nodes.push({
      id: partial.id,
      kind: 'assistant',
      seq: partial.seq,
      time: partial.time,
      text: partial.text,
      ...(partial.reasoning.length === 0 ? {} : { reasoning: partial.reasoning }),
      streaming: true,
    })
  }
  nodes.sort((left, right) => left.seq - right.seq)
  return {
    throughSeq: events.at(-1)?.seq ?? -1,
    nodes: nodes.slice(-limit),
  }
}

function isVisibleUserSource(source: MessageSource): boolean {
  if (source.kind === 'user') return true
  if (source.kind !== 'plugin') return false
  return source.plugin === 'dsh-agent-team' && source.form === 'relay'
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'tool-result') return [textOf(block.content)]
    if (block.type === 'image') return ['[图片]']
    return []
  }).filter(Boolean).join('\n')
}

function reasoningOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'reasoning' ? [block.text] : []).join('\n')
}

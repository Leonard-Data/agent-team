import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

interface TeamToolHandlers {
  assertIdentity: (agent: Agent | undefined) => void
  getTaskBoard: () => {
    teamId: string
    revision: number
    tasks: Array<Record<string, string | number | string[]>>
  }
  createTask: (input: {
    title: string
    description?: string
    ownerSlotId?: string
    fileScopes?: string[]
  }) => Promise<{ taskId: string; status: string; deliveryState?: 'queued' | 'delivered' }>
  updateTask: (input: {
    taskId: string
    status: 'pending' | 'assigned' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'
    result?: string
    error?: string
    ownerSlotId?: string
  }) => Promise<{ taskId: string; status: string; deliveryState?: 'queued' | 'delivered' }>
  sendMessage: (
    recipientSlotId: string,
    content: string,
    type?: 'instruction' | 'progress' | 'result' | 'question' | 'warning',
  ) => Promise<{ messageId: string; deliveryState: 'delivered' }>
}

export function registerTeamTools(
  agentCtx: Context,
  handlers: TeamToolHandlers,
): void {
  agentCtx.tools.register(defineTool({
    name: 'team_get_task_board',
    description: 'Read the current shared task board for this Agent Team.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (_args, exec) => {
      handlers.assertIdentity(exec.agent)
      return handlers.getTaskBoard()
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
      handlers.assertIdentity(exec.agent)
      return handlers.createTask(args)
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
      handlers.assertIdentity(exec.agent)
      return handlers.updateTask(args)
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
      handlers.assertIdentity(exec.agent)
      return handlers.sendMessage(args.recipientSlotId, args.content, args.type)
    },
  }))
}

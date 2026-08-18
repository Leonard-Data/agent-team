export const AGENT_TEAM_API_PATH = '/agent-team/api'
export const AGENT_TEAM_EVENTS_PATH = '/agent-team/events'
export const AGENT_TEAM_UPLOAD_PATH = '/agent-team/upload'

export type AgentTeamMethod =
  | 'catalog.get'
  | 'skill.catalog'
  | 'mcp.catalog'
  | 'assistant.list'
  | 'assistant.get'
  | 'assistant.create'
  | 'assistant.update'
  | 'assistant.clone'
  | 'assistant.delete'
  | 'assistant.builder.list'
  | 'assistant.builder.draft.get'
  | 'assistant.builder.draft.configure'
  | 'assistant.builder.start'
  | 'assistant.builder.get'
  | 'assistant.builder.configure'
  | 'assistant.builder.send'
  | 'assistant.builder.stop'
  | 'assistant.builder.archive'
  | 'team.list'
  | 'team.get'
  | 'team.createDraft'
  | 'team.start'
  | 'team.addMember'
  | 'team.removeMember'
  | 'team.changeLeader'
  | 'team.reset'
  | 'team.message.list'
  | 'team.message.send'
  | 'team.workbench.get'
  | 'team.member.stop'
  | 'team.member.setPermissionPreset'
  | 'team.workspace.list'
  | 'team.dissolve'

export type ConversationNode =
  | {
    id: string
    kind: 'user' | 'assistant'
    seq: number
    time: number
    text: string
    reasoning?: string
    streaming?: boolean
  }
  | {
    id: string
    kind: 'team-message'
    seq: number
    time: number
    text: string
    senderName: string
    senderId: string
    senderRole: 'leader' | 'member' | 'system'
    messageType: 'instruction' | 'progress' | 'result' | 'question' | 'warning' | 'system'
    relatedTaskId?: string
  }
  | {
    id: string
    kind: 'tool'
    seq: number
    time: number
    callId: string
    name: string
    arguments: string
    status: 'running' | 'success' | 'error'
    result?: string
    error?: string
  }
  | {
    id: string
    kind: 'notice'
    seq: number
    time: number
    tone: 'neutral' | 'error' | 'warning'
    text: string
  }

export interface MemberConversationView {
  slotId: string
  sessionId: string
  throughSeq: number
  status: 'offline' | 'starting' | 'idle' | 'running' | 'waiting_approval' | 'error'
  nodes: ConversationNode[]
}

export interface TeamWorkbenchView {
  schemaVersion: 1
  teamId: string
  revision: number
  conversations: MemberConversationView[]
}

export interface AssistantBuilderConversationView {
  schemaVersion: 1
  sessionId: string
  status: 'starting' | 'idle' | 'running' | 'error'
  throughSeq: number
  nodes: ConversationNode[]
  configuration: {
    provider: string
    model: string
    agentPresetId: string
    permissionPresetId: string
  }
}

export interface AssistantBuilderConversationSummary {
  sessionId: string
  title: string
  createdAt: string
  updatedAt: string
  state: 'new' | 'in_progress' | 'completed'
}

export interface AssistantBuilderConversationListView {
  items: AssistantBuilderConversationSummary[]
  total: number
}

export interface AssistantBuilderDraftView {
  schemaVersion: 1
  configuration: AssistantBuilderConversationView['configuration']
}

export interface WorkspaceEntryView {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink'
}

export interface WorkspaceUploadView {
  name: string
  path: string
  bytes: number
}

export interface AgentTeamRequest {
  requestId: string
  method: AgentTeamMethod
  expectedRevision?: number
  payload: unknown
}

export type AgentTeamResponse =
  | { requestId: string; ok: true; value: unknown }
  | {
    requestId: string
    ok: false
    error: {
      code: string
      message: string
      details?: Readonly<Record<string, unknown>>
    }
  }

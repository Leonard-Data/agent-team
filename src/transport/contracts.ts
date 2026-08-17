export const AGENT_TEAM_API_PATH = '/agent-team/api'
export const AGENT_TEAM_EVENTS_PATH = '/agent-team/events'

export type AgentTeamMethod =
  | 'catalog.get'
  | 'assistant.list'
  | 'assistant.get'
  | 'assistant.create'
  | 'assistant.update'
  | 'assistant.clone'
  | 'assistant.delete'
  | 'team.list'
  | 'team.get'
  | 'team.createDraft'
  | 'team.start'
  | 'team.addMember'
  | 'team.removeMember'
  | 'team.changeLeader'
  | 'team.pause'
  | 'team.resume'
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
  status: 'offline' | 'starting' | 'idle' | 'running' | 'waiting_approval' | 'error' | 'paused'
  nodes: ConversationNode[]
}

export interface TeamWorkbenchView {
  schemaVersion: 1
  teamId: string
  revision: number
  conversations: MemberConversationView[]
}

export interface WorkspaceEntryView {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink'
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

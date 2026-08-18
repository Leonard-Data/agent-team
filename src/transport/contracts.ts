import type {
  AddTeamMemberInput,
  AssistantTemplate,
  CreateAssistantInput,
  CreateTeamDraftInput,
  TeamAggregate,
  TeamMessage,
  UpdateAssistantInput,
} from '../domain/types.js'

export const AGENT_TEAM_API_PATH = '/agent-team/api'
export const AGENT_TEAM_EVENTS_PATH = '/agent-team/events'
export const AGENT_TEAM_UPLOAD_PATH = '/agent-team/upload'

export const AGENT_TEAM_METHODS = [
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
  'assistant.builder.draft.get',
  'assistant.builder.draft.configure',
  'assistant.builder.start',
  'assistant.builder.get',
  'assistant.builder.configure',
  'assistant.builder.send',
  'assistant.builder.stop',
  'assistant.builder.archive',
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
  'team.workspace.changes',
  'team.workspace.diff',
  'team.dissolve',
] as const

export type AgentTeamMethod = typeof AGENT_TEAM_METHODS[number]

export type AssistantView = AssistantTemplate
export type TeamView = TeamAggregate

export interface PageView<T> {
  items: T[]
  total: number
}

export interface CatalogView {
  providers: Array<{ id: string; name: string }>
  models: Record<string, Array<{ id: string; name: string; description?: string }>>
  agentPresets: Array<{ id: string; name: string; description?: string; broken?: string }>
  permissionPresets: Array<{ value: string; name: string; description?: string }>
  workspaces: Array<{ id: string; path: string; title: string; status: 'ok' | 'missing-dir' }>
}

export interface SkillCatalogView {
  agentPresetId: string
  skills: Array<{
    name: string
    description: string
    source: string
  }>
}

export interface McpCatalogView {
  agentPresetId: string
  servers: Array<{
    name: string
    tools: Array<{ name: string; description: string }>
  }>
}

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
  contextUsage?: {
    usedTokens: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
    contextWindow?: number
  }
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

export interface WorkspaceGitChangeView {
  path: string
  originalPath?: string
  kind: 'added' | 'copied' | 'deleted' | 'modified' | 'renamed' | 'type-changed' | 'unmerged' | 'untracked'
  staged: boolean
  unstaged: boolean
  indexCode: string
  workTreeCode: string
}

export interface WorkspaceGitStatusView {
  state: 'repository' | 'not-repository'
  changes: WorkspaceGitChangeView[]
  truncated: boolean
}

export interface WorkspaceGitDiffView {
  path: string
  scope: 'staged' | 'unstaged'
  layout: 'unified' | 'split'
  theme: 'light' | 'dark'
  html: string
  binary: boolean
}

export interface WorkspaceUploadView {
  name: string
  path: string
  bytes: number
}

export interface AgentTeamRequestMap {
  'catalog.get': { payload: undefined; result: CatalogView }
  'skill.catalog': { payload: { agentPresetId: string }; result: SkillCatalogView }
  'mcp.catalog': { payload: { agentPresetId: string }; result: McpCatalogView }
  'assistant.list': { payload: undefined; result: PageView<AssistantView> }
  'assistant.get': { payload: { id: string }; result: AssistantView }
  'assistant.create': { payload: CreateAssistantInput; result: AssistantView }
  'assistant.update': { payload: { id: string; value: UpdateAssistantInput }; result: AssistantView }
  'assistant.clone': { payload: { id: string; name?: string }; result: AssistantView }
  'assistant.delete': { payload: { id: string }; result: null }
  'assistant.builder.list': { payload: undefined; result: AssistantBuilderConversationListView }
  'assistant.builder.draft.get': { payload: undefined; result: AssistantBuilderDraftView }
  'assistant.builder.draft.configure': {
    payload: { provider: string; model: string }
    result: AssistantBuilderDraftView
  }
  'assistant.builder.start': {
    payload: { provider: string; model: string; content: string }
    result: AssistantBuilderConversationView
  }
  'assistant.builder.get': { payload: { sessionId: string }; result: AssistantBuilderConversationView }
  'assistant.builder.configure': {
    payload: { sessionId: string; provider: string; model: string }
    result: AssistantBuilderConversationView
  }
  'assistant.builder.send': {
    payload: { sessionId: string; content: string }
    result: { messageId: string }
  }
  'assistant.builder.stop': { payload: { sessionId: string }; result: { accepted: boolean } }
  'assistant.builder.archive': { payload: { sessionId: string }; result: { archived: boolean } }
  'team.list': { payload: undefined; result: PageView<TeamView> }
  'team.get': { payload: { id: string }; result: TeamView }
  'team.createDraft': { payload: CreateTeamDraftInput; result: TeamView }
  'team.start': { payload: { id: string }; result: TeamView }
  'team.addMember': { payload: { teamId: string; value: AddTeamMemberInput }; result: TeamView }
  'team.removeMember': { payload: { teamId: string; slotId: string }; result: TeamView }
  'team.changeLeader': { payload: { teamId: string; successorSlotId: string }; result: TeamView }
  'team.reset': { payload: { teamId: string; confirmation: string }; result: TeamView }
  'team.message.list': { payload: { id: string }; result: PageView<TeamMessage> }
  'team.message.send': {
    payload: { teamId: string; content: string; targetSlotId?: string }
    result: TeamMessage
  }
  'team.workbench.get': { payload: { id: string }; result: TeamWorkbenchView }
  'team.member.stop': { payload: { teamId: string; slotId: string }; result: { accepted: boolean } }
  'team.member.setPermissionPreset': {
    payload: { teamId: string; slotId: string; permissionPresetId: string }
    result: TeamView
  }
  'team.workspace.list': {
    payload: { teamId: string; path?: string }
    result: WorkspaceEntryView[]
  }
  'team.workspace.changes': { payload: { teamId: string }; result: WorkspaceGitStatusView }
  'team.workspace.diff': {
    payload: {
      teamId: string
      path: string
      scope: 'staged' | 'unstaged'
      layout: 'unified' | 'split'
      theme: 'light' | 'dark'
    }
    result: WorkspaceGitDiffView
  }
  'team.dissolve': { payload: { teamId: string; confirmation: string }; result: null }
}

export type AgentTeamPayload<M extends AgentTeamMethod> = AgentTeamRequestMap[M]['payload']
export type AgentTeamResult<M extends AgentTeamMethod> = AgentTeamRequestMap[M]['result']

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
